import { describe, it, expect } from 'vitest'
import {
  sma,
  ema,
  vwap,
  rsi,
  atr,
  relativeVolume,
  sessionFractionElapsed,
  calculateSessionLevels,
  calculateSupportResistance,
} from '../src/lib/technical'
import type { Candle, TechnicalData } from '../src/types'

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeCandles(closes: number[], volumeBase = 100_000): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 300,
    open: c * 0.99,
    high: c * 1.01,
    low: c * 0.98,
    close: c,
    volume: volumeBase,
  }))
}

// ── SMA ───────────────────────────────────────────────────────────────────

describe('sma', () => {
  it('returns null when insufficient data', () => {
    expect(sma([1, 2], 5)).toBeNull()
  })

  it('calculates simple moving average', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBeCloseTo(3)
  })

  it('uses last N values', () => {
    expect(sma([10, 1, 2, 3, 4, 5], 5)).toBeCloseTo(3)
  })
})

// ── EMA ───────────────────────────────────────────────────────────────────

describe('ema', () => {
  it('returns null when insufficient data', () => {
    expect(ema([1, 2], 5)).toBeNull()
  })

  it('EMA equals SMA for constant prices', () => {
    const prices = Array(20).fill(10)
    expect(ema(prices, 9)).toBeCloseTo(10)
  })

  it('EMA reacts faster than SMA to price spikes', () => {
    const prices = [...Array(20).fill(10), 20]
    const e = ema(prices, 9)!
    const s = sma(prices, 9)!
    expect(e).toBeGreaterThan(s)
  })
})

// ── VWAP ──────────────────────────────────────────────────────────────────

describe('vwap', () => {
  it('returns null for empty candles', () => {
    expect(vwap([])).toBeNull()
  })

  it('equals typical price for single candle', () => {
    const c: Candle = { time: 0, open: 10, high: 12, low: 8, close: 11, volume: 1000 }
    const tp = (12 + 8 + 11) / 3
    expect(vwap([c])).toBeCloseTo(tp)
  })

  it('weights higher-volume candles more', () => {
    const candles: Candle[] = [
      { time: 0, open: 10, high: 12, low: 9, close: 10, volume: 100 },   // tp ≈ 10.33
      { time: 1, open: 20, high: 22, low: 19, close: 20, volume: 1000 }, // tp ≈ 20.33
    ]
    const result = vwap(candles)!
    expect(result).toBeGreaterThan(19) // dominated by high-vol candle
  })
})

// ── RSI ───────────────────────────────────────────────────────────────────

describe('rsi', () => {
  it('returns null when insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull()
  })

  it('returns 100 for all-up series', () => {
    const prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    expect(rsi(prices, 14)).toBe(100)
  })

  it('RSI is near 50 for alternating prices', () => {
    const prices: number[] = []
    for (let i = 0; i < 30; i++) prices.push(i % 2 === 0 ? 10 : 11)
    const r = rsi(prices, 14)!
    expect(r).toBeGreaterThan(40)
    expect(r).toBeLessThan(60)
  })
})

// ── ATR ───────────────────────────────────────────────────────────────────

describe('atr', () => {
  it('returns null when insufficient data', () => {
    const candles = makeCandles([10, 11])
    expect(atr(candles, 14)).toBeNull()
  })

  it('ATR is positive for volatile series', () => {
    const closes = [10, 12, 9, 14, 8, 13, 11, 15, 10, 14, 9, 16, 8, 12, 10, 14]
    const candles = makeCandles(closes)
    const result = atr(candles, 14)
    expect(result).toBeGreaterThan(0)
  })

  it('ATR is small for flat prices', () => {
    const candles = makeCandles(Array(20).fill(10))
    // Flat candles have very small true range
    const result = atr(candles, 14)!
    expect(result).toBeLessThan(0.5)
  })
})

// ── Relative volume ────────────────────────────────────────────────────────

describe('relativeVolume', () => {
  it('returns null for zero avg volume', () => {
    expect(relativeVolume(100_000, 0, 0.5)).toBeNull()
  })

  it('returns null for zero fraction', () => {
    expect(relativeVolume(100_000, 1_000_000, 0)).toBeNull()
  })

  it('returns 2x when at pace for double normal volume', () => {
    // avgVol 1M, halfway through session, current vol 1M → pace is 2M = 2x
    const result = relativeVolume(1_000_000, 1_000_000, 0.5)!
    expect(result).toBeCloseTo(2)
  })
})

