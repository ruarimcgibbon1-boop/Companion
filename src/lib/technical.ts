/**
 * Deterministic technical analysis engine.
 * All calculations are local — Claude receives results, not raw candles.
 */

import type { Candle, TechnicalData, SessionLevels, SupportResistanceZone } from '@/types'
import { isPremarket, isRegularHours, etMinutesOfDay } from './market-hours'

// ── Moving averages ────────────────────────────────────────────────────────

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < values.length; i++) {
    result = values[i] * k + result * (1 - k)
  }
  return result
}

export function emaAll(values: number[], period: number): number[] {
  if (values.length < period) return []
  const k = 2 / (period + 1)
  const results: number[] = []
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  results.push(current)
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k)
    results.push(current)
  }
  return results
}

// ── VWAP ──────────────────────────────────────────────────────────────────

export function vwap(candles: Candle[]): number | null {
  if (!candles.length) return null
  let cumVolume = 0
  let cumTpv = 0
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3
    cumTpv += tp * c.volume
    cumVolume += c.volume
  }
  return cumVolume > 0 ? cumTpv / cumVolume : null
}

export function vwapSeries(candles: Candle[]): number[] {
  const results: number[] = []
  let cumVolume = 0
  let cumTpv = 0
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3
    cumTpv += tp * c.volume
    cumVolume += c.volume
    results.push(cumVolume > 0 ? cumTpv / cumVolume : c.close)
  }
  return results
}

// ── RSI ───────────────────────────────────────────────────────────────────

export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1]
    if (diff > 0) gains += diff
    else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

// ── ATR ───────────────────────────────────────────────────────────────────

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low
    const hpc = Math.abs(candles[i].high - candles[i - 1].close)
    const lpc = Math.abs(candles[i].low - candles[i - 1].close)
    trs.push(Math.max(hl, hpc, lpc))
  }
  if (trs.length < period) return null
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period
  }
  return atrVal
}

// ── Relative volume ────────────────────────────────────────────────────────

export function relativeVolume(
  currentVolume: number,
  avgVolume: number,
  sessionFractionElapsed: number
): number | null {
  if (!avgVolume || sessionFractionElapsed <= 0) return null
  const expectedAtThisPoint = avgVolume * sessionFractionElapsed
  return expectedAtThisPoint > 0 ? currentVolume / expectedAtThisPoint : null
}

/**
 * Fraction of the 09:30–16:00 ET session elapsed — 0 before the open, 1 after
 * the close. RVOL paces the day's volume against this, so it MUST be measured in
 * ET: computing it off the host clock measured the *local* trading day, which on
 * a London machine (BST, 5h ahead) read 0.77 at the 09:30 ET open and pinned to
 * 1.0 from 11:00 ET onward. Morning RVOL therefore came out 10–20× too low —
 * exactly when the momentum book trades — so the in-play gate (RVOL ≥ 2) and the
 * runner extension cap (RVOL ≥ 5) were being asked of numbers that could not
 * reach them. Before the open this is 0 and RVOL is null by design: there is no
 * regular session to pace against yet (see `premarket-volume.ts` for the
 * premarket measure).
 */
export function sessionFractionElapsed(ts: number = Date.now()): number {
  const mins = etMinutesOfDay(ts)
  const open = 9 * 60 + 30
  const close = 16 * 60
  return Math.min(Math.max((mins - open) / (close - open), 0), 1)
}

// ── Session levels ─────────────────────────────────────────────────────────

