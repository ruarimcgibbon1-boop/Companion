/**
 * FMP historical replay backtest — reruns the CURRENT decision logic over a past
 * week's tape and reports what it would have signalled and how those signals paid.
 *
 * It imports the real pipeline (detectSetups, calculateTechnical/SessionLevels,
 * buildKeyLevels, premarketVolumeProfile, scaledPnl/resolveLogAgainstCandles) and
 * replicates the useMonitor buy-log gate stack, walking each day bar-by-bar with a
 * simulated clock (the nowTs params threaded into the builders).
 *
 * Fidelity caveats (see the report footer):
 *  - Universe is RECONSTRUCTED: FMP has no historical top-gainers snapshot, so the
 *    candidate pool is the union of every symbol the live scanner has surfaced (all
 *    exported buy-signal CSVs) plus each day's actual CSV names, ranked per day by
 *    FMP daily (intraday-high vs prior close). Names never once surfaced live can't
 *    appear. This is the main limitation and it hits exactly the rocket/fade names.
 *  - No live news feed → catalystScore 0 (the in-play gate still has RVOL/gap/float).
 *  - 5-min bar granularity (live sweeps at 15s); detectors are close-based so this
 *    aligns, but an intrabar break/stop between 5-min closes is only seen at the close.
 *  - Stand-down (failed-bounce) is approximated from logged-entry outcomes.
 *
 * Run:  node node_modules/tsx/dist/cli.mjs scripts/backtest.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { Candle, SetupLog, DetectedSetup, SetupType } from '@/types'
import { calculateSessionLevels, calculateTechnical } from '@/lib/technical'
import { buildKeyLevels } from '@/lib/levels-engine'
import { detectSetups, type DetectionContext } from '@/lib/setup-detectors'
import { premarketVolumeProfile } from '@/lib/premarket-volume'
import { getSessionType, minutesSinceOpen } from '@/lib/market-hours'
import { scaledPnl, resolveLogAgainstCandles, slippageForSession } from '@/lib/eod-resolver'

// ── Config ───────────────────────────────────────────────────────────────────

const DAYS = [
  '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10',
  '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
  '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24',
  '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31',
]
const TOP_GAINERS_UNIVERSE = 15          // matches useMonitor gatherUniverse
const MIN_SCORE_FLOOR = 55               // useMonitor display floor
const MIN_LEVEL_STRENGTH = 40            // store default notificationSettings.minLevelStrength
// Buy-log gate constants (mirrored from useMonitor.ts)
const MIN_BUY_VOLUME = 100_000
const MIN_PREMARKET_BUY_VOLUME = 50_000
const GRADE_FLOOR_EXEMPT = new Set<SetupType>(['opening_drive'])  // PMB dropped 2026-08-05; momentum_pullback exemption tested + reverted (flooded losers)
const LATE_LOG_CUTOFF_HHMM = 1400  // no new regular-hours BUYs at/after 14:00 ET
const MAX_LOGS_PER_SYMBOL = 2
const SYMBOL_LOG_WINDOW_MS = 12 * 60 * 60 * 1000
const ENTRY_SIMILARITY_PCT = 0.03
const BUY_DEDUP_COOLDOWN_MS = 45 * 60 * 1000
const STANDDOWN_MS = 120 * 60 * 1000
const SYMBOL_CAP_MS = 120 * 60 * 1000
const SYMBOL_WIN_CAP = 2
const BOUNCE_TYPES = new Set<SetupType>(['pullback', 'vwap_bounce', 'vwap_reclaim', 'ema9_bounce', 'ema21_bounce'])

const SCRATCH = process.env.SCRATCH_DIR ||
  '/private/tmp/claude-501/-Users-elonmusk-Companion/e73f584c-b4b9-412c-a4d7-ccaf1e47b222/scratchpad'
const CACHE_DIR = join(SCRATCH, 'fmp-cache')
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })

const REPO = process.cwd()
const DOWNLOADS = join(homedir(), 'Downloads')

// ── FMP fetch layer (disk-cached) ─────────────────────────────────────────────

function apiKey(): string {
  const env = readFileSync(join(REPO, '.env.local'), 'utf8')
  const m = env.match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/)
  if (!m) throw new Error('FMP_API_KEY not found in .env.local')
  return m[1]
}
const KEY = apiKey()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function cachedGet(cacheName: string, url: string): Promise<any> {
  const f = join(CACHE_DIR, cacheName + '.json')
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  let lastErr = ''
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const json = await res.json()
      writeFileSync(f, JSON.stringify(json))
      return json
    }
    lastErr = `HTTP ${res.status}`
    // 429 (rate limit) / 5xx → back off and retry; anything else is fatal.
    if (res.status !== 429 && res.status < 500) break
    await sleep(1500 * (attempt + 1))
  }
  throw new Error(`FMP ${cacheName} → ${lastErr}`)
}

interface RawRow { date: string; open: number; high: number; low: number; close: number; volume: number }

async function fetchDaily(symbol: string): Promise<RawRow[]> {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${symbol}&from=2026-05-01&to=2026-07-31&apikey=${KEY}`
  const j = await cachedGet(`daily_${symbol}`, url)
  const arr: RawRow[] = Array.isArray(j) ? j : (j?.historical ?? [])
  return arr.slice().sort((a, b) => a.date.localeCompare(b.date))
}

// Extended 5-min tape ending at the replay day. FMP's 5-min endpoint caps each
// response to ~10 recent days from `to` REGARDLESS of `from`, so a wide window
// silently returns only the last ~10 days — the `to` must be anchored at the day.
// 14 calendar days back yields the walk window (day-2..day) + ~8-10 prior sessions
// for the premarket-volume baseline. Cache key includes the day.
async function fetch5minForDay(symbol: string, day: string): Promise<RawRow[]> {
  const fromDay = etDayKey(etStrToUnixSec(day) - 14 * 86400)
  const url = `https://financialmodelingprep.com/stable/historical-chart/5min?symbol=${symbol}&from=${fromDay}&to=${day}&extended=true&apikey=${KEY}`
  const j = await cachedGet(`m5_${symbol}_${day}`, url)
  const arr: RawRow[] = Array.isArray(j) ? j : []
  return arr.slice().sort((a, b) => a.date.localeCompare(b.date))
}

async function fetchFloat(symbol: string): Promise<number | null> {
  try {
    const url = `https://financialmodelingprep.com/stable/shares-float?symbol=${symbol}&apikey=${KEY}`
    const j = await cachedGet(`float_${symbol}`, url)
    const v = Array.isArray(j) ? j[0]?.floatShares ?? null : null
    return v != null && v >= 10_000 ? v : null
  } catch { return null }
}

// ── Time parsing (FMP intraday strings are ET wall-time; July 2026 = EDT -04:00) ─

function etStrToUnixSec(dateStr: string): number {
  // "2026-07-31 09:30:00" → treat as America/New_York (EDT, -04:00 for all of July)
  const iso = dateStr.length <= 10 ? `${dateStr}T00:00:00-04:00` : `${dateStr.replace(' ', 'T')}-04:00`
  return Math.floor(Date.parse(iso) / 1000)
}
function etDayKey(unixSec: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(unixSec * 1000))
}
function etHHMM(unixMs: number): number {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(unixMs))
  const [h, m] = s.split(':').map(Number)
  return h * 100 + m
}

function toCandles(rows: RawRow[]): Candle[] {
  return rows.map(r => ({
    time: etStrToUnixSec(r.date),
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0,
  })).sort((a, b) => a.time - b.time)
}

// ── Candidate pool (union of all exported buy-signal CSV symbols) ──────────────
// Prefer the live CSV export dir; when the OS sandbox blocks it (background runs
// can't read ~/Downloads), fall back to the daily-candle cache, whose filenames
// ARE the pool (one daily_<SYM>.json per symbol the scanner has surfaced).

function poolFromDownloads(): string[] {
  const set = new Set<string>()
  for (const f of readdirSync(DOWNLOADS)) {
    if (!/^buy-signals-2026-.*\.csv$/.test(f)) continue
    for (const ln of readFileSync(join(DOWNLOADS, f), 'utf8').split('\n').slice(1)) {
      const sym = ln.split(',')[1]?.trim()
      if (sym && /^[A-Z]{1,6}$/.test(sym)) set.add(sym)
    }
  }
  return [...set]
}
function poolFromCache(): string[] {
  const set = new Set<string>()
  for (const f of readdirSync(CACHE_DIR)) {
    const m = f.match(/^daily_([A-Z]{1,6})\.json$/)
    if (m) set.add(m[1])
  }
  return [...set]
}
function poolSymbols(): string[] {
  try { const p = poolFromDownloads(); if (p.length) return p } catch { /* sandbox */ }
  return poolFromCache()
}

