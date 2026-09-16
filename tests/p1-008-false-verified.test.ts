/**
 * P1-008 — FALSE BROKER VERIFIED (adversarial reproduction, Phase P1-R)
 *
 * AUDIT CLAIM: broker reconciliation (src/lib/research/broker-reconcile.ts `reconcile`) emits
 * VERIFIED when evidence is incomplete or uncomputable:
 *   A. an aborted trade with no ledger short-circuits to VERIFIED before any position check,
 *      even with NO position snapshot (or one that shows the broker still holds shares).
 *   B. a closed filled trade with local realizedPnl=null: delta.pnl is null → the P&L-mismatch
 *      guard is skipped → falls through to VERIFIED.
 *   C. a non-finite broker P&L (from a malformed fill) makes delta.pnl NaN → Math.abs(NaN)>tol
 *      is false → falls through to VERIFIED.
 *
 * Real reconciliation + real broker-ledger builder, offline, deterministic. Assertions encode
 * the safe invariants and FAIL on the current base. DO NOT FIX.
 */
import { describe, it, expect } from 'vitest'
import { reconcile, type LocalTradeAccounting } from '@/lib/research/broker-reconcile'
import { buildBrokerLedger, type LedgerFill } from '@/lib/research/broker-ledger'

const DAY = '2026-08-07'
const TID = 'pt:sig-1'

function local(over: Partial<LocalTradeAccounting> = {}): LocalTradeAccounting {
  return {
    tradeId: TID, setupId: 'setup-1', symbol: 'TEST',
    entryFillQty: 0, entryFillPrice: null, exits: [], openQty: 0,
    fullyClosed: false, realizedPnl: null, reconciliationStatus: 'pending',
    brokerVerifiedQty: null, ...over,
  }
}

function fill(over: Partial<LedgerFill>): LedgerFill {
  return { symbol: 'TEST', side: 'buy', qty: 100, price: 10, filledAt: 1, orderId: 'o', clientOrderId: TID, ...over }
}

const classify = (
  l: LocalTradeAccounting,
  fills: LedgerFill[],
  positions: ReadonlyMap<string, number> | null,
) => {
  const ledger = buildBrokerLedger(DAY, fills, [{ id: TID, symbol: 'TEST', setupId: 'setup-1' }])
  return reconcile(DAY, [l], ledger, positions).perTrade[0].classification
}

describe('P1-008 false broker VERIFIED', () => {
  // ── A: aborted / no ledger / no position evidence ──────────────────────────────
  it('A1: aborted + no ledger + NO position snapshot → must not VERIFY (no flatness evidence)', () => {
    const c = classify(local({ aborted: true, fullyClosed: true }), [], null)
    // Current base: `t.aborted && !bl` → VERIFIED, before any position-snapshot check.
    expect(c).not.toBe('VERIFIED')
  })

  it('A2: aborted + no ledger but broker STILL HOLDS 500 → must not VERIFY', () => {
    const c = classify(local({ aborted: true, fullyClosed: true }), [], new Map([['TEST', 500]]))
    // The broker holds 500 for this symbol, yet the aborted short-circuit verifies "no trade".
    expect(c).not.toBe('VERIFIED')     // should be LOCAL_FLAT_BROKER_NONFLAT / MANUAL_REVIEW
  })

  // ── B: closed filled trade, local realizedPnl null ─────────────────────────────
  it('B: closed filled trade with local realizedPnl=null → must not VERIFY', () => {
    const fills = [
      fill({ side: 'buy', qty: 100, price: 10, orderId: 'b1' }),
      fill({ side: 'sell', qty: 100, price: 11, orderId: 's1' }),
    ]
    const c = classify(
      local({
        entryFillQty: 100, entryFillPrice: 10,
        exits: [{ qty: 100, fillPrice: 11 }],
        openQty: 0, fullyClosed: true, realizedPnl: null,   // ← local P&L uncomputable
        reconciliationStatus: 'closed',
      }),
      fills,
      new Map([['TEST', 0]]),
    )
    // delta.pnl is null (local realizedPnl null) → the P&L-mismatch guard is skipped → VERIFIED.
    expect(c).not.toBe('VERIFIED')     // should be PNL_UNRESOLVED / MANUAL_REVIEW
  })

  // ── C: non-finite broker numeric reaches ledger arithmetic ─────────────────────
  it('C: NaN broker P&L (malformed fill price) → NaN comparison must not fall through to VERIFY', () => {
    const fills = [
      fill({ side: 'buy', qty: 100, price: NaN, orderId: 'b1' }),   // malformed price → brokerPnl NaN
      fill({ side: 'sell', qty: 100, price: 11, orderId: 's1' }),
    ]
    const ledger = buildBrokerLedger(DAY, fills, [{ id: TID, symbol: 'TEST', setupId: 'setup-1' }])
    expect(Number.isNaN(ledger.perTrade[0].brokerPnl)).toBe(true)   // NaN reached ledger arithmetic

    const c = reconcile(DAY, [local({
      entryFillQty: 100, entryFillPrice: 10,
      exits: [{ qty: 100, fillPrice: 11 }],
      openQty: 0, fullyClosed: true, realizedPnl: 100,    // finite local P&L
      reconciliationStatus: 'closed',
    })], ledger, new Map([['TEST', 0]])).perTrade[0].classification

    // Math.abs(NaN) > tol is false → mismatch guard skipped → VERIFIED on invalid numerics.
    expect(c).not.toBe('VERIFIED')     // should be MANUAL_REVIEW / PNL_UNRESOLVED (invalid evidence)
  })

  // ── Contrast: a genuinely clean closed trade DOES verify (guards against over-broad fix) ──
  it('control: clean closed trade with finite matching P&L verifies', () => {
    const fills = [
      fill({ side: 'buy', qty: 100, price: 10, orderId: 'b1' }),
      fill({ side: 'sell', qty: 100, price: 11, orderId: 's1' }),
    ]
    const c = classify(
      local({
        entryFillQty: 100, entryFillPrice: 10,
        exits: [{ qty: 100, fillPrice: 11 }],
        openQty: 0, fullyClosed: true, realizedPnl: 100,   // broker 100, local 100
        reconciliationStatus: 'closed',
      }),
      fills,
      new Map([['TEST', 0]]),
    )
    expect(c).toBe('VERIFIED')
  })
})
