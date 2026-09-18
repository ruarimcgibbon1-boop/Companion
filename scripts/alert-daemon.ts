/**
 * Headless alert daemon — fires Telegram buy alerts WITHOUT a browser open, and
 * optionally paper-trades them.
 *
 * The scanner sweep normally runs client-side (useMonitor), so alerts only fire
 * while Companion is open in a tab. This daemon runs that sweep as a standalone
 * process: it reuses the existing routes over HTTP (so all data logic stays in
 * one place) and the shared gate stack (src/lib/buy-log.ts, the same one the
 * client uses), then posts each new BUY to /api/telegram. The route dedups on the
 * stable setup id, so the daemon and any open browser tab never double-text.
 *
 * With PAPER_TRADE=1 the same BUYs are also routed to the Alpaca paper executor
 * (src/lib/execution/), which sizes them, places real paper orders, and manages
 * the position on the resolver's scale-out ladder. Alerts still fire either way —
 * paper trading is additive, never a replacement.
 *
 * Prereqs: the Next dev server running (`npm run dev`) + Telegram configured in
 * .env.local. Run:  npx tsx scripts/alert-daemon.ts
 *                   PAPER_TRADE=1 npx tsx scripts/alert-daemon.ts
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { MonitorResult, BuySignalRecord, DetectedSetup } from '@/types'
import { classifyBuy, decomposeGates, passesTrackingFloor, DISPLAY_FLOOR_SCORE, SYMBOL_LOG_WINDOW_MS } from '@/lib/buy-log'
import { getSessionType } from '@/lib/market-hours'
import { loadEnvLocal } from '@/lib/execution/env'
import { AlpacaBroker } from '@/lib/execution/alpaca'
import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { enforceProducerProvenance, overrideEnabled, type ProducerProvenance } from '@/lib/execution/provenance'
import { authorityLockPath } from '@/lib/execution/authority'
import { isHalted, haltFile, etDayKey, decisionsFile, arbitrationFile } from '@/lib/execution/store'
import { emitFunnel, emitSessionSummary, newSweepId, ensureFunnelRunId, funnelDegraded, funnelDroppedTotal, type SweepContext } from '@/lib/telemetry/funnel'
import { UniverseCoordinator, type SweepSnapshot, type UniverseEnvelope } from '@/lib/universe/coordinator'
import type { RankedRow } from '@/lib/universe/pipeline'
import type { DiscoverySymbolProv } from '@/lib/universe/discovery-provenance'
import { updateLeaderState, etDay, resolveLeaderConfig, leaderConfigHash, type LeaderStateConfig, type LeaderStateMap } from '@/lib/leader/leader-state'
import { selectLeaderObservationCohort, resolveLeaderObservationConfig, leaderObservationConfigHash, type LeaderObservationConfig } from '@/lib/leader/leader-observation'
import { runSharedMonitorPass, shouldRefreshObservation, resolveObservationPassConfig, observationPassConfigHash, type ObservationPassConfig } from '@/lib/leader/observation-pass'
import { loadLeaderState, saveLeaderState, type SaveReason, type RecoveryStatus } from '@/lib/leader/leader-store'
import { acquireLeaderWriterLock } from '@/lib/leader/leader-lock'
import { AlpacaMarketData } from '@/lib/execution/execution-quality'
import { makeObserverLoop } from '@/lib/execution/observer-wiring'
import type { ObserverLoop } from '@/lib/execution/observer-loop'

// Capture the dirty-producer override from the INHERITED launch environment, BEFORE
// loadEnvLocal() runs — otherwise a stale `ALLOW_DIRTY_PRODUCER=1` left in .env.local
// would silently turn an emergency override into a persistent default. The override
// must be an explicit launch-time act (e.g. `ALLOW_DIRTY_PRODUCER=1 npx tsx ...`).
const LAUNCH_ALLOW_DIRTY_PRODUCER = overrideEnabled(process.env)

loadEnvLocal()   // ALPACA_* live here; the daemon has no Next runtime to load them

const BASE = process.env.COMPANION_URL || 'http://localhost:3000'
const DRY_RUN = process.env.DRY_RUN === '1'   // log alerts instead of sending them
const ONCE = process.env.ONCE === '1'         // run a single sweep then exit (testing)
const PAPER_TRADE = process.env.PAPER_TRADE === '1'
// Passive execution-quality observer — opt-in, OFF by default so the daemon's
// behaviour is byte-for-byte unchanged unless explicitly enabled. Read-only: it
// witnesses open positions on an independent feed and writes only the EQ timeline.
const EXEC_OBSERVER = process.env.EXEC_OBSERVER === '1'
const SWEEP_MS = 15_000                 // active-session cadence (matches the client)
const IDLE_MS = 5 * 60_000              // slow poll when the market is closed
// Position management runs on its OWN loop, not inside the sweep.
//
// It used to be the first thing each sweep did, so an open position was only
// checked once per sweep + universe fetch ≈ 20s. On 2026-08-10 that cost real
// money: exits averaged −1.00% against the level, and decomposing the worst one
// (AUUD −2.84%) put −2.35% of it in the gap between the stop breaking and us
// noticing, vs −0.50% in our limit tolerance. 82% of the bleed was latency.
//
// A resting broker stop would remove the latency entirely, but Alpaca rejects
// stop orders outside 09:30–16:00 and every slipped exit that day was premarket,
// so the only lever there is looking more often. One symbol through /api/monitor
// is ~0.5–0.9s warm, so a 3s cadence on the 1–3 names we hold is affordable.
const POSITION_MS = 3_000               // held-position check cadence
const POSITION_IDLE_MS = 10_000         // slower spin when flat
const MIN_LEVEL_STRENGTH = 40           // store default notificationSettings.minLevelStrength
const TOP_GAINERS_UNIVERSE = 15         // matches useMonitor.gatherUniverse

// H3A funnel telemetry: producer head for event provenance, set once at startup from
// the same provenance the executor uses. Telemetry-only; never read by any decision.
let PRODUCER_HEAD: string | null = null

// H3C observational leader state (persistent history over the canonical snapshot). SHADOW ONLY —
// never changes the monitored universe, BASE inputs, or execution. Read from disk at startup.
let leaderState: LeaderStateMap = {}
let leaderHistoryComplete = true          // false once a degraded/fresh load or active eviction happens
let leaderSweepCounter = 0
const LEADER_PERSIST_EVERY = 20           // periodic save (~5 min at 15s), plus on shutdown
// Effective (env-resolved) provisional config + its fingerprint — stamped on every persisted checkpoint
// and every leader telemetry event so a transition can be pinned to the exact config that produced it.
let leaderCfg: LeaderStateConfig = resolveLeaderConfig()
let leaderConfigHashV = leaderConfigHash(leaderCfg)
// H4A.1 observational leader cohort — DATA COVERAGE ONLY. Keeps fresh market data for a bounded set of
// persistent leaders OUTSIDE top15 so H4B can study them. These symbols NEVER enter the BASE universe,
// detectSetups, arbitration, or execution. Provisional, env-overridable, fingerprinted.
const leaderObsCfg: LeaderObservationConfig = resolveLeaderObservationConfig()
const leaderObsConfigHashV = leaderObservationConfigHash(leaderObsCfg)
// H4A.1 shared-pass coordinator config: BASE-latency isolation + bar-driven observational refresh cadence.
const obsPassCfg: ObservationPassConfig = resolveObservationPassConfig()
const obsPassConfigHashV = observationPassConfigHash(obsPassCfg)
// Last time the observational cohort was actually re-fetched (gated to the bar cadence). Never gates BASE.
let lastObsRefreshAt: number | null = null
let leaderRecoveryStatus: RecoveryStatus = 'FRESH_UNKNOWN'
let leaderCheckpointSeq = 0
// Single-writer ownership (research only; NEVER affects trading). A secondary daemon runs without
// persisting leader state.
let leaderWriterOwned = false
let releaseLeaderLock: () => void = () => {}

// H4A observational local-structure: last emitted (resetState|status|reExpansion) signature per symbol,
// so we only emit local_structure_changed on a real transition. Recomputed from bars each sweep (no new
// persistence layer — H3C stays the durable history); bounded to the monitored set each sweep.
const h4aLastSig = new Map<string, string>()

/** Persist leader state ONLY if we own the writer lease; stamps saveReason + config provenance. */
function persistLeaderState(reason: SaveReason, now: number, lastSweepId: string | null): boolean {
  if (!leaderWriterOwned) return false
  return saveLeaderState({
    records: leaderState, producerHead: PRODUCER_HEAD, tradingDay: etDay(now), saveReason: reason,
    runId: ensureFunnelRunId(now), lastSweepId, checkpointSeq: ++leaderCheckpointSeq,
    configVersion: leaderCfg.ruleVersion, configHash: leaderConfigHashV, log,
  })
}