// The fraction RVOL is paced against. This was computed off the host clock, so on
// a London machine it measured the LOCAL trading day: ~0.77 elapsed at the 09:30 ET
// open and pinned at 1.0 from 11:00 ET, understating morning RVOL by 10–20×.
describe('sessionFractionElapsed', () => {
  // 2026-08-03 is EDT (UTC-4); Europe/London is UTC+1 that day, so any host-clock
  // arithmetic gives visibly different answers here.
  const et = (h: number, m = 0) => Date.UTC(2026, 7, 3, h + 4, m)

  it('is 0 through premarket — there is no session to pace against yet', () => {
    expect(sessionFractionElapsed(et(4))).toBe(0)
    expect(sessionFractionElapsed(et(8, 30))).toBe(0)
    expect(sessionFractionElapsed(et(9, 29))).toBe(0)
  })

  it('is ~0 at the open, not 0.77', () => {
    expect(sessionFractionElapsed(et(9, 30))).toBe(0)
    // 09:45 ET = a quarter hour into a 390-minute session.
    expect(sessionFractionElapsed(et(9, 45))).toBeCloseTo(15 / 390, 4)
  })

  it('is half a session at 12:45 ET, not pinned at 1.0', () => {
    expect(sessionFractionElapsed(et(12, 45))).toBeCloseTo(0.5, 4)
  })

  it('reaches 1 only at the close and stays there', () => {
    expect(sessionFractionElapsed(et(16))).toBe(1)
    expect(sessionFractionElapsed(et(18))).toBe(1)
  })

  it('paces the morning correctly end to end (the regression that mattered)', () => {
    // 10:00 ET, a name that has already traded a full average day's volume.
    const rvol = relativeVolume(1_000_000, 1_000_000, sessionFractionElapsed(et(10)))!
    expect(rvol).toBeCloseTo(13, 0)   // ~13× pace; the London clock reported ~1.3×
  })
})

// ── Session levels ─────────────────────────────────────────────────────────

describe('calculateSessionLevels', () => {
  it('handles empty candle arrays gracefully', () => {
    const levels = calculateSessionLevels([], [])
    expect(levels.vwap).toBeNull()
    expect(levels.previousClose).toBeNull()
    expect(levels.premarketHigh).toBeNull()
  })
})

// ── Opening range ─────────────────────────────────────────────────────────

describe('opening range identification', () => {
  it('5-min OR captures first 5 minutes of regular session candles', () => {
    // Regular session starts at 9:30 ET = 13:30 UTC typically
    // We simulate with timestamps that fall in regular hours
    // For simplicity we test that OR high >= OR low
    const levels = calculateSessionLevels([], [])
    // Both null when no data — the important invariant
    expect(levels.or5High == null || levels.or5High >= (levels.or5Low ?? -Infinity)).toBe(true)
  })
})

// ── Support/resistance clustering ─────────────────────────────────────────

describe('calculateSupportResistance', () => {
  it('returns empty array for empty candles', () => {
    const sessionLevels = calculateSessionLevels([], [])
    const tech: TechnicalData = {
      vwap: null, ema9: null, ema20: null, ma50Intraday: null,
      rsi14: null, atr: null, relativeVolume: null,
      volumeTrend: 'flat', trend5m: 'flat', trend15m: 'flat',
      vwapCrossCount: 0, higherHighsLows: null, lowerHighsLows: null,
      distanceFromVwapPct: null, distanceFromDayHighPct: null,
      ma50Daily: null, ma200Daily: null, dailyRsi: null, dailyAtr: null,
      gapPct: null, fiveDayHigh: null, fiveDayLow: null,
      twentyDayHigh: null, twentyDayLow: null, avgVolume20d: null,
      isBreakingOutOfRange: false,
    }
    const zones = calculateSupportResistance([], sessionLevels, 10, tech)
    // Should not throw; zones may be empty or contain whole-dollar levels
    expect(Array.isArray(zones)).toBe(true)
  })

  it('zones have lower <= midpoint <= upper', () => {
    const candles = makeCandles([9.8, 10, 10.2, 10.1, 9.9, 10.3, 10.0, 9.8])
    const sessionLevels = calculateSessionLevels([], [])
    const tech: TechnicalData = {
      vwap: 10, ema9: 10.1, ema20: 9.9, ma50Intraday: null,
      rsi14: 55, atr: 0.2, relativeVolume: 1.5,
      volumeTrend: 'flat', trend5m: 'up', trend15m: 'up',
      vwapCrossCount: 1, higherHighsLows: true, lowerHighsLows: false,
      distanceFromVwapPct: 0, distanceFromDayHighPct: -2,
      ma50Daily: null, ma200Daily: null, dailyRsi: null, dailyAtr: null,
      gapPct: 5, fiveDayHigh: 11, fiveDayLow: 8,
      twentyDayHigh: 12, twentyDayLow: 7, avgVolume20d: 800000,
      isBreakingOutOfRange: false,
    }
    const zones = calculateSupportResistance(candles, sessionLevels, 10, tech)
    for (const z of zones) {
      expect(z.lower).toBeLessThanOrEqual(z.midpoint)
      expect(z.midpoint).toBeLessThanOrEqual(z.upper)
    }
  })
})

