/**
 * SPACE gate — room to the next meaningful supply, measured in R.
 *
 * From the support/resistance framework: "BREAKOUT LEVEL → OPEN PRICE SPACE →
 * NEXT SUPPLY AREA". This was the one variable the engine never measured, and its
 * absence had a specific consequence — the target ladder's reward floor skips a
 * level that sits closer than the minimum reward and rates a FURTHER one as T1, so
 * a setup with supply 0.5% overhead got a manufactured 2% target instead of being
 * refused.
 */
import { describe, it, expect } from 'vitest'
import { spaceToNextSupply, closedAboveLevel, acceptedAbove } from '../src/lib/setup-detectors'
import type { KeyLevel } from '../src/types'

function level(midpoint: number, strength: number): KeyLevel {
  return {
    midpoint, lower: midpoint * 0.999, upper: midpoint * 1.001,
    strength, touches: 2, sourceLabels: ['test'], kind: 'resistance',
  } as unknown as KeyLevel
}

describe('spaceToNextSupply', () => {
  it('measures room to the nearest meaningful level, in R', () => {
    // Fill 10.00, stop distance 0.20 (=1R). Supply at 10.40 → 0.40 away = 2R.
    const s = spaceToNextSupply([level(10.4, 60)], 10, 0.2, 'long')
    expect(s.nextSupply).toBe(10.4)
    expect(s.pct!).toBeCloseTo(4, 1)
    expect(s.r!).toBeCloseTo(2, 2)
  })

  it('reports the no-room case the gate refuses', () => {
    // Exercise 20.2: flag at 3.95, breakout 4.00, next supply 4.08 — "Breaks $4.00,
    // stalls $4.06, reverses." Stop under the flag at 3.90 = 0.10 risk, and only
    // 0.08 of room: the trade cannot earn 1R before it meets sellers.
    const s = spaceToNextSupply([level(4.08, 60)], 4.0, 0.1, 'long')
    expect(s.r!).toBeCloseTo(0.8, 2)
    expect(s.r!).toBeLessThan(1.0)
  })

  it('takes the NEAREST meaningful level, not the most significant one', () => {
    // The immediate problem is the closest supply, however big the one behind it.
    const s = spaceToNextSupply([level(12, 90), level(10.2, 50)], 10, 0.2, 'long')
    expect(s.nextSupply).toBe(10.2)
  })

  it('ignores weak levels so noise cannot veto a trade', () => {
    // A 20-strength blip 0.5% overhead is not supply. The real level is 10.60.
    const s = spaceToNextSupply([level(10.05, 20), level(10.6, 70)], 10, 0.2, 'long')
    expect(s.nextSupply).toBe(10.6)
    expect(s.r!).toBeCloseTo(3, 2)
  })

  it('fails OPEN when nothing is overhead — open space is the BEST case', () => {
    // Lesson 20.14, the two-month high with nothing above it. Must never veto.
    const s = spaceToNextSupply([], 10, 0.2, 'long')
    expect(s).toEqual({ nextSupply: null, pct: null, r: null })
  })

  it('fails OPEN when every level overhead is too weak to count', () => {
    expect(spaceToNextSupply([level(10.1, 10)], 10, 0.2, 'long').nextSupply).toBeNull()
  })

  it('ignores levels below the fill for a long', () => {
    // Former resistance now under us is support, not the next problem.
    expect(spaceToNextSupply([level(9.5, 80)], 10, 0.2, 'long').nextSupply).toBeNull()
  })

  it('mirrors for shorts — supply becomes demand below', () => {
    const s = spaceToNextSupply([level(9.6, 70)], 10, 0.2, 'short')
    expect(s.nextSupply).toBe(9.6)
    expect(s.r!).toBeCloseTo(2, 2)
  })

  it('returns a null R rather than dividing by a zero stop', () => {
    const s = spaceToNextSupply([level(10.4, 60)], 10, 0, 'long')
    expect(s.nextSupply).toBe(10.4)
    expect(s.r).toBeNull()
  })

  it('fails OPEN on a non-positive fill', () => {
    expect(spaceToNextSupply([level(10.4, 60)], 0, 0.2, 'long').nextSupply).toBeNull()
  })
})

describe('closedAboveLevel — acceptance', () => {
  const bar = (close: number) => ({ time: 0, open: close, high: close, low: close, close, volume: 1 })

  it('accepts when the last bar closed above the level', () => {
    expect(closedAboveLevel([bar(9.9), bar(10.2)], 10, 1)).toBe(true)
  })

  it('REFUSES a wick through the level that closed back below', () => {
    // Lesson 9 Fakeout A: price traded above but never achieved acceptance. This
    // is the trade that killed 12 of 18 live entries inside their own bar.
    expect(closedAboveLevel([bar(9.9), bar(9.95)], 10, 1)).toBe(false)
  })

  it('requires EVERY one of the last N bars to close above', () => {
    expect(closedAboveLevel([bar(10.2), bar(9.98)], 10, 2)).toBe(false)
    expect(closedAboveLevel([bar(10.1), bar(10.2)], 10, 2)).toBe(true)
  })

  it('is disabled at 0 bars, so the default ships unchanged', () => {
    expect(closedAboveLevel([bar(9.5)], 10, 0)).toBe(true)
  })

  it('passes when there is not enough tape to judge — never block on unknown', () => {
    expect(closedAboveLevel([bar(10.2)], 10, 3)).toBe(true)
    expect(closedAboveLevel([], 10, 1)).toBe(true)
  })

  it('passes on a nonsense level rather than vetoing every setup', () => {
    expect(closedAboveLevel([bar(9.5)], 0, 1)).toBe(true)
  })
})

describe('acceptedAbove — drops the forming bar', () => {
  // A bar whose close is the given price; the LAST element is the forming bar
  // (its close = current price), exactly as the detectors see it live.
  const bar = (close: number) => ({ time: 0, open: close, high: close, low: close, close, volume: 1 })

  it('REFUSES a wick even though the forming bar is above the level', () => {
    // The failed-breakout buy: prior completed bar closed 9.9 (below 10), the
    // forming bar is printing 10.2 above it. The trigger fires on that print;
    // acceptance must still refuse it, because no completed bar closed above.
    expect(acceptedAbove([bar(9.9), bar(10.2)], 10, 1)).toBe(false)
  })

  it('accepts once a COMPLETED bar has closed above, forming bar aside', () => {
    // Prior bar closed 10.2 (accepted); forming bar now printing 10.4.
    expect(acceptedAbove([bar(9.8), bar(10.2), bar(10.4)], 10, 1)).toBe(true)
  })

  it('is a no-op at 0 bars — the pre-2026-08-15 default', () => {
    expect(acceptedAbove([bar(9.9), bar(10.2)], 10, 0)).toBe(true)
  })

  it('fails OPEN with only a forming bar and nothing completed', () => {
    // <2 bars: after dropping the forming one there is nothing to judge, so never
    // block — the session-open case, consistent with the fail-open rule.
    expect(acceptedAbove([bar(10.2)], 10, 1)).toBe(true)
    expect(acceptedAbove([], 10, 1)).toBe(true)
  })
})
