/**
 * H4B-PREP — causal 1m tape replay (STEP 11/12): NO-LOOKAHEAD contract.
 *
 * The load-bearing guarantee: a bar revision observed LATER must never change what a
 * replay AS OF an EARLIER time returns. Companion's causal knowledge is frozen at T.
 */
import { describe, it, expect } from 'vitest'
import {
  parseTape, barObservations, latestObservationAsOf, barsAsKnownAt, revisionHistory,
  assessTapeCompleteness, splitTapeSessions, type TapeEvent,
} from '../src/lib/research/tape-1m-replay'

// A bar observation as it appears on disk (only the fields replay reads).
function obs(o: Partial<TapeEvent> & {
  symbol: string; barTimeSec: number; observedAtMs: number
  open: number; high: number; low: number; close: number; volume: number
  fingerprint: string; revisionSequence: number
}): TapeEvent {
  return {
    eventType: 'bar_observation', timeframe: '1m', barStatus: 'CLOSED',
    observedAt: new Date(o.observedAtMs).toISOString(), receivedAt: null, source: 'UNKNOWN',
    requestKind: 'BASE', barFingerprint: o.fingerprint, ...o,
  }
}

describe('H4B tape replay — no-lookahead (STEP 12)', () => {
  // The canonical scenario from the protocol.
  const bx = 1_726_660_860 // some minute (unix sec)
  const t1 = Date.parse('2026-09-18T10:01:05-04:00') // first observation of bar X
  const t2 = Date.parse('2026-09-18T10:03:00-04:00') // later REVISED observation of bar X
  const asOf1002 = Date.parse('2026-09-18T10:02:00-04:00')
  const asOf1004 = Date.parse('2026-09-18T10:04:00-04:00')

  const events: TapeEvent[] = [
    obs({ symbol: 'AAA', barTimeSec: bx, observedAtMs: t1, open: 10, high: 11, low: 9.5, close: 10.5, volume: 1000, fingerprint: 'fpA', revisionSequence: 0 }),
    obs({ symbol: 'AAA', barTimeSec: bx, observedAtMs: t2, open: 10, high: 12, low: 9.5, close: 11.8, volume: 4200, fingerprint: 'fpB', revisionSequence: 1 }),
  ]

  it('replay AS OF 10:02 returns the ORIGINAL OHLCV (future revision invisible)', () => {
    const asOf = latestObservationAsOf(events, 'AAA', bx, asOf1002)
    expect(asOf).not.toBeNull()
    expect(asOf!.high).toBe(11)
    expect(asOf!.close).toBe(10.5)
    expect(asOf!.revisionSequence).toBe(0)
    const bars = barsAsKnownAt(events, 'AAA', asOf1002)
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({ time: bx, high: 11, close: 10.5, volume: 1000 })
  })

  it('replay AS OF 10:04 returns the REVISED OHLCV', () => {
    const asOf = latestObservationAsOf(events, 'AAA', bx, asOf1004)
    expect(asOf!.high).toBe(12)
    expect(asOf!.close).toBe(11.8)
    expect(asOf!.revisionSequence).toBe(1)
    const bars = barsAsKnownAt(events, 'AAA', asOf1004)
    expect(bars[0]).toMatchObject({ time: bx, high: 12, close: 11.8, volume: 4200 })
  })

  it('replay BEFORE the first observation returns nothing (bar not yet known)', () => {
    expect(latestObservationAsOf(events, 'AAA', bx, t1 - 1)).toBeNull()
    expect(barsAsKnownAt(events, 'AAA', t1 - 1)).toHaveLength(0)
  })

  it('revisionHistory preserves BOTH observations oldest→newest', () => {
    const hist = revisionHistory(events, 'AAA', bx)
    expect(hist).toHaveLength(2)
    expect(hist.map(h => h.revisionSequence)).toEqual([0, 1])
    expect(hist.map(h => h.high)).toEqual([11, 12])
  })
})