// RankedRow now lives in the shared universe pipeline (single source of truth).
const STATE_FILE = join(homedir(), '.companion-alert-daemon.json')
// Every triggered setup + its verdict, appended as JSONL. This is the session
// audit trail: at end of day you can answer "did we miss X?" from data instead of
// memory — including the NEAR-MISSES (triggered but gated), which the terminal
// output never showed. One line per triggered setup per sweep-first-sighting.
// Keyed on the ET TRADING day, not the UTC calendar day, and the file is chosen at
// APPEND TIME from the decision's own timestamp (decisionsFile(etDayKey(now))) — NOT
// once at startup. A daemon running continuously across ET midnight therefore rolls
// to the new day's file on its own, and a decision after 20:00 ET (= 00:00Z) never
// spills into the wrong UTC day. etDayKey matches the paper-trades files so
// decisions and trades for one session always share a date.

const HEARTBEAT_MS = 5 * 60_000         // "still alive" line when nothing is triggering
let lastHeartbeat = 0

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

// Persisted buy history (dedup + per-symbol cap survive a daemon restart).
function loadBuys(): BuySignalRecord[] {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : [] } catch { return [] }
}
function saveBuys(buys: BuySignalRecord[]) {
  try { writeFileSync(STATE_FILE, JSON.stringify(buys)) } catch (e) { log('state save failed:', (e as Error).message) }
}

// Record each triggered setup's verdict once (a setup persists across sweeps, so
// key on setup id + verdict to avoid one line every 15s).
const seenDecisions = new Set<string>()
function recordDecision(row: Record<string, unknown>, now: number = Date.now()) {
  const key = `${row.setupId}:${row.verdict}`
  if (seenDecisions.has(key)) return
  seenDecisions.add(key)
  // Path derived from the decision's ET day AT APPEND TIME — rotates across ET midnight.
  try { appendFileSync(decisionsFile(etDayKey(now)), JSON.stringify(row) + '\n') } catch { /* audit trail is best-effort */ }
}

/**
 * Signal-time attributes for a triggered setup, drawn ENTIRELY from values already
 * present on the DetectedSetup + MonitorResult at decision time. Pure projection —
 * reads only, computes nothing new, and is shared by the decision log and the
 * arbitration snapshot so the two can never disagree. Fields not available on a
 * given build surface as explicit null (never fabricated). `float`/`spaceR` are the
 * additive observational fields (see monitor.ts / setup-detectors.ts); older results
 * lacking them read null.
 */
function signalAttrs(setup: DetectedSetup, r: MonitorResult): Record<string, unknown> {
  return {
    symbol: setup.symbol,
    setupId: setup.id,
    setupType: setup.type,
    state: setup.state,
    score: setup.score,
    grade: setup.grade,
    levelQuality: setup.breakdown?.levelQuality ?? null,
    levelStrength: setup.levelStrength ?? null,
    rewardRisk: setup.rewardRisk ?? null,
    distanceToZonePct: setup.distanceToZonePct ?? null,
    distanceFromVwapPct: setup.distanceFromVwapPct ?? null,
    distanceFromEma9Pct: setup.distanceFromEma9Pct ?? null,
    distanceFromEma21Pct: setup.distanceFromEma21Pct ?? null,
    distanceFromDayHighPct: r.technicals?.distanceFromDayHighPct ?? null,
    offHighPct: r.technicals?.distanceFromDayHighPct ?? null,
    rvol: r.relativeVolume ?? null,
    changePct: r.changePct ?? null,
    confidence: setup.confidence ?? null,
    testCount: setup.testCount ?? null,
    catalyst: r.catalyst ?? null,
    float: r.float ?? null,
    spaceR: setup.spaceR ?? null,
    keyRisks: setup.keyRisks ?? [],
    session: r.integrity.session,
    fill: setup.entryFill ?? setup.zoneUpper,
    stop: setup.stopReference,
    targets: setup.targets.map(t => t.price),
    entryRef: setup.entryFill ?? setup.zoneUpper,
  }
}

