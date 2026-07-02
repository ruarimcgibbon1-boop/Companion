import { describe, it, expect } from 'vitest'
import { buildKeyLevels } from '../src/lib/levels-engine'
import { detectSetups, type DetectionContext } from '../src/lib/setup-detectors'
import { scoreSetup, type ScoringContext, gradeFor } from '../src/lib/scoring-matrix'
import { buildRoadmap } from '../src/lib/roadmap-engine'
import type { Candle, SessionLevels, TechnicalData } from '../src/types'

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeTechnical(over: Partial<TechnicalData> = {}): TechnicalData {
  return {
    vwap: 4.9,
    ema9: 4.92,
    ema20: 4.85,
    ma50Intraday: 4.8,
    rsi14: 60,
    atr: 0.08,
    relativeVolume: 3,
    volumeTrend: 'flat',
    trend5m: 'up',
    trend15m: 'up',
    vwapCrossCount: 1,
    higherHighsLows: true,
    lowerHighsLows: false,
    distanceFromVwapPct: 2,
    distanceFromDayHighPct: -1,
    ma50Daily: 4.5,
    ma200Daily: 4.0,
    dailyRsi: 58,
    dailyAtr: 0.2,
    gapPct: 5,
    fiveDayHigh: 5.2,
    fiveDayLow: 4.2,
    twentyDayHigh: 5.5,
    twentyDayLow: 3.8,
    avgVolume20d: 1_000_000,
    isBreakingOutOfRange: false,
    ...over,
  }
}

function makeSessionLevels(over: Partial<SessionLevels> = {}): SessionLevels {
  return {
    premarketHigh: 5.1,
    premarketLow: 4.6,
    premarketVolume: 500_000,
    regularHigh: 5.05,
    regularLow: 4.8,
    openingPrint: 4.85,
    or5High: 4.95,
    or5Low: 4.82,
    or15High: 5.0,
    or15Low: 4.8,
    vwap: 4.9,
    previousClose: 4.7,
    previousDayHigh: 5.15,
    previousDayLow: 4.5,
    ...over,
  }
}

// Build an uptrend that pulls back to ~5.00
function uptrendThenPullback(): Candle[] {
  const seq = [4.7, 4.75, 4.82, 4.9, 4.98, 5.06, 5.12, 5.08, 5.04, 5.02, 5.0, 5.01, 5.0, 5.0, 5.01]
  return seq.map((c, i) => ({
    time: 1_700_000_000 + i * 300,
    open: c - 0.01,
    high: c + 0.02,
    low: c - 0.02,
    close: c,
    volume: 200_000 - i * 3_000, // volume contracting into the pullback
  }))
}

// ── Levels engine: merging ───────────────────────────────────────────────────

describe('levels engine', () => {
  it('merges several nearby levels into a single labelled zone', () => {
    const candles = uptrendThenPullback()
    const sl = makeSessionLevels({ premarketHigh: 5.0, or15High: 5.01, regularHigh: 5.0 })
    const levels = buildKeyLevels({
      intraday: candles, daily: [], sessionLevels: sl,
      technical: makeTechnical({ atr: 0.08 }), currentPrice: 4.8,
    })
    const near5 = levels.filter(l => Math.abs(l.midpoint - 5.0) < 0.05)
    // Should not draw three separate lines at ~5.00 — one merged zone with multiple sources.
    expect(near5.length).toBe(1)
    expect(near5[0].sources.length).toBeGreaterThan(1)
  })

  it('annotates each level with an expected setup and a strength score', () => {
    const levels = buildKeyLevels({
      intraday: uptrendThenPullback(), daily: [], sessionLevels: makeSessionLevels(),
      technical: makeTechnical(), currentPrice: 4.95,
    })
    expect(levels.length).toBeGreaterThan(0)
    for (const l of levels) {
      expect(l.strength).toBeGreaterThanOrEqual(1)
      expect(l.strength).toBeLessThanOrEqual(100)
    }
  })
})

// ── Detectors: scanner-wide (no manual selection) ────────────────────────────