export function calculateSessionLevels(
  intradayCandles: Candle[],
  dailyCandles: Candle[],
  livePrice?: number,
  liveVolume?: number
): SessionLevels {
  const now = Date.now() / 1000
  const todayStart = getTodayStartUnix()

  const today = intradayCandles.filter(c => c.time >= todayStart)
  const premarket = today.filter(c => isPremarket(c.time * 1000))
  const regular = today.filter(c => isRegularHours(c.time * 1000))

  const premarketHigh = premarket.length ? Math.max(...premarket.map(c => c.high)) : null
  const premarketLow = premarket.length ? Math.min(...premarket.map(c => c.low)) : null
  const premarketVolume = premarket.length ? premarket.reduce((s, c) => s + c.volume, 0) : null

  const regularHigh = regular.length ? Math.max(...regular.map(c => c.high)) : null
  const regularLow = regular.length ? Math.min(...regular.map(c => c.low)) : null
  const openingPrint = regular.length ? regular[0]?.open ?? null : null

  // 5-min opening range
  const or5Candles = regular.filter(c => c.time < regular[0]?.time + 300)
  const or5High = or5Candles.length ? Math.max(...or5Candles.map(c => c.high)) : null
  const or5Low = or5Candles.length ? Math.min(...or5Candles.map(c => c.low)) : null

  // 15-min opening range
  const or15Candles = regular.filter(c => c.time < regular[0]?.time + 900)
  const or15High = or15Candles.length ? Math.max(...or15Candles.map(c => c.high)) : null
  const or15Low = or15Candles.length ? Math.min(...or15Candles.map(c => c.low)) : null

  // VWAP anchors to the active session: today's regular candles once the bell
  // rings, otherwise today's premarket candles — so a premarket-anchored VWAP is
  // available before the open instead of nothing (which was silently disabling
  // every VWAP-based setup in premarket).
  const vwapBase = regular.length ? regular : premarket
  // Incorporate live price tick into VWAP so it reflects current quote, not just last closed candle
  const vwapCandles = (livePrice != null && liveVolume != null && liveVolume > 0 && vwapBase.length)
    ? [...vwapBase, { time: Date.now() / 1000, open: livePrice, high: livePrice, low: livePrice, close: livePrice, volume: liveVolume }]
    : vwapBase
  const vwapVal = vwapCandles.length ? vwap(vwapCandles) : null

  const prevDay = dailyCandles.length >= 2 ? dailyCandles[dailyCandles.length - 2] : null
  const previousClose = prevDay?.close ?? null
  const previousDayHigh = prevDay?.high ?? null
  const previousDayLow = prevDay?.low ?? null

  void now

  return {
    premarketHigh,
    premarketLow,
    premarketVolume,
    regularHigh,
    regularLow,
    openingPrint,
    or5High,
    or5Low,
    or15High,
    or15Low,
    vwap: vwapVal,
    previousClose,
    previousDayHigh,
    previousDayLow,
  }
}

function getTodayStartUnix(): number {
  // Midnight ET (not local/UTC) so candles are bucketed correctly regardless of server timezone
  const now = new Date()
  const etMidnight = new Date(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now) + ', 00:00:00'
  )
  return etMidnight.getTime() / 1000
}

// ── Full technical calculation ─────────────────────────────────────────────