/**
 * Per-sweep arbitration snapshot — one JSONL record per sweep that had ≥1 Stage-1-
 * eligible long. OBSERVATIONAL ONLY: written AFTER the (unchanged) candidate loop,
 * from data passively accumulated during it. It reorders nothing, ranks nothing,
 * delays nothing, and is never read back into a decision. No per-sweep dedup — the
 * competition set is a genuine per-sweep fact.
 */
function recordArbitration(row: Record<string, unknown>, now: number): void {
  try { appendFileSync(arbitrationFile(etDayKey(now)), JSON.stringify(row) + '\n') } catch { /* audit trail is best-effort */ }
}

/**
 * Fetch + rank the monitored universe. BEHAVIOR UNCHANGED: `symbols` is the same
 * top-`TOP_GAINERS_UNIVERSE` set (same day-change re-sort + slice) the daemon has
 * always monitored. The extra `rankedRows` return and the sweepId/producerHead query
 * params are TELEMETRY ONLY — the route ignores unknown params, so selection is
 * identical; the params never influence the ranking or the returned set.
 */
/**
 * Fetch the route's ranked rows — the UNCHANGED provider path (one /api/gainers HTTP call per
 * sweep; the route makes the same provider calls it always did; H3B adds ZERO provider requests
 * and does not touch cache scope). The daemon-side SELECTION now lives in UniverseCoordinator,
 * not here. `ctx` carries sweepId/producerHead so the route's discovery telemetry shares them.
 */
async function fetchUniverseEnvelope(ctx?: SweepContext): Promise<UniverseEnvelope> {
  const params = new URLSearchParams({
    minChangePct: '3', minPrice: '0.1', maxPrice: '300', minVolume: '500000', minRvol: '1.5', maxResults: '30',
  })
  if (ctx) {
    params.set('sweepId', ctx.sweepId)
    if (ctx.producerHead) params.set('producerHead', ctx.producerHead)
  }
  const res = await fetch(`${BASE}/api/gainers?${params}`)
  if (!res.ok) throw new Error(`gainers HTTP ${res.status}`)
  const data = await res.json() as { rows?: RankedRow[]; discovery?: DiscoverySymbolProv[] }
  return { rows: data.rows ?? [], discovery: data.discovery ?? [] }
}

// One coordinator owns the daemon-side canonical universe (compatibility mode = legacy output).
const universeCoordinator = new UniverseCoordinator({
  fetchUniverse: (c) => fetchUniverseEnvelope({ sweepId: c.sweepId, producerHead: c.producerHead }),
  monitoredCap: TOP_GAINERS_UNIVERSE,
})

async function fetchResults(symbols: string[], observationalOnly: string[] = []): Promise<MonitorResult[]> {
  const res = await fetch(`${BASE}/api/monitor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // H4A.1: one shared acquisition pass. `observationalOnly` names the cohort subset that takes the
    // lighter observational path; absent = every symbol is a full BASE monitor result (unchanged).
    body: JSON.stringify(observationalOnly.length ? { symbols, observationalOnly } : { symbols }),
  })
  if (!res.ok) throw new Error(`monitor HTTP ${res.status}`)
  const data = await res.json() as { results?: MonitorResult[] }
  return data.results ?? []
}

async function sendAlert(buy: BuySignalRecord): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/telegram`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signal: buy }),
    })
    const data = await res.json() as { sent?: boolean; reason?: string }
    return data.sent === true
  } catch (e) { log('telegram post failed:', (e as Error).message); return false }
}

/**
 * Prices for the executor's open positions, from the same /api/monitor pipeline
 * the signals come out of. Deliberately NOT the broker's feed: exit decisions and
 * backtest decisions have to be made on identical data or the comparison between
 * them means nothing.
 */
async function fetchPrices(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out
  for (const r of await fetchResults(symbols)) {
    if (typeof r.price === 'number' && r.price > 0) out.set(r.symbol, r.price)
  }
  return out
}

