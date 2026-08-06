/**
 * Headless alert daemon — fires Telegram buy alerts WITHOUT a browser open.
 *
 * The scanner sweep normally runs client-side (useMonitor), so alerts only fire
 * while Companion is open in a tab. This daemon runs that sweep as a standalone
 * process: it reuses the existing routes over HTTP (so all data logic stays in
 * one place) and the shared gate stack (src/lib/buy-log.ts, the same one the
 * client uses), then posts each new BUY to /api/telegram. The route dedups on the
 * stable setup id, so the daemon and any open browser tab never double-text.
 *
 * Prereqs: the Next dev server running (`npm run dev`) + Telegram configured in
 * .env.local. Run:  npx tsx scripts/alert-daemon.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { MonitorResult, BuySignalRecord, DetectedSetup } from '@/types'
import { classifyBuy, passesTrackingFloor, SYMBOL_LOG_WINDOW_MS } from '@/lib/buy-log'
import { getSessionType } from '@/lib/market-hours'

const BASE = process.env.COMPANION_URL || 'http://localhost:3000'
const DRY_RUN = process.env.DRY_RUN === '1'   // log alerts instead of sending them
const ONCE = process.env.ONCE === '1'         // run a single sweep then exit (testing)
const SWEEP_MS = 15_000                 // active-session cadence (matches the client)
const IDLE_MS = 5 * 60_000              // slow poll when the market is closed
const MIN_LEVEL_STRENGTH = 40           // store default notificationSettings.minLevelStrength
const TOP_GAINERS_UNIVERSE = 15         // matches useMonitor.gatherUniverse
const STATE_FILE = join(homedir(), '.companion-alert-daemon.json')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

// Persisted buy history (dedup + per-symbol cap survive a daemon restart).
function loadBuys(): BuySignalRecord[] {
  try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : [] } catch { return [] }
}
function saveBuys(buys: BuySignalRecord[]) {
  try { writeFileSync(STATE_FILE, JSON.stringify(buys)) } catch (e) { log('state save failed:', (e as Error).message) }
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

async function sweep(buys: BuySignalRecord[]): Promise<BuySignalRecord[]> {
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
      // bounce stand-down no-op on empty logs/states; overLogged + dedup + the
      // strong-continuation override still apply, which is the alerting core.
      const { verdict, buy } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })
      if (verdict === 'logged' && buy) {
        state = [...state, buy]
        const tag = `${buy.symbol} ${buy.setupType} @ ${buy.entryHigh} (grade ${buy.grade}, rvol ${buy.ctxRelVol?.toFixed(0) ?? '—'}×)`
        if (DRY_RUN) { sent++; log(`[dry-run] would alert ${tag}`) }
        else if (await sendAlert(buy)) { sent++; log(`ALERT ${tag}`) }
      }
    }
  }
  if (triggered) log(`swept ${universe.length} names · ${triggered} triggers · ${sent} new alerts`)
  return state
}

async function main() {
  log(`alert-daemon starting → ${BASE}${DRY_RUN ? ' [DRY_RUN]' : ''}${ONCE ? ' [ONCE]' : ''} (state: ${STATE_FILE})`)
  let buys = loadBuys()
  while (true) {
    const session = getSessionType()
    if (session === 'overnight' || session === 'closed') {
      if (ONCE) { log('market closed — nothing to sweep'); return }
      await sleep(IDLE_MS); continue
    }
    try {
      buys = await sweep(buys)
      if (!DRY_RUN) saveBuys(buys)
    } catch (e) {
      log('sweep error (is the dev server up?):', (e as Error).message)
    }
    if (ONCE) return
    await sleep(SWEEP_MS)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
