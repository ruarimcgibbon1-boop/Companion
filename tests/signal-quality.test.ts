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
import { calculateSessionLevels } from '../src/lib/technical'
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
    expect(longBounceRolledOver(ctx(c, 4.8, { technical: technical({ distanceFromDayHighPct: -13 }) }))).toBe(true)
  })
  it('does not veto a shallow pullback near the highs (SKIN/LUCY winners)', () => {
    const c = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0])
    expect(longBounceRolledOver(ctx(c, 5.0, { technical: technical({ distanceFromDayHighPct: -1 }) }))).toBe(false)
  })
  it('vetoes at the tightened 5% threshold (6% off high, rolling — was missed at 8%)', () => {
    const c = bars([5.3, 5.2, 5.1, 5.05, 5.0, 4.95, 4.9])
    expect(longBounceRolledOver(ctx(c, 4.9, { technical: technical({ distanceFromDayHighPct: -6, atr: 0.08 }) }))).toBe(true)
  })
  it('does NOT veto a high-ATR momentum name for a sub-1.5-ATR pullback (2026-07-10 JZXN)', () => {
    // atr 0.4 on a ~4.9 price ≈ 8% ATR → 6% off high is <1 ATR, just breathing
    const c = bars([5.3, 5.2, 5.1, 5.05, 5.0, 4.95, 4.9])
    expect(longBounceRolledOver(ctx(c, 4.9, { technical: technical({ distanceFromDayHighPct: -6, atr: 0.4 }) }))).toBe(false)
  })
  it('falls back to a candle scan when the day-high reading is unavailable', () => {
    const c = bars([5.0, 5.3, 5.5, 5.35, 5.15, 4.95, 4.8])
    expect(longBounceRolledOver(ctx(c, 4.8, { technical: technical({ distanceFromDayHighPct: null }) }))).toBe(true)
  })
})

describe('premarket-anchored VWAP', () => {
  // Timestamps for 08:00 ET *today* (EDT = -04:00 in July), robust to the machine's
  // local timezone. These are today's premarket bars with NO regular-session bars.
  function todayPremarketBars(closes: number[]): Candle[] {
    const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
    const base = Math.floor(new Date(`${etDate}T08:00:00-04:00`).getTime() / 1000)
    return closes.map((c, i) => ({
      time: base + i * 60,
      open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c, volume: 50_000,
    }))
  }

  it('produces a VWAP from premarket candles when there is no regular session yet', () => {
    const candles = todayPremarketBars([2.0, 2.1, 2.25, 2.3, 2.28, 2.35, 2.4])
    const sl = calculateSessionLevels(candles, [])
    // Before this change vwap was null in premarket (regular-only) — now it anchors to premarket.
    expect(sl.vwap).not.toBeNull()
    expect(sl.vwap!).toBeGreaterThan(2.0)
    expect(sl.vwap!).toBeLessThan(2.4)
    expect(sl.premarketHigh).toBeCloseTo(2.42, 1)
  })
})

describe('entry-on-trigger + extension drop', () => {
  // A rising series that closes strong, so a long bounce/momentum setup can trigger.
  const rising = bars([4.7, 4.78, 4.86, 4.95, 5.0, 5.04, 5.08])

  it('entryFill is the current price when price is above the zone (buy the reclaim, not a limit below)', () => {
    const setups = detectSetups(ctx(rising, 5.08))
    const longs = setups.filter(s => s.direction === 'long' && s.entryFill != null)
    expect(longs.length).toBeGreaterThan(0)
    for (const s of longs) {
      // never asks you to enter below current price on a long
      expect(s.entryFill!).toBeGreaterThanOrEqual(Math.min(s.zoneUpper, 5.08) - 1e-9)
    }
  })

  it('does not trigger a long bounce when price is >4% above the entry zone (a chase, not a bounce)', () => {
    // price 5.50 sits ~8% above a ~5.05 zone — the PRME-EMA21 / ELTX-pullback case
    const setups = detectSetups(ctx(rising, 5.5))
    for (const s of setups) {
      if (s.direction === 'long' && s.zoneUpper > 0 && 5.5 > s.zoneUpper * 1.04) {
        expect(s.state).not.toBe('triggered')
        expect(s.triggeredRaw ?? false).toBe(false)
      }
    }
  })
})

describe('data-integrity gate', () => {
  it('builds no setups when the quote price is wildly outside the candle tape', () => {
    const c = bars([1.09, 1.10, 1.11, 1.10, 1.12, 1.13, 1.11])   // tape ~1.07–1.15
    expect(detectSetups(ctx(c, 1.55)).length).toBe(0)             // quote 1.55 = ~35% above (DCX/HAO case)
  })
  it('still trades a genuine fast tick just above recent highs', () => {
    const c = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0])
    expect(detectSetups(ctx(c, 5.2)).length).toBeGreaterThan(0)   // 5.2 within 10% of the ~5.08 high
  })
})

describe('new momentum setups', () => {
  it('detects a bull flag — sharp pole then a tight consolidation', () => {
    const c = bars([3.98,4.08,4.20,4.30,4.42,4.50,4.56,4.60,4.62, 4.55,4.52,4.54,4.53,4.56])
    expect(detectSetups(ctx(c, 4.56)).some(s => s.type === 'bull_flag')).toBe(true)
  })

  it('bull flag carries measured-move targets above the pole high', () => {
    const c = bars([3.98,4.08,4.20,4.30,4.42,4.50,4.56,4.60,4.62, 4.55,4.52,4.54,4.53,4.56])
    const bf = detectSetups(ctx(c, 4.56)).find(s => s.type === 'bull_flag')
    expect(bf).toBeTruthy()
    expect(bf!.targets.some(t => t.price > 4.64)).toBe(true)   // 1× measured move clears the pole high
  })

  it('detects a break of structure — rising swing highs over a higher low', () => {
    const c = bars([4.00,4.06,4.15,4.08,4.02,4.12,4.28,4.20,4.14,4.24,4.40,4.32,4.26,4.36,4.52,4.46,4.50,4.54])
    expect(detectSetups(ctx(c, 4.54)).some(s => s.type === 'break_of_structure')).toBe(true)
  })

  it('does not fire momentum setups in a clear downtrend', () => {
    const c = bars([4.62,4.5,4.4,4.3,4.2,4.1,4.0,3.9,3.8,3.75,3.7,3.68,3.66,3.64])
    const types = new Set(detectSetups(ctx(c, 3.64, { technical: technical({ trend5m: 'down' }) })).map(s => s.type))
    expect(types.has('bull_flag')).toBe(false)
    expect(types.has('break_of_structure')).toBe(false)
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