describe('H4B tape replay — reconstruction across symbols & minutes', () => {
  const base = Date.parse('2026-09-18T09:31:00-04:00')
  const m = (n: number) => 1_726_660_800 + n * 60
  const events: TapeEvent[] = [
    obs({ symbol: 'AAA', barTimeSec: m(0), observedAtMs: base, open: 1, high: 2, low: 1, close: 1.5, volume: 100, fingerprint: 'a0', revisionSequence: 0 }),
    obs({ symbol: 'AAA', barTimeSec: m(1), observedAtMs: base + 60_000, open: 1.5, high: 2.5, low: 1.4, close: 2.2, volume: 200, fingerprint: 'a1', revisionSequence: 0 }),
    obs({ symbol: 'BBB', barTimeSec: m(0), observedAtMs: base, open: 9, high: 9, low: 8, close: 8.5, volume: 50, fingerprint: 'b0', revisionSequence: 0 }),
  ]

  it('same barTimeSec, different symbol → kept separate', () => {
    expect(barsAsKnownAt(events, 'AAA', base + 1000)).toHaveLength(1) // only m(0) known at `base`
    expect(barsAsKnownAt(events, 'BBB', base + 1000)).toHaveLength(1)
    expect(barsAsKnownAt(events, 'AAA', base + 120_000)).toHaveLength(2) // both minutes now known
  })

  it('reconstruction is sorted ascending by bar time', () => {
    const bars = barsAsKnownAt(events, 'AAA', base + 120_000)
    expect(bars.map(b => b.time)).toEqual([m(0), m(1)])
  })
})

describe('H4B tape replay — robustness', () => {
  it('parseTape skips a torn/partial trailing line and counts it', () => {
    const good = JSON.stringify({ eventType: 'bar_observation', symbol: 'AAA', barTimeSec: 1, observedAtMs: 1 })
    const text = `${good}\n{ "eventType": "bar_observation", "symbol": "AA` // torn final append
    const { events, malformed } = parseTape(text)
    expect(events).toHaveLength(1)
    expect(malformed).toBe(1)
  })

  it('barObservations ignores non-bar and structurally-invalid records', () => {
    const evs: TapeEvent[] = [
      { eventType: 'tape_writer_started' },
      { eventType: 'bar_observation', symbol: 'AAA' }, // missing barTimeSec/observedAtMs
      obs({ symbol: 'AAA', barTimeSec: 1, observedAtMs: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, fingerprint: 'x', revisionSequence: 0 }),
    ]
    expect(barObservations(evs)).toHaveLength(1)
  })

  it('data-quality-nulled OHLC is retained as an observation but omitted from Candle[]', () => {
    const evs: TapeEvent[] = [{
      eventType: 'bar_observation', symbol: 'AAA', timeframe: '1m', barTimeSec: 5, observedAtMs: 10,
      open: null, high: null, low: null, close: null, volume: null, barStatus: 'UNKNOWN',
      barFingerprint: 'z', revisionSequence: 0, observedAt: 'x', receivedAt: null, source: 'UNKNOWN', requestKind: 'BASE',
    }]
    expect(barObservations(evs)).toHaveLength(1)      // forensic record kept
    expect(barsAsKnownAt(evs, 'AAA', 100)).toHaveLength(0) // but not a usable candle
  })

  it('completeness helpers are pure and classify a summary-terminated stream COMPLETE', () => {
    const evs: TapeEvent[] = [
      { eventType: 'tape_writer_started' },
      obs({ symbol: 'AAA', barTimeSec: 1, observedAtMs: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, fingerprint: 'x', revisionSequence: 0 }),
      { eventType: 'tape_writer_summary', cleanClose: true, eventsDropped: 0, writeFailures: 0, queueOverflows: 0, degradedEver: false },
    ]
    expect(assessTapeCompleteness(evs)).toBe('COMPLETE')
    expect(splitTapeSessions(evs)).toHaveLength(1)
  })
})