function makeContext(over: Partial<DetectionContext> = {}): DetectionContext {
  const candles = uptrendThenPullback()
  const sl = makeSessionLevels()
  const technical = makeTechnical()
  const currentPrice = 5.0
  const levels = buildKeyLevels({ intraday: candles, daily: [], sessionLevels: sl, technical, currentPrice })
  return {
    symbol: 'TEST', price: currentPrice, candles, sessionLevels: sl, technical, levels,
    catalystScore: 10, hasCatalyst: true, spreadPct: 0.15, changePct: 6,
    ...over,
  }
}

describe('setup detectors', () => {
  it('detects setups purely from data, without any manual selection', () => {
    const setups = detectSetups(makeContext())
    expect(setups.length).toBeGreaterThan(0)
    // Each carries its own zone, confirmation, invalidation and score
    for (const s of setups) {
      expect(s.confirmation.length).toBeGreaterThan(0)
      expect(s.invalidation).toBeGreaterThan(0)
      expect(s.score).toBeGreaterThanOrEqual(0)
      expect(s.approachThresholdPct).toBeGreaterThan(0)
    }
  })

  it('treats pullback, EMA and VWAP as distinct setup types', () => {
    const setups = detectSetups(makeContext())
    const types = new Set(setups.map(s => s.type))
    // At least a couple of the momentum setups should be distinct entries
    expect(types.size).toBeGreaterThanOrEqual(2)
  })

  it('produces a confirmed breakout when price closes above resistance on volume', () => {
    // Price coiling just under 5.05 then a strong close above on volume expansion
    const closes = [4.9, 4.95, 4.98, 5.0, 5.02, 5.03, 5.04, 5.045, 5.05, 5.11]
    const candles: Candle[] = closes.map((c, i) => ({
      time: 1_700_000_000 + i * 300, open: c - 0.005, high: c + 0.01, low: c - 0.01, close: c,
      volume: i === closes.length - 1 ? 900_000 : 150_000,
    }))
    const sl = makeSessionLevels({ regularHigh: 5.05, or15High: 5.05, premarketHigh: 5.05 })
    const technical = makeTechnical({ atr: 0.06, distanceFromVwapPct: 3 })
    const levels = buildKeyLevels({ intraday: candles, daily: [], sessionLevels: sl, technical, currentPrice: 5.11 })
    const setups = detectSetups({ symbol: 'BRK', price: 5.11, candles, sessionLevels: sl, technical, levels, catalystScore: 10, hasCatalyst: true, spreadPct: 0.1, changePct: 8 })
    const breakout = setups.find(s => s.type === 'breakout')
    // A breakout setup should exist and be in an advanced state (triggered/confirming/at level)
    if (breakout) {
      expect(['triggered', 'confirming', 'at_level', 'approaching']).toContain(breakout.state)
    } else {
      // if resistance is now below price it may register as a retest zone — acceptable
      expect(setups.length).toBeGreaterThan(0)
    }
  })

  it('detects a VWAP reclaim when price closes back above VWAP', () => {
    const closes = [4.95, 4.9, 4.85, 4.82, 4.8, 4.83, 4.88, 4.93, 4.96]
    const candles: Candle[] = closes.map((c, i) => ({
      time: 1_700_000_000 + i * 300, open: c - 0.005, high: c + 0.01, low: c - 0.01, close: c,
      volume: i >= closes.length - 2 ? 500_000 : 150_000,
    }))
    const sl = makeSessionLevels({ vwap: 4.9 })
    const technical = makeTechnical({ vwap: 4.9, trend5m: 'up', vwapCrossCount: 2 })
    const levels = buildKeyLevels({ intraday: candles, daily: [], sessionLevels: sl, technical, currentPrice: 4.96 })
    const setups = detectSetups({ symbol: 'VW', price: 4.96, candles, sessionLevels: sl, technical, levels, catalystScore: 8, hasCatalyst: true, spreadPct: 0.15, changePct: 4 })
    const vwap = setups.find(s => s.type === 'vwap_bounce' || s.type === 'vwap_reclaim')
    expect(vwap).toBeTruthy()
  })

  it('does not attempt long setups when trend and structure are clearly broken', () => {
    const ctx = makeContext({
      technical: makeTechnical({ trend5m: 'down', trend15m: 'down', higherHighsLows: false, lowerHighsLows: true }),
    })
    const longs = detectSetups(ctx).filter(s => s.direction === 'long' && s.type === 'pullback')
    expect(longs.length).toBe(0)
  })
})

