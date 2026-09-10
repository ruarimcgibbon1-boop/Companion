/**
 * MIKE'S STRATEGY — established-HOD rule.
 *
 * Mike may anchor to an intraday HOD only if that high was established BEFORE the
 * current break; a high printed by the current move must never become that move's own
 * reference. Once a lifecycle is created the level is frozen exactly as before.
 */
import { describe, it, expect } from 'vitest'
import { evaluateMike, establishedHigh } from '../src/lib/mike/engine'
import { ingestCandidate, activeLifecycle, priorForEngine, type MikeStoreState } from '../src/lib/mike/driver'
import type { MikeInput } from '../src/lib/mike/types'
import type { Candle } from '../src/types'

function bar(open: number, high: number, low: number, close: number, t = 0): Candle {
  return { time: 1_700_000_000 + t * 300, open, high, low, close, volume: 1000 }
}
const NOW = 1_700_000_000_000
const noRefs = { previousDayHigh: null, premarketHigh: null, dayHigh: null, twentyDayHigh: null }
function input(candles5m: Candle[], price: number, over: Partial<MikeInput> = {}): MikeInput {
  return {
    symbol: 'HOD', session: 'regular', now: NOW, price, candles5m,
    indicators: { vwap: null, ema9: null, ema21: null, rvol: null }, levels: [], refs: noRefs, ...over,
  }
}

describe('establishedHigh derivation', () => {
  it('returns the prior high that price later failed to exceed', () => {
    const highs = [4.8, 4.9, 5.0, 4.95, 4.97, 5.05, 5.10, 5.20]
    const bars = highs.map((h, i) => bar(h - 0.05, h, h - 0.1, h - 0.02, i))
    expect(establishedHigh(bars)).toBe(5.0)
  })
  it('returns null for a straight vertical where every bar is a new high', () => {
    const bars = [4.8, 4.9, 5.0, 5.1, 5.2].map((h, i) => bar(h - 0.05, h, h - 0.1, h - 0.02, i))
    expect(establishedHigh(bars)).toBeNull()
  })
  it('returns null with fewer than two bars', () => {
    expect(establishedHigh([bar(5, 5.1, 4.9, 5.05)])).toBeNull()
  })
})

describe('breakout-level uses the ESTABLISHED high, never the running one', () => {
  // Prior high 5.00, a pullback, then a vertical run to 5.20 (the current move).
  const withPriorHigh = [
    bar(4.78, 4.85, 4.75, 4.82, 0), bar(4.95, 5.00, 4.90, 4.98, 1), bar(4.92, 4.97, 4.85, 4.95, 2),
    bar(5.00, 5.05, 4.98, 5.04, 3), bar(5.05, 5.12, 5.03, 5.10, 4), bar(5.10, 5.20, 5.08, 5.18, 5),
  ]

  it('prior established HOD can be selected when approaching it', () => {
    const c = evaluateMike(input([bar(4.78, 4.85, 4.75, 4.82, 0), bar(4.95, 5.00, 4.90, 4.98, 1), bar(4.92, 4.97, 4.85, 4.95, 2)], 4.99))
    expect(c.breakoutLevel?.price).toBe(5.0)
    expect(c.breakoutLevel?.type).toBe('hod')
  })

  it('the current breakout cannot self-create its own reference (5.20 not chosen)', () => {
    const c = evaluateMike(input(withPriorHigh, 5.20))
    expect(c.breakoutLevel?.price).toBe(5.0)
    expect(c.breakoutLevel?.price).not.toBe(5.20)
  })

  it('a newly-created running HOD cannot replace the established breakout level', () => {
    const c = evaluateMike(input(withPriorHigh, 5.20))
    const { state } = ingestCandidate({ candidates: [] }, c, { acceptanceCandle: null, rejection: null, shadow: null }, NOW)
    expect(activeLifecycle(state, 'HOD')!.breakoutLevel?.price).toBe(5.0)
  })

  it('frozen HOD remains unchanged after further new highs', () => {
    const c1 = evaluateMike(input(withPriorHigh, 5.20))
    const { state } = ingestCandidate({ candidates: [] }, c1, { acceptanceCandle: null, rejection: null, shadow: null }, NOW)
    const lc = activeLifecycle(state, 'HOD')!
    expect(lc.breakoutLevel?.price).toBe(5.0)
    // Later sweep: the tape now prints a higher established high (5.30), but the prior is fed back.
    const extended = [...withPriorHigh, bar(5.18, 5.30, 5.15, 5.25, 6), bar(5.20, 5.28, 5.10, 5.15, 7)]
    const c2 = evaluateMike(input(extended, 5.25, { prior: priorForEngine(lc), now: NOW + 300_000 }))
    expect(c2.breakoutLevel?.price).toBe(5.0)   // NOT the newer 5.30
  })

  it('does not invent a HOD when none is established', () => {
    const vertical = [4.8, 4.9, 5.0, 5.1, 5.2].map((h, i) => bar(h - 0.05, h, h - 0.1, h - 0.02, i))
    const c = evaluateMike(input(vertical, 5.2))
    expect(c.breakoutLevel).toBeNull()
    expect(c.state).toBe('SCANNED')
  })
})

// The engine must remain the single source of freeze; a rising established high with a
// stored (terminal) candidate at the old level spawns a NEW lifecycle, never a mutation.
describe('established-HOD interacts correctly with lifecycle identity', () => {
  it('keeps the frozen level immutable across ingest', () => {
    const withPriorHigh = [
      bar(4.78, 4.85, 4.75, 4.82, 0), bar(4.95, 5.00, 4.90, 4.98, 1), bar(4.92, 4.97, 4.85, 4.95, 2),
      bar(5.00, 5.05, 4.98, 5.04, 3), bar(5.05, 5.12, 5.03, 5.10, 4), bar(5.10, 5.20, 5.08, 5.18, 5),
    ]
    let state: MikeStoreState = { candidates: [] }
    const c1 = evaluateMike(input(withPriorHigh, 5.20))
    state = ingestCandidate(state, c1, { acceptanceCandle: null, rejection: null, shadow: null }, NOW).state
    const frozen = activeLifecycle(state, 'HOD')!.breakoutLevel!.price
    const c2 = evaluateMike(input([...withPriorHigh, bar(5.2, 5.5, 5.1, 5.45, 6)], 5.45, { prior: priorForEngine(activeLifecycle(state, 'HOD')!), now: NOW + 300_000 }))
    state = ingestCandidate(state, c2, { acceptanceCandle: null, rejection: null, shadow: null }, NOW + 300_000).state
    expect(activeLifecycle(state, 'HOD')!.breakoutLevel!.price).toBe(frozen)
  })
})
