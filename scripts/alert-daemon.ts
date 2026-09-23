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
import { classifyBuy, passesTrackingFloor, SYMBOL_LOG_WINDOW_MS } from '@/lib/buy-log'
import { getSessionType } from '@/lib/market-hours'
import { loadEnvLocal } from '@/lib/execution/env'
import { AlpacaBroker } from '@/lib/execution/alpaca'
import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { enforceProducerProvenance, overrideEnabled, type ProducerProvenance } from '@/lib/execution/provenance'
import { isHalted, haltFile, etDayKey, decisionsFile, arbitrationFile } from '@/lib/execution/store'
import { AlpacaMarketData } from '@/lib/execution/execution-quality'
import { makeObserverLoop } from '@/lib/execution/observer-wiring'
import type { ObserverLoop } from '@/lib/execution/observer-loop'
// QUALITY_ONLY_CONTINUATION — read-only shadow-observation research hook. See
// src/lib/experiments/quality-only/ for the full implementation. This import
// is the ONE addition to this file's dependency surface for that experiment;
// nothing here is imported BACK by BASE (setup-detectors.ts/buy-log.ts/
// monitor.ts), and nothing in this experiment touches the broker/executor.
import { observeQualityOnlyFromDecision, FreshnessTracker, JournalWriter, buildProvenance, resolvePendingCandidates, type ObserverContext } from '@/lib/experiments/quality-only'
// PROSPECTIVE_DISCOVERY_CAPTURE — read-only, additive capture of the causal
// path GAINERS ROUTE UNIVERSE -> DAEMON EXECUTION UNIVERSE -> MONITOR ->
// SETUP -> BASE DECISION. See src/lib/research/universe-journal.ts for the
// full module doc (the four-universes framing, what this cannot reconstruct,
// and why JournalWriter is reused via a structural cast). Wholly separate
// from QUALITY_ONLY: its own journal file, its own schema, never reads or
// writes QUALITY_ONLY_JOURNAL_FILE/QUALITY_ONLY_MARKER_FILE.
import {
  buildSweepRecords, attachSetupDecision, appendSweepBatch,
  type RouteUniverseRow, type SweepEnvelope, type SymbolRecord,
} from '@/lib/research/universe-journal'

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

// ── QUALITY_ONLY_CONTINUATION — read-only shadow-observation state ──────────
// Lives for the daemon process's lifetime, same posture as `seenDecisions`/
// `state` above. FreshnessTracker enforces "earliest valid observation wins"
// across sweeps; JournalWriter queues candidate/outcome rows and is drained on
// the daemon's existing graceful-shutdown path (see `shutdown` below). Never
// imported by BASE, never touches the broker/executor, never blocks/alters the
// real decision flow — see the try/catch wrapper at the call site in `sweep`.
const QUALITY_ONLY_JOURNAL_FILE = join(homedir(), '.companion-quality-only-journal.ndjson')
// Official collection-start marker path (host-local runtime research state,
// not a repository artifact — named here only so the convention is documented
// alongside the journal path above; nothing in this file creates it).
const QUALITY_ONLY_MARKER_FILE = join(homedir(), '.companion-quality-only', 'quality-only-epoch-1.collection-start.json')
const qualityOnlyFreshness = new FreshnessTracker()
const qualityOnlyWriter = new JournalWriter(QUALITY_ONLY_JOURNAL_FILE)