function csvSymbolsForDay(day: string): string[] {
  try {
    const f = join(DOWNLOADS, `buy-signals-${day}.csv`)
    if (!existsSync(f)) return []
    const set = new Set<string>()
    for (const ln of readFileSync(f, 'utf8').split('\n').slice(1)) {
      const sym = ln.split(',')[1]?.trim()
      if (sym && /^[A-Z]{1,6}$/.test(sym)) set.add(sym)
    }
    return [...set]
  } catch { return [] }   // sandbox blocked ~/Downloads → rely on daily-ranked top-N only
}

// ── Universe reconstruction per day ────────────────────────────────────────────

async function reconstructUniverse(day: string, pool: string[], dailyBySym: Map<string, RawRow[]>): Promise<string[]> {
  const ranked: { sym: string; move: number }[] = []
  for (const sym of pool) {
    const daily = dailyBySym.get(sym) ?? []
    const idx = daily.findIndex(r => r.date.slice(0, 10) === day)
    if (idx <= 0) continue
    const prevClose = daily[idx - 1].close
    if (!(prevClose > 0)) continue
    const move = (daily[idx].high - prevClose) / prevClose   // intraday-high vs prior close
    ranked.push({ sym, move })
  }
  ranked.sort((a, b) => b.move - a.move)
  const top = ranked.slice(0, TOP_GAINERS_UNIVERSE).map(r => r.sym)
  const universe = new Set<string>([...top, ...csvSymbolsForDay(day)])
  // Only keep names that actually have a daily bar that day (tradeable).
  return [...universe].filter(s => (dailyBySym.get(s) ?? []).some(r => r.date.slice(0, 10) === day))
}

