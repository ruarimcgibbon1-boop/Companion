/**
 * Adaptive early-warning distance.
 *
 * Instead of a single fixed percentage for every stock, the approach threshold
 * is derived from the stock's own volatility profile: ATR, average candle
 * range, share price, and spread. A $0.80 low-float runner and a $180 large-cap
 * need very different "getting close" bands.
 */

import type { Candle, TechnicalData } from '@/types'

export interface ThresholdInput {
  price: number
  technical: TechnicalData
  candles: Candle[]
  spreadPct?: number | null
}

/**
 * Returns the early-warning distance as a percentage of price.
 * Clamped to a sane [0.3%, 6%] band.
 */
export function approachThresholdPct(input: ThresholdInput): number {
  const { price, technical: t, candles, spreadPct } = input
  if (price <= 0) return 1

  // ATR as a percentage of price — the dominant term.
  const atrPct = t.atr && t.atr > 0 ? (t.atr / price) * 100 : null

  // Average candle range over the last ~10 bars.
  const recent = candles.slice(-10)
  const avgRangePct = recent.length
    ? (recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length / price) * 100
    : null

  // Base band: about 0.6× ATR, or ~1.2× the average candle range if ATR missing.
  let band =
    atrPct != null ? atrPct * 0.6
    : avgRangePct != null ? avgRangePct * 1.2
    : 1

  // Low-priced names swing more in percentage terms — widen slightly.
  if (price < 2) band *= 1.4
  else if (price < 5) band *= 1.2
  else if (price > 100) band *= 0.8

  // Wide spreads mean price "arrives" sooner in practical terms — widen.
  if (spreadPct != null && spreadPct > 0.3) band += spreadPct

  // Elevated intraday volatility (many VWAP crosses) — widen a touch.
  if (t.vwapCrossCount > 5) band *= 1.15

  return Math.max(0.3, Math.min(6, Math.round(band * 100) / 100))
}
