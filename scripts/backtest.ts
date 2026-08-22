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

import type { Candle, SetupLog, SetupStateRecord, SetupType, BuySignalRecord } from '@/types'
// ONE decision engine: this replay walks the SHARED production pipeline (replayDay
// → real technicals/levels/detectors) and classifies each trigger through the
// SHARED gate stack (classifyBuy + buy-log constants) — the same modules the live
// client, the alert daemon, diagnose, and recall use. Nothing about the BUY/drop
// decision is re-implemented here, so replay and live cannot drift.
import { replayDay } from '@/lib/replay-day'
import { classifyBuy, passesTrackingFloor, BOUNCE_TYPES } from '@/lib/buy-log'
import { getSessionType } from '@/lib/market-hours'
import { scaledPnl, resolveLogAgainstCandles, slippageForSession } from '@/lib/eod-resolver'
import { researchWindowDays, weekdaysBetween, classifyDays } from '@/lib/research-window'

// ── Config ───────────────────────────────────────────────────────────────────

const REPO = process.cwd()
const DOWNLOADS = join(homedir(), 'Downloads')

// PRIORITY 4 — the development/research window is July 2026; August 2026 is the
// held-out validation window (defined in src/lib/research-window.ts). It is NOT
// listed here: reaching it requires an explicit, recorded opt-in (see below).
const RESEARCH_WINDOW = researchWindowDays()

// PRIORITY 2 — choose the replay days without editing source:
//   BACKTEST_DAYS=2026-07-14                        one day
//   BACKTEST_DAYS=2026-07-06,2026-07-14,2026-07-31  a few
//   BACKTEST_DAYS=2026-07-06:2026-07-10             an inclusive range over the window
//   (unset)                                          the full research window
function selectedDays(): string[] {
  const spec = process.env.BACKTEST_DAYS?.trim()
  if (!spec) return RESEARCH_WINDOW
  if (spec.includes(':')) {
    const [a, b] = spec.split(':').map(s => s.trim())
    // Range endpoints may sit outside the known window (e.g. an August validation
    // range); expand over calendar weekdays so an explicit range still works.
    return weekdaysBetween(a, b)
  }
  return spec.split(',').map(s => s.trim()).filter(Boolean)
}
const DAYS = selectedDays()

// PRIORITY 4 — refuse to silently research on the held-out month. Selecting an
// August date requires VALIDATE=1 + VALIDATION_NOTE; the use is then appended to
// data/validation-ledger.json so August can never quietly become training data.
guardHeldOut(DAYS)

const TOP_GAINERS_UNIVERSE = 15          // matches useMonitor gatherUniverse
const MIN_LEVEL_STRENGTH = 40            // store default notificationSettings.minLevelStrength

// PRIORITY 3 — the intraday timeframe is configurable. 1m and 5m run the SAME
// production pipeline (technicals, levels, detectors, gates, resolver); they differ
// ONLY in the tape they see and the simulated bar-close clock. TIMEFRAME=1m | 5m.
const TIMEFRAME = process.env.TIMEFRAME === '1m' ? '1m' : '5m'
const BAR_SECONDS = TIMEFRAME === '1m' ? 60 : 300
const INTRADAY_ENDPOINT = TIMEFRAME === '1m' ? '1min' : '5min'
const INTRADAY_PREFIX = TIMEFRAME === '1m' ? 'm1' : 'm5'   // cache-key prefix per timeframe

// The buy-log GATE STACK is no longer mirrored here — this file imports classifyBuy
// and its constants directly (see the import block). One consequence worth stating:
// the per-symbol cap now defaults to the PRODUCTION value (buy-log's
// MAX_LOGS_PER_SYMBOL = 2), not the old replay-only Infinity, so the replay finally
// matches live. Override it exactly as live can: MAX_LOGS_PER_SYMBOL=3 npx tsx …

const SCRATCH = process.env.SCRATCH_DIR ||
  '/private/tmp/claude-501/-Users-elonmusk-Companion/e73f584c-b4b9-412c-a4d7-ccaf1e47b222/scratchpad'