/**
 * Fires immediately after classifyBuy() produces its verdict, with the exact
 * setup/MonitorResult context already in scope — never recomputes verdict,
 * never mutates it, never feeds back into `state`/alerts/the executor.
 *
 * BAR AVAILABILITY (documented, not silently assumed): this daemon consumes
 * MonitorResult/DetectedSetup from the JSON `/api/monitor` response, which
 * carries no raw Candle[] — the sweep loop has no 1m bar array in scope, and
 * fetching one here would be an incremental provider request (explicitly
 * disallowed). Candles are therefore passed as `[]`:
 *   - gate reconstruction stays correct under this branch's live defaults —
 *     RUNUP needs MAX_LEG_RUNUP_PCT=Infinity (legRunUpPct's result can never
 *     exceed it, candles or not) and the unconfirmed/green-streak check is
 *     short-circuited by MIN_GREEN_STREAK=0 — so an empty candle array changes
 *     no gate outcome under the defaults recorded in this experiment's spec
 *     (see src/lib/experiments/quality-only/spec.ts). SPACE/OFF_HIGH/GRADE_FLOOR
 *     need no candles at all (levels/technicals/grade are already in `r`/`setup`).
 *   - outcome resolution CANNOT happen HERE, at candidate-creation time: MFE/MAE
 *     requires bars AFTER the candidate's observation instant, which do not
 *     exist yet at this point in a real sweep. `outcomeCandles` is intentionally
 *     omitted, so `observeQualityOnlyFromDecision` defers outcome to `null`
 *     (pending) rather than fabricating one — see outcome.ts's causal-bars
 *     convention. Resolution DOES now happen on a LATER pass: a passive bar
 *     mirror (src/lib/research/bar-journal.ts) captures the same 1m bars
 *     monitor.ts's own `/api/monitor` requests already fetch (zero incremental
 *     provider requests), and the pending-candidate resolver
 *     (src/lib/experiments/quality-only/resolver.ts) is invoked once per sweep
 *     below to read that mirror and causally resolve PENDING candidates into
 *     SCORABLE/CENSORED/DEGRADED — see the resolver invocation later in this
 *     sweep() function.
 */
