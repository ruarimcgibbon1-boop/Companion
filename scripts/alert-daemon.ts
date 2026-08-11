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
import { isHalted, haltFile } from '@/lib/execution/store'

loadEnvLocal()   // ALPACA_* live here; the daemon has no Next runtime to load them

const BASE = process.env.COMPANION_URL || 'http://localhost:3000'
const DRY_RUN = process.env.DRY_RUN === '1'   // log alerts instead of sending them
const ONCE = process.env.ONCE === '1'         // run a single sweep then exit (testing)
const PAPER_TRADE = process.env.PAPER_TRADE === '1'
const SWEEP_MS = 15_000                 // active-session cadence (matches the client)
const IDLE_MS = 5 * 60_000              // slow poll when the market is closed
const MIN_LEVEL_STRENGTH = 40           // store default notificationSettings.minLevelStrength
const TOP_GAINERS_UNIVERSE = 15         // matches useMonitor.gatherUniverse
const STATE_FILE = join(homedir(), '.companion-alert-daemon.json')
// Every triggered setup + its verdict, appended as JSONL. This is the session
// audit trail: at end of day you can answer "did we miss X?" from data instead of
// memory — including the NEAR-MISSES (triggered but gated), which the terminal
// output never showed. One line per triggered setup per sweep-first-sighting.
const DECISION_LOG = join(homedir(), `.companion-decisions-${new Date().toISOString().slice(0, 10)}.jsonl`)

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
function recordDecision(row: Record<string, unknown>) {
  const key = `${row.setupId}:${row.verdict}`
  if (seenDecisions.has(key)) return
  seenDecisions.add(key)
  try { appendFileSync(DECISION_LOG, JSON.stringify(row) + '\n') } catch { /* audit trail is best-effort */ }
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
  // Manage open positions first: an exit that's already due shouldn't wait behind
  // a universe scan, and it frees a concurrency slot for anything new this sweep.
  if (executor) {
    try { await executor.tick() } catch (e) { log('executor tick failed:', (e as Error).message) }
  }

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
      })
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
  log(`decisions → ${DECISION_LOG}`)

  let executor: PaperExecutor | null = null
  try {
    executor = await buildExecutor()
  } catch (e) {
    // Missing/invalid Alpaca credentials must not silently degrade to alerts-only:
    // you'd spend a session believing you were paper trading when you weren't.
    log('FATAL: paper trading requested but the executor could not start:', (e as Error).message)
    process.exit(1)
  }

  // Exiting with shares outstanding leaves paper positions unmanaged and pollutes
  // the day's stats, so flatten on the way out rather than just dropping the loop.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`${signal} — shutting down`)
    if (executor) {
      await executor.flattenAll('risk_halt').catch(e => log('flatten failed:', (e as Error).message))
      log('paper session summary:\n' + executor.summary())
    }
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })

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