// PRIORITY 2 — two cache tiers:
//   1. tests/fixtures/replay-tape/ — SMALL, committed, deterministic (checked in).
//   2. the research cache          — LARGE, local only, NEVER committed (gitignored).
// Reads consult fixtures FIRST, then the research cache; writes only ever go to the
// research cache, so the committed fixture set stays a curated minimum.
const FIXTURE_DIR = join(REPO, 'tests', 'fixtures', 'replay-tape')
const RESEARCH_CACHE = process.env.FMP_CACHE_DIR || join(SCRATCH, 'fmp-cache')
if (!existsSync(RESEARCH_CACHE)) mkdirSync(RESEARCH_CACHE, { recursive: true })
// OFFLINE replays only tape already on disk (fixtures + research cache) — no
// network, so re-runs are fast and deterministic and can't be rate-limited.
const OFFLINE = process.env.OFFLINE === '1'

const DAILY_TO = DAYS.reduce((m, d) => (d > m ? d : m), '2026-07-31')

// PRIORITY 4 — gate on the held-out month. Selecting any August date is refused
// unless VALIDATE=1 and a VALIDATION_NOTE are set; the use is then appended to the
// validation ledger so a held-out judgement is on the record forever.
function guardHeldOut(days: string[]): void {
  const { heldout, research } = classifyDays(days)
  if (heldout.length === 0) return
  const note = process.env.VALIDATION_NOTE?.trim()
  if (process.env.VALIDATE !== '1' || !note) {
    throw new Error(
      `Refusing to replay held-out days ${heldout.join(', ')}.\n` +
      `August 2026 is the HELD-OUT validation window and must stay untouched until a\n` +
      `candidate change is already chosen on July. To spend it deliberately:\n` +
      `  VALIDATE=1 VALIDATION_NOTE="<candidate id + what you're judging>" BACKTEST_DAYS=… npx tsx scripts/backtest.ts`,
    )
  }
  const ledgerPath = join(REPO, 'data', 'validation-ledger.json')
  let ledger: { runs: unknown[] } = { runs: [] }
  try { if (existsSync(ledgerPath)) ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) } catch { /* start fresh */ }
  ledger.runs.push({
    timestamp: new Date().toISOString(),
    heldoutDays: heldout,
    alsoResearchDays: research,
    note,
    runTag: process.env.RUN_TAG ?? null,
  })
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
  console.error(`⚠️  HELD-OUT VALIDATION recorded → ${ledgerPath} (${heldout.length} August day(s), note: "${note}")`)
}

// ── FMP fetch layer (disk-cached) ─────────────────────────────────────────────

function apiKey(): string {
  const env = readFileSync(join(REPO, '.env.local'), 'utf8')
  const m = env.match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/)
  if (!m) throw new Error('FMP_API_KEY not found in .env.local')
  return m[1]
}
// In OFFLINE mode we never hit the network, so a missing key must not abort the run.
const KEY = (() => { try { return apiKey() } catch (e) { if (OFFLINE) return ''; throw e } })()

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Two-tier read (fixtures first, then research cache); writes go to the research
// cache only. In OFFLINE mode a miss is final — no fetch.
function readCached(cacheName: string): unknown {
  for (const dir of [FIXTURE_DIR, RESEARCH_CACHE]) {
    const f = join(dir, cacheName + '.json')
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  }
  return null
}