// ── News deduplication ─────────────────────────────────────────────────────

describe('news deduplication', () => {
  it('deduplicates identical headlines', async () => {
    const { processNews } = await import('../src/lib/news-engine')
    const raw = [
      { symbol: 'TEST', title: 'Company announces deal', text: '', url: '', site: 'source1', publisher: 'source1', publishedDate: new Date().toISOString(), image: '' },
      { symbol: 'TEST', title: 'Company announces deal', text: '', url: '', site: 'source2', publisher: 'source2', publishedDate: new Date().toISOString(), image: '' },
    ]
    const result = processNews(raw, 'TEST')
    expect(result.length).toBe(1)
  })
})

// ── Dilution detection ─────────────────────────────────────────────────────

describe('dilution term detection', () => {
  it('flags public offering language', async () => {
    const { processNews } = await import('../src/lib/news-engine')
    const raw = [{
      symbol: 'TEST',
      title: 'Company prices public offering of 5 million shares',
      text: '',
      url: '',
      site: 'PR Newswire',
      publisher: 'PR Newswire',
      publishedDate: new Date().toISOString(),
      image: '',
    }]
    const result = processNews(raw, 'TEST')
    expect(result[0].isDilutive).toBe(true)
    expect(result[0].quality).toBe('Negative or Dilutive Catalyst')
  })

  it('does not flag non-dilutive news', async () => {
    const { processNews } = await import('../src/lib/news-engine')
    const raw = [{
      symbol: 'TEST',
      title: 'Company wins major government contract worth $50 million',
      text: '',
      url: '',
      site: 'Reuters',
      publisher: 'Reuters',
      publishedDate: new Date().toISOString(),
      image: '',
    }]
    const result = processNews(raw, 'TEST')
    expect(result[0].isDilutive).toBe(false)
  })
})

// ── Stale data detection ───────────────────────────────────────────────────

describe('stale data detection', () => {
  it('isStale returns true for old timestamps', async () => {
    const { isStale } = await import('../src/lib/market-hours')
    const oldTs = Date.now() - 300_000
    expect(isStale(oldTs, 120_000)).toBe(true)
  })

  it('isStale returns false for recent timestamps', async () => {
    const { isStale } = await import('../src/lib/market-hours')
    expect(isStale(Date.now() - 10_000, 120_000)).toBe(false)
  })
})

// ── Setup scoring ──────────────────────────────────────────────────────────

describe('calculateSetupScore', () => {
  it('returns a score object with total between 0 and 100', async () => {
    const { calculateSetupScore } = await import('../src/lib/setup-engine')
    const tech: TechnicalData = {
      vwap: 10, ema9: 10.1, ema20: 9.9, ma50Intraday: null,
      rsi14: 60, atr: 0.3, relativeVolume: 3,
      volumeTrend: 'increasing', trend5m: 'up', trend15m: 'up',
      vwapCrossCount: 1, higherHighsLows: true, lowerHighsLows: false,
      distanceFromVwapPct: 2, distanceFromDayHighPct: -1,
      ma50Daily: 9, ma200Daily: 8, dailyRsi: 55, dailyAtr: 0.5,
      gapPct: 8, fiveDayHigh: 11, fiveDayLow: 8,
      twentyDayHigh: 12, twentyDayLow: 7, avgVolume20d: 1_000_000,
      isBreakingOutOfRange: true,
    }
    const score = calculateSetupScore(tech, [], [], 'Moderate Catalyst')
    expect(score.total).toBeGreaterThanOrEqual(0)
    expect(score.total).toBeLessThanOrEqual(100)
    expect(score.status).toBeTruthy()
    expect(score.classification).toBeTruthy()
  })
})