async function sweep(buys: BuySignalRecord[], executor: PaperExecutor | null): Promise<BuySignalRecord[]> {
  // NB: position management is NOT done here — it runs on its own faster loop
  // (see positionLoop / POSITION_MS). Ticking here too would double-poll and, more
  // importantly, would put exits back behind the universe scan.
  // H3A: one sweep identity threads all telemetry for this cycle. Created BEFORE the
  // universe fetch so the fetch can carry it; NEVER read by any decision.
  const sweepStart = Date.now()
  const sweepCtx: SweepContext = { sweepId: newSweepId(sweepStart), producerHead: PRODUCER_HEAD }
  // H3B: the UniverseCoordinator is the single owner of the daemon-side canonical universe.
  // Compatibility mode reproduces the exact legacy monitored set (same rows, same re-sort,
  // same top-15) — proven by the parity harness. Provider path is unchanged (see fetchRankedRows).
  const snapshot: SweepSnapshot = await universeCoordinator.buildSweep({
    sweepId: sweepCtx.sweepId, runId: ensureFunnelRunId(sweepStart),
    producerHead: PRODUCER_HEAD, session: getSessionType(sweepStart),
  })
  const universe = snapshot.monitoredSymbols as string[]
  const rankedRows = snapshot.rawDiscovery as RankedRow[]
  // Funnel telemetry: sweep + monitored-universe decisions (best-effort; selection is exactly
  // `snapshot.monitoredSymbols`, owned by the coordinator).
  const monitoredSet = new Set(universe)
  emitFunnel(sweepCtx, 'sweep_started', {
    session: snapshot.session, universeSize: universe.length, poolSize: rankedRows.length,
    runId: snapshot.runId, snapshotSchemaVersion: snapshot.schemaVersion, universePolicy: snapshot.policy,
  }, sweepStart)
  rankedRows.slice().sort((a, b) => b.changePct - a.changePct).forEach((row, i) => {
    const monitored = monitoredSet.has(row.symbol)
    emitFunnel(sweepCtx, 'universe_decision', {
      symbol: row.symbol, strategyId: 'BASE',
      routeRank: row.rank ?? null,          // rank after the route's momentum re-rank
      daychangeRank: i + 1,                 // rank after the daemon's day-change re-sort
      monitored, monitoredRank: monitored ? i + 1 : null,
      admissionReason: monitored ? 'within_top_gainers_universe_cap' : null,
      exclusionReason: monitored ? null : 'below_daemon_truncation',
      universeSizeBefore: rankedRows.length, universeSizeAfter: universe.length,
      rankComponents: {
        changePct: row.changePct, momentumScore: row.momentumScore ?? null, offHighPct: row.offHighPct ?? null,
        rocPct: row.rocPct ?? null, relativeVolume: row.relativeVolume ?? null, volume: row.volume ?? null,
        float: row.float ?? null, premarketVolume: row.premarketVolume ?? null,
      },
    }, sweepStart)
  })
  // ── H3C: observational leader state ───────────────────────────────────────
  // Consumes the (deep-frozen) snapshot; SHADOW ONLY — it cannot and does not change `universe`,
  // BASE inputs, or execution. Best-effort: a throw here must never break the sweep.
  try {
    const before = universe                                   // capture to assert isolation below
    const upd = updateLeaderState(leaderState, snapshot, leaderCfg, sweepStart, leaderHistoryComplete)
    leaderState = upd.state
    // Provenance stamp on EVERY leader event: which run + exactly which effective config produced it.
    const prov = { runId: ensureFunnelRunId(sweepStart), ruleVersion: leaderCfg.ruleVersion, leaderConfigVersion: leaderCfg.ruleVersion, leaderConfigHash: leaderConfigHashV }
    for (const t of upd.transitions) emitFunnel(sweepCtx, 'leader_state_transition', {
      symbol: t.symbol, leaderEpisodeId: t.leaderEpisodeId, priorState: t.priorState, newState: t.newState,
      transitionReason: t.reason, ...prov,
    }, sweepStart)
    for (const rc of upd.roleChanges) emitFunnel(sweepCtx, 'leader_role_changed', {
      symbol: rc.symbol, leaderEpisodeId: rc.leaderEpisodeId, priorRole: rc.priorRole, newRole: rc.newRole, ...prov,
    }, sweepStart)
    // CAPACITY EVICTION is auditable: a non-expired (active) eviction is a research-integrity event —
    // emit it loudly and mark subsequent history incomplete so a later reappearance can never masquerade
    // as clean continuity (a fresh episode, not a normal expiry/re-entry).
    for (const ev of upd.evictions) {
      if (!ev.active) continue
      emitFunnel(sweepCtx, 'leader_state_evicted', {
        symbol: ev.symbol, leaderEpisodeId: ev.leaderEpisodeId, role: ev.role, lifecycleState: ev.lifecycleState,
        reason: 'capacity_pressure', historyComplete: false, ...prov,
      }, sweepStart)
      leaderHistoryComplete = false
    }
    // Compact per-sweep observation for role holders only (bounded — never a full-state dump).
    for (const rec of Object.values(leaderState)) {
      if (rec.role === 'NONE' || !rec.presentThisSweep) continue
      emitFunnel(sweepCtx, 'leader_state_observed', {
        symbol: rec.symbol, leaderEpisodeId: rec.leaderEpisodeId, role: rec.role, lifecycleState: rec.lifecycleState,
        peakChangePct: rec.peakObservedChangePct, currentChangePct: rec.currentChangePct, offHighPct: rec.currentOffHighPct,
        bestRouteRank: rec.bestRouteRank, timesTop30: rec.timesTop30, consecutiveSweepsSeen: rec.consecutiveSweepsSeen,
        historyComplete: rec.historyComplete, ...prov,
      }, sweepStart)
    }
    // ISOLATION ASSERT: the monitored universe must be byte-identical after the leader-state update.
    if (universe !== before || universe.length !== snapshot.monitoredSymbols.length) {
      log('FATAL: leader-state update altered the monitored universe — this must never happen'); process.exit(1)
    }
    // Periodic atomic persist (research only; never blocks; SKIPPED if we don't own the writer lease).
    if (++leaderSweepCounter % LEADER_PERSIST_EVERY === 0) {
      const ok = persistLeaderState('PERIODIC', sweepStart, sweepCtx.sweepId)
      emitFunnel(sweepCtx, 'leader_state_persisted', {
        ok, writerOwned: leaderWriterOwned, saveReason: 'PERIODIC', recordCount: Object.keys(leaderState).length,
        evicted: upd.evicted, historyComplete: leaderHistoryComplete, recoveryStatus: leaderRecoveryStatus, ...prov,
      }, sweepStart)
    }
  } catch (e) {
    log('leader-state update failed (research only; sweep continues):', (e as Error).message)
  }

  if (universe.length === 0) return buys

  // ── H4A.1: ONE shared observational data plane ─────────────────────────────
  // baseSymbols = legacy top15 — the ONLY detection/execution universe (unchanged). The bounded
  // leader-observation cohort rides the SAME monitor pass to keep fresh market data for persistent
  // leaders OUTSIDE top15 (the H4B study population). Cohort membership is a pure function of H3C
  // persistent facts (no H4A feature → no circular bias), deduplicated against base + open positions,
  // and NEVER enters detectSetups / BASE scoring / arbitration / the executor.
  const baseSymbols = universe
  let leaderObservationSymbols: string[] = []
  let cohortSelected: ReturnType<typeof selectLeaderObservationCohort>['selected'] = []
  let refreshObservation = false   // whether the cohort is RE-FETCHED this sweep (bar-driven cadence)
  try {
    const operational = executor ? executor.openTrades().map(t => t.symbol) : []
    const cohort = selectLeaderObservationCohort(leaderState, baseSymbols, leaderObsCfg, { excludeSymbols: operational })
    cohortSelected = cohort.selected
    leaderObservationSymbols = cohort.selected.map(m => m.symbol)
    // Selection runs EVERY sweep (a persisted leader stays selected); the data FETCH is gated to the cadence.
    refreshObservation = leaderObservationSymbols.length > 0 && shouldRefreshObservation(sweepStart, lastObsRefreshAt, obsPassCfg)
    emitFunnel(sweepCtx, 'leader_observation_cohort', {
      runId: ensureFunnelRunId(sweepStart),
      baseSize: baseSymbols.length, cap: cohort.cap,
      eligibleCount: cohort.eligibleCount, selectedCount: cohort.selectedCount, excludedByCapCount: cohort.excludedByCapCount,
      selected: cohort.selected.map(m => ({ symbol: m.symbol, leaderEpisodeId: m.leaderEpisodeId, role: m.role, lifecycleState: m.lifecycleState, reason: m.reason, presentThisSweep: m.presentThisSweep })),
      excludedByCap: cohort.excludedByCap.map(m => ({ symbol: m.symbol, role: m.role, reason: m.reason })),
      refreshed: refreshObservation, refreshIntervalMs: obsPassCfg.observationRefreshMs,
      configVersion: cohort.configVersion, configHash: cohort.configHash,
      observationPassConfigVersion: obsPassCfg.version, observationPassConfigHash: obsPassConfigHashV,
    }, sweepStart)
  } catch (e) {
    log('leader-observation cohort selection failed (research only; sweep continues):', (e as Error).message)
    leaderObservationSymbols = []; cohortSelected = []; refreshObservation = false   // fail closed to BASE-only coverage
  }

  // ── H4A.1: shared monitor pass — BASE completion barrier + best-effort observational tail ──
  // LATENCY ISOLATION (red-team §1): BASE awaits ONLY its own results. The observational request (issued
  // only on a refresh tick) runs concurrently on the SAME fetcher/endpoint/cache/single-flight and is
  // drained AFTER the BASE loop, best-effort — a slow, hung, or failed observational fetch can never
  // delay the moment BASE detection/arbitration/execution begins, nor change any BASE output.
  const pass = runSharedMonitorPass(
    fetchResults, baseSymbols, refreshObservation ? leaderObservationSymbols : [],
    {
      observationTimeoutMs: obsPassCfg.observationTimeoutMs,
      onObservationError: e => log('leader-observation fetch failed (research only; BASE unaffected):', (e as Error).message),
    },
  )
  const results = await pass.baseResults   // ← BASE COMPLETION BARRIER — no observational symbol is awaited here

  // ── H4A: observational local-reset geometry telemetry ─────────────────────
  // The features are computed at the data source (monitor pipeline, over the same 1m bars — zero new
  // provider requests) and arrive on each MonitorResult. Here we only JOIN the H3C leaderEpisodeId and
  // emit compact, bounded telemetry. SHADOW ONLY — never read by any gate/decision/execution.
  try {
    const seenH4a = new Set<string>()
    for (const r of results) {
      const ls = r.localStructure
      if (!ls) continue
      seenH4a.add(r.symbol)
      const sig = `${ls.resetState}|${ls.status}|${ls.reExpansion.observed}|${ls.base.detected}`
      const changed = h4aLastSig.get(r.symbol) !== sig
      h4aLastSig.set(r.symbol, sig)
      const leaderEpisodeId = leaderState[r.symbol]?.leaderEpisodeId ?? null
      const payload = {
        symbol: r.symbol, leaderEpisodeId, runId: ensureFunnelRunId(sweepStart),
        resetState: ls.resetState, dataQualityStatus: ls.status, qualityFlags: ls.qualityFlags, timeframe: ls.provenance.timeframe,
        globalOffHighPct: ls.global.offHighPct, impulsePct: ls.impulse.pct, dominantImpulsePct: ls.impulse.dominantImpulsePct,
        pullbackPct: ls.pullback.pctFromImpulsePeak, baseDetected: ls.base.detected, baseRangePct: ls.base.rangePct,
        baseDurationBars: ls.base.durationBars, volumeContraction: ls.base.volumeContraction,
        localExtensionPct: ls.localExtension.localExtensionPct, downsideToBaseLowPct: ls.localExtension.downsideToBaseLowPct,
        globalVsLocalExtensionRatio: ls.localExtension.globalVsLocalExtensionRatio, reExpansionObserved: ls.reExpansion.observed,
        discontinuity: ls.provenance.discontinuityInWindow, containsSessionBoundary: ls.provenance.containsSessionBoundary,
        cadenceConsistency: ls.provenance.cadenceConsistency,
        localFeatureConfigVersion: ls.provenance.localFeatureConfigVersion, localFeatureConfigHash: ls.provenance.localFeatureConfigHash,
      }
      // Emit the snapshot only for symbols carrying real geometry (bounded); always emit a transition.
      if (ls.impulse.detected || ls.status !== 'AVAILABLE') emitFunnel(sweepCtx, 'local_structure_observed', payload, sweepStart)
      if (changed) emitFunnel(sweepCtx, 'local_structure_changed', payload, sweepStart)
    }
    for (const k of [...h4aLastSig.keys()]) if (!seenH4a.has(k)) h4aLastSig.delete(k)   // bounded to the monitored set
  } catch (e) {
    log('local-structure telemetry failed (research only; sweep continues):', (e as Error).message)
  }

  const now = Date.now()
  // Prune history to the session window so cap/dedup stay bounded.
  let state = buys.filter(b => now - b.timestamp < SYMBOL_LOG_WINDOW_MS)
  let triggered = 0, sent = 0

  // ── Arbitration snapshot (OBSERVATIONAL) ──────────────────────────────────
  // Free-capacity reading captured NOW, before any order is submitted this sweep,
  // so the record reflects the slots each eligible candidate was actually competing
  // for. Read-only; null when running alerts-only (no executor). Candidates are
  // accumulated below and written once, after the unchanged loop.
  const capacityAtSweepStart = executor ? executor.observeCapacity(getSessionType(now)) : null
  const eligibleCandidates: Record<string, unknown>[] = []

  for (const r of results) {
    for (const setup of r.setups as DetectedSetup[]) {
      if (!(setup.direction === 'long' && setup.triggeredRaw)) continue
      // H3B (Step 11): a raw trigger that fails the tracking floor was previously dropped
      // SILENTLY (H3A blind spot). Record it before the (unchanged) `continue` so a research
      // audit distinguishes "no raw trigger" from "raw trigger below the tracking floor".
      if (!passesTrackingFloor(setup, MIN_LEVEL_STRENGTH)) {
        emitFunnel(sweepCtx, 'tracking_floor', {
          symbol: setup.symbol, strategyId: 'BASE', setupId: setup.id, setupType: setup.type,
          triggeredRaw: setup.triggeredRaw ?? false,
          observed: { score: setup.score, levelQuality: setup.breakdown?.levelQuality ?? null, levelStrength: setup.levelStrength ?? null },
          rule: { displayFloorScore: DISPLAY_FLOOR_SCORE, minLevelStrengthPct: MIN_LEVEL_STRENGTH },
          result: 'FAIL', reason: 'below_tracking_floor',
        }, now)
        continue
      }
      triggered++
      // Daemon tracks buys only (no full log/state machine) — the win/loss cap and
      // bounce stand-down no-op on empty logs/states; dedup + the
      // strong-continuation override still apply, which is the alerting core.
      const { verdict, buy } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })
      // H3A funnel: exact per-gate PASS/FAIL/binding (pure projection; gd.verdict === verdict).
      const gd = decomposeGates(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })
      emitFunnel(sweepCtx, 'strategy_trigger', {
        symbol: setup.symbol, strategyId: 'BASE', setupId: setup.id, setupType: setup.type,
        state: setup.state, triggeredRaw: setup.triggeredRaw ?? false, score: setup.score, grade: setup.grade,
        offHighPct: setup.gateGeometry?.offHighPct ?? null, verdict,
      }, now)
      emitFunnel(sweepCtx, 'gate_evaluation', {
        symbol: setup.symbol, strategyId: 'BASE', setupId: setup.id, setupType: setup.type,
        verdict, gates: gd.gates,
      }, now)
      const attrs = signalAttrs(setup, r)
      // Audit trail: every trigger + verdict, so end-of-session "did we miss X?"
      // is answerable from data — near-misses included. `attrs` is a read-only
      // projection of already-computed detection values; extending it adds fields
      // for research and changes no decision. The fields the Shadow Journal reads
      // (ts/etTime/verdict/price + those in attrs) are all preserved.
      recordDecision({
        ts: new Date(now).toISOString(),
        etTime: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(now),
        ...attrs,
        verdict,
        price: r.price,
      }, now)
      if (verdict === 'logged' && buy) {
        state = [...state, buy]
        const tag = `${buy.symbol} ${buy.setupType} @ ${buy.entryHigh} (grade ${buy.grade}, rvol ${buy.ctxRelVol?.toFixed(0) ?? '—'}×)`
        if (DRY_RUN) { sent++; log(`[dry-run] would alert ${tag}`) }
        else if (await sendAlert(buy)) { sent++; log(`ALERT ${tag}`) }

        // Submission outcome for the arbitration snapshot only. Declared here so it
        // is captured whether or not an executor is attached; the executor call and
        // its behaviour below are entirely unchanged.
        let submitted: boolean | null = null
        let blockReason: string | null = null

        if (executor) {
          try {
            // Session volume caps position size to something that could actually
            // fill — see sizing.ts. Premarket reports its own volume separately.
            const sessionVolume = r.integrity.session === 'premarket'
              ? r.premarketVolume ?? null
              : r.volume || null
            const res = await executor.onSignal(buy, { sessionVolume })
            if (!res.taken) log(`  paper: skipped ${buy.symbol} — ${res.reason}`)
            submitted = res.taken
            blockReason = res.taken ? null : (res.reason ?? null)
          } catch (e) {
            log(`  paper: executor failed on ${buy.symbol}:`, (e as Error).message)
            submitted = false
            blockReason = `executor_error: ${(e as Error).message}`
          }
          // H3A funnel: the handoff to the single execution authority (records the
          // outcome only; the submit call above is entirely unchanged).
          emitFunnel(sweepCtx, 'execution_handoff', {
            symbol: buy.symbol, strategyId: 'BASE', setupId: buy.setupId, setupType: buy.setupType,
            submitted, blockReason,
          }, now)
        }

        // Observational: record this eligible candidate + its submission outcome.
        // Pushed AFTER the (unchanged) submit call, preserving iteration order.
        eligibleCandidates.push({ ...attrs, verdict, submitted, blockReason })
      }
    }
  }

  // ── Write the per-sweep arbitration snapshot (OBSERVATIONAL) ───────────────
  // One record per sweep that had ≥1 Stage-1-eligible long. Written here, after the
  // loop, from passively accumulated data — it reorders/ranks/delays nothing.
  if (eligibleCandidates.length >= 1) {
    recordArbitration({
      ts: new Date(now).toISOString(),
      etTime: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(now),
      session: getSessionType(now),
      universeSize: universe.length,
      capacity: capacityAtSweepStart,
      eligibleCount: eligibleCandidates.length,
      submittedCount: eligibleCandidates.filter(c => c.submitted === true).length,
      capacityBlockedCount: eligibleCandidates.filter(c => c.submitted === false).length,
      candidates: eligibleCandidates,
    }, now)
    // H3A funnel: slim arbitration decision (references by setupId; no fat candidate
    // payloads — the legacy arbitration log above keeps the full detail).
    emitFunnel(sweepCtx, 'arbitration_decision', {
      session: getSessionType(now), universeSize: universe.length,
      eligibleCount: eligibleCandidates.length,
      submittedCount: eligibleCandidates.filter(c => c.submitted === true).length,
      capacityBlockedCount: eligibleCandidates.filter(c => c.submitted === false).length,
      eligibleSetupIds: eligibleCandidates.map(c => c.setupId ?? null),
    }, now)
  }
  // ── H4A.1: drain the best-effort observational tail (AFTER all BASE work) ───
  // BASE detection/arbitration/execution are already complete above. The observational fetch ran
  // concurrently on the shared plane; here we await it (bounded by the pass timeout — it resolves []
  // on slow/hung/failed provider work) and emit honest per-symbol coverage. Nothing here can change a
  // BASE result: this is strictly downstream of the BASE loop.
  if (refreshObservation) {
    try {
      const obsResults = await pass.observationResults          // best-effort: [] on timeout/failure
      lastObsRefreshAt = sweepStart                             // advance the cadence clock only on an issued refresh
      const obsBySymbol = new Map(obsResults.map(r => [r.symbol, r]))
      const prov = { runId: ensureFunnelRunId(sweepStart), leaderObservationConfigVersion: leaderObsCfg.version, leaderObservationConfigHash: leaderObsConfigHashV }
      for (const m of cohortSelected) {
        const r = obsBySymbol.get(m.symbol)
        const ls = r?.localStructure ?? null
        emitFunnel(sweepCtx, 'leader_observation_data', {
          symbol: m.symbol, leaderEpisodeId: m.leaderEpisodeId, role: m.role, lifecycleState: m.lifecycleState,
          cohortReason: m.reason, presentThisSweep: m.presentThisSweep,
          monitorResultAvailable: !!r,
          localStructureAvailable: !!ls,
          timeframe: ls?.provenance.timeframe ?? null,
          dataQualityStatus: ls?.status ?? (r ? 'NO_LOCAL_STRUCTURE' : 'MONITOR_UNAVAILABLE'),
          qualityFlags: ls?.qualityFlags ?? [],
          globalOffHighPct: ls?.global.offHighPct ?? null,
          dataAsOf: r?.integrity.marketDataTimestamp ?? null,
          barsFreshnessMs: r?.integrity.ageMs ?? null,
          delayed: r?.integrity.delayed ?? null,
          localFeatureConfigVersion: ls?.provenance.localFeatureConfigVersion ?? null,
          localFeatureConfigHash: ls?.provenance.localFeatureConfigHash ?? null,
          ...prov,
        }, sweepStart)
      }
    } catch (e) {
      log('leader-observation data telemetry failed (research only; sweep continues):', (e as Error).message)
    }
  }

  // Log on activity, or periodically so a quiet stretch is visibly alive (not hung).
  // A degraded-telemetry note rides the same lines so an operator sees observability loss
  // live (execution is unaffected; this is a research-integrity signal only).
  const telWarn = funnelDegraded() ? ` · ⚠ TELEMETRY DEGRADED (${funnelDroppedTotal()} funnel events dropped this run)` : ''
  if (triggered) log(`swept ${universe.length} names · ${triggered} triggers · ${sent} new alerts${telWarn}`)
  else if (now - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = now
    log(`· alive — watching ${universe.length} names (${universe.slice(0, 5).join(' ')}${universe.length > 5 ? '…' : ''}), no triggers${telWarn}`)
  }
  return state
}

