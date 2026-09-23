/**
 * Pattern-log admission rules. Each case corresponds to a specific defect in the
 * 2026-08-12 export (191 rows, 115 distinct, and rather fewer useful).
 */
import { describe, it, expect } from 'vitest'
import {
  shouldLogPattern, patternLogId, patternPriceKey,
  PATTERN_LOG_CUTOFF_ET_MIN, PATTERN_MAX_FADE_PCT,
} from '../src/lib/pattern-log-gate'

// 11:00 and 16:30 ET on a weekday (August → EDT, UTC-4).
const MIDDAY = new Date('2026-08-12T15:00:00Z').getTime()
const AFTER_CLOSE = new Date('2026-08-12T20:30:00Z').getTime()

const ctx = (over: Partial<Parameters<typeof shouldLogPattern>[1]> = {}) => ({
  now: MIDDAY, changePct: 20, loggedIds: new Set<string>(), ...over,
})

describe('patternPriceKey', () => {
  it('keys on price so a frozen quote logs once, not once per bucket', () => {
    // INLF logged 21x at exactly 6.27 over three hours under the old time bucket.
    expect(patternPriceKey(6.27)).toBe(patternPriceKey(6.27))
    expect(patternLogId('INLF', 'hammer', 6.27)).toBe('INLF:hammer:6.270')
  })

  it('collapses sub-tick noise but separates a genuine move', () => {
    expect(patternPriceKey(6.2701)).toBe(patternPriceKey(6.2699))
    expect(patternPriceKey(6.27)).not.toBe(patternPriceKey(6.29))
  })

  it('survives a zero or negative price without throwing', () => {
    expect(patternPriceKey(0)).toBe('0')
    expect(patternPriceKey(-1)).toBe('0')
  })
})

describe('shouldLogPattern', () => {
  it('admits a normal in-play occurrence', () => {
    expect(shouldLogPattern('AAA:hammer:10.000', ctx())).toEqual({ log: true })
  })

  it('rejects a repeat at the same price', () => {
    const loggedIds = new Set(['AAA:hammer:10.000'])
    expect(shouldLogPattern('AAA:hammer:10.000', ctx({ loggedIds })))
      .toEqual({ log: false, reason: 'duplicate' })
  })

  it('still admits the same pattern once price has actually moved', () => {
    const loggedIds = new Set([patternLogId('AAA', 'hammer', 10)])
    expect(shouldLogPattern(patternLogId('AAA', 'hammer', 10.4), ctx({ loggedIds })))
      .toEqual({ log: true })
  })

  it('rejects anything at or after the close', () => {
    // 15 of that export's patterns fired at 16:00+, and they were its highest-
    // quality cohort — 60% volume-confirmed, and entirely untradeable.
    expect(shouldLogPattern('AAA:hammer:10.000', ctx({ now: AFTER_CLOSE })))
      .toEqual({ log: false, reason: 'after_cutoff' })
  })

  it('rejects a bullish reversal on a name in freefall', () => {
    // YXT three_white_soldiers at −60.3%; four ONFO hammers at −23% to −27%.
    expect(shouldLogPattern('YXT:three_white_soldiers:9.290', ctx({ changePct: -60.3 })))
      .toEqual({ log: false, reason: 'faded' })
    expect(shouldLogPattern('ONFO:hammer:0.053', ctx({ changePct: -27.3 })))
      .toEqual({ log: false, reason: 'faded' })
  })

  it('still admits a mild pullback — the guard is for knives, not dips', () => {
    expect(shouldLogPattern('AAA:hammer:10.000', ctx({ changePct: -PATTERN_MAX_FADE_PCT + 0.1 })))
      .toEqual({ log: true })
  })

  it('checks duplicates before the session and fade rules', () => {
    // A duplicate is reported as such regardless of when or on what it fired, so
    // rejection counts stay attributable to one cause.
    const loggedIds = new Set(['AAA:hammer:10.000'])
    expect(shouldLogPattern('AAA:hammer:10.000', ctx({ loggedIds, now: AFTER_CLOSE, changePct: -50 })))
      .toEqual({ log: false, reason: 'duplicate' })
  })

  it('cuts off at 15:55 ET, before the close auction', () => {
    expect(PATTERN_LOG_CUTOFF_ET_MIN).toBe(15 * 60 + 55)
  })
})
