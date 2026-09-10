/**
 * MIKE'S STRATEGY — stateful driver: level freezing, lifecycle persistence,
 * event dedup, completed-5m determination, and observational telemetry.
 */
import { describe, it, expect } from 'vitest'
import { evaluateMike } from '../src/lib/mike/engine'
import {
  isFiveMinComplete, completedFiveMin, computeRejectionTelemetry,
  ingestCandidate, activeLifecycle, priorForEngine,
  type MikeStoreState,
} from '../src/lib/mike/driver'
import type { MikeInput } from '../src/lib/mike/types'
import type { Candle } from '../src/types'

function bar(open: number, high: number, low: number, close: number, t = 0, volume = 1000): Candle {
  return { time: 1_700_000_000 + t * 300, open, high, low, close, volume }
}
const NOW = 1_700_000_000_000
const NULL_IND = { vwap: null, ema9: null, ema21: null, rvol: null }

function acceptedInput(over: Partial<MikeInput> = {}): MikeInput {
  return {
    symbol: 'AAA', session: 'regular', now: NOW, price: 5.10,
    candles5m: [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.06, 5.12, 5.05, 5.10, 1)],
    indicators: { vwap: 4.9, ema9: null, ema21: null, rvol: 3 },
    levels: [], refs: { previousDayHigh: 5.0, premarketHigh: null, dayHigh: null, twentyDayHigh: null },
    ...over,
  }
}
const empty = (): MikeStoreState => ({ candidates: [] })
const ex = () => ({ acceptanceCandle: null, rejection: null, shadow: null })

// ── deterministic selection ──────────────────────────────────────────────────
describe('breakout-level selection', () => {
  it('is deterministic for identical input', () => {
    const a = evaluateMike(acceptedInput())
    const b = evaluateMike(acceptedInput())
    expect(a.breakoutLevel).toEqual(b.breakoutLevel)
    expect(a.state).toBe(b.state)
  })
})

// ── freezing ─────────────────────────────────────────────────────────────────
describe('frozen breakout level', () => {
  it('does not move when the HOD rises on a later sweep', () => {
    const c1 = evaluateMike(acceptedInput())
    expect(c1.breakoutLevel?.price).toBe(5.0)
    const { state } = ingestCandidate(empty(), c1, ex(), NOW)
    const lc = activeLifecycle(state, 'AAA')!
    expect(lc.breakoutLevel?.price).toBe(5.0)
    expect(lc.breakoutLevelFrozenAt).toBe(NOW)

    // Next sweep: HOD has risen to 5.40, but the frozen prior is fed back.
    const c2 = evaluateMike(acceptedInput({ refs: { previousDayHigh: 5.0, premarketHigh: null, dayHigh: 5.40, twentyDayHigh: null }, prior: priorForEngine(lc), now: NOW + 300_000, price: 5.30 }))
    expect(c2.breakoutLevel?.price).toBe(5.0)   // NOT 5.40
    const { state: s2 } = ingestCandidate(state, c2, ex(), NOW + 300_000)
    expect(activeLifecycle(s2, 'AAA')!.breakoutLevel?.price).toBe(5.0)
  })

  it('a genuinely new established level becomes a NEW candidate, not a mutation', () => {
    // First candidate goes terminal (rejected) at level 5.00.
    const rejected = evaluateMike(acceptedInput({ candles5m: [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.05, 5.06, 4.90, 4.95, 1)], price: 4.96 }))
    expect(rejected.veto?.reason).toBe('REJECTED_BREAKOUT')
    const { state } = ingestCandidate(empty(), rejected, ex(), NOW)
    expect(state.candidates).toHaveLength(1)
    expect(state.candidates[0].terminal).toBe(true)

    // Later, a genuinely higher established level (6.00) with no active lifecycle.
    const fresh = evaluateMike(acceptedInput({
      candles5m: [bar(6.02, 6.10, 6.01, 6.06, 2), bar(6.06, 6.14, 6.05, 6.10, 3)], price: 6.10,
      refs: { previousDayHigh: 6.0, premarketHigh: null, dayHigh: null, twentyDayHigh: null }, now: NOW + 600_000,
    }))
    const { state: s2 } = ingestCandidate(state, fresh, ex(), NOW + 600_000)
    expect(s2.candidates).toHaveLength(2)
    expect(s2.candidates[0].breakoutLevel?.price).toBe(5.0)   // original untouched
    expect(s2.candidates[1].breakoutLevel?.price).toBe(6.0)
  })

  it('does not resurrect a terminal candidate at (approximately) the same level', () => {
    const rejected = evaluateMike(acceptedInput({ candles5m: [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.05, 5.06, 4.90, 4.95, 1)], price: 4.96 }))
    const { state } = ingestCandidate(empty(), rejected, ex(), NOW)
    // Same level 5.00 reappears — must NOT create a new lifecycle.
    const again = evaluateMike(acceptedInput({ candles5m: [bar(5.02, 5.08, 5.01, 5.06, 4)], price: 5.03 }))
    const { state: s2, event } = ingestCandidate(state, again, ex(), NOW + 300_000)
    expect(s2.candidates).toHaveLength(1)
    expect(event).toBeNull()
  })
})