// ── Buy-log gate helpers (mirrored from useMonitor.ts) ─────────────────────────

interface Buy {
  id: string; setupId: string; symbol: string; timestamp: number; setupType: SetupType
  entryLow: number; entryHigh: number; invalidation: number; stop: number
  targets: number[]; score: number; grade: string; rewardRisk: number | null
  priceAtSignal: number; session: string
  ctxDistDayHighPct: number | null; ctxRelVol: number | null; ctxAtrPct: number | null
}
interface MiniLog { id: string; symbol: string; type: SetupType; invalidation: number; t1: number | null; outcome: 'open' | 'invalidated' | 'target_hit'; resolvedAt: number | null; direction: 'long' }

function isDuplicateBuy(sym: string, entryHigh: number, now: number, prior: Buy[]): boolean {
  for (const b of prior) {
    if (b.symbol !== sym) continue
    if (now - b.timestamp > BUY_DEDUP_COOLDOWN_MS) continue
    if (b.entryHigh > 0 && Math.abs(entryHigh - b.entryHigh) / b.entryHigh < ENTRY_SIMILARITY_PCT) return true
  }
  return false
}
function symbolCapReached(sym: string, now: number, logs: MiniLog[], buys: Buy[]): boolean {
  const lostIds = new Set(logs.filter(l => l.outcome === 'invalidated' && l.resolvedAt != null && now - l.resolvedAt < SYMBOL_CAP_MS).map(l => l.id))
  if (buys.some(b => b.symbol === sym && lostIds.has(b.setupId))) return true
  const wins = logs.filter(l => l.symbol === sym && l.outcome === 'target_hit' && l.resolvedAt != null && now - l.resolvedAt < SYMBOL_CAP_MS).length
  return wins >= SYMBOL_WIN_CAP
}

