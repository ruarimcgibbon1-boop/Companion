/**
 * Leg-maturity gate (2026-08-11).
 *
 * Added after resolving all 18 executed paper trades against the 5-min tape: 12 of
 * 18 were stopped out inside the bar they entered, and the segmentation pointed at
 * how far the LEG had already run — a dimension `maxTriggerExtension` does not
 * measure, because it only caps distance past the trigger LEVEL.
 *
 * These test the measurement helpers, which are what the gate keys on. The
 * threshold itself is swept on the replay, not asserted here.
 */
import { describe, it, expect } from 'vitest'
import { legRunUpPct, greenStreak, TRIGGERS_QUARANTINED } from '../src/lib/setup-detectors'
import type { Candle } from '../src/types'

/** Build bars from (low, close) pairs; open is derived so close>open marks a green bar. */
function bars(pairs: [low: number, close: number][]): Candle[] {
  return pairs.map(([low, close], i) => ({
    time: 1_700_000_000 + i * 300,
    open: close - 0.01,
    high: close + 0.02,
    low,
    close,
    volume: 10_000,
  }))
}

describe('legRunUpPct', () => {
  it('measures the trigger against the lowest low in the window', () => {
    // Low of 10.00, trigger at 11.00 → the leg has run 10%.
    const c = bars([[10, 10.2], [10.4, 10.6], [10.5, 10.8]])
    expect(legRunUpPct(c, 11)!).toBeCloseTo(10, 5)
  })

  it('catches a name sitting on its trigger after a huge run (the AUUD case)', () => {
    // AUUD entered right at its trigger while 82% above its 10-bar low, and passed
    // every existing gate. This is the hole the new gate closes.
    const c = bars([[1.0, 1.1], [1.2, 1.4], [1.5, 1.7]])
    expect(legRunUpPct(c, 1.82)!).toBeCloseTo(82, 0)
  })

  it('is near zero for an entry taken off the base', () => {
    const c = bars([[10, 10.05], [9.98, 10.02], [10.0, 10.04]])
    expect(legRunUpPct(c, 10.1)!).toBeLessThan(1.5)
  })

  it('fails OPEN (null) when the tape is too short to judge', () => {
    // Never treat "unknown" as "over-extended" — the 2026-07-20 silent-[] trap.
    expect(legRunUpPct(bars([[10, 10.1]]), 10.5)).toBeNull()
    expect(legRunUpPct([], 10.5)).toBeNull()
  })

  it('fails OPEN on a non-positive price', () => {
    expect(legRunUpPct(bars([[10, 10.1], [10, 10.2], [10, 10.3]]), 0)).toBeNull()
  })

  it('only looks back over the window it is given', () => {
    // An old, much lower low outside the lookback must not inflate the run-up.
    const c = bars([[1, 1.1], [9.9, 10.0], [9.95, 10.05], [10.0, 10.1]])
    expect(legRunUpPct(c, 10.2, 3)!).toBeLessThan(4)
  })
})

describe('quarantined triggers (thesis cut, 2026-08-11)', () => {
  it('quarantines exactly the four setups the 20-day replay showed negative in R', () => {
    // Guard against a silent edit: each of these was net-negative in R over the
    // replay, premarket_breakout worst at −10.3R. Changing this set changes what
    // the live executor is allowed to buy, so it should never move by accident.
    expect([...TRIGGERS_QUARANTINED].sort()).toEqual([
      'ema21_bounce', 'momentum_pullback', 'premarket_breakout', 'pullback',
    ])
  })

  it('keeps the setups that carry the book', () => {
    // opening_range_break (+14.1R) and opening_drive (+13.5R) are 84% of the profit;
    // break_of_structure and hod_break stay because cutting them LOWERS net R.
    for (const keep of ['opening_range_break', 'opening_drive', 'break_of_structure', 'hod_break']) {
      expect(TRIGGERS_QUARANTINED.has(keep as never)).toBe(false)
    }
  })
})

describe('greenStreak', () => {
  it('counts consecutive up-closes ending at the most recent bar', () => {
    const c = bars([[10, 9.9], [10, 10.2], [10, 10.4]])
    c[0].open = 10.0   // red
    expect(greenStreak(c)).toBe(2)
  })

  it('is 0 when the last bar closed down — the profile that died 10 of 12 times', () => {
    const c = bars([[10, 10.2], [10, 10.4]])
    c[c.length - 1].open = 10.6   // red close
    expect(greenStreak(c)).toBe(0)
  })

  it('is 0 on an empty tape', () => {
    expect(greenStreak([])).toBe(0)
  })
})
