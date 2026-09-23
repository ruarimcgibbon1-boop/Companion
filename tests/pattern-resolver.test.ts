/**
 * Pattern-log outcome resolver.
 *
 * Added 2026-08-12 after reviewing an export that had no outcome column at all —
 * 191 rows recording that patterns fired and nothing about whether they worked.
 */
import { describe, it, expect } from 'vitest'
import {
  resolvePattern, resolvePatternLog, patternWinRate,
  PATTERN_BARRIER_PCT, PATTERN_HORIZON_BARS,
} from '../src/lib/pattern-resolver'
import type { Candle, PatternLogRecord } from '../src/types'

const T0 = Math.floor(new Date('2026-08-12T14:00:00Z').getTime() / 1000)
const LATER = (T0 + PATTERN_HORIZON_BARS * 300 + 3600) * 1000

function rec(over: Partial<PatternLogRecord> = {}): PatternLogRecord {
  return {
    id: 'AAA:hammer:10.000', timestamp: T0 * 1000, symbol: 'AAA', pattern: 'hammer',
    strength: 70, atSupport: true, volumeConfirmed: true,
    price: 10, changePct: 20, rvol: 5, outcome: 'open', ...over,
  } as PatternLogRecord
}

/** Bars from (low, high) pairs, 5 minutes apart, starting at the record's time. */
function bars(pairs: [low: number, high: number][], startSec = T0): Candle[] {
  return pairs.map(([low, high], i) => ({
    time: startSec + i * 300,
    open: low, close: high, low, high, volume: 1000,
  }))
}

describe('resolvePattern', () => {
  it('books a win when the up barrier is touched first', () => {
    const r = resolvePattern(rec(), bars([[9.95, 10.05], [9.98, 10.25]]), LATER)!
    expect(r.outcome).toBe('win')
    expect(r.mfePct).toBeCloseTo(2.5, 1)
  })

  it('books a loss when the down barrier is touched first', () => {
    const r = resolvePattern(rec(), bars([[9.95, 10.05], [9.75, 10.0]]), LATER)!
    expect(r.outcome).toBe('loss')
    expect(r.maePct).toBeCloseTo(-2.5, 1)
  })

  it('scores a bar spanning BOTH barriers as the loss', () => {
    // Adverse first — intrabar order is unknown, so never credit the win.
    // Matches eod-resolver's rule so the two measurements stay comparable.
    const r = resolvePattern(rec(), bars([[9.7, 10.4]]), LATER)!
    expect(r.outcome).toBe('loss')
  })

  it('expires when neither barrier is reached inside the horizon', () => {
    const flat: [number, number][] = Array.from({ length: PATTERN_HORIZON_BARS }, () => [9.95, 10.05])
    const r = resolvePattern(rec(), bars(flat), LATER)!
    expect(r.outcome).toBe('expired')
  })

  it('stays unresolved while the horizon is still running', () => {
    // Two quiet bars in and nothing decided: that is missing data, not a loss.
    const soon = (T0 + 600) * 1000
    expect(resolvePattern(rec(), bars([[9.95, 10.05], [9.96, 10.04]]), soon)).toBeNull()
  })

  it('ignores tape from before the pattern fired', () => {
    // A drop an hour earlier must not be scored against a pattern logged after it.
    const before = bars([[9.0, 9.1]], T0 - 3600)
    const after = bars([[9.98, 10.3]])
    const r = resolvePattern(rec(), [...before, ...after], LATER)!
    expect(r.outcome).toBe('win')
    expect(r.maePct).toBeGreaterThan(-1)
  })

  it('returns null with no usable tape or a bad price', () => {
    expect(resolvePattern(rec(), [], LATER)).toBeNull()
    expect(resolvePattern(rec({ price: 0 }), bars([[9, 11]]), LATER)).toBeNull()
  })

  it('uses symmetric barriers, so win rate alone is the edge', () => {
    expect(PATTERN_BARRIER_PCT).toBe(2)
  })
})

describe('resolvePatternLog', () => {
  it('resolves only unresolved rows and fetches each symbol once', async () => {
    const fetched: string[] = []
    const fetch = async (s: string) => { fetched.push(s); return bars([[9.98, 10.3]]) }
    const out = await resolvePatternLog([
      rec({ id: 'a', symbol: 'AAA' }),
      rec({ id: 'b', symbol: 'AAA' }),
      rec({ id: 'c', symbol: 'BBB', outcome: 'win' }),   // already resolved
    ], fetch, LATER)

    expect(out.map(r => r.id).sort()).toEqual(['a', 'b'])
    expect(fetched).toEqual(['AAA'])                      // BBB never fetched
    expect(out.every(r => r.outcome === 'win')).toBe(true)
  })

  it('leaves rows untouched when the tape fetch fails', async () => {
    const out = await resolvePatternLog([rec()], async () => { throw new Error('down') }, LATER)
    expect(out).toEqual([])
  })
})

describe('patternWinRate', () => {
  it('excludes expired rows — they made no directional call', () => {
    const r = patternWinRate([
      rec({ outcome: 'win' }), rec({ outcome: 'win' }),
      rec({ outcome: 'loss' }), rec({ outcome: 'expired' }), rec({ outcome: 'open' }),
    ])
    expect(r).toMatchObject({ wins: 2, losses: 1 })
    expect(r.pct).toBeCloseTo(66.7, 1)
  })

  it('is null when nothing has resolved', () => {
    expect(patternWinRate([rec()]).pct).toBeNull()
  })
})
