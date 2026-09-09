import { describe, it, expect } from 'vitest'
import { buildBrokerLedger, ownerOf, type LedgerFill, type LedgerTradeRef } from '@/lib/research/broker-ledger'

// Trades from the 2026-08-27 session (ids/setupIds/risk are the real frozen values).
const YYGH: LedgerTradeRef = { id: 'pt:YYGH:break_of_structure:1.86:triggered:1787826399', symbol: 'YYGH', setupId: 'YYGH:break_of_structure:1.86', plannedRisk: 105.97440000000002 }
const FWDI: LedgerTradeRef = { id: 'pt:FWDI:opening_range_break:6.71:triggered:1787844688', symbol: 'FWDI', setupId: 'FWDI:opening_range_break:6.71', plannedRisk: 277.7421537303935 }
const NVDL: LedgerTradeRef = { id: 'pt:NVDL:hod_break:36.37:triggered:1787819364', symbol: 'NVDL', setupId: 'NVDL:hod_break:36.37', plannedRisk: 461.26299999999867 }

const f = (o: Partial<LedgerFill> & Pick<LedgerFill, 'symbol' | 'side' | 'qty' | 'price' | 'clientOrderId'>): LedgerFill =>
  ({ filledAt: 0, orderId: 'o', ...o })

describe('ownerOf — client_order_id ownership mapping', () => {
  it('maps entry (id) and exit (id:x:…) fills to the owning trade', () => {
    expect(ownerOf(YYGH.id, [YYGH, FWDI])?.id).toBe(YYGH.id)
    expect(ownerOf(`${YYGH.id}:x:t1:1787831570`, [YYGH, FWDI])?.id).toBe(YYGH.id)
    expect(ownerOf(`${YYGH.id}:stop:1787839418`, [YYGH, FWDI])?.id).toBe(YYGH.id)
  })
  it('returns null for an external client_order_id', () => {
    expect(ownerOf('some-dashboard-order-xyz', [YYGH, FWDI])).toBeNull()
    expect(ownerOf(null, [YYGH, FWDI])).toBeNull()
  })
})

describe('buildBrokerLedger — exact broker fills resolve the under-booked trades', () => {
  it('YYGH: full 798-share t1 (not just the 409 local ingested) → +$71.82 / +0.678R', () => {
    const fills: LedgerFill[] = [
      f({ symbol: 'YYGH', side: 'buy', qty: 1596, price: 1.89, clientOrderId: YYGH.id }),
      // Broker filled the FULL 798 at t1 (local under-ingested to 409). Two partials summing 798.
      f({ symbol: 'YYGH', side: 'sell', qty: 409, price: 1.99, clientOrderId: `${YYGH.id}:x:t1:1` }),
      f({ symbol: 'YYGH', side: 'sell', qty: 389, price: 1.99, clientOrderId: `${YYGH.id}:x:t1:1` }),
      f({ symbol: 'YYGH', side: 'sell', qty: 798, price: 1.88, clientOrderId: `${YYGH.id}:stop:2` }),
    ]
    const led = buildBrokerLedger('2026-08-27', fills, [YYGH])
    const t = led.perTrade[0]
    expect(t.entryQty).toBe(1596)
    expect(t.exitQty).toBe(1596)          // every exit share accounted (vs local 1207)
    expect(t.residualQty).toBe(0)
    expect(t.brokerPnl).toBeCloseTo(71.82, 2)
    expect(t.brokerR!).toBeCloseTo(0.678, 2)
    expect(t.flags).not.toContain('residual_exposure')
  })

  it('FWDI: all 2,711 exit shares (local booked only 182) → ≈ -$256.7 / ≈ -0.92R', () => {
    const fills: LedgerFill[] = [
      f({ symbol: 'FWDI', side: 'buy', qty: 2711, price: 6.83, clientOrderId: FWDI.id }),
      f({ symbol: 'FWDI', side: 'sell', qty: 2529, price: 6.7353006270748805, clientOrderId: `${FWDI.id}:stop:1` }),
      f({ symbol: 'FWDI', side: 'sell', qty: 182, price: 6.7353006270748805, clientOrderId: `${FWDI.id}:x:flat:2` }),
    ]
    const led = buildBrokerLedger('2026-08-27', fills, [FWDI])
    const t = led.perTrade[0]
    expect(t.entryQty).toBe(2711)
    expect(t.exitQty).toBe(2711)
    expect(t.brokerPnl).toBeCloseTo(-256.73, 1)
    expect(t.brokerR!).toBeCloseTo(-0.924, 2)
  })

  it('clean trade reconciles to local exactly (NVDL -$468.16)', () => {
    const fills: LedgerFill[] = [
      f({ symbol: 'NVDL', side: 'buy', qty: 418, price: 36.46, clientOrderId: NVDL.id }),
      f({ symbol: 'NVDL', side: 'sell', qty: 418, price: 35.34, clientOrderId: `${NVDL.id}:stop:1` }),
    ]
    const t = buildBrokerLedger('2026-08-27', fills, [NVDL]).perTrade[0]
    expect(t.brokerPnl).toBeCloseTo(-468.16, 2)
  })

  it('flags an unmapped/external sell and a residual, and is deterministic (stable hash)', () => {
    const fills: LedgerFill[] = [
      f({ symbol: 'NVDL', side: 'buy', qty: 418, price: 36.46, clientOrderId: NVDL.id }),
      f({ symbol: 'NVDL', side: 'sell', qty: 200, price: 35.34, clientOrderId: `${NVDL.id}:stop:1` }),
      f({ symbol: 'NVDL', side: 'sell', qty: 100, price: 35.30, clientOrderId: 'external-liquidation-order' }),
    ]
    const a = buildBrokerLedger('2026-08-27', fills, [NVDL])
    const b = buildBrokerLedger('2026-08-27', fills, [NVDL])
    expect(a.unmapped).toHaveLength(1)
    expect(a.perTrade[0].residualQty).toBe(218)
    expect(a.perTrade[0].flags).toContain('residual_exposure')
    expect(a.contentSha256).toBe(b.contentSha256)   // pure/deterministic
  })

  it('retrievalComplete=false is carried through and changes the content hash (fail-closed)', () => {
    const fills: LedgerFill[] = [
      f({ symbol: 'NVDL', side: 'buy', qty: 418, price: 36.46, clientOrderId: NVDL.id }),
      f({ symbol: 'NVDL', side: 'sell', qty: 418, price: 35.34, clientOrderId: `${NVDL.id}:stop:1` }),
    ]
    const complete = buildBrokerLedger('2026-08-27', fills, [NVDL], 'src', true)
    const partial = buildBrokerLedger('2026-08-27', fills, [NVDL], 'src', false)
    expect(complete.retrievalComplete).toBe(true)
    expect(partial.retrievalComplete).toBe(false)
    expect(partial.contentSha256).not.toBe(complete.contentSha256)
  })
})
