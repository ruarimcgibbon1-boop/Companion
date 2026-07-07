/**
 * Signal-quality guardrails added from the 2026-07-06/07 trade review:
 *  - long-bounce rollover veto (don't buy falling knives off the session high)
 *  - minimum stop-width floor (no degenerate sub-1.5% scalps)
 */
import { describe, it, expect } from 'vitest'
import {
  detectSetups, rollingOver, longBounceRolledOver, type DetectionContext,
} from '../src/lib/setup-detectors'
import { buildKeyLevels } from '../src/lib/levels-engine'
import type { Candle, SessionLevels, TechnicalData } from '../src/types'

function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 300,
    open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c, volume: 100_000,
  }))
}

function technical(over: Partial<TechnicalData> = {}): TechnicalData {
  return {
    vwap: 4.9, ema9: 4.92, ema20: 4.85, ma50Intraday: 4.8, rsi14: 60, atr: 0.08,
    relativeVolume: 3, volumeTrend: 'flat', trend5m: 'up', trend15m: 'up',
    vwapCrossCount: 1, higherHighsLows: true, lowerHighsLows: false,
    distanceFromVwapPct: 2, distanceFromDayHighPct: -1, ma50Daily: 4.5, ma200Daily: 4.0,
    dailyRsi: 58, dailyAtr: 0.2, gapPct: 5, fiveDayHigh: 5.2, fiveDayLow: 4.2,
    twentyDayHigh: 5.5, twentyDayLow: 3.8, avgVolume20d: 1_000_000, isBreakingOutOfRange: false,
    ...over,
  }
}

function session(over: Partial<SessionLevels> = {}): SessionLevels {
  return {
    premarketHigh: 5.1, premarketLow: 4.6, premarketVolume: 500_000, regularHigh: 5.05,
    regularLow: 4.8, openingPrint: 4.85, or5High: 4.95, or5Low: 4.82, or15High: 5.0,
    or15Low: 4.8, vwap: 4.9, previousClose: 4.7, previousDayHigh: 5.15, previousDayLow: 4.5,
    ...over,
  }
}

function ctx(candles: Candle[], price: number, over: Partial<DetectionContext> = {}): DetectionContext {
  const sl = session({ vwap: over.sessionLevels?.vwap ?? price })
  const t = technical(over.technical)
  const levels = buildKeyLevels({ intraday: candles, daily: [], sessionLevels: sl, technical: t, currentPrice: price })
  return {
    symbol: 'TEST', price, candles, sessionLevels: sl, technical: t, levels,
    catalystScore: 10, hasCatalyst: true, spreadPct: 0.15, changePct: 6, ...over,
  }
}

describe('rollingOver', () => {
  it('flags a lower-highs down-leg', () => {
    expect(rollingOver(bars([5.5, 5.4, 5.3, 5.2]))).toBe(true)
  })
  it('does not flag a rising sequence', () => {
    expect(rollingOver(bars([4.8, 4.9, 5.0, 5.1]))).toBe(false)
  })
})

describe('longBounceRolledOver', () => {
  it('vetoes when price is >8% off the session high on lower highs (CLRO/JLHL pattern)', () => {
    // ran to 5.5 then bled to ~4.8 (≈13% off high) making lower highs
    const c = bars([5.0, 5.3, 5.5, 5.35, 5.15, 4.95, 4.8])
    expect(longBounceRolledOver(ctx(c, 4.8))).toBe(true)
  })
  it('does not veto a shallow pullback near the highs (SKIN/LUCY winners)', () => {
    const c = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0])
    expect(longBounceRolledOver(ctx(c, 5.0))).toBe(false)
  })
})

describe('minimum stop-width floor', () => {
  it('never emits a long setup whose stop is tighter than 1.5%', () => {
    // Tiny ATR would otherwise yield a razor-thin stop (the SEER 0.6% case)
    const c = bars([4.9, 4.95, 5.0, 5.02, 5.0, 5.01, 5.0])
    const setups = detectSetups(ctx(c, 5.0, { technical: technical({ atr: 0.005 }) }))
    const longs = setups.filter(s => s.direction === 'long')
    expect(longs.length).toBeGreaterThan(0)
    for (const s of longs) {
      const stopDist = s.zoneUpper - s.invalidation
      expect(stopDist).toBeGreaterThanOrEqual(5.0 * 0.015 - 1e-9)
    }
  })
})