async function buildExecutor(provenance: ProducerProvenance): Promise<PaperExecutor | null> {
  if (!PAPER_TRADE) return null
  const executor = new PaperExecutor(
    new AlpacaBroker(),
    fetchPrices,
    // Execution authority is REQUIRED (explicit): the process-exclusive lease at
    // authorityLockPath must be acquired before this daemon can submit any order. A second
    // paper daemon that finds the marker held fails closed below.
    // The bounded shutdown-settlement window is on by default in DEFAULT_EXECUTOR (safe by
    // default), so no explicit override is needed here.
    { ...DEFAULT_EXECUTOR, dryRun: DRY_RUN, provenance, authorityMode: 'required', authorityLockPath: authorityLockPath() },
    (...a: unknown[]) => log('paper:', ...a),
  )
  await executor.init()
  if (!executor.isExecutionAuthorized()) {
    const info = executor.deniedAuthorityInfo()
    log('FATAL: execution authority is held by another producer — refusing to start a second paper daemon.')
    if (info) {
      log(`  existing holder: pid=${info.pid} host=${info.hostname} started=${info.startedAtUtc}`)
      log(`  head=${info.producerHead} branch=${info.branch} mode=${info.mode}`)
    }
    log(`  If that producer is gone, reconcile broker exposure and remove ${authorityLockPath()} by hand before restarting.`)
    process.exit(1)
  }
  if (isHalted()) log(`NOTE: kill switch is engaged (${haltFile()} exists or HALT=1) — no new entries`)
  return executor
}