// ── Concurrency helper ─────────────────────────────────────────────────────────

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() { while (i < items.length) { const j = i++; out[j] = await fn(items[j]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// ── Per (symbol, day) walk-forward replay ──────────────────────────────────────

interface DropCounts { session: number; volume: number; veto: number; standDown: number; capped: number; dup: number }

function replaySymbolDay(
  symbol: string, day: string, wide5: RawRow[], daily: RawRow[], float: number | null,
  dayBuys: Buy[], dayLogs: Map<string, MiniLog>, failedBounces: { symbol: string; type: SetupType; at: number }[],
  drops: DropCounts, funnel: { triggered: number },
): void {
  const dailyUpTo = daily.filter(r => r.date.slice(0, 10) <= day)
  if (dailyUpTo.length < 2) return
  const dailyCandles = toCandles(dailyUpTo)
  const dayIdx = dailyUpTo.findIndex(r => r.date.slice(0, 10) === day)
  if (dayIdx <= 0) return
  const prevClose = dailyUpTo[dayIdx - 1].close
  // Baseline avg volume = 20 trading days before the replay day.
  const priorDaily = dailyUpTo.slice(Math.max(0, dayIdx - 20), dayIdx)
  const avgVolume = priorDaily.length ? priorDaily.reduce((s, r) => s + r.volume, 0) / priorDaily.length : 0

  const allCandles = toCandles(wide5)
  // Walk window: prior 2 days + the replay day (warm-up for EMAs/ATR), like getIntradayCandles.
  const windowStartDay = etDayKey(etStrToUnixSec(day) - 2 * 86400)
  const walkCandles = allCandles.filter(c => etDayKey(c.time) >= windowStartDay && etDayKey(c.time) <= day)
  const dayBars = walkCandles.filter(c => etDayKey(c.time) === day)
  if (dayBars.length === 0) return

  const seenLog = new Set<string>()  // ensure one log per setup.id (like ensureLog)

  for (let bi = 0; bi < walkCandles.length; bi++) {
    const bar = walkCandles[bi]
    if (etDayKey(bar.time) !== day) continue
    const nowTs = (bar.time + 300) * 1000   // "now" = the just-closed 5-min bar's close
    const session = getSessionType(nowTs)
    if (session !== 'premarket' && session !== 'regular') continue

    const candlesSoFar = walkCandles.slice(0, bi + 1)
    const price = bar.close
    if (!(price > 0)) continue
    const todayVol = candlesSoFar.filter(c => etDayKey(c.time) === day).reduce((s, c) => s + c.volume, 0)

    const sessionLevels = calculateSessionLevels(candlesSoFar, dailyCandles, undefined, undefined, nowTs)
    const technical = calculateTechnical(candlesSoFar, dailyCandles, todayVol, avgVolume, sessionLevels, undefined, nowTs)

    let premarketVolForGate: number | null = null
    if (session === 'premarket') {
      const profile = premarketVolumeProfile(wide5, { todayEt: day, throughHHMM: etHHMM(nowTs) })
      if (profile.relativeVolume != null) technical.relativeVolume = profile.relativeVolume
      premarketVolForGate = profile.measured ? profile.todayVolume : null
    }

    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0
    const levels = buildKeyLevels({ intraday: candlesSoFar, daily: dailyCandles, sessionLevels, technical, currentPrice: price, nowTs })

    const detCtx: DetectionContext = {
      symbol, price, candles: candlesSoFar, sessionLevels, technical, levels,
      catalystScore: 0, hasCatalyst: false, spreadPct: null, changePct, session,
      minutesSinceOpen: minutesSinceOpen(nowTs), float,
    }
    const setups = detectSetups(detCtx)

    for (const setup of setups) {
      const meetsLevel = (setup.breakdown.levelQuality / 20) * 100 >= MIN_LEVEL_STRENGTH * 0.2 || setup.confidence >= MIN_LEVEL_STRENGTH
      if (setup.score < MIN_SCORE_FLOOR && !meetsLevel) continue
      if (!(setup.direction === 'long' && setup.triggeredRaw)) continue
      funnel.triggered++

      const fill = setup.entryFill ?? setup.zoneUpper
      const dup = isDuplicateBuy(symbol, fill, nowTs, dayBuys)
      const volumeOk = session === 'premarket'
        ? premarketVolForGate == null || premarketVolForGate >= MIN_PREMARKET_BUY_VOLUME
        : todayVol === 0 || todayVol >= MIN_BUY_VOLUME
      const gradeFloorFail = setup.grade === 'below' && !GRADE_FLOOR_EXEMPT.has(setup.type)
      const standDown = BOUNCE_TYPES.has(setup.type) &&
        failedBounces.some(fb => fb.symbol === symbol && nowTs - fb.at < STANDDOWN_MS)
      const symbolLogsThisSession = dayBuys.filter(b => b.symbol === symbol && nowTs - b.timestamp < SYMBOL_LOG_WINDOW_MS).length
      const overLogged = symbolLogsThisSession >= MAX_LOGS_PER_SYMBOL
      const capped = symbolCapReached(symbol, nowTs, [...dayLogs.values()], dayBuys) || overLogged

      // Late-session cutoff: regular-hours BUYs stop at 14:00 ET (premarket exempt).
      if (session === 'regular' && etHHMM(nowTs) >= LATE_LOG_CUTOFF_HHMM) { drops.session++; continue }
      if (!volumeOk) { drops.volume++; continue }
      if (setup.qualityVetoed || gradeFloorFail) { drops.veto++; continue }
      if (standDown) { drops.standDown++; continue }
      if (capped) { drops.capped++; continue }
      if (dup) { drops.dup++; continue }

      const t1 = setup.targets[0]?.price ?? null
      const rr = t1 != null && fill > setup.stopReference
        ? Math.round(((t1 - fill) / (fill - setup.stopReference)) * 10) / 10
        : setup.rewardRisk
      dayBuys.push({
        id: `${setup.id}:${Math.floor(nowTs / 1000)}`, setupId: setup.id, symbol, timestamp: nowTs,
        setupType: setup.type, entryLow: setup.zoneLower, entryHigh: fill, invalidation: setup.invalidation,
        stop: setup.stopReference, targets: setup.targets.map(t => t.price), score: setup.score, grade: setup.grade,
        rewardRisk: rr, priceAtSignal: price, session,
        ctxDistDayHighPct: technical.distanceFromDayHighPct, ctxRelVol: technical.relativeVolume,
        ctxAtrPct: technical.atr != null && price > 0 ? (technical.atr / price) * 100 : null,
      })
      if (!seenLog.has(setup.id)) {
        seenLog.add(setup.id)
        dayLogs.set(setup.id, { id: setup.id, symbol, type: setup.type, invalidation: setup.stopReference, t1, outcome: 'open', resolvedAt: null, direction: 'long' })
      }
    }

    // Latch open logs against THIS bar so the per-symbol cap sees wins/losses as they
    // happen (adverse-first within a bar). Feeds symbolCapReached + stand-down.
    for (const log of dayLogs.values()) {
      if (log.outcome !== 'open') continue
      if (bar.low <= log.invalidation) {
        log.outcome = 'invalidated'; log.resolvedAt = nowTs
        if (BOUNCE_TYPES.has(log.type)) failedBounces.push({ symbol, type: log.type, at: nowTs })
      } else if (log.t1 != null && bar.high >= log.t1) {
        log.outcome = 'target_hit'; log.resolvedAt = nowTs
      }
    }
  }
}

// ── Resolution + reporting ─────────────────────────────────────────────────────

interface Resolved extends Buy { pnlPct: number; outcome: string; fullyClosed: boolean; mfePct: number; maePct: number }

function resolveBuy(b: Buy, dayCandles: Candle[]): Resolved {
  const slip = slippageForSession(getSessionType(b.timestamp))
  const pnl = scaledPnl(b.entryHigh, b.stop, b.targets, dayCandles, b.timestamp, slip)
  const log: SetupLog = {
    id: b.id, symbol: b.symbol, type: b.setupType, direction: 'long',
    identifiedAt: b.timestamp, priceAtIdentification: b.entryHigh,
    zoneLower: b.entryLow, zoneUpper: b.entryHigh, score: b.score, grade: b.grade as any,
    confirmation: [], invalidation: b.stop, targets: b.targets.map((p, i) => ({ price: p, label: `T${i + 1}`, rewardRisk: null })),
    statesReached: [], maxFavorablePrice: b.entryHigh, maxAdversePrice: b.entryHigh,
    maxFavorablePct: 0, maxAdversePct: 0, outcome: 'open', outcomeReason: null,
    triggeredAt: b.timestamp, resolvedAt: null, relativeVolumeAtId: null, sessionAtId: b.session, testCount: 0,
  }
  const r = resolveLogAgainstCandles(log, dayCandles)
  return {
    ...b, pnlPct: pnl?.pnlPct ?? 0, fullyClosed: pnl?.fullyClosed ?? false,
    outcome: r?.outcome ?? 'open', mfePct: r?.maxFavorablePct ?? 0, maePct: r?.maxAdversePct ?? 0,
  }
}

function pct(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%' }

async function main() {
  const pool = poolSymbols()
  console.error(`Candidate pool: ${pool.length} symbols. Fetching daily candles…`)
  const dailyBySym = new Map<string, RawRow[]>()
  await mapLimit(pool, 3, async sym => { try { dailyBySym.set(sym, await fetchDaily(sym)) } catch { dailyBySym.set(sym, []) } })

  // Reconstruct each day's universe, then gather the distinct symbols to fetch 5-min tape for.
  const universeByDay = new Map<string, string[]>()
  for (const day of DAYS) universeByDay.set(day, await reconstructUniverse(day, pool, dailyBySym))
  const need = new Set<string>()
  for (const u of universeByDay.values()) for (const s of u) need.add(s)
  console.error(`Universe symbols to replay: ${need.size} distinct. Fetching floats…`)

  // Floats are ~constant, fetched once per symbol; 5-min tape is fetched per DAY
  // (see fetch5minForDay) because the endpoint only returns ~10 days from `to`.
  const floatBySym = new Map<string, number | null>()
  await mapLimit([...need], 3, async sym => { floatBySym.set(sym, await fetchFloat(sym)) })

  const lines: string[] = []
  const allResolved: Resolved[] = []
  const perDayTriggered: Record<string, number> = {}
  const perDayDrops: Record<string, DropCounts> = {}

  lines.push(`# FMP replay backtest — current decision logic vs ${DAYS[0]} → ${DAYS[DAYS.length - 1]} (${DAYS.length} trading days)`)
  lines.push('')
  lines.push('_Regenerated signals under the current (post-anti-spray-pivot) logic, walked bar-by-bar on FMP\'s real 5-min tape, resolved with the current scaled-out resolver (ATR ladder, breakeven-after-T1, session slippage haircut)._')
  lines.push('')

  for (const day of DAYS) {
    const universe = universeByDay.get(day)!
    console.error(`Replaying ${day} (${universe.length} names)…`)
    const dayBuys: Buy[] = []
    const dayLogs = new Map<string, MiniLog>()
    const failedBounces: { symbol: string; type: SetupType; at: number }[] = []
    const drops: DropCounts = { session: 0, volume: 0, veto: 0, standDown: 0, capped: 0, dup: 0 }
    const funnel = { triggered: 0 }

    // Fetch each universe symbol's day-anchored 5-min tape (concurrency-limited).
    const dayRowsBySym = new Map<string, RawRow[]>()
    await mapLimit(universe, 3, async sym => {
      try { dayRowsBySym.set(sym, await fetch5minForDay(sym, day)) }
      catch (e) { console.error(`5min ${sym} ${day} failed:`, (e as Error).message); dayRowsBySym.set(sym, []) }
    })

    for (const sym of universe) {
      const rows = dayRowsBySym.get(sym) ?? []
      const daily = dailyBySym.get(sym) ?? []
      if (rows.length === 0 || daily.length === 0) continue
      replaySymbolDay(sym, day, rows, daily, floatBySym.get(sym) ?? null, dayBuys, dayLogs, failedBounces, drops, funnel)
      process.stderr.write('.')
    }
    console.error(` ${funnel.triggered} triggers, ${dayBuys.length} logged`)
    perDayTriggered[day] = funnel.triggered
    perDayDrops[day] = drops

    // Resolve every logged buy against its day's full tape.
    const resolved: Resolved[] = []
    for (const b of dayBuys) {
      resolved.push(resolveBuy(b, toCandles(dayRowsBySym.get(b.symbol) ?? [])))
    }
    allResolved.push(...resolved)

    const wins = resolved.filter(r => r.outcome === 'target_hit')
    const losses = resolved.filter(r => r.outcome === 'invalidated')
    const opens = resolved.filter(r => r.outcome !== 'target_hit' && r.outcome !== 'invalidated')
    const decided = wins.length + losses.length
    const winRate = decided ? (wins.length / decided) * 100 : 0
    const avgPnl = resolved.length ? resolved.reduce((s, r) => s + r.pnlPct, 0) / resolved.length : 0
    const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0
    const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0

    lines.push(`## ${day} — universe ${universe.length} names, ${funnel.triggered} triggers → ${resolved.length} signals logged`)
    lines.push('')
    if (resolved.length === 0) {
      lines.push('_No signals cleared the gates._  ')
      lines.push(`Drops: volume ${drops.volume}, veto/grade ${drops.veto}, stand-down ${drops.standDown}, capped ${drops.capped}, dup ${drops.dup}`)
      lines.push('')
      continue
    }
    lines.push(`Win rate ${winRate.toFixed(0)}% (${wins.length}W / ${losses.length}L / ${opens.length} open-at-close) · avg win ${pct(avgWin)} · avg loss ${pct(avgLoss)} · **avg/trade ${pct(avgPnl)}** · net ${pct(resolved.reduce((s, r) => s + r.pnlPct, 0))}`)
    lines.push(`Gate drops: volume ${drops.volume}, veto/grade ${drops.veto}, stand-down ${drops.standDown}, capped ${drops.capped}, dup ${drops.dup}`)
    lines.push('')
    lines.push('| time ET | symbol | setup | grade | entry | stop | T1 | RVOL | off-high% | outcome | scaled P/L |')
    lines.push('|---|---|---|---|--:|--:|--:|--:|--:|---|--:|')
    for (const r of resolved.slice().sort((a, b) => a.timestamp - b.timestamp)) {
      const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(r.timestamp))
      lines.push(`| ${t} | ${r.symbol} | ${r.setupType} | ${r.grade} | ${r.entryHigh.toFixed(2)} | ${r.stop.toFixed(2)} | ${r.targets[0]?.toFixed(2) ?? '—'} | ${r.ctxRelVol?.toFixed(1) ?? '—'} | ${r.ctxDistDayHighPct?.toFixed(1) ?? '—'} | ${r.outcome} | ${pct(r.pnlPct)} |`)
    }
    lines.push('')
  }

  // ── Overall ──
  const wins = allResolved.filter(r => r.outcome === 'target_hit')
  const losses = allResolved.filter(r => r.outcome === 'invalidated')
  const opens = allResolved.filter(r => r.outcome !== 'target_hit' && r.outcome !== 'invalidated')
  const decided = wins.length + losses.length
  const winRate = decided ? (wins.length / decided) * 100 : 0
  const avgPnl = allResolved.length ? allResolved.reduce((s, r) => s + r.pnlPct, 0) / allResolved.length : 0
  const tradingDays = DAYS.length

  lines.push(`## Overall — ${DAYS[0]} → ${DAYS[DAYS.length - 1]} (${DAYS.length} trading days)`)
  lines.push('')
  lines.push(`- **${allResolved.length} signals** total · **${(allResolved.length / tradingDays).toFixed(1)} per day** (NORTH STAR ≈ 5/day)`)
  lines.push(`- **Win rate ${winRate.toFixed(0)}%** — ${wins.length}W / ${losses.length}L / ${opens.length} open-at-close`)
  lines.push(`- **Avg win ${pct(wins.length ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0)}** · avg loss ${pct(losses.length ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0)}`)
  lines.push(`- **Avg/trade ${pct(avgPnl)}** · net over the week ${pct(allResolved.reduce((s, r) => s + r.pnlPct, 0))} (scaled, slippage-adjusted)`)
  lines.push('')

  // By setup type
  const byType = new Map<string, Resolved[]>()
  for (const r of allResolved) { const g = byType.get(r.setupType) ?? []; g.push(r); byType.set(r.setupType, g) }
  lines.push('### By setup type')
  lines.push('')
  lines.push('| setup | n | win% | avg/trade |')
  lines.push('|---|--:|--:|--:|')
  for (const [type, rs] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const w = rs.filter(r => r.outcome === 'target_hit').length
    const l = rs.filter(r => r.outcome === 'invalidated').length
    const wr = (w + l) ? (w / (w + l)) * 100 : 0
    const a = rs.reduce((s, r) => s + r.pnlPct, 0) / rs.length
    lines.push(`| ${type} | ${rs.length} | ${wr.toFixed(0)}% | ${pct(a)} |`)
  }
  lines.push('')
  lines.push('### Per-day triggers vs logged (funnel)')
  lines.push('')
  lines.push('| day | universe | triggers | logged |')
  lines.push('|---|--:|--:|--:|')
  for (const day of DAYS) {
    const logged = allResolved.filter(r => etDayKey(Math.floor(r.timestamp / 1000)) === day).length
    lines.push(`| ${day} | ${universeByDay.get(day)!.length} | ${perDayTriggered[day]} | ${logged} |`)
  }
  lines.push('')
  lines.push('---')
  lines.push('### Fidelity caveats')
  lines.push('- **Universe is reconstructed** (no historical FMP gainers snapshot): candidate pool = every symbol the live scanner has ever surfaced (all exported CSVs, ' + pool.length + ' names) + each day\'s actual CSV names, ranked per day by FMP daily intraday-high vs prior close. A name never surfaced live cannot appear — this bias hits exactly the low-float premarket rockets.')
  lines.push('- **No live news feed** → catalystScore 0; the in-play gate still passes on RVOL / gap / float.')
  lines.push('- **5-min bar granularity** (live sweeps at 15s). Detectors are close-based so this aligns, but an intrabar break/stop between 5-min closes is only seen at the bar close.')
  lines.push('- **Stand-down** (failed-bounce) is approximated from logged-entry outcomes rather than the full state machine.')
  lines.push('- All target/stop geometry, gates, and P/L come from the CURRENT committed code (branch improve-signal-quality).')

  const report = lines.join('\n')
  const outPath = join(SCRATCH, 'backtest-july.md')
  writeFileSync(outPath, report)
  // Also dump the reconstructed signals as CSV.
  const csv = ['day,time_ET,symbol,setup,grade,entry,stop,t1,rvol,off_high_pct,outcome,scaled_pnl_pct']
  for (const r of allResolved.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    const day = etDayKey(Math.floor(r.timestamp / 1000))
    const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(r.timestamp))
    csv.push([day, t, r.symbol, r.setupType, r.grade, r.entryHigh.toFixed(2), r.stop.toFixed(2), r.targets[0]?.toFixed(2) ?? '', r.ctxRelVol?.toFixed(1) ?? '', r.ctxDistDayHighPct?.toFixed(1) ?? '', r.outcome, r.pnlPct.toFixed(2)].join(','))
  }
  writeFileSync(join(SCRATCH, 'backtest-july-signals.csv'), csv.join('\n'))

  console.log(report)
  console.error(`\n\nReport → ${outPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
