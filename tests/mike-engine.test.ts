/**
 * MIKE'S STRATEGY — engine tests (v0.2).
 *
 * Covers the hard 5m-acceptance gate, immediate-rejection veto, the +10% loading
 * ceiling / chase-limit, supporting-confirmation counting (volume never mandatory),
 * structural stop selection, and the trim ladder.
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateMike, fiveMinAcceptance, hasImmediateRejection, withinLoadingCeiling,
  countSupporting, selectStop, buildTradePlan,
} from '../src/lib/mike/engine'
import { DEFAULT_MIKE_CONFIG, type MikeInput, type MikeIndicators } from '../src/lib/mike/types'
import type { Candle } from '../src/types'

const LEVEL = 5.0
function bar(open: number, high: number, low: number, close: number, volume = 1000, t = 0): Candle {
  return { time: 1_700_000_000 + t * 300, open, high, low, close, volume }
}
const noInd: MikeIndicators = { vwap: null, ema9: null, ema21: null, rvol: null }

function input(over: Partial<MikeInput> = {}): MikeInput {
  return {
    symbol: 'TEST', session: 'regular', now: 1_700_000_000_000, price: 5.06,
    candles5m: [], indicators: noInd, levels: [],
    // LEVEL sourced from an established ref (PDH); the running-HOD path is covered separately.
    refs: { previousDayHigh: LEVEL, premarketHigh: null, dayHigh: null, twentyDayHigh: null },
    ...over,
  }
}

// ── 5m acceptance ────────────────────────────────────────────────────────────
describe('fiveMinAcceptance (mandatory hard gate)', () => {
  it('ACCEPTS a candle that opens above AND closes above the level', () => {
    expect(fiveMinAcceptance([bar(5.02, 5.08, 5.01, 5.06)], LEVEL).accepted).toBe(true)
  })
  it('REJECTS a candle that opens below and closes above (must open above too)', () => {
    expect(fiveMinAcceptance([bar(4.98, 5.08, 4.97, 5.06)], LEVEL).accepted).toBe(false)
  })
  it('REJECTS a wick above that closes back below', () => {
    expect(fiveMinAcceptance([bar(4.99, 5.20, 4.95, 4.97)], LEVEL).accepted).toBe(false)
  })
  it('engine surfaces acceptance on a valid candle', () => {
    const c = evaluateMike(input({ candles5m: [bar(5.02, 5.08, 5.01, 5.06)], price: 5.06 }))
    expect(c.acceptance.accepted).toBe(true)
    expect(['ACCEPTED', 'LOADING', 'TRIGGERED']).toContain(c.state)
  })
  it('engine does NOT accept an open-below/close-above candle', () => {
    const c = evaluateMike(input({ candles5m: [bar(4.98, 5.08, 4.97, 5.06)], price: 5.06 }))
    expect(c.acceptance.accepted).toBe(false)
    expect(c.state).not.toBe('TRIGGERED')
  })
})

// ── immediate rejection ──────────────────────────────────────────────────────
describe('immediate rejection (hard gate)', () => {
  it('flags a completed candle that closes back below the level', () => {
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 1000, 0), bar(5.05, 5.06, 4.90, 4.95, 1000, 1)]
    expect(hasImmediateRejection(candles, LEVEL, 0)).toBe(true)
  })
  it('vetoes REJECTED_BREAKOUT in the engine', () => {
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 1000, 0), bar(5.05, 5.06, 4.90, 4.95, 1000, 1)]
    const c = evaluateMike(input({ candles5m: candles, price: 4.96 }))
    expect(c.state).toBe('VETOED')
    expect(c.veto?.reason).toBe('REJECTED_BREAKOUT')
  })
  it('an accepted breakout holding above the level is NOT rejected', () => {
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 1000, 0), bar(5.05, 5.10, 5.03, 5.08, 1000, 1)]
    const c = evaluateMike(input({ candles5m: candles, price: 5.08 }))
    expect(c.acceptance.accepted).toBe(true)
    expect(c.veto?.reason).not.toBe('REJECTED_BREAKOUT')
    expect(['ACCEPTED', 'LOADING', 'TRIGGERED']).toContain(c.state)
  })
})

// ── loading ceiling / chase ──────────────────────────────────────────────────
describe('loading ceiling (+10%) and chase limit', () => {
  it('withinLoadingCeiling: +10% is inside, just past is outside', () => {
    expect(withinLoadingCeiling(5.5, LEVEL, 0.10)).toBe(true)
    expect(withinLoadingCeiling(5.51, LEVEL, 0.10)).toBe(false)
  })
  it('loading zone is [level, level*1.10]', () => {
    const c = evaluateMike(input({ candles5m: [bar(5.02, 5.08, 5.01, 5.06)], price: 5.06 }))
    expect(c.loadingZone).toEqual({ low: 5.0, high: 5.5 })
  })
  it('CHASE_LIMIT when accepted but price is already past +10%', () => {
    const c = evaluateMike(input({ candles5m: [bar(5.02, 5.60, 5.01, 5.55)], price: 5.60 }))
    expect(c.veto?.reason).toBe('CHASE_LIMIT')
    expect(c.state).toBe('EXPIRED')
    expect(c.outcome).toBe('EXPIRED')
  })
  it('CHASE_LIMIT when price runs past +10% before any acceptance', () => {
    // opens below → never accepted, but excursion (high 5.60) exceeds +10%.
    const c = evaluateMike(input({ candles5m: [bar(4.98, 5.60, 4.97, 5.55)], price: 5.60 }))
    expect(c.acceptance.accepted).toBe(false)
    expect(c.veto?.reason).toBe('CHASE_LIMIT')
  })
})

// ── supporting confirmations ─────────────────────────────────────────────────
describe('supporting confirmations (≥2, none individually mandatory)', () => {
  it('TWO supporting confirmations permits a TRIGGER', () => {
    // Two candles both closing above the level (C4) + VWAP support (C5) = 2 supporting.
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 1000, 0), bar(5.06, 5.12, 5.05, 5.10, 1200, 1)]
    const c = evaluateMike(input({ candles5m: candles, price: 5.10, indicators: { vwap: 4.9, ema9: null, ema21: null, rvol: 3 } }))
    expect(c.acceptance.accepted).toBe(true)
    expect(c.supportingCount).toBeGreaterThanOrEqual(2)
    expect(c.state).toBe('TRIGGERED')
    expect(c.tradePlan).not.toBeNull()
  })
  it('FEWER than two does NOT trigger — stays LOADING', () => {
    // Single green accept candle: only C3 (momentum). count = 1.
    const c = evaluateMike(input({ candles5m: [bar(5.02, 5.08, 5.01, 5.06)], price: 5.06, indicators: noInd }))
    expect(c.acceptance.accepted).toBe(true)
    expect(c.supportingCount).toBeLessThan(2)
    expect(c.state).not.toBe('TRIGGERED')
    expect(c.state).toBe('LOADING')
  })
  it('volume is NOT mandatory: a TRIGGER can happen with expandingVolume false', () => {
    // Second candle has LOWER volume (no expansion) but two closes above + VWAP = 2.
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 2000, 0), bar(5.06, 5.12, 5.05, 5.10, 500, 1)]
    const c = evaluateMike(input({ candles5m: candles, price: 5.10, indicators: { vwap: 4.9, ema9: null, ema21: null, rvol: null } }))
    expect(c.supporting.expandingVolume).toBe(false)
    expect(c.state).toBe('TRIGGERED')
  })
  it('volume ALONE yields only one confirmation (insufficient by itself)', () => {
    // acceptIndex 0; only expanding volume is true, everything else false.
    const candles = [bar(5.01, 5.06, 4.90, 5.05, 100, 0), bar(5.02, 5.03, 4.80, 4.95, 200, 1)]
    const { supporting, count } = countSupporting(candles, LEVEL, 5.02, noInd, 0)
    expect(supporting.expandingVolume).toBe(true)
    expect(count).toBe(1)
  })
})

// ── structural stop ──────────────────────────────────────────────────────────
describe('structural stop selection', () => {
  it('accepts a structural stop within 10% (tightest = breakout level)', () => {
    const s = selectStop({ entry: 5.06, level: LEVEL, ind: noInd, higherLow: null, maxStopPct: 0.10 })
    expect(s).not.toBeNull()
    expect(s!.ref).toBe('breakout_level')
    expect(s!.distancePct).toBeLessThanOrEqual(10)
  })
  it('prefers a TIGHTER structural ref when one sits below entry', () => {
    // EMA9 at 5.04 is tighter than the breakout level 5.00.
    const s = selectStop({ entry: 5.06, level: LEVEL, ind: { vwap: 4.8, ema9: 5.04, ema21: 4.9, rvol: null }, higherLow: null, maxStopPct: 0.10 })
    expect(s!.ref).toBe('ema9')
  })
  it('returns null when no structural stop is within 10% → RISK_TOO_WIDE trigger', () => {
    expect(selectStop({ entry: 5.06, level: 4.40, ind: noInd, higherLow: null, maxStopPct: 0.10 })).toBeNull()
  })
  it('engine vetoes RISK_TOO_WIDE when even the level is beyond the max stop', () => {
    // Force a tiny max-stop so the ~1.2% level stop is too wide; still inside the +10% ceiling.
    const cfg = { ...DEFAULT_MIKE_CONFIG, maxStopPct: 0.001 }
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 1000, 0), bar(5.06, 5.12, 5.05, 5.10, 1200, 1)]
    const c = evaluateMike(input({ candles5m: candles, price: 5.10, indicators: { vwap: 4.9, ema9: null, ema21: null, rvol: null }, config: cfg }))
    expect(c.acceptance.accepted).toBe(true)
    expect(c.veto?.reason).toBe('RISK_TOO_WIDE')
  })
})

// ── profit-taking ladder ─────────────────────────────────────────────────────
describe('profit-taking ladder', () => {
  it('+10% sells 50% of original, +15% sells 25% of original, 25% runner remains', () => {
    const stop = selectStop({ entry: 5.0, level: 4.8, ind: noInd, higherLow: null, maxStopPct: 0.10 })!
    const plan = buildTradePlan(5.0, stop, DEFAULT_MIKE_CONFIG)
    expect(plan.trims[0]).toMatchObject({ gainPct: 0.10, sellOriginalFraction: 0.50, targetPrice: 5.5 })
    expect(plan.trims[1]).toMatchObject({ gainPct: 0.15, sellOriginalFraction: 0.25 })
    expect(plan.trims[1].targetPrice).toBeCloseTo(5.75, 6)
    expect(plan.runnerFraction).toBe(0.25)
    expect(plan.trims[0].sellOriginalFraction + plan.trims[1].sellOriginalFraction + plan.runnerFraction).toBeCloseTo(1.0, 6)
    expect(plan.runnerExit).toBe('UNRESOLVED_EXPERIMENTAL')
  })
})

// ── attribution on every candidate ───────────────────────────────────────────
describe('attribution', () => {
  it("every Mike candidate carries strategy: 'mike'", () => {
    for (const c of [
      evaluateMike(input({ candles5m: [bar(5.02, 5.08, 5.01, 5.06)] })),
      evaluateMike(input({ candles5m: [], price: 4.99 })),
      evaluateMike(input({ price: -1 })),
    ]) {
      expect(c.strategy).toBe('mike')
    }
  })
})