export function calculateTechnical(
  intradayCandles: Candle[],
  dailyCandles: Candle[],
  currentVolume: number,
  avgVolume: number,
  sessionLevels: SessionLevels,
  livePrice?: number   // live quote price — injected to bring EMAs/VWAP current
): TechnicalData {
  const closes = intradayCandles.map(c => c.close)
  const todayStart = getTodayStartUnix()

  // Session-aware indicator frame. Regular-session candles drive EMAs/RSI/VWAP
  // cross during and after regular hours (unchanged). Before the open, use
  // TODAY's premarket candles (when there are enough to form the moving averages)
  // so the indicators track the live premarket tape instead of anchoring to
  // yesterday's close — the reason premarket setups sat pinned to stale levels.
  const regular = intradayCandles.filter(c => isRegularHours(c.time * 1000))
  const todayPremarket = intradayCandles.filter(c => c.time >= todayStart && isPremarket(c.time * 1000))
  const frame = (isPremarket(Date.now()) && todayPremarket.length >= 9) ? todayPremarket : regular
  const frameCloses = frame.map(c => c.close)

  // If livePrice is newer than the last candle close, append it so indicators are current
  const lastClose = closes[closes.length - 1] ?? null
  const effectivePrice = livePrice ?? lastClose
  const closesWithLive = livePrice != null && livePrice !== lastClose
    ? [...frameCloses, livePrice]
    : frameCloses

  const vwapVal = sessionLevels.vwap
  const currentPrice = effectivePrice

  const distanceFromVwapPct =
    vwapVal && currentPrice
      ? ((currentPrice - vwapVal) / vwapVal) * 100
      : null

  // Before the open there is no regular-session high yet — fall back to the
  // premarket high so extension/roadmap logic still has a session ceiling.
  const dayHigh = sessionLevels.regularHigh ?? sessionLevels.premarketHigh
  const distanceFromDayHighPct =
    dayHigh && currentPrice
      ? ((currentPrice - dayHigh) / dayHigh) * 100
      : null

  // Intraday EMAs — use closesWithLive so they reflect the current quote price
  const ema9Val = ema(closesWithLive, 9)
  const ema20Val = ema(closesWithLive, 20)
  const ma50IntradayVal = sma(closesWithLive, 50)

  // RSI on live closes
  const rsi14Val = rsi(closesWithLive, 14)

  // ATR on intraday
  const atrVal = atr(intradayCandles.filter(c => c.time >= todayStart - 86400), 14)

  const rvol = relativeVolume(currentVolume, avgVolume, sessionFractionElapsed())

  // Volume trend
  const recentCandles = intradayCandles.slice(-6)
  const firstHalf = recentCandles.slice(0, 3).reduce((s, c) => s + c.volume, 0)
  const secondHalf = recentCandles.slice(3).reduce((s, c) => s + c.volume, 0)
  const volumeTrend =
    secondHalf > firstHalf * 1.1
      ? 'increasing'
      : secondHalf < firstHalf * 0.9
      ? 'decreasing'
      : 'flat'

  // Trend direction from recent candles
  const last5 = intradayCandles.slice(-5)
  const last15 = intradayCandles.slice(-15)
  const trend5m = trendDirection(last5)
  const trend15m = trendDirection(last15)

  // Higher highs/lows
  const highs = intradayCandles.slice(-10).map(c => c.high)
  const lows = intradayCandles.slice(-10).map(c => c.low)
  const hhhl = isHigherHighsLows(highs, lows)
  const lhll = isLowerHighsLows(highs, lows)

  // VWAP cross count — over the active session frame (premarket before the open)
  const vwapSer = vwapSeries(frame)
  let crosses = 0
  for (let i = 1; i < frame.length && i < vwapSer.length; i++) {
    const prevAbove = frame[i - 1].close > vwapSer[i - 1]
    const currAbove = frame[i].close > vwapSer[i]
    if (prevAbove !== currAbove) crosses++
  }

  // Daily indicators
  const dailyCloses = dailyCandles.map(c => c.close)
  const ma50Daily = sma(dailyCloses, 50)
  const ma200Daily = sma(dailyCloses, 200)
  const dailyRsiVal = rsi(dailyCloses, 14)
  const dailyAtrVal = atr(dailyCandles, 14)

  const prevClose = sessionLevels.previousClose
  const todayOpen = sessionLevels.openingPrint
  const gapPct =
    prevClose && todayOpen ? ((todayOpen - prevClose) / prevClose) * 100 : null

  const recent5d = dailyCandles.slice(-5)
  const fiveDayHigh = recent5d.length ? Math.max(...recent5d.map(c => c.high)) : null
  const fiveDayLow = recent5d.length ? Math.min(...recent5d.map(c => c.low)) : null

  const recent20d = dailyCandles.slice(-20)
  const twentyDayHigh = recent20d.length ? Math.max(...recent20d.map(c => c.high)) : null
  const twentyDayLow = recent20d.length ? Math.min(...recent20d.map(c => c.low)) : null

  const avgVol20d =
    recent20d.length >= 5
      ? recent20d.reduce((s, c) => s + c.volume, 0) / recent20d.length
      : null

  // Range breakout
  const last5dHigh = dailyCandles.slice(-6, -1).reduce((m, c) => Math.max(m, c.high), 0)
  const isBreakingOutOfRange = currentPrice != null && last5dHigh > 0 && currentPrice > last5dHigh

  return {
    vwap: vwapVal,
    ema9: ema9Val,
    ema20: ema20Val,
    ma50Intraday: ma50IntradayVal,
    rsi14: rsi14Val,
    atr: atrVal,
    relativeVolume: rvol,
    volumeTrend,
    trend5m,
    trend15m,
    vwapCrossCount: crosses,
    higherHighsLows: hhhl,
    lowerHighsLows: lhll,
    distanceFromVwapPct,
    distanceFromDayHighPct,
    ma50Daily,
    ma200Daily,
    dailyRsi: dailyRsiVal,
    dailyAtr: dailyAtrVal,
    gapPct,
    fiveDayHigh,
    fiveDayLow,
    twentyDayHigh,
    twentyDayLow,
    avgVolume20d: avgVol20d,
    isBreakingOutOfRange,
  }
}

