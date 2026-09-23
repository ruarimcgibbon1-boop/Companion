/**
 * Momentum ranking — replaces day-change ordering for the scanner universe.
 *
 * Each case encodes the 2026-08-12 finding: ranking by change-from-close surfaces
 * names AFTER their move, at which point the anti-fade gate correctly refuses
 * them. 9 of 12 top gainers were >5% off their session high; 46 setups on them
 * produced zero triggers.
 */
import { describe, it, expect } from 'vitest'
import {
  readMomentum, compareByMomentum, RANK_MAX_BELOW_HIGH_PCT, MOMENTUM_WINDOW_MIN,
} from '../src/lib/momentum-rank'
import type { Candle } from '../src/types'

const NOW = new Date('2026-08-12T14:00:00Z').getTime()

/** Bars every 5 minutes ending just before NOW; `closes` runs oldest → newest. */
function tape(closes: number[], highs?: number[]): Candle[] {
  const endSec = Math.floor(NOW / 1000) - 60
  return closes.map((c, i) => {
    const time = endSec - (closes.length - 1 - i) * 300
    return { time, open: c, close: c, high: highs?.[i] ?? c, low: c, volume: 10_000 }
  })
}

describe('readMomentum', () => {
  it('measures the move over the trailing window, not since yesterday', () => {
    // Flat at 10 for half an hour, then 10 → 11 inside the last 15 minutes.
    const m = readMomentum(tape([10, 10, 10, 10.5, 11]), 11, NOW)
    expect(m.rocPct).toBeCloseTo(10, 0)   // measured from the 10.00 before the window
    expect(m.nearHigh).toBe(true)
  })

  it('gives a faded name a low score however big its day change', () => {
    // Spiked to 20 then collapsed to 13 — the OFAL/RMCF/BAOS profile.
    const spiked = readMomentum(tape([10, 15, 20, 16, 13], [10, 15, 20, 16, 13]), 13, NOW)
    expect(spiked.offHighPct).toBeCloseTo(-35, 0)
    expect(spiked.nearHigh).toBe(false)

    const running = readMomentum(tape([10, 10, 10, 10.2, 10.6]), 10.6, NOW)
    expect(running.nearHigh).toBe(true)
    // A name up 30% on the day but 35% off its high must NOT outrank one quietly
    // making new highs — that inversion is the entire bug.
    expect(running.score).toBeGreaterThan(spiked.score)
  })

  it('ranks the faster mover first among names that are both near their highs', () => {
    const fast = readMomentum(tape([10, 10, 10, 10.4, 11]), 11, NOW)
    const slow = readMomentum(tape([10, 10, 10, 10.05, 10.1]), 10.1, NOW)
    expect(fast.score).toBeGreaterThan(slow.score)
  })

  it('uses the same fade line the detectors do', () => {
    // If these drift apart, discovery starts ranking names the gates will refuse.
    expect(RANK_MAX_BELOW_HIGH_PCT).toBe(5)
    const edge = readMomentum(tape([10, 10, 10, 10, 9.6], [10, 10, 10, 10, 9.6]), 9.6, NOW)
    expect(edge.offHighPct).toBeCloseTo(-4, 0)
    expect(edge.nearHigh).toBe(true)
  })

  it('fails OPEN when there is no tape or no price', () => {
    // Never bury a row for missing data — the 2026-07-20 silent-[] trap.
    const none = readMomentum([], 10, NOW)
    expect(none.nearHigh).toBe(true)
    expect(none.rocPct).toBeNull()
    expect(none.score).toBeGreaterThan(0)
    expect(readMomentum(tape([10, 11]), 0, NOW).nearHigh).toBe(true)
  })

  it('ignores bars older than the window when measuring the move', () => {
    expect(MOMENTUM_WINDOW_MIN).toBe(15)
    // Crash well OUTSIDE the 15-min window (bars are 5 min apart, so it needs to
    // be >4 bars back), then a quiet base that ticks up. Current momentum is the
    // tick up, not the old crash.
    const m = readMomentum(tape([20, 12, 10, 10, 10, 10.1, 10.3]), 10.3, NOW)
    expect(m.rocPct!).toBeGreaterThan(0)
  })

  it('reads negative when the name is net down across the window', () => {
    const m = readMomentum(tape([10, 10, 12, 11, 9.5]), 9.5, NOW)
    expect(m.rocPct!).toBeLessThan(0)
  })

  it('catches a spike-and-fade through offHigh, not through rocPct', () => {
    // Worth pinning down because it is easy to assume rocPct alone does the work.
    // Spiked to 12 inside the window and fell back to 10.3: still net POSITIVE
    // over the window, so rocPct won't demote it. The fade check does.
    const m = readMomentum(tape([10, 10, 12, 11, 10.3]), 10.3, NOW)
    expect(m.rocPct!).toBeGreaterThan(0)
    expect(m.offHighPct!).toBeLessThan(-RANK_MAX_BELOW_HIGH_PCT)
    expect(m.nearHigh).toBe(false)
  })
})

describe('compareByMomentum', () => {
  const row = (momentumScore: number | null, changePct: number) => ({ momentumScore, changePct })

  it('sorts by momentum score descending', () => {
    const rows = [row(5, 900), row(1_000_010, 20), row(1_000_050, 8)]
    expect(rows.sort(compareByMomentum).map(r => r.changePct)).toEqual([8, 20, 900])
  })

  it('falls back to day change when neither row has a score', () => {
    // Candle feed down → degrade to the old behaviour, not to an arbitrary order.
    const rows = [row(null, 10), row(null, 90)]
    expect(rows.sort(compareByMomentum).map(r => r.changePct)).toEqual([90, 10])
  })

  it('prefers a scored row over an unscored one', () => {
    const rows = [row(null, 500), row(3, 4)]
    expect(rows.sort(compareByMomentum)[0].changePct).toBe(4)
  })
})
