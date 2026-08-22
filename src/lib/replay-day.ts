/**
 * Historical replay of one symbol-day through the real pipeline.
 *
 * Shared by the diagnostic (`scripts/diagnose.ts`) and the recall harness
 * (`scripts/recall.ts`) so there is ONE implementation of "walk this name's tape
 * bar by bar and see what the detectors + gates would have done". Duplicating
 * this is what let the diagnostic silently drift out of sync with the live gates
 * (2026-08-06), so it lives here instead.
 *
 * Server/CLI only — it takes raw FMP rows and a simulated clock.
 */
import type { Candle, DetectedSetup, MonitorResult } from '@/types'
import { calculateSessionLevels, calculateTechnical } from './technical'
import { buildKeyLevels } from './levels-engine'
import { detectSetups, type DetectionContext } from './setup-detectors'
import { premarketVolumeProfile } from './premarket-volume'
import { getSessionType, minutesSinceOpen } from './market-hours'

export interface RawRow { date: string; open: number; high: number; low: number; close: number; volume: number }

/** FMP intraday date strings are ET wall-time (EDT/-04:00 through the summer). */
export function etStrToUnixSec(s: string): number {
  return Math.floor(Date.parse((s.length <= 10 ? `${s}T00:00:00` : s.replace(' ', 'T')) + '-04:00') / 1000)
}
// PERFORMANCE: both map an instant to an ET wall-clock field and are pure in their
// argument, but the per-bar `todayVol` filter calls etDayKey once PER CANDLE on
// every bar it re-scans — O(bars²) Intl formats, a dominant replay cost. Reuse one
// formatter each and memoise per key. Pure caching: identical inputs → identical
// outputs, so no decision changes. Bounded + cleared-when-full so live can't leak.
const ET_DAYKEY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
})
const ET_HHMM_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
})
const MAX_CACHE = 200_000
const dayKeyCache = new Map<number, string>()
const hhmmCache = new Map<number, number>()

export function etDayKey(unixSec: number): string {
  const hit = dayKeyCache.get(unixSec)
  if (hit !== undefined) return hit
  const v = ET_DAYKEY_FMT.format(unixSec * 1000)
  if (dayKeyCache.size >= MAX_CACHE) dayKeyCache.clear()
  dayKeyCache.set(unixSec, v)
  return v
}
export function etHHMM(ms: number): number {
  const hit = hhmmCache.get(ms)
  if (hit !== undefined) return hit
  const s = ET_HHMM_FMT.format(ms)
  const [h, m] = s.split(':').map(Number)
  const v = h * 100 + m
  if (hhmmCache.size >= MAX_CACHE) hhmmCache.clear()
  hhmmCache.set(ms, v)
  return v
}
export function toCandles(rows: RawRow[]): Candle[] {
  return rows.map(x => ({
    time: etStrToUnixSec(x.date), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0,
  })).sort((a, b) => a.time - b.time)
}

/** One bar's worth of replayed state: what the pipeline saw and produced. */
export interface ReplayBar {
  nowTs: number
  etHHMM: number
  session: string
  price: number
  /** This bar's high/low — callers latching stop/target touches need the range,
   *  not just the close. */
  high: number
  low: number
  setups: DetectedSetup[]
  /** Shaped like the MonitorResult the live gates consume. */
  result: MonitorResult
}

/**
 * Walk `day`'s bars for `symbol`, yielding the pipeline state at each bar close.
 * `rows` should span ~14 days back (warm-up + premarket-volume baseline); `daily`
 * is the EOD series up to and including `day`.
 *
 * `barSeconds` is the intraday bar width (300 = 5-min, 60 = 1-min). It ONLY sets
 * the simulated clock (nowTs = bar close = bar.time + barSeconds); the technicals,
 * levels, detectors, and gates are the real production code either way, so 1m and
 * 5m differ only by the data they see, never by a parallel strategy path.
 */
export function* replayDay(
  symbol: string, day: string, rows: RawRow[], daily: RawRow[],
  float: number | null = null, barSeconds = 300,
): Generator<ReplayBar> {
  const m5 = rows
  const dailyUpTo = daily.filter(r => r.date.slice(0, 10) <= day)
  if (dailyUpTo.length < 2) return
  const dailyC = toCandles(dailyUpTo)
  const di = dailyUpTo.findIndex(r => r.date.slice(0, 10) === day)
  const prevClose = di > 0 ? dailyUpTo[di - 1].close : (dailyUpTo[dailyUpTo.length - 2]?.close ?? 0)
  const pIdx = di < 0 ? dailyUpTo.length : di
  const prior = dailyUpTo.slice(Math.max(0, pIdx - 20), pIdx)
  const avgVol = prior.length ? prior.reduce((s, r) => s + r.volume, 0) / prior.length : 0

  const all = toCandles(m5)
  const windowStart = etDayKey(etStrToUnixSec(day) - 2 * 86400)
  const walk = all.filter(c => etDayKey(c.time) >= windowStart && etDayKey(c.time) <= day)

  for (let i = 0; i < walk.length; i++) {
    const bar = walk[i]
    if (etDayKey(bar.time) !== day) continue
    const nowTs = (bar.time + barSeconds) * 1000   // "now" = this bar's close
    const session = getSessionType(nowTs)
    if (session !== 'premarket' && session !== 'regular') continue

    const soFar = walk.slice(0, i + 1)
    const price = bar.close
    if (!(price > 0)) continue
    const todayVol = soFar.filter(c => etDayKey(c.time) === day).reduce((s, c) => s + c.volume, 0)

    const sl = calculateSessionLevels(soFar, dailyC, undefined, undefined, nowTs)
    const tech = calculateTechnical(soFar, dailyC, todayVol, avgVol, sl, undefined, nowTs)
    let pmVol: number | null = null
    if (session === 'premarket') {
      const p = premarketVolumeProfile(m5, { todayEt: day, throughHHMM: etHHMM(nowTs) })
      if (p.relativeVolume != null) tech.relativeVolume = p.relativeVolume
      pmVol = p.measured ? p.todayVolume : null
    }

    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0
    const levels = buildKeyLevels({ intraday: soFar, daily: dailyC, sessionLevels: sl, technical: tech, currentPrice: price, nowTs })
    const ctx: DetectionContext = {
      symbol, price, candles: soFar, sessionLevels: sl, technical: tech, levels,
      catalystScore: 0, hasCatalyst: false, spreadPct: null, changePct, session,
      minutesSinceOpen: minutesSinceOpen(nowTs), float,
    }
    const setups = detectSetups(ctx)

    const result = {
      symbol, price, volume: todayVol, relativeVolume: tech.relativeVolume,
      premarketVolume: session === 'premarket' ? pmVol : null,
      integrity: { session },
      technicals: {
        distanceFromDayHighPct: tech.distanceFromDayHighPct, trend15m: tech.trend15m,
        distanceFromVwapPct: tech.distanceFromVwapPct, higherHighsLows: tech.higherHighsLows,
        atrPct: tech.atr != null && price > 0 ? (tech.atr / price) * 100 : null,
      },
    } as unknown as MonitorResult

    yield { nowTs, etHHMM: etHHMM(nowTs), session, price, high: bar.high, low: bar.low, setups, result }
  }
}
