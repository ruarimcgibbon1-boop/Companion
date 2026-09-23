import { describe, it, expect } from 'vitest'
import { canonicalBooks, type AuditTradeInput } from '@/lib/execution/audit-books'

const T = (over: Partial<AuditTradeInput>): AuditTradeInput => ({
  day: '2026-08-19', symbol: 'X', setup: 'opening_drive', actualR: -1, idealR: -1, externalExit: false, ...over,
})

describe('canonicalBooks — three books, external exits segregated', () => {
  it('separates external exits from the strategy book but keeps them in the account book', () => {
    const trades = [
      T({ symbol: 'CDE', actualR: -1.05, idealR: -1.0 }),
      T({ symbol: 'CABA', actualR: -1.02, idealR: -1.0 }),
      T({ symbol: 'EL', actualR: 2.33, idealR: null, externalExit: true }),   // manual/external
      T({ symbol: 'FSM', actualR: 1.89, idealR: null, externalExit: true }),
    ]
    const b = canonicalBooks(trades)
    // Account book: ALL four, external included.
    expect(b.account.n).toBe(4)
    expect(b.account.netR).toBeCloseTo(-1.05 - 1.02 + 2.33 + 1.89)
    // Strategy book: only the two Companion opened AND closed itself.
    expect(b.strategy.n).toBe(2)
    expect(b.strategy.netR).toBeCloseTo(-2.07)
    expect(b.externalTrades.map(t => t.symbol).sort()).toEqual(['EL', 'FSM'])
  })

  it('ideal-stop book is an upper bound over the reconstructable strategy trades only', () => {
    const b = canonicalBooks([
      T({ symbol: 'CDE', actualR: -1.05, idealR: -1.0 }),
      T({ symbol: 'UUU', actualR: -2.82, idealR: -1.0 }),
    ])
    expect(b.idealStopUpperBound.n).toBe(2)
    expect(b.idealStopUpperBound.netR).toBeCloseTo(-2.0)
    // execution cost = strategy actual − ideal, defined only when the sets match.
    expect(b.executionCostR).toBeCloseTo(-3.87 - -2.0)
  })

  it('execution cost is null (undefined) when some strategy trades lack a reconstructable ideal', () => {
    const b = canonicalBooks([
      T({ symbol: 'CDE', actualR: -1.05, idealR: -1.0 }),
      T({ symbol: 'HZO', actualR: 0.03, idealR: null }),   // EOD time-exit, not reconstructable
    ])
    expect(b.idealUnreconstructable.map(t => t.symbol)).toEqual(['HZO'])
    expect(b.executionCostR).toBeNull()
    expect(b.idealStopUpperBound.n).toBe(1)                // only CDE in the ideal book
  })

  it('empty book is well-formed', () => {
    const b = canonicalBooks([])
    expect(b.account.n).toBe(0)
    expect(b.account.avgR).toBeNull()
    expect(b.executionCostR).toBe(0)   // 0 − 0, no unreconstructable trades
  })
})