async function cachedGet(cacheName: string, url: string): Promise<unknown> {
  const hit = readCached(cacheName)
  if (hit != null) return hit
  if (OFFLINE) throw new Error(`OFFLINE: ${cacheName} not in fixtures or research cache`)
  let lastErr = ''
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url)
    if (res.ok) {
      const json = await res.json()
      writeFileSync(join(RESEARCH_CACHE, cacheName + '.json'), JSON.stringify(json))
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
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${symbol}&from=2026-05-01&to=${DAILY_TO}&apikey=${KEY}`
  const j = await cachedGet(`daily_${symbol}`, url)
  const arr: RawRow[] = Array.isArray(j) ? j : ((j as { historical?: RawRow[] } | null)?.historical ?? [])
  return arr.slice().sort((a, b) => a.date.localeCompare(b.date))
}

// Extended intraday tape ending at the replay day, at the configured TIMEFRAME.
// FMP's intraday endpoints cap each response to ~10 recent days from `to`
// REGARDLESS of `from`, so the `to` must be anchored at the day. 14 calendar days
// back yields the walk window (day-2..day) + prior sessions for the premarket
// baseline. The cache key includes both the timeframe prefix and the day, so 1m and
// 5m tapes never collide.
async function fetchIntradayForDay(symbol: string, day: string): Promise<RawRow[]> {
  const fromDay = etDayKey(etStrToUnixSec(day) - 14 * 86400)
  const url = `https://financialmodelingprep.com/stable/historical-chart/${INTRADAY_ENDPOINT}?symbol=${symbol}&from=${fromDay}&to=${day}&extended=true&apikey=${KEY}`
  const j = await cachedGet(`${INTRADAY_PREFIX}_${symbol}_${day}`, url)
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
  for (const f of readdirSync(RESEARCH_CACHE)) {
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
  const seenLog = new Set<string>()  // ensure one log per setup.id (like ensureLog)

  // The pipeline (technicals → levels → detectors → MonitorResult) is the SHARED
  // production code, driven by a simulated clock. We only add the gate classification
  // and the per-bar log latching around it.
  for (const rb of replayDay(symbol, day, wide5, daily, float, BAR_SECONDS)) {
    // Feed the win/loss cap and the failed-bounce stand-down the same evidence the
    // live client does: latched setup logs + failed-bounce state records. (The
    // daemon and recall stub these out with []; live and this replay do not.)
    const priorLogs = [...dayLogs.values()] as unknown as SetupLog[]
    const priorStates = failedBounces.map(fb => ({
      symbol: fb.symbol, type: fb.type, state: 'failed', updatedAt: fb.at,
    })) as unknown as SetupStateRecord[]

    for (const setup of rb.setups) {
      if (!(setup.direction === 'long' && setup.triggeredRaw)) continue
      if (!passesTrackingFloor(setup, MIN_LEVEL_STRENGTH)) continue
      funnel.triggered++

      const { verdict, buy } = classifyBuy(setup, rb.result, {
        now: rb.nowTs, priorBuys: dayBuys as unknown as BuySignalRecord[], priorLogs, priorStates,
      })
      if (verdict !== 'logged' || !buy) { drops[verdict as keyof DropCounts]++; continue }

      // classifyBuy returns the production BuySignalRecord; the replay's Buy shape is
      // that plus the entry session (used by the resolver's slippage haircut).
      dayBuys.push({ ...buy, session: rb.session } as unknown as Buy)
      if (!seenLog.has(setup.id)) {
        seenLog.add(setup.id)
        dayLogs.set(setup.id, {
          id: setup.id, symbol, type: setup.type, invalidation: setup.stopReference,
          t1: setup.targets[0]?.price ?? null, outcome: 'open', resolvedAt: null, direction: 'long',
        })
      }
    }

    // Latch open logs against THIS bar so the per-symbol cap sees wins/losses as they
    // happen (adverse-first within a bar). Feeds symbolCapReached + stand-down.
    for (const log of dayLogs.values()) {
      if (log.outcome !== 'open') continue
      if (rb.low <= log.invalidation) {
        log.outcome = 'invalidated'; log.resolvedAt = rb.nowTs
        if (BOUNCE_TYPES.has(log.type)) failedBounces.push({ symbol, type: log.type, at: rb.nowTs })
      } else if (log.t1 != null && rb.high >= log.t1) {
        log.outcome = 'target_hit'; log.resolvedAt = rb.nowTs
      }
    }
  }
}

// ── Resolution + reporting ─────────────────────────────────────────────────────

interface Resolved extends Buy {
  pnlPct: number; outcome: string; fullyClosed: boolean; mfePct: number; maePct: number
  // Anatomy of the scale-out ladder for the winner-capture study (additive; the
  // decision/P&L are unchanged — this only DECOMPOSES the P&L the resolver produced).
  t1Reached: boolean; t2Reached: boolean; breakevenActivated: boolean
  fracRemainingAtClose: number; realisedBeforeCloseR: number; closeMarkR: number
  endReason: string; tT1Min: number | null; tT2Min: number | null; tMfeMin: number | null
  lastBarMin: number | null; lastClose: number | null
}

function resolveBuy(b: Buy, dayCandles: Candle[]): Resolved {
  const slip = slippageForSession(getSessionType(b.timestamp))
  const pnl = scaledPnl(b.entryHigh, b.stop, b.targets, dayCandles, b.timestamp, slip)
  const log: SetupLog = {
    id: b.id, symbol: b.symbol, type: b.setupType, direction: 'long',
    identifiedAt: b.timestamp, priceAtIdentification: b.entryHigh,
    zoneLower: b.entryLow, zoneUpper: b.entryHigh, score: b.score, grade: b.grade as SetupLog['grade'],
    confirmation: [], invalidation: b.stop, targets: b.targets.map((p, i) => ({ price: p, label: `T${i + 1}`, rewardRisk: null })),
    statesReached: [], maxFavorablePrice: b.entryHigh, maxAdversePrice: b.entryHigh,
    maxFavorablePct: 0, maxAdversePct: 0, outcome: 'open', outcomeReason: null,
    triggeredAt: b.timestamp, resolvedAt: null, relativeVolumeAtId: null, sessionAtId: b.session, testCount: 0,
  }
  const r = resolveLogAgainstCandles(log, dayCandles)

  // ── Ladder decomposition (R attribution per leg) ──
  const legs = pnl?.legs ?? []
  const entryEff = b.entryHigh * (1 + slip)
  const stopFrac = b.entryHigh > 0 ? (b.entryHigh - b.stop) / b.entryHigh : 0   // one R, as a fraction of entry
  let realisedBeforeCloseR = 0, closeMarkR = 0
  for (const leg of legs) {
    const exitEff = leg.exitPrice * (1 - slip)
    const legR = stopFrac > 0 ? ((exitEff - entryEff) / entryEff) * leg.fraction / stopFrac : 0
    if (leg.reason === 'close') closeMarkR += legR; else realisedBeforeCloseR += legR
  }
  const closeLeg = legs.find(l => l.reason === 'close')

  // ── Timing (minutes from entry) over the entry day's post-signal tape ──
  const signalSec = Math.floor(b.timestamp / 1000)
  const day = dayCandles.filter(c => c.time >= signalSec && getSessionType(c.time * 1000 + 60000)).sort((x, y) => x.time - y.time)
  const t1 = b.targets[0] ?? null, t2 = b.targets[1] ?? null
  let tT1Min: number | null = null, tT2Min: number | null = null, tMfeMin: number | null = null, hi = -Infinity
  for (const c of day) {
    const min = Math.round((c.time * 1000 - b.timestamp) / 60000)
    if (min < 0) continue
    if (tT1Min == null && t1 != null && c.high >= t1) tT1Min = min
    if (tT2Min == null && t2 != null && c.high >= t2) tT2Min = min
    if (c.high > hi) { hi = c.high; tMfeMin = min }
  }
  const lastBar = day[day.length - 1] ?? null

  return {
    ...b, pnlPct: pnl?.pnlPct ?? 0, fullyClosed: pnl?.fullyClosed ?? false,
    outcome: r?.outcome ?? 'open', mfePct: r?.maxFavorablePct ?? 0, maePct: r?.maxAdversePct ?? 0,
    t1Reached: legs.some(l => l.reason === 'T1'),
    t2Reached: legs.some(l => l.reason === 'T2'),
    breakevenActivated: legs.some(l => l.reason === 'breakeven'),
    fracRemainingAtClose: closeLeg?.fraction ?? 0,
    realisedBeforeCloseR, closeMarkR,
    endReason: legs.length ? legs[legs.length - 1].reason : 'none',
    tT1Min, tT2Min, tMfeMin,
    lastBarMin: lastBar ? Math.round((lastBar.time * 1000 - b.timestamp) / 60000) : null,
    lastClose: lastBar?.close ?? null,
  }
}

function pct(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%' }

async function main() {
  const pool = poolSymbols()
  console.error(`Candidate pool: ${pool.length} symbols. Fetching daily candles…`)
  const dailyBySym = new Map<string, RawRow[]>()
  await mapLimit(pool, 3, async sym => { try { dailyBySym.set(sym, await fetchDaily(sym)) } catch { dailyBySym.set(sym, []) } })

  // Reconstruct each day's universe, then gather the distinct symbols to fetch 5-min tape for.
  // UNIVERSE_FROM pins the per-day universe to the symbols in an existing signals
  // CSV, instead of re-ranking the (drift-prone) cache pool. This is how a prior
  // canonical run is reproduced exactly for e.g. an anatomy pass: the pool grows as
  // more days are cached, which changes the top-N-by-move ranking, so re-running
  // free-form would replay a different universe. Pinning removes that drift.
  const universeByDay = new Map<string, string[]>()
  const pinPath = process.env.UNIVERSE_FROM
  if (pinPath) {
    const pinned = new Map<string, Set<string>>()
    for (const ln of readFileSync(pinPath, 'utf8').trim().split('\n').slice(1)) {
      const c = ln.split(','); const d = c[0]?.trim(); const sym = c[2]?.trim()
      if (d && sym) { if (!pinned.has(d)) pinned.set(d, new Set()); pinned.get(d)!.add(sym) }
    }
    for (const day of DAYS) universeByDay.set(day, [...(pinned.get(day) ?? new Set<string>())])
    console.error(`Universe PINNED from ${pinPath}`)
  } else {
    for (const day of DAYS) universeByDay.set(day, await reconstructUniverse(day, pool, dailyBySym))
  }
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
      try { dayRowsBySym.set(sym, await fetchIntradayForDay(sym, day)) }
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
  const tag = process.env.RUN_TAG ? `-${process.env.RUN_TAG}` : ''
  const outPath = join(SCRATCH, `backtest-july${tag}.md`)
  writeFileSync(outPath, report)
  // Also dump the reconstructed signals as CSV.
  // mae_pct/mfe_pct are already computed per signal (resolveBuy → resolveLogAgainstCandles);
  // exporting them lets scripts/research.ts run its excursion section (how much stop
  // room a winner actually needed) instead of reporting "not available".
  const csv = ['day,time_ET,symbol,setup,grade,entry,stop,t1,rvol,off_high_pct,outcome,scaled_pnl_pct,mae_pct,mfe_pct']
  for (const r of allResolved.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    const day = etDayKey(Math.floor(r.timestamp / 1000))
    const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(r.timestamp))
    csv.push([day, t, r.symbol, r.setupType, r.grade, r.entryHigh.toFixed(2), r.stop.toFixed(2), r.targets[0]?.toFixed(2) ?? '', r.ctxRelVol?.toFixed(1) ?? '', r.ctxDistDayHighPct?.toFixed(1) ?? '', r.outcome, r.pnlPct.toFixed(2), r.maePct.toFixed(2), r.mfePct.toFixed(2)].join(','))
  }
  writeFileSync(join(SCRATCH, `backtest-july${tag}-signals.csv`), csv.join('\n'))

  // Per-trade ANATOMY of the scale-out ladder (additive research output; does not
  // affect the signals CSV above or any decision). Columns decompose the resolver's
  // P&L into realised-before-close vs EOD-mark, with ladder events and timing, in R.
  const anat = ['day,time_ET,symbol,setup,session,grade,entry,stop,t1,t2,outcome,total_R,realised_before_close_R,close_mark_R,frac_remaining_close,t1_reached,t2_reached,breakeven_activated,end_reason,mfe_R,mae_R,t_t1_min,t_t2_min,t_mfe_min,last_bar_min,last_close']
  for (const r of allResolved.slice().sort((a, b) => a.timestamp - b.timestamp)) {
    const day = etDayKey(Math.floor(r.timestamp / 1000))
    const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(r.timestamp))
    const stopFrac = r.entryHigh > 0 ? (r.entryHigh - r.stop) / r.entryHigh * 100 : 0   // 1R in %
    const totalR = stopFrac > 0 ? r.pnlPct / stopFrac : 0
    const mfeR = stopFrac > 0 ? r.mfePct / stopFrac : 0
    const maeR = stopFrac > 0 ? r.maePct / stopFrac : 0
    anat.push([day, t, r.symbol, r.setupType, r.session, r.grade, r.entryHigh.toFixed(2), r.stop.toFixed(2),
      r.targets[0]?.toFixed(2) ?? '', r.targets[1]?.toFixed(2) ?? '', r.outcome, totalR.toFixed(3),
      r.realisedBeforeCloseR.toFixed(3), r.closeMarkR.toFixed(3), r.fracRemainingAtClose.toFixed(3),
      r.t1Reached ? '1' : '0', r.t2Reached ? '1' : '0', r.breakevenActivated ? '1' : '0', r.endReason,
      mfeR.toFixed(3), maeR.toFixed(3), r.tT1Min ?? '', r.tT2Min ?? '', r.tMfeMin ?? '', r.lastBarMin ?? '', r.lastClose?.toFixed(2) ?? ''].join(','))
  }
  writeFileSync(join(SCRATCH, `backtest-july${tag}-anatomy.csv`), anat.join('\n'))

  console.log(report)
  console.error(`\n\nReport → ${outPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
