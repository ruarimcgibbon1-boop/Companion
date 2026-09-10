/**
 * MIKE'S STRATEGY — shadow outcome tracking (evidence only, never an order).
 */
import { describe, it, expect } from 'vitest'
import { evaluateMike } from '../src/lib/mike/engine'
import { resolveMikeShadow, mikeShadowReference, mikeShadowStop } from '../src/lib/mike/shadow'
import type { MikeInput } from '../src/lib/mike/types'
import type { Candle } from '../src/types'

const SINCE = 1_700_000_000_000
function bar(open: number, high: number, low: number, close: number, t: number): Candle {
  return { time: Math.floor(SINCE / 1000) + t * 300, open, high, low, close, volume: 1000 }
}

describe('resolveMikeShadow', () => {
  it('records a +10% hit without reaching +15%', () => {
    const o = resolveMikeShadow(5.0, 4.5, [bar(5.0, 5.2, 4.95, 5.1, 0), bar(5.1, 5.55, 5.05, 5.5, 1)], SINCE)
    expect(o.hit10).toBe(true)
    expect(o.hit15).toBe(false)
    expect(o.reachedRunner).toBe(false)
    expect(o.resolved).toBe(true)
  })
  it('records a +15% runner', () => {
    const o = resolveMikeShadow(5.0, 4.5, [bar(5.0, 5.2, 4.95, 5.1, 0), bar(5.1, 5.85, 5.05, 5.8, 1)], SINCE)
    expect(o.hit15).toBe(true)
    expect(o.reachedRunner).toBe(true)
  })
  it('records stop-equivalent downside (adverse first)', () => {
    const o = resolveMikeShadow(5.0, 4.5, [bar(5.0, 5.05, 4.40, 4.45, 0)], SINCE)
    expect(o.hitStop).toBe(true)
    expect(o.hit10).toBe(false)
  })
  it('is empty (unresolved) when there is no tape at/after the signal', () => {
    const o = resolveMikeShadow(5.0, 4.5, [bar(5.0, 5.5, 4.9, 5.4, -100)], SINCE) // bar before SINCE
    expect(o.resolved).toBe(false)
  })
})

describe('continued shadow tracking AFTER a veto', () => {
  it('a vetoed candidate is still tracked to +10% (evidence, no order)', () => {
    // Build a REJECTED_BREAKOUT candidate.
    const input: MikeInput = {
      symbol: 'VET', session: 'regular', now: SINCE, price: 4.96,
      candles5m: [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.05, 5.06, 4.90, 4.95, 1)],
      indicators: { vwap: null, ema9: null, ema21: null, rvol: null }, levels: [],
      refs: { previousDayHigh: 5.0, premarketHigh: null, dayHigh: null, twentyDayHigh: null },
    }
    const cand = evaluateMike(input)
    expect(cand.veto?.reason).toBe('REJECTED_BREAKOUT')

    // The setup subsequently DID run — the shadow must capture that (false-negative signal).
    const ref = mikeShadowReference(cand)!
    const stop = mikeShadowStop(cand)
    const future = [bar(5.0, 5.2, 4.9, 5.15, 2), bar(5.15, 5.85, 5.1, 5.8, 3)]
    const shadow = resolveMikeShadow(ref, stop, future, SINCE)
    expect(ref).toBe(5.0)                 // reference = the frozen breakout level for a veto
    expect(shadow.hit10).toBe(true)
    expect(shadow.hit15).toBe(true)       // a runner Mike passed on → veto false-negative
  })
})

describe('shadow reference/stop selection', () => {
  it('uses the intended entry + plan stop for a TRADED candidate', () => {
    const input: MikeInput = {
      symbol: 'GO', session: 'regular', now: SINCE, price: 5.10,
      candles5m: [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.06, 5.12, 5.05, 5.10, 1)],
      indicators: { vwap: 4.9, ema9: null, ema21: null, rvol: 3 }, levels: [],
      refs: { previousDayHigh: 5.0, premarketHigh: null, dayHigh: null, twentyDayHigh: null },
    }
    const cand = evaluateMike(input)
    expect(cand.outcome).toBe('TRADED')
    expect(mikeShadowReference(cand)).toBe(cand.tradePlan!.entry)
    expect(mikeShadowStop(cand)).toBe(cand.tradePlan!.stop.price)
  })
})