function trendDirection(candles: Candle[]): 'up' | 'down' | 'flat' {
  if (candles.length < 2) return 'flat'
  const first = candles[0].close
  const last = candles[candles.length - 1].close
  const pct = (last - first) / first
  if (pct > 0.003) return 'up'
  if (pct < -0.003) return 'down'
  return 'flat'
}

function isHigherHighsLows(highs: number[], lows: number[]): boolean | null {
  if (highs.length < 4) return null
  const n = highs.length
  return (
    highs[n - 1] > highs[n - 3] &&
    highs[n - 2] > highs[n - 4] &&
    lows[n - 1] > lows[n - 3] &&
    lows[n - 2] > lows[n - 4]
  )
}

function isLowerHighsLows(highs: number[], lows: number[]): boolean | null {
  if (highs.length < 4) return null
  const n = highs.length
  return (
    highs[n - 1] < highs[n - 3] &&
    highs[n - 2] < highs[n - 4] &&
    lows[n - 1] < lows[n - 3] &&
    lows[n - 2] < lows[n - 4]
  )
}

// ── Support & Resistance ───────────────────────────────────────────────────

export function calculateSupportResistance(
  intradayCandles: Candle[],
  sessionLevels: SessionLevels,
  currentPrice: number,
  technical: TechnicalData
): SupportResistanceZone[] {
  // ATR-based clustering threshold: 0.5× intraday ATR, min 0.3%, max 1.5%
  const atrVal = technical.atr ?? currentPrice * 0.005
  const clusterPct = Math.min(0.015, Math.max(0.003, atrVal / currentPrice * 0.5))

  const candidateLevels: Array<{ price: number; reasons: string[]; type: 'support' | 'resistance' | 'pivot' }> = []

  const add = (price: number | null | undefined, reason: string, type: 'support' | 'resistance' | 'pivot') => {
    if (price == null || price <= 0) return
    const existing = candidateLevels.find(l => Math.abs(l.price - price) / price < clusterPct)
    if (existing) {
      existing.reasons.push(reason)
    } else {
      candidateLevels.push({ price, reasons: [reason], type })
    }
  }

  // Session levels
  const sl = sessionLevels
  const priceDir = (p: number) => (p < currentPrice ? 'support' : 'resistance') as 'support' | 'resistance'

  add(sl.vwap, 'VWAP', priceDir(sl.vwap ?? 0))
  add(sl.premarketHigh, 'Premarket High', priceDir(sl.premarketHigh ?? 0))
  add(sl.premarketLow, 'Premarket Low', priceDir(sl.premarketLow ?? 0))
  add(sl.previousDayHigh, 'Previous Day High', priceDir(sl.previousDayHigh ?? 0))
  add(sl.previousDayLow, 'Previous Day Low', priceDir(sl.previousDayLow ?? 0))
  add(sl.previousClose, 'Previous Close', 'pivot')
  add(sl.or5High, '5-min OR High', priceDir(sl.or5High ?? 0))
  add(sl.or5Low, '5-min OR Low', priceDir(sl.or5Low ?? 0))
  add(sl.or15High, '15-min OR High', priceDir(sl.or15High ?? 0))
  add(sl.or15Low, '15-min OR Low', priceDir(sl.or15Low ?? 0))
  add(sl.regularHigh, 'Day High', 'resistance')
  add(sl.regularLow, 'Day Low', 'support')

  // Technical levels
  add(technical.ema9, '9 EMA', priceDir(technical.ema9 ?? 0))
  add(technical.ema20, '20 EMA', priceDir(technical.ema20 ?? 0))
  add(technical.ma50Daily, '50-day MA', priceDir(technical.ma50Daily ?? 0))
  add(technical.ma200Daily, '200-day MA', priceDir(technical.ma200Daily ?? 0))

  // Whole and half-dollar levels
  const base = Math.floor(currentPrice)
  for (let i = base - 3; i <= base + 4; i++) {
    add(i, 'Whole dollar', priceDir(i))
    add(i + 0.5, 'Half dollar', priceDir(i + 0.5))
  }

  // Swing highs/lows from intraday candles
  const swings = findSwingPoints(intradayCandles)
  for (const s of swings.highs) add(s, 'Swing High', 'resistance')
  for (const s of swings.lows) add(s, 'Swing Low', 'support')

  // Cluster and score — use ATR for adaptive thresholds
  const atrForSR = technical.atr ?? currentPrice * 0.005
  return clusterAndScore(candidateLevels, currentPrice, intradayCandles, atrForSR)
}

