/**
 * MIKE'S STRATEGY — 1-minute rejection telemetry (observational only).
 *
 * Completed 1m evidence is recorded after acceptance. It NEVER feeds the veto — the
 * engine's 5m REJECTED_BREAKOUT rule is unchanged and never sees 1m data.
 */
import { describe, it, expect } from 'vitest'
import { evaluateMike } from '../src/lib/mike/engine'
import { computeRejectionTelemetry, completedOneMin } from '../src/lib/mike/driver'
import type { MikeInput } from '../src/lib/mike/types'
import type { Candle } from '../src/types'

function bar5(open: number, high: number, low: number, close: number, t = 0): Candle {
  return { time: 1_700_000_000 + t * 300, open, high, low, close, volume: 1000 }
}
function bar1(open: number, high: number, low: number, close: number, t = 0): Candle {
  return { time: 1_700_000_000 + t * 60, open, high, low, close, volume: 500 }
}
const LEVEL = 5.0

describe('1m rejection telemetry', () => {
  // 5m stays above the level (no 5m close below), but a 1m bar dips and closes below.
  const candles5m = [bar5(5.02, 5.08, 5.01, 5.06, 0), bar5(5.05, 5.10, 5.02, 5.08, 1)]
  const oneMinBelow = [bar1(5.06, 5.07, 4.98, 4.99, 0), bar1(4.99, 5.05, 4.97, 5.03, 1)]

  it('records a completed 1m close below the level that the 5m rule misses', () => {
    const tel = computeRejectionTelemetry(candles5m, LEVEL, 0, 5.08, oneMinBelow)!
    expect(tel.completed5mClosedBelow).toBe(false)      // the 5m rule saw nothing
    expect(tel.oneMin).not.toBeNull()
    expect(tel.oneMin!.closedBelow).toBe(true)
    expect(tel.oneMin!.firstCloseBelowBar).toBe(0)
    expect(tel.oneMin!.tradedIntrabarBelow).toBe(true)
    expect(tel.oneMin!.maxExcursionBelowPct!).toBeLessThan(0)
    expect(tel.oneMin!.recoveredAfter).toBe(true)       // second 1m closed back above
    expect(tel.completed1mClosedBelow).toBe(true)        // convenience mirror
  })

  it('does NOT alter the engine state / veto outcome', () => {
    // Engine never receives 1m; on this 5m tape it does not reject.
    const inp: MikeInput = {
      symbol: 'ONEM', session: 'regular', now: 1_700_000_000_000, price: 5.08, candles5m,
      indicators: { vwap: 4.9, ema9: null, ema21: null, rvol: 3 }, levels: [],
      refs: { previousDayHigh: 5.0, premarketHigh: null, dayHigh: null, twentyDayHigh: null },
    }
    const cand = evaluateMike(inp)
    expect(cand.veto?.reason).not.toBe('REJECTED_BREAKOUT')
    expect(cand.acceptance.accepted).toBe(true)

    // The 5m-level telemetry fields are identical whether or not 1m tape is supplied.
    const without = computeRejectionTelemetry(candles5m, LEVEL, 0, 5.08, null)!
    const withOne = computeRejectionTelemetry(candles5m, LEVEL, 0, 5.08, oneMinBelow)!
    expect(without.tradedIntrabarBelow).toBe(withOne.tradedIntrabarBelow)
    expect(without.completed5mClosedBelow).toBe(withOne.completed5mClosedBelow)
    expect(without.barsToFirstBelow).toBe(withOne.barsToFirstBelow)
    expect(without.oneMin).toBeNull()
  })

  it('ignores still-forming 1m bars (only completed count)', () => {
    const bars = [bar1(5, 5.05, 4.95, 5.02, 0), bar1(5.02, 5.06, 4.9, 4.99, 1)]
    const now = (bars[1].time + 10) * 1000   // second 1m bar still forming
    const done = completedOneMin(bars, now)
    expect(done).toHaveLength(1)
    expect(done[0].time).toBe(bars[0].time)
    // exact boundary is complete
    expect(completedOneMin(bars, (bars[1].time + 60) * 1000)).toHaveLength(2)
  })
})