async function main() {
  log(`alert-daemon starting → ${BASE}${DRY_RUN ? ' [DRY_RUN]' : ''}${ONCE ? ' [ONCE]' : ''}${PAPER_TRADE ? ' [PAPER_TRADE]' : ''}`)
  log(`decisions → ${decisionsFile(etDayKey())} (rotates by ET day at append time)`)

  // PRODUCER PROVENANCE GUARD — runs BEFORE any execution authority is taken
  // (before buildExecutor → executor.init() reconciliation / order path). Fails
  // closed and exits non-zero on a dirty/unverifiable producer when paper trading,
  // unless ALLOW_DIRTY_PRODUCER=1. Records provenance for the init event.
  const provenance = enforceProducerProvenance({ requireAuthority: PAPER_TRADE, override: LAUNCH_ALLOW_DIRTY_PRODUCER, log })
  // H3A: stamp funnel telemetry with the same producer head the executor records.
  PRODUCER_HEAD = provenance.producerHead ?? null

  // H3C: recover observational leader state (research only; NEVER blocks execution). A corrupt/absent
  // file starts fresh and marks history INCOMPLETE — a restart must not pretend it knows a symbol's
  // earlier-in-day leadership.
  {
    leaderCfg = resolveLeaderConfig()
    leaderConfigHashV = leaderConfigHash(leaderCfg)
    // CRASH-AWARE recovery: only a clean-terminal checkpoint (SHUTDOWN/ONCE) with the same producer +
    // config is trusted complete; a PERIODIC checkpoint left by a crashed prior run is history-INCOMPLETE.
    const lr = loadLeaderState({ producerHead: PRODUCER_HEAD, configHash: leaderConfigHashV, log })
    leaderState = lr.records
    leaderHistoryComplete = lr.historyComplete
    leaderRecoveryStatus = lr.recoveryStatus
    // Acquire the single-writer lease (research only; a failure NEVER affects trading — we just don't persist).
    try {
      const lock = acquireLeaderWriterLock(
        { pid: process.pid, runId: ensureFunnelRunId(Date.now()), producerHead: PRODUCER_HEAD, startedAt: new Date().toISOString() }, log,
      )
      leaderWriterOwned = lock.acquired
      releaseLeaderLock = lock.release
    } catch (e) {
      leaderWriterOwned = false
      log('leader-state writer-lease error (research only; trading unaffected):', (e as Error).message)
    }
    const ctx0: SweepContext = { sweepId: newSweepId(), producerHead: PRODUCER_HEAD }
    const prov = { runId: ensureFunnelRunId(Date.now()), leaderConfigVersion: leaderCfg.ruleVersion, leaderConfigHash: leaderConfigHashV }
    const common = { recoveryStatus: lr.recoveryStatus, historyComplete: lr.historyComplete, recordCount: Object.keys(leaderState).length, writerOwned: leaderWriterOwned, ...prov }
    if (lr.degraded) emitFunnel(ctx0, 'leader_state_degraded', { reason: lr.reason, ...common })
    else emitFunnel(ctx0, 'leader_state_recovered', { loadedFromDisk: lr.loadedFromDisk, reason: lr.reason, producerHeadChanged: lr.producerHeadChanged, configChanged: lr.configChanged, savedReason: lr.savedReason, lastSweepId: lr.lastSweepId, ...common })
    // A secondary daemon (writer lease not owned) is a research-observability degradation — flag it loudly.
    if (!leaderWriterOwned) emitFunnel(ctx0, 'leader_state_degraded', { reason: 'writer_not_owned_secondary_daemon', ...common })
    log(`leader-state: ${lr.loadedFromDisk ? `recovered ${Object.keys(leaderState).length} records` : 'fresh'} [${lr.recoveryStatus}]${lr.historyComplete ? '' : ' (history INCOMPLETE)'}${leaderWriterOwned ? '' : ' (SECONDARY — not persisting leader state)'}`)
  }

  let executor: PaperExecutor | null = null
  try {
    executor = await buildExecutor(provenance)
  } catch (e) {
    // Missing/invalid Alpaca credentials must not silently degrade to alerts-only:
    // you'd spend a session believing you were paper trading when you weren't.
    log('FATAL: paper trading requested but the executor could not start:', (e as Error).message)
    process.exit(1)
  }

  // Passive observer — a SEPARATE, read-only lifecycle. It only runs with paper
  // trading (so there are positions to witness) and Alpaca creds, and only when
  // explicitly enabled. It never feeds back into any trading decision; a failure
  // here cannot crash, block, or delay the executor/alert path. Construction is
  // guarded so a missing feed simply means no observer, never a daemon failure.
  let observerLoop: ObserverLoop | null = null
  if (EXEC_OBSERVER && PAPER_TRADE && executor && !ONCE) {
    try {
      observerLoop = makeObserverLoop(executor, new AlpacaMarketData())
      log('execution-quality observer: ENABLED (passive, read-only)')
    } catch (e) {
      // No observer is a non-event — the trading path is entirely unaffected.
      log('execution-quality observer: disabled —', (e as Error).message)
      observerLoop = null
    }
  }

  // Exiting with shares outstanding leaves paper positions unmanaged and pollutes
  // the day's stats, so flatten on the way out rather than just dropping the loop.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`${signal} — shutting down`)
    observerLoop?.stop()   // clear its interval + abort in-flight reads before we exit
    // H3C: write a CLEAN-TERMINAL checkpoint (saveReason=SHUTDOWN) so the next start recovers COMPLETE,
    // then release the writer lease. Research only; best-effort; never blocks execution.
    try { persistLeaderState('SHUTDOWN', Date.now(), null); releaseLeaderLock() } catch { /* research persistence is best-effort */ }
    if (executor) {
      // Explicit ordered shutdown: cancel/settle pending entries, flatten open exposure,
      // reconcile, and release execution authority ONLY if the result is SAFE.
      const result = await executor.shutdown().catch(e => {
        log('shutdown failed:', (e as Error).message)
        return { safe: false, reason: 'shutdown threw' as string | null }
      })
      log('paper session summary:\n' + executor.summary())
      if (!result.safe) {
        // Terminal funnel certificate: this was still a GRACEFUL process shutdown, so the
        // funnel file is certifiable even though execution exposure was unresolved (that is
        // encoded separately in the paper summary + retained authority marker).
        emitSessionSummary(PRODUCER_HEAD)
        // Do NOT report a clean shutdown and do NOT exit 0: authority marker was retained.
        log(`EXIT 1 — ${result.reason ?? 'shutdown unresolved'}; execution authority marker retained for manual reconciliation`)
        process.exit(1)
      }
    }
    // Terminal funnel certificate — best-effort; if it can't be written the ABSENT marker
    // is itself the evidence the file is not certifiably complete. Never blocks the exit.
    emitSessionSummary(PRODUCER_HEAD)
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

  // Start the observer on its OWN cadence, independent of the sweep/position loops.
  observerLoop?.start()

  // Position loop — deliberately separate from the sweep so an exit never waits
  // behind a universe scan. Sequential by construction, so ticks can't overlap.
  // ONCE mode skips it: a single sweep has nothing to manage over time.
  if (executor && !ONCE) {
    void (async () => {
      while (!shuttingDown) {
        const session = getSessionType()
        if (session === 'overnight' || session === 'closed') { await sleep(IDLE_MS); continue }
        const holding = executor!.openTrades().length > 0
        if (holding) {
          try { await executor!.tick() } catch (e) { log('position tick failed:', (e as Error).message) }
        }
        await sleep(holding ? POSITION_MS : POSITION_IDLE_MS)
      }
    })()
  }

  let buys = loadBuys()
  while (true) {
    const session = getSessionType()
    if (session === 'overnight' || session === 'closed') {
      if (ONCE) { log('market closed — nothing to sweep'); try { releaseLeaderLock() } catch { /* best-effort */ } emitSessionSummary(PRODUCER_HEAD); return }
      await sleep(IDLE_MS); continue
    }
    try {
      buys = await sweep(buys, executor)
      if (!DRY_RUN) saveBuys(buys)
    } catch (e) {
      log('sweep error (is the dev server up?):', (e as Error).message)
    }
    if (ONCE) {
      if (executor) log('paper session summary:\n' + executor.summary())
      // A completed single-shot run is a CLEAN-TERMINAL checkpoint (saveReason=ONCE) — its history is complete.
      try { persistLeaderState('ONCE', Date.now(), null); releaseLeaderLock() } catch { /* research persistence is best-effort */ }
      emitSessionSummary(PRODUCER_HEAD)   // terminal funnel certificate for the ONCE run
      return
    }
    await sleep(SWEEP_MS)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
