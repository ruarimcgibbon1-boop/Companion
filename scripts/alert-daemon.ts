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
import { isHalted, haltFile, etDayKey, decisionsFile } from '@/lib/execution/store'
import { AlpacaMarketData } from '@/lib/execution/execution-quality'
import { makeObserverLoop } from '@/lib/execution/observer-wiring'
import type { ObserverLoop } from '@/lib/execution/observer-loop'

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

async function fetchUniverse(): Promise<string[]> {
  const params = new URLSearchParams({
    minChangePct: '3', minPrice: '0.1', maxPrice: '300', minVolume: '500000', minRvol: '1.5', maxResults: '30',
  })
  const res = await fetch(`${BASE}/api/gainers?${params}`)
  if (!res.ok) throw new Error(`gainers HTTP ${res.status}`)
  const data = await res.json() as { rows?: { symbol: string; changePct: number }[] }
  return (data.rows ?? [])
    .slice().sort((a, b) => b.changePct - a.changePct)
    .slice(0, TOP_GAINERS_UNIVERSE).map(r => r.symbol)
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
  const universe = await fetchUniverse()
  if (universe.length === 0) return buys
  const results = await fetchResults(universe)

  const now = Date.now()
  // Prune history to the session window so cap/dedup stay bounded.
  let state = buys.filter(b => now - b.timestamp < SYMBOL_LOG_WINDOW_MS)
  let triggered = 0, sent = 0

  for (const r of results) {
    for (const setup of r.setups as DetectedSetup[]) {
      if (!(setup.direction === 'long' && setup.triggeredRaw)) continue
      if (!passesTrackingFloor(setup, MIN_LEVEL_STRENGTH)) continue
      triggered++
      // Daemon tracks buys only (no full log/state machine) — the win/loss cap and
      // bounce stand-down no-op on empty logs/states; dedup + the
      // strong-continuation override still apply, which is the alerting core.
      const { verdict, buy } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })
      // Audit trail: every trigger + verdict, so end-of-session "did we miss X?"
      // is answerable from data — near-misses included.
      recordDecision({
        ts: new Date(now).toISOString(),
        etTime: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(now),
        symbol: setup.symbol, setupId: setup.id, setupType: setup.type,
        grade: setup.grade, score: setup.score, verdict,
        fill: setup.entryFill ?? setup.zoneUpper,
        rvol: r.relativeVolume, offHighPct: r.technicals?.distanceFromDayHighPct ?? null,
        session: r.integrity.session, price: r.price,
        // Additive signal-time geometry for the Shadow Journal (src/lib/research/shadow-journal.ts).
        // Logging only — every field is already known at detection; nothing here changes a decision.
        stop: setup.stopReference, targets: setup.targets.map(t => t.price), entryRef: setup.entryFill ?? setup.zoneUpper,
      }, now)
      if (verdict === 'logged' && buy) {
        state = [...state, buy]
        const tag = `${buy.symbol} ${buy.setupType} @ ${buy.entryHigh} (grade ${buy.grade}, rvol ${buy.ctxRelVol?.toFixed(0) ?? '—'}×)`
        if (DRY_RUN) { sent++; log(`[dry-run] would alert ${tag}`) }
        else if (await sendAlert(buy)) { sent++; log(`ALERT ${tag}`) }

        if (executor) {
          try {
            // Session volume caps position size to something that could actually
            // fill — see sizing.ts. Premarket reports its own volume separately.
            const sessionVolume = r.integrity.session === 'premarket'
              ? r.premarketVolume ?? null
              : r.volume || null
            const res = await executor.onSignal(buy, { sessionVolume })
            if (!res.taken) log(`  paper: skipped ${buy.symbol} — ${res.reason}`)
          } catch (e) {
            log(`  paper: executor failed on ${buy.symbol}:`, (e as Error).message)
          }
        }
      }
    }
  }
  // Log on activity, or periodically so a quiet stretch is visibly alive (not hung).
  if (triggered) log(`swept ${universe.length} names · ${triggered} triggers · ${sent} new alerts`)
  else if (now - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = now
    log(`· alive — watching ${universe.length} names (${universe.slice(0, 5).join(' ')}${universe.length > 5 ? '…' : ''}), no triggers`)
  }
  return state
}

async function buildExecutor(): Promise<PaperExecutor | null> {
  if (!PAPER_TRADE) return null
  const executor = new PaperExecutor(
    new AlpacaBroker(),
    fetchPrices,
    { ...DEFAULT_EXECUTOR, dryRun: DRY_RUN },
    (...a: unknown[]) => log('paper:', ...a),
  )
  await executor.init()
  if (isHalted()) log(`NOTE: kill switch is engaged (${haltFile()} exists or HALT=1) — no new entries`)
  return executor
}

async function main() {
  log(`alert-daemon starting → ${BASE}${DRY_RUN ? ' [DRY_RUN]' : ''}${ONCE ? ' [ONCE]' : ''}${PAPER_TRADE ? ' [PAPER_TRADE]' : ''}`)
  log(`decisions → ${decisionsFile(etDayKey())} (rotates by ET day at append time)`)

  let executor: PaperExecutor | null = null
  try {
    executor = await buildExecutor()
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
      await executor.flattenAll('risk_halt').catch(e => log('flatten failed:', (e as Error).message))
      log('paper session summary:\n' + executor.summary())
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
