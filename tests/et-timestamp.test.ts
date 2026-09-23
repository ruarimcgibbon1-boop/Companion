/**
 * ET timestamp parsing.
 *
 * These tests exist because of a bug that invalidated a great deal of live
 * behaviour: FMP returns intraday timestamps as naive ET wall-clock strings, and
 * every call site parsed them with `new Date()`, which resolves in the HOST
 * timezone. On America/New_York that is accidentally correct; on Europe/Madrid it
 * put every candle SIX HOURS early, so a 09:35 ET bar — five minutes after the
 * open — was classified `overnight`.
 *
 * The suite forces a non-ET timezone so a regression cannot hide on an ET machine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parseEtTimestamp, parseEtTimestampSec, getSessionType } from '../src/lib/market-hours'

const originalTZ = process.env.TZ

beforeAll(() => { process.env.TZ = 'Europe/Madrid' })
afterAll(() => { process.env.TZ = originalTZ })

describe('parseEtTimestamp', () => {
  it('reads an FMP summer timestamp as EDT (UTC-4)', () => {
    // 09:35 ET on 2026-08-12 is 13:35 UTC.
    expect(new Date(parseEtTimestamp('2026-08-12 09:35:00')).toISOString())
      .toBe('2026-08-12T13:35:00.000Z')
  })

  it('reads a winter timestamp as EST (UTC-5), not a hardcoded -04:00', () => {
    // The backtest hardcoded -04:00, which silently breaks every November.
    expect(new Date(parseEtTimestamp('2026-01-15 09:35:00')).toISOString())
      .toBe('2026-01-15T14:35:00.000Z')
  })

  it('handles a date-only string as ET midnight', () => {
    expect(new Date(parseEtTimestamp('2026-08-12')).toISOString())
      .toBe('2026-08-12T04:00:00.000Z')
  })

  it('trusts a string that already carries a zone', () => {
    expect(new Date(parseEtTimestamp('2026-08-12T13:35:00Z')).toISOString())
      .toBe('2026-08-12T13:35:00.000Z')
    expect(new Date(parseEtTimestamp('2026-08-12T09:35:00-04:00')).toISOString())
      .toBe('2026-08-12T13:35:00.000Z')
  })

  it('returns NaN for junk rather than a bogus instant', () => {
    // Callers drop these; coercing to 0 would silently place bars in 1970.
    expect(Number.isNaN(parseEtTimestamp('not a date'))).toBe(true)
    expect(Number.isNaN(parseEtTimestamp(''))).toBe(true)
    expect(Number.isNaN(parseEtTimestampSec('nope'))).toBe(true)
  })

  it('gives seconds for the Candle shape', () => {
    expect(parseEtTimestampSec('2026-08-12 09:35:00'))
      .toBe(Math.floor(Date.parse('2026-08-12T13:35:00Z') / 1000))
  })
})

describe('session classification of parsed candles', () => {
  // The actual symptom. Each of these was wrong before the fix.
  const cases: [string, string][] = [
    ['2026-08-12 04:00:00', 'premarket'],
    ['2026-08-12 09:35:00', 'regular'],
    ['2026-08-12 12:00:00', 'regular'],
    ['2026-08-12 15:55:00', 'regular'],
    ['2026-08-12 17:00:00', 'afterhours'],
  ]

  for (const [stamp, expected] of cases) {
    it(`puts an FMP bar at ${stamp.slice(11)} ET in the ${expected} session`, () => {
      expect(getSessionType(parseEtTimestamp(stamp))).toBe(expected)
    })
  }

  it('no longer calls a bar five minutes after the open "overnight"', () => {
    const naive = new Date('2026-08-12 09:35:00').getTime()   // the old code path
    const correct = parseEtTimestamp('2026-08-12 09:35:00')
    expect(getSessionType(correct)).toBe('regular')
    // Guard the premise: on a non-ET host the naive parse really is different.
    expect(naive).not.toBe(correct)
  })
})