// ── persistence + dedup across sweeps / restart ──────────────────────────────
describe('lifecycle persistence & event dedup', () => {
  it('persists state across sweeps and grows history only on transitions', () => {
    // Sweep 1: LOADING (one supporting).
    const loading = evaluateMike(acceptedInput({ candles5m: [bar(5.02, 5.08, 5.01, 5.06, 0)], price: 5.06, indicators: NULL_IND }))
    expect(loading.state).toBe('LOADING')
    const r1 = ingestCandidate(empty(), loading, ex(), NOW)
    expect(r1.event?.kind).toBe('created')

    // Sweep 2: same LOADING (no change) → no event, still one lifecycle.
    const r2 = ingestCandidate(r1.state, loading, ex(), NOW + 15_000)
    expect(r2.event).toBeNull()
    expect(r2.state.candidates).toHaveLength(1)

    // Sweep 3: advances to TRIGGERED → event + history entry.
    const triggered = evaluateMike(acceptedInput())
    const r3 = ingestCandidate(r2.state, triggered, ex(), NOW + 30_000)
    expect(r3.event?.kind).toBe('state_change')
    expect(activeLifecycle(r3.state, 'AAA')!.history.length).toBeGreaterThanOrEqual(2)
  })

  it('a duplicate sweep after a simulated restart does not re-emit', () => {
    const triggered = evaluateMike(acceptedInput())
    const r1 = ingestCandidate(empty(), triggered, ex(), NOW)
    // Simulate restart: round-trip the state through JSON (as the state file would).
    const restored: MikeStoreState = JSON.parse(JSON.stringify(r1.state))
    const r2 = ingestCandidate(restored, triggered, ex(), NOW + 15_000)
    expect(r2.event).toBeNull()
    expect(r2.state.candidates).toHaveLength(1)
  })

  it('persists the acceptance candle OHLCV', () => {
    const c = evaluateMike(acceptedInput())
    const accCandle = bar(5.02, 5.08, 5.01, 5.06, 0)
    const { state } = ingestCandidate(empty(), c, { acceptanceCandle: accCandle, rejection: null, shadow: null }, NOW)
    expect(activeLifecycle(state, 'AAA')!.acceptanceCandle).toEqual(accCandle)
  })

  it('records the six supporting confirmations individually', () => {
    const c = evaluateMike(acceptedInput())
    const { state } = ingestCandidate(empty(), c, ex(), NOW)
    const sup = activeLifecycle(state, 'AAA')!.supporting!
    expect(Object.keys(sup).sort()).toEqual(
      ['continuedMomentum', 'emaSupport', 'expandingVolume', 'higherLowAboveLevel', 'secondCandleHolds', 'vwapSupport'],
    )
  })

  it('persists a veto and keeps it for shadow tracking', () => {
    const rejected = evaluateMike(acceptedInput({ candles5m: [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.05, 5.06, 4.90, 4.95, 1)], price: 4.96 }))
    const shadow = { reference: 5, stop: 4.5, hit10: true, hit15: false, hitStop: false, mfePct: 12, maePct: -1, maxRunPct: 12, reachedRunner: false, runnerExcursionAfter15Pct: null, timeTo10Bars: 2, timeTo15Bars: null, timeToAdverseBars: null, barsToResolve: null, resolvedFromBars: 5, resolved: true }
    const { state, event } = ingestCandidate(empty(), rejected, { acceptanceCandle: null, rejection: null, shadow }, NOW)
    const lc = state.candidates[0]
    expect(lc.veto?.reason).toBe('REJECTED_BREAKOUT')
    expect(lc.terminal).toBe(true)
    expect(lc.shadow?.hit10).toBe(true)
    expect(event?.kind).toBe('terminal')
  })
})