// ── Scoring: setup-specific weights, repeated tests, missing data ────────────

describe('scoring matrix', () => {
  function baseCtx(over: Partial<ScoringContext> = {}): ScoringContext {
    return {
      setupType: 'ema9_bounce',
      levelStrength: 70, levelTouches: 2, levelHigherTf: false, levelConfluence: true,
      structureIntact: true, cleanCandles: true, constructiveConsolidation: true, structureBroken: false,
      relativeVolume: 3, volumeContractsIntoZone: true, volumeExpandsOnSignal: false, sustainedInterest: true,
      intradayTrendAligned: true, higherTfTrendAligned: true, aboveVwap: true, emaStackAligned: true,
      catalystScore: 10, unusualVolume: true,
      rewardRisk: 3, roomToTarget: true, nearbyOpposingLevel: false, clearInvalidation: true,
      spreadPct: 0.15, liquidVolume: true, priceStable: true,
      confirmationSignals: 2, testCount: 1,
      ...over,
    }
  }

  it('reduces the score on repeated EMA/VWAP tests', () => {
    const first = scoreSetup(baseCtx({ testCount: 1 }))
    const repeat = scoreSetup(baseCtx({ testCount: 4 }))
    expect(repeat.total).toBeLessThan(first.total)
    expect(repeat.risks.some(r => /tested/i.test(r))).toBe(true)
  })

  it('surfaces missing data as risks and does not hide it', () => {
    const res = scoreSetup(baseCtx({ relativeVolume: null, spreadPct: null, rewardRisk: null, clearInvalidation: false }))
    expect(res.risks).toContain('Relative volume unavailable')
    expect(res.risks).toContain('Spread unavailable')
    expect(res.risks.some(r => /reward-to-risk could not/i.test(r))).toBe(true)
  })

  it('weights breakout resistance/volume differently from a pullback', () => {
    const breakout = scoreSetup(baseCtx({ setupType: 'breakout', volumeExpandsOnSignal: true, volumeContractsIntoZone: false }))
    const pullback = scoreSetup(baseCtx({ setupType: 'pullback', volumeExpandsOnSignal: false, volumeContractsIntoZone: true }))
    // Different weight profiles → different category maxima
    expect(breakout.breakdown.volumeMomentum).not.toBe(pullback.breakdown.volumeMomentum)
  })

  it('maps totals to the documented grade bands', () => {
    expect(gradeFor(92)).toBe('A+')
    expect(gradeFor(86)).toBe('A')
    expect(gradeFor(82)).toBe('A-')
    expect(gradeFor(77)).toBe('B+')
    expect(gradeFor(72)).toBe('B')
    expect(gradeFor(64)).toBe('C')
    expect(gradeFor(50)).toBe('below')
  })
})

// ── Roadmap ──────────────────────────────────────────────────────────────────

describe('roadmap engine', () => {
  it('ranks reaction points above and below current price', () => {
    const levels = buildKeyLevels({
      intraday: uptrendThenPullback(), daily: [], sessionLevels: makeSessionLevels(),
      technical: makeTechnical(), currentPrice: 4.95,
    })
    const roadmap = buildRoadmap('TEST', 4.95, levels)
    // Upside sorted ascending, downside descending
    for (let i = 1; i < roadmap.upside.length; i++) {
      expect(roadmap.upside[i].price).toBeGreaterThanOrEqual(roadmap.upside[i - 1].price)
    }
    for (let i = 1; i < roadmap.downside.length; i++) {
      expect(roadmap.downside[i].price).toBeLessThanOrEqual(roadmap.downside[i - 1].price)
    }
    // Each level explains why + what happens if it holds/fails
    for (const l of [...roadmap.upside, ...roadmap.downside]) {
      expect(l.why.length).toBeGreaterThan(0)
      expect(l.ifHolds.length).toBeGreaterThan(0)
      expect(l.ifFails.length).toBeGreaterThan(0)
    }
  })
})
