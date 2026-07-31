/**
 * Bullish candlestick pattern detection for the top-gainer pattern scan.
 *
 * The patterns themselves (hammer, engulfing, morning star, three white soldiers)
 * are sub-50% signals in isolation — every source in the research says so. The edge
 * comes from three context filters, which is why a hit carries them:
 *   - location: formed at a pullback low / near support (not mid-range)
 *   - volume:   above-average on the signal candle
 *   - trend:    inside an intraday uptrend (a continuation, not a random reversal)
 * The scan surfaces raw hits with these flags so a hammer AT support on volume reads
 * differently from a hammer floating mid-range.
 */

import type { Candle, CandlePattern, PatternHit } from '@/types'

export type { CandlePattern, PatternHit }

const body = (c: Candle) => Math.abs(c.close - c.open)
const range = (c: Candle) => c.high - c.low
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close)
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low
const isGreen = (c: Candle) => c.close > c.open
const isRed = (c: Candle) => c.close < c.open

// ── Raw shape tests (context-free) ───────────────────────────────────────────

export function isHammer(c: Candle): boolean {
  const r = range(c)
  if (r <= 0) return false
  // Range-relative so it holds for tiny bodies: a long lower wick that dominates
  // the candle, a small upper wick, and a small real body near the top.
  return lowerWick(c) >= r * 0.55 && upperWick(c) <= r * 0.15 && body(c) <= r * 0.35
}

export function isBullishEngulfing(prev: Candle, cur: Candle): boolean {
  return isRed(prev) && isGreen(cur) &&
    cur.close >= prev.open && cur.open <= prev.close &&
    body(cur) > body(prev)
}

export function isMorningStar(a: Candle, b: Candle, c: Candle): boolean {
  // big red → small-bodied indecision → strong green closing back into the red body
  if (!(isRed(a) && isGreen(c))) return false
  if (body(b) > body(a) * 0.5) return false          // middle candle is a small real body
  const aMid = (a.open + a.close) / 2
  return c.close > aMid && body(c) > body(b)
}

export function isThreeWhiteSoldiers(a: Candle, b: Candle, c: Candle): boolean {
  if (!(isGreen(a) && isGreen(b) && isGreen(c))) return false
  if (!(b.close > a.close && c.close > b.close)) return false          // each closes higher
  const opensWithin = b.open >= a.open && b.open <= a.close && c.open >= b.open && c.open <= b.close
  const tightTops = [a, b, c].every(x => upperWick(x) <= body(x) * 0.7)  // not long upper wicks
  return opensWithin && tightTops
}

// ── Scan ─────────────────────────────────────────────────────────────────────

export interface PatternContext {
  /** Price is at a pullback low / near support (VWAP or 9EMA) in an uptrend. */
  atSupport: boolean
  /** Intraday trend is up (a continuation context, not a blind reversal). */
  uptrend: boolean
}

function scoreHit(atSupport: boolean, volumeConfirmed: boolean, uptrend: boolean): number {
  let s = 40 // raw pattern ≈ coin flip
  if (atSupport) s += 25
  if (volumeConfirmed) s += 20
  if (uptrend) s += 15
  return Math.min(100, s)
}

/** Detect bullish candlestick patterns on the most recent candle(s). */
export function detectCandlePatterns(candles: Candle[], ctx: PatternContext): PatternHit[] {
  if (candles.length < 3) return []
  const n = candles.length
  const cur = candles[n - 1], prev = candles[n - 2], prev2 = candles[n - 3]

  const recent = candles.slice(-11, -1) // ~10 bars before the signal candle
  const avgVol = recent.length ? recent.reduce((s, c) => s + c.volume, 0) / recent.length : cur.volume
  const volumeConfirmed = avgVol > 0 && cur.volume > avgVol * 1.2

  const hits: PatternHit[] = []
  const add = (pattern: CandlePattern) => hits.push({
    pattern, atSupport: ctx.atSupport, volumeConfirmed,
    strength: scoreHit(ctx.atSupport, volumeConfirmed, ctx.uptrend),
  })

  if (isHammer(cur)) add('hammer')
  if (isBullishEngulfing(prev, cur)) add('bullish_engulfing')
  if (isMorningStar(prev2, prev, cur)) add('morning_star')
  if (isThreeWhiteSoldiers(prev2, prev, cur)) add('three_white_soldiers')

  return hits
}