// ── completed 5m determination ───────────────────────────────────────────────
describe('completed 5m determination', () => {
  const T = 1_700_000_000
  it('a bucket is complete exactly at its end boundary, not before', () => {
    expect(isFiveMinComplete(T, (T + 300) * 1000)).toBe(true)
    expect(isFiveMinComplete(T, (T + 300) * 1000 - 1)).toBe(false)
    expect(isFiveMinComplete(T, (T + 299) * 1000)).toBe(false)
  })
  it('drops a still-forming last bar (RTH)', () => {
    const bars = [bar(5, 5.1, 4.9, 5.05, 0), bar(5.05, 5.2, 5.0, 5.15, 1)]
    const now = (bars[1].time + 100) * 1000   // second bar still forming
    const done = completedFiveMin(bars, now)
    expect(done).toHaveLength(1)
    expect(done[0].time).toBe(bars[0].time)
  })
  it('applies identically in extended hours (no session dependence)', () => {
    const pm = [bar(2, 2.1, 1.9, 2.05, 0)]
    expect(completedFiveMin(pm, (pm[0].time + 300) * 1000)).toHaveLength(1)
    expect(completedFiveMin(pm, (pm[0].time + 100) * 1000)).toHaveLength(0)
  })
  it('a delayed/missing most-recent bar just yields fewer completed bars, never a partial', () => {
    const bars = [bar(5, 5.1, 4.9, 5.05, 0), bar(5.05, 5.2, 5.0, 5.15, 1)]
    const now = (bars[1].time + 10_000) * 1000
    expect(completedFiveMin(bars, now)).toHaveLength(2)
  })
})

// ── immediate-rejection telemetry (observational only) ───────────────────────
describe('immediate-rejection telemetry', () => {
  it('records what happened after acceptance without changing the veto rule', () => {
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.05, 5.06, 4.90, 4.95, 1)]
    const tel = computeRejectionTelemetry(candles, 5.0, 0, 4.96)!
    expect(tel.tradedIntrabarBelow).toBe(true)
    expect(tel.completed5mClosedBelow).toBe(true)
    expect(tel.completed1mClosedBelow).toBeNull()   // no 1m supplied
    expect(tel.barsToFirstBelow).toBe(1)
    expect(tel.recoveredAfter).toBe(false)
    expect(tel.maxExcursionBelowPct!).toBeLessThan(0)
    // The engine's REJECTED_BREAKOUT rule is unchanged and still fires.
    const c = evaluateMike(acceptedInput({ candles5m: candles, price: 4.96 }))
    expect(c.veto?.reason).toBe('REJECTED_BREAKOUT')
  })
  it('records 1m closes-below only when 1m tape is supplied', () => {
    const candles = [bar(5.02, 5.08, 5.01, 5.06, 0), bar(5.05, 5.10, 5.02, 5.08, 1)]
    const oneMin = [bar(5.06, 5.07, 4.98, 4.99, 2)]   // a 1m bar closing below the level
    const tel = computeRejectionTelemetry(candles, 5.0, 0, 5.08, oneMin)!
    expect(tel.completed1mClosedBelow).toBe(true)
    expect(tel.completed5mClosedBelow).toBe(false)    // no 5m closed below
  })
})
