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
import { classifyBuy, decomposeGates, passesTrackingFloor, SYMBOL_LOG_WINDOW_MS } from '@/lib/buy-log'
import { getSessionType } from '@/lib/market-hours'
import { loadEnvLocal } from '@/lib/execution/env'
import { AlpacaBroker } from '@/lib/execution/alpaca'
import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { enforceProducerProvenance, overrideEnabled, type ProducerProvenance } from '@/lib/execution/provenance'
import { authorityLockPath } from '@/lib/execution/authority'
import { isHalted, haltFile, etDayKey, decisionsFile, arbitrationFile } from '@/lib/execution/store'
import { emitFunnel, newSweepId, funnelDegraded, funnelDroppedTotal, type SweepContext } from '@/lib/telemetry/funnel'
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

/** One ranked row as the gainers route returns it — used ONLY for telemetry. */
interface RankedRow {
  symbol: string
  changePct: number
  rank?: number
  momentumScore?: number | null
  offHighPct?: number | null
  rocPct?: number | null
  relativeVolume?: number | null
  volume?: number
  float?: number | null
  premarketVolume?: number | null
}
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
async function fetchUniverse(ctx?: SweepContext): Promise<{ symbols: string[]; rankedRows: RankedRow[] }> {
  const params = new URLSearchParams({
    minChangePct: '3', minPrice: '0.1', maxPrice: '300', minVolume: '500000', minRvol: '1.5', maxResults: '30',
  })
  if (ctx) {
    params.set('sweepId', ctx.sweepId)
    if (ctx.producerHead) params.set('producerHead', ctx.producerHead)
  }
  const res = await fetch(`${BASE}/api/gainers?${params}`)
  if (!res.ok) throw new Error(`gainers HTTP ${res.status}`)
  const data = await res.json() as { rows?: RankedRow[] }
  const rankedRows = data.rows ?? []
  const symbols = rankedRows
    .slice().sort((a, b) => b.changePct - a.changePct)
    .slice(0, TOP_GAINERS_UNIVERSE).map(r => r.symbol)
  return { symbols, rankedRows }
}

async function fetchResults(symbols: string[]): Promise<MonitorResult[]> {
  const res = await fetch(`${BASE}/api/monitor`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols }),
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
  const { symbols: universe, rankedRows } = await fetchUniverse(sweepCtx)
  // Funnel telemetry: sweep + monitored-universe decisions (best-effort; selection
  // is exactly `universe`, computed identically to before this instrumentation).
  const monitoredSet = new Set(universe)
  emitFunnel(sweepCtx, 'sweep_started', {
    session: getSessionType(sweepStart), universeSize: universe.length, poolSize: rankedRows.length,
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
  if (universe.length === 0) return buys
  const results = await fetchResults(universe)

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
      if (!passesTrackingFloor(setup, MIN_LEVEL_STRENGTH)) continue
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
    if (executor) {
      // Explicit ordered shutdown: cancel/settle pending entries, flatten open exposure,
      // reconcile, and release execution authority ONLY if the result is SAFE.
      const result = await executor.shutdown().catch(e => {
        log('shutdown failed:', (e as Error).message)
        return { safe: false, reason: 'shutdown threw' as string | null }
      })
      log('paper session summary:\n' + executor.summary())
      if (!result.safe) {
        // Do NOT report a clean shutdown and do NOT exit 0: authority marker was retained.
        log(`EXIT 1 — ${result.reason ?? 'shutdown unresolved'}; execution authority marker retained for manual reconciliation`)
        process.exit(1)
      }
    }
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
      if (ONCE) { log('market closed — nothing to sweep'); return }
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
      return
    }
    await sleep(SWEEP_MS)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