function findSwingPoints(candles: Candle[]): { highs: number[]; lows: number[] } {
  const highs: number[] = []
  const lows: number[] = []
  const n = 3
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) isHigh = false
      if (candles[j].low <= c.low) isLow = false
    }
    if (isHigh) highs.push(c.high)
    if (isLow) lows.push(c.low)
  }
  return { highs, lows }
}

function clusterAndScore(
  candidates: Array<{ price: number; reasons: string[]; type: 'support' | 'resistance' | 'pivot' }>,
  currentPrice: number,
  candles: Candle[],
  atrVal: number
): SupportResistanceZone[] {
  // ATR-based clustering — merge levels within 0.5× ATR of each other
  const clusterThresh = Math.max(atrVal * 0.5, currentPrice * 0.003)
  candidates.sort((a, b) => a.price - b.price)

  const merged: typeof candidates = []
  for (const c of candidates) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(last.price - c.price) < clusterThresh) {
      last.reasons = [...new Set([...last.reasons, ...c.reasons])]
      last.price = (last.price + c.price) / 2
    } else {
      merged.push({ ...c, reasons: [...c.reasons] })
    }
  }

  // Zone span = 0.25× ATR on each side
  const span = Math.max(atrVal * 0.25, currentPrice * 0.002)

  const zones: SupportResistanceZone[] = []
  for (const m of merged) {
    const reactions = countReactions(candles, m.price, span)
    // 5-tier strength: 1 weak → 10 very strong
    // Confluence sources × 2 + reactions (weighted)
    const rawScore = m.reasons.length * 1.5 + reactions * 1.5
    const score = Math.min(10, Math.max(1, Math.round(rawScore)))
    const lower = m.price - span
    const upper = m.price + span
    const status: SupportResistanceZone['status'] =
      currentPrice >= lower && currentPrice <= upper
        ? 'testing'
        : m.reasons.includes('failed')
        ? 'failed'
        : 'intact'
    zones.push({
      lower,
      upper,
      midpoint: m.price,
      type: m.type,
      strengthScore: score,
      reasons: m.reasons,
      priorReactions: reactions,
      status,
    })
  }

  // Return strongest, closest to price first
  return zones
    .sort((a, b) => {
      const distA = Math.abs(a.midpoint - currentPrice)
      const distB = Math.abs(b.midpoint - currentPrice)
      return distA - distB
    })
    .slice(0, 12)
}

function countReactions(candles: Candle[], price: number, tolerance: number): number {
  let count = 0
  let inZone = false
  for (const c of candles) {
    const near = c.low <= price + tolerance && c.high >= price - tolerance
    if (near && !inZone) {
      count++
      inZone = true
    } else if (!near) {
      inZone = false
    }
  }
  return count
}