function runQualityOnlyObserver(setup: DetectedSetup, r: MonitorResult, verdict: string, now: number, state: BuySignalRecord[]): void {
  try {
    const ctx: ObserverContext = {
      now,
      minLevelStrength: MIN_LEVEL_STRENGTH,
      priorBuys: state,
      priorLogs: [],
      priorStates: [],
      everLoggedForSetupId: (setupId: string) => state.some(b => b.setupId === setupId),
      // Descriptive-only field (sameSymbolMeta), never gates eligibility — a
      // fixed 24h lookback is a safe, honest approximation without an ET
      // midnight calculator in this file.
      dayStartMs: now - 24 * 60 * 60 * 1000,
      candles: [],
      freshness: qualityOnlyFreshness,
    }
    const result = observeQualityOnlyFromDecision(setup, r, verdict, ctx)
    if (!result || !result.candidate) return
    const prov = buildProvenance()
    qualityOnlyWriter.enqueue({
      kind: 'candidate', identity: result.candidate.identity, payload: result.candidate,
      provenance: prov, preOfficial: true, // no collection-start marker exists anywhere in this task
    })
    if (result.outcome) {
      qualityOnlyWriter.enqueue({
        kind: 'outcome', identity: result.candidate.identity, payload: result.outcome,
        provenance: prov, preOfficial: true,
      })
    }
  } catch (e) {
    // Research-only failure — must never compromise BASE's alerting/decision
    // flow. Caught here AND inside observeQualityOnlyFromDecision itself
    // (belt-and-suspenders per the task's exception-isolation requirement).
    try { log('[quality-only] observer error (swallowed):', (e as Error)?.message ?? e) } catch { /* logging must never throw upward */ }
  }
}

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
 * PROSPECTIVE_DISCOVERY_CAPTURE — this is a return-type WIDENING, not a new
 * fetch. `/api/gainers`'s JSON body already carries `rank` (the route's own
 * momentum-ranked position), `momentumScore` (its sort metric), `changePct`,
 * `price`, `volume`, and `relativeVolume` on every row; this function used to
 * discard everything but `symbol`. It now also returns `routeRows` (every
 * row the route returned, before this daemon's own re-sort/truncation) and
 * `routeComputedAt` (the route's own `timestamp` field), so the capture
 * observer in `sweep()` can record both what the route returned AND what
 * this daemon's rerank/truncation kept vs dropped. The one existing caller
 * (`sweep()`) is updated to pull `.symbols` where it only ever needed the
 * plain string list — daemon behavior (which symbols get watched/alerted) is
 * byte-for-byte unchanged.
 */
interface FetchUniverseResult {
  /** Unchanged behavior: the daemon's own re-sort by raw changePct,
   *  truncated to TOP_GAINERS_UNIVERSE — this is what `sweep()` watches. */
  symbols: string[]
  /** Every row the route returned this sweep, reduced to discovery-relevant
   *  fields — see RouteUniverseRow's doc for the exact field provenance. */
  routeRows: RouteUniverseRow[]
  routeComputedAt: number | null
}

async function fetchUniverse(): Promise<FetchUniverseResult> {
  const params = new URLSearchParams({
    minChangePct: '3', minPrice: '0.1', maxPrice: '300', minVolume: '500000', minRvol: '1.5', maxResults: '30',
  })
  const res = await fetch(`${BASE}/api/gainers?${params}`)
  if (!res.ok) throw new Error(`gainers HTTP ${res.status}`)
  const data = await res.json() as {
    rows?: {
      symbol: string; changePct: number; rank?: number; momentumScore?: number | null
      price?: number; volume?: number; relativeVolume?: number | null
    }[]
    timestamp?: number
  }
  const rawRows = data.rows ?? []
  const routeRows: RouteUniverseRow[] = rawRows.map(r => ({
    symbol: r.symbol,
    routeRank: typeof r.rank === 'number' ? r.rank : null,
    routeMomentumScore: typeof r.momentumScore === 'number' ? r.momentumScore : null,
    changePct: typeof r.changePct === 'number' ? r.changePct : null,
    price: typeof r.price === 'number' ? r.price : null,
    volume: typeof r.volume === 'number' ? r.volume : null,
    relativeVolume: typeof r.relativeVolume === 'number' ? r.relativeVolume : null,
  }))
  // UNCHANGED behavior: re-sort by raw changePct, truncate to top-15. See
  // universe-journal.ts's DAEMON_SORT_METRIC doc for the observed tie-break
  // (none explicit — stable-sort artifact only). Nulls sort last (a route
  // row should always have a numeric changePct in practice; `?? -Infinity`
  // is defensive, not a behavior change).
  const symbols = rawRows
    .slice().sort((a, b) => b.changePct - a.changePct)
    .slice(0, TOP_GAINERS_UNIVERSE).map(r => r.symbol)
  return {
    symbols,
    routeRows,
    routeComputedAt: typeof data.timestamp === 'number' ? data.timestamp : null,
  }
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
  const universeResult = await fetchUniverse()
  const universe = universeResult.symbols
  if (universe.length === 0) return buys
  const results = await fetchResults(universe)

  const now = Date.now()

  // ── PROSPECTIVE_DISCOVERY_CAPTURE — build this sweep's records ────────────
  // Right here: route rows, daemon-universe membership, and monitor results
  // all coexist in scope, exactly as required. Read-only/additive: builds a
  // local map this function owns; never touches `state`/BASE. Wrapped in
  // try/catch so a bug here can never affect alerting/execution.
  let captureEnvelope: SweepEnvelope | null = null
  let captureRecords: Map<string, SymbolRecord> | null = null
  try {
    const built = buildSweepRecords({
      now,
      sweepId: `sweep-${now}`,
      routeComputedAt: universeResult.routeComputedAt,
      routeRows: universeResult.routeRows,
      daemonSymbols: universe,
      daemonTopN: TOP_GAINERS_UNIVERSE,
      monitorRequestedSymbols: universe,
      monitorResultSymbols: results.map(r => r.symbol),
    })
    captureEnvelope = built.envelope
    captureRecords = built.recordsBySymbol
  } catch (e) {
    try { log('[universe-capture] build error (swallowed):', (e as Error)?.message ?? e) } catch { /* never throw */ }
  }
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
      // QUALITY_ONLY_CONTINUATION — read-only research observer, wired in
      // immediately after the verdict is produced and before it is used for
      // anything else. Exception-safe (never throws into this loop); never
      // alters `verdict`/`buy`/`setup`/`r`, never places orders, never touches
      // the executor/Mike/provider requests. See runQualityOnlyObserver's doc
      // comment for the bar-availability honesty statement.
      try { runQualityOnlyObserver(setup, r, verdict, now, state) } catch { /* never propagate into BASE */ }
      // PROSPECTIVE_DISCOVERY_CAPTURE — attach SETUP/BASE facts to the
      // already-built record for this symbol. Read-only projection of the
      // verdict already computed above; never recomputes or alters it.
      try {
        const rec = captureRecords?.get(setup.symbol)
        if (rec) attachSetupDecision(rec, setup.id, verdict)
      } catch { /* never propagate into BASE */ }
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
  }
  // Log on activity, or periodically so a quiet stretch is visibly alive (not hung).
  if (triggered) log(`swept ${universe.length} names · ${triggered} triggers · ${sent} new alerts`)
  else if (now - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = now
    log(`· alive — watching ${universe.length} names (${universe.slice(0, 5).join(' ')}${universe.length > 5 ? '…' : ''}), no triggers`)
  }

  // QUALITY_ONLY_CONTINUATION — pending-outcome resolver. Runs once per sweep
  // (the daemon's existing cadence; no new process/timer). Reads ONLY local
  // files (the candidate journal + the passive research bar journal monitor.ts
  // mirrors into) — zero provider requests. Exception-isolated: a resolver bug
  // can never affect BASE's alerting/executor flow above, which has already
  // fully completed by this point in the sweep.
  try {
    const res = resolvePendingCandidates(QUALITY_ONLY_JOURNAL_FILE, now)
    if (res.resolved > 0) {
      log(`quality-only: resolved ${res.resolved} pending candidate(s) — scorable=${res.scorable} censored=${res.censored} degraded=${res.degraded} (still pending=${res.stillPending})`)
    }
  } catch (e) {
    log('quality-only: resolver error (swallowed):', (e as Error)?.message ?? e)
  }

  // ── PROSPECTIVE_DISCOVERY_CAPTURE — one batched flush per sweep ───────────
  // Everything for this sweep (envelope + every symbol record, SETUP/BASE
  // fields now attached where applicable) is written in ONE call here,
  // rather than as two separate incomplete writes at two different points
  // in this function. Wrapped in try/catch: a flush failure is research-only
  // and must never affect the already-completed alerting/execution flow above.
  try {
    if (captureEnvelope && captureRecords) {
      appendSweepBatch(captureEnvelope, [...captureRecords.values()])
    }
  } catch (e) {
    try { log('[universe-capture] flush error (swallowed):', (e as Error)?.message ?? e) } catch { /* never throw */ }
  }

  return state
}

async function buildExecutor(provenance: ProducerProvenance): Promise<PaperExecutor | null> {
  if (!PAPER_TRADE) return null
  const executor = new PaperExecutor(
    new AlpacaBroker(),
    fetchPrices,
    { ...DEFAULT_EXECUTOR, dryRun: DRY_RUN, provenance },
    (...a: unknown[]) => log('paper:', ...a),
  )
  await executor.init()
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

    // SHUTDOWN PRIORITY (execution safety before research completeness):
    //   1. stop new daemon work (observerLoop.stop(), above)
    //   2. execution cancel/flatten/settlement — executor.flattenAll(...)
    //   3. execution summary
    //   4. QUALITY_ONLY research drain (bounded — see below)
    //   5. process exit
    // Real position-flattening/settlement must NEVER be delayed or blocked by
    // a research-only write. It used to run AFTER the research drain, which
    // was backwards (a stuck/slow research write could have held up flatten);
    // it is now unconditionally first.
    if (executor) {
      await executor.flattenAll('risk_halt').catch(e => log('flatten failed:', (e as Error).message))
      log('paper session summary:\n' + executor.summary())
    }

    // QUALITY_ONLY_CONTINUATION drain — now happens AFTER execution settlement
    // is complete. Exception-safe AND time-bounded: a slow/stuck disk write
    // here must never hang process exit indefinitely. 2s is generous for the
    // low-frequency, small (single JSON line) writes this queue holds; a
    // timeout leaves any remainder un-flushed rather than blocking exit —
    // research completeness is best-effort, execution settlement above is not.
    try {
      const { drained, timedOut } = qualityOnlyWriter.shutdown(2_000)
      if (drained > 0) log(`quality-only: drained ${drained} queued research write(s)`)
      if (timedOut) log('quality-only: drain hit its time budget — remaining writes left queued (non-fatal)')
    } catch (e) {
      log('quality-only: drain failed (non-fatal):', (e as Error)?.message ?? e)
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

// Guarded so tests/quality-only-daemon-integration.test.ts can import this
// module's exported QUALITY_ONLY hook (runQualityOnlyObserver) without
// starting the real daemon loop (network fetches, SIGINT/SIGTERM handlers,
// etc.). Vitest sets VITEST=true in its worker env; a real launch
// (`npx tsx scripts/alert-daemon.ts`) never has it set, so behavior for an
// actual run is byte-for-byte unchanged.
if (process.env.VITEST !== 'true') {
  main().catch(e => { console.error(e); process.exit(1) })
}

// Exported for tests/quality-only-daemon-integration.test.ts — the ACTUAL
// daemon-side hook, not a re-implementation. Exporting an existing internal
// function for test visibility does not change daemon behavior.
export { runQualityOnlyObserver, qualityOnlyWriter, qualityOnlyFreshness, QUALITY_ONLY_MARKER_FILE }
