/**
 * Local-vs-broker reconciliation regression suite (Pre-V2 Step 4).
 * Pure/offline: builds a broker ledger from synthetic fills + local views. No network,
 * no broker mutation. Historical incident SHAPES are synthetic (no live data).
 */
import { describe, it, expect } from 'vitest'
import { buildBrokerLedger, type LedgerFill, type LedgerTradeRef } from '@/lib/research/broker-ledger'
import { reconcile, type LocalTradeAccounting } from '@/lib/research/broker-reconcile'
import { collectDayFills, etDayBoundsMs, type RawFillActivity } from '@/lib/research/alpaca-fills'

const DAY = '2026-09-08'

// ---- builders ----
let coidSeq = 0
function fill(symbol: string, side: 'buy' | 'sell', qty: number, price: number, coid: string | null, orderId = `o${++coidSeq}`): LedgerFill {
  return { symbol, side, qty, price, filledAt: Date.now() + coidSeq, orderId, clientOrderId: coid }
}
function ledgerOf(trades: LedgerTradeRef[], fills: LedgerFill[], complete = true) {
  return buildBrokerLedger(DAY, fills, trades, 'test', complete)
}
function local(over: Partial<LocalTradeAccounting> & Pick<LocalTradeAccounting, 'tradeId' | 'setupId' | 'symbol'>): LocalTradeAccounting {
  return {
    entryFillQty: 0, entryFillPrice: null, exits: [], openQty: 0, fullyClosed: true,
    realizedPnl: null, reconciliationStatus: 'pending', brokerVerifiedQty: null, ...over,
  }
}
const tref = (id: string, symbol: string, setupId: string, plannedRisk = 100): LedgerTradeRef => ({ id, symbol, setupId, plannedRisk })
const classOf = (rep: ReturnType<typeof reconcile>, tradeId: string) => rep.perTrade.find(r => r.tradeId === tradeId)!.classification

describe('reconciliation — core classifications', () => {
  it('TEST 1 — exact local/broker match, broker flat → VERIFIED', () => {
    const t = tref('pt:AAA', 'AAA', 'AAA:x:10')
    const ledger = ledgerOf([t], [fill('AAA', 'buy', 100, 10, 'pt:AAA'), fill('AAA', 'sell', 100, 11, 'pt:AAA:x:t1:1')])
    const loc = local({ tradeId: 'pt:AAA', setupId: 'AAA:x:10', symbol: 'AAA', entryFillQty: 100, entryFillPrice: 10, exits: [{ qty: 100, fillPrice: 11 }], openQty: 0, realizedPnl: 100 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['AAA', 0]]))
    expect(classOf(rep, 'pt:AAA')).toBe('VERIFIED')
    expect(rep.summary.verified).toBe(1)
  })

  it('TEST 2 — broker has additional exit qty → LOCAL_UNDERBOOKED', () => {
    const t = tref('pt:BBB', 'BBB', 'BBB:x:5')
    const ledger = ledgerOf([t], [fill('BBB', 'buy', 500, 5, 'pt:BBB'), fill('BBB', 'sell', 500, 6, 'pt:BBB:stop:1')])
    const loc = local({ tradeId: 'pt:BBB', setupId: 'BBB:x:5', symbol: 'BBB', entryFillQty: 500, entryFillPrice: 5, exits: [{ qty: 250, fillPrice: 6 }], openQty: 250, fullyClosed: false, realizedPnl: 250 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['BBB', 0]]))
    expect(classOf(rep, 'pt:BBB')).toBe('LOCAL_UNDERBOOKED')
    expect(rep.perTrade[0].delta.exitQty).toBe(250)
  })

  it('TEST 3 — local exit not supported by broker → LOCAL_OVERBOOKED', () => {
    const t = tref('pt:CCC', 'CCC', 'CCC:x:5')
    const ledger = ledgerOf([t], [fill('CCC', 'buy', 500, 5, 'pt:CCC'), fill('CCC', 'sell', 250, 6, 'pt:CCC:stop:1')])
    const loc = local({ tradeId: 'pt:CCC', setupId: 'CCC:x:5', symbol: 'CCC', entryFillQty: 500, entryFillPrice: 5, exits: [{ qty: 500, fillPrice: 6 }], openQty: 0, realizedPnl: 500 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['CCC', 250]]))
    expect(classOf(rep, 'pt:CCC')).toBe('LOCAL_OVERBOOKED')
  })

  it('TEST 4 — local flat, broker position nonzero → LOCAL_FLAT_BROKER_NONFLAT', () => {
    const t = tref('pt:DDD', 'DDD', 'DDD:x:5')
    const ledger = ledgerOf([t], [fill('DDD', 'buy', 500, 5, 'pt:DDD'), fill('DDD', 'sell', 500, 6, 'pt:DDD:stop:1')])
    const loc = local({ tradeId: 'pt:DDD', setupId: 'DDD:x:5', symbol: 'DDD', entryFillQty: 500, entryFillPrice: 5, exits: [{ qty: 500, fillPrice: 6 }], openQty: 0, realizedPnl: 500 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['DDD', 300]]))   // broker still holds 300
    expect(classOf(rep, 'pt:DDD')).toBe('LOCAL_FLAT_BROKER_NONFLAT')
  })

  it('TEST 5 — local nonflat, broker position zero → LOCAL_NONFLAT_BROKER_FLAT', () => {
    const t = tref('pt:EEE', 'EEE', 'EEE:x:5')
    const ledger = ledgerOf([t], [fill('EEE', 'buy', 500, 5, 'pt:EEE'), fill('EEE', 'sell', 500, 6, 'pt:EEE:stop:1')])
    // Local believes 100 still open but its exits only priced 400; broker flat.
    const loc = local({ tradeId: 'pt:EEE', setupId: 'EEE:x:5', symbol: 'EEE', entryFillQty: 500, entryFillPrice: 5, exits: [{ qty: 500, fillPrice: 6 }], openQty: 100, fullyClosed: false, realizedPnl: 500 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['EEE', 0]]))
    expect(classOf(rep, 'pt:EEE')).toBe('LOCAL_NONFLAT_BROKER_FLAT')
  })

  it('TEST 6 — broker fills for a trade absent locally → UNMATCHED_BROKER_ORDER_OR_FILL', () => {
    const t = tref('pt:FFF', 'FFF', 'FFF:x:5')
    const ledger = ledgerOf([t], [fill('FFF', 'buy', 100, 5, 'pt:FFF'), fill('FFF', 'sell', 100, 6, 'pt:FFF:stop:1')])
    const rep = reconcile(DAY, [], ledger, new Map([['FFF', 0]]))   // no local trades at all
    expect(classOf(rep, 'pt:FFF')).toBe('UNMATCHED_BROKER_ORDER_OR_FILL')
    expect(rep.summary.unmatched).toBe(1)
  })

  it('TEST 7 — local trade with no broker fills → UNMATCHED_LOCAL_TRADE', () => {
    const loc = local({ tradeId: 'pt:GGG', setupId: 'GGG:x:5', symbol: 'GGG', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, realizedPnl: 100 })
    const ledger = ledgerOf([], [])
    const rep = reconcile(DAY, [loc], ledger, new Map())
    expect(classOf(rep, 'pt:GGG')).toBe('UNMATCHED_LOCAL_TRADE')
  })

  it('TEST 9 — partially-filled canceled order contributes only its filled portion', () => {
    // Broker filled 250 of a 500 stop, then canceled → only 250 sold.
    const t = tref('pt:HHH', 'HHH', 'HHH:x:5')
    const ledger = ledgerOf([t], [fill('HHH', 'buy', 500, 5, 'pt:HHH'), fill('HHH', 'sell', 250, 6, 'pt:HHH:stop:1')])
    const loc = local({ tradeId: 'pt:HHH', setupId: 'HHH:x:5', symbol: 'HHH', entryFillQty: 500, entryFillPrice: 5, exits: [{ qty: 250, fillPrice: 6 }], openQty: 250, fullyClosed: false, realizedPnl: 250 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['HHH', 250]]))
    expect(rep.perTrade[0].broker.exitQty).toBe(250)
    expect(classOf(rep, 'pt:HHH')).toBe('VERIFIED')   // qty match, and broker still holds 250 (consistent)
  })

  it('TEST 10 — multiple exit orders aggregate correctly', () => {
    const t = tref('pt:III', 'III', 'III:x:5')
    const ledger = ledgerOf([t], [
      fill('III', 'buy', 500, 5, 'pt:III'),
      fill('III', 'sell', 250, 6, 'pt:III:x:t1:1'),
      fill('III', 'sell', 250, 5.5, 'pt:III:stop:2'),
    ])
    expect(ledger.perTrade[0].exitQty).toBe(500)
    const loc = local({ tradeId: 'pt:III', setupId: 'III:x:5', symbol: 'III', entryFillQty: 500, entryFillPrice: 5, exits: [{ qty: 250, fillPrice: 6 }, { qty: 250, fillPrice: 5.5 }], openQty: 0, realizedPnl: 250 * 1 + 250 * 0.5 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['III', 0]]))
    expect(classOf(rep, 'pt:III')).toBe('VERIFIED')
  })

  it('TEST 11 — full broker fill-price precision preserved (no rounding)', () => {
    const px = 31.7933082707
    const t = tref('pt:JJJ', 'JJJ', 'JJJ:x:30')
    const ledger = ledgerOf([t], [fill('JJJ', 'buy', 532, 30, 'pt:JJJ'), fill('JJJ', 'sell', 532, px, 'pt:JJJ:stop:1')])
    expect(ledger.perTrade[0].exitFills[0].price).toBe(px)             // exact, unrounded
    const loc = local({ tradeId: 'pt:JJJ', setupId: 'JJJ:x:30', symbol: 'JJJ', entryFillQty: 532, entryFillPrice: 30, exits: [{ qty: 532, fillPrice: px }], openQty: 0, realizedPnl: (px - 30) * 532 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['JJJ', 0]]))
    expect(rep.perTrade[0].broker.exitNotional).toBeCloseTo(532 * px, 8)
    expect(classOf(rep, 'pt:JJJ')).toBe('VERIFIED')
  })

  it('TEST 12 — broker exits without an entry fill → PNL_UNRESOLVED, no fabricated P&L', () => {
    const t = tref('pt:KKK', 'KKK', 'KKK:x:5')
    const ledger = ledgerOf([t], [fill('KKK', 'sell', 500, 6, 'pt:KKK:stop:1')])   // exit only, no buy fill
    const loc = local({ tradeId: 'pt:KKK', setupId: 'KKK:x:5', symbol: 'KKK', entryFillQty: 500, entryFillPrice: 5, exits: [{ qty: 500, fillPrice: 6 }], openQty: 0, realizedPnl: 500 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['KKK', 0]]))
    expect(classOf(rep, 'pt:KKK')).toBe('PNL_UNRESOLVED')
    expect(rep.perTrade[0].broker.realizedPnl).toBeNull()             // never invented
  })

  it('TEST 13 — deterministic setupId/order identity via client_order_id', () => {
    const t1 = tref('pt:LLL', 'LLL', 'LLL:x:5'); const t2 = tref('pt:LLL2', 'LLL', 'LLL:y:5')
    // Same symbol, two trades — fills attributed strictly by client_order_id prefix.
    const ledger = ledgerOf([t1, t2], [
      fill('LLL', 'buy', 100, 5, 'pt:LLL'), fill('LLL', 'sell', 100, 6, 'pt:LLL:stop:1'),
      fill('LLL', 'buy', 200, 5, 'pt:LLL2'), fill('LLL', 'sell', 200, 4, 'pt:LLL2:stop:1'),
    ])
    expect(ledger.perTrade.find(p => p.tradeId === 'pt:LLL')!.exitQty).toBe(100)
    expect(ledger.perTrade.find(p => p.tradeId === 'pt:LLL2')!.exitQty).toBe(200)
  })

  it('TEST 14 — fill with NULL client_order_id is surfaced UNMATCHED, never silently attributed', () => {
    const t = tref('pt:MMM', 'MMM', 'MMM:x:5')
    const ledger = ledgerOf([t], [
      fill('MMM', 'buy', 100, 5, 'pt:MMM'), fill('MMM', 'sell', 100, 6, 'pt:MMM:stop:1'),
      fill('MMM', 'sell', 50, 6, null),   // no client_order_id — same symbol, but NOT attributed
    ])
    const loc = local({ tradeId: 'pt:MMM', setupId: 'MMM:x:5', symbol: 'MMM', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, realizedPnl: 100 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['MMM', 0]]))
    expect(rep.unmatchedBrokerFills.length).toBe(1)                   // surfaced, not merged
    expect(rep.perTrade[0].confidence).toBe('exact')                 // matched portion stays exact
    expect(classOf(rep, 'pt:MMM')).toBe('VERIFIED')                  // the 50 phantom is NOT folded in silently
  })

  it('TEST 15 — repeated reconciliation is deterministic (identical hash)', () => {
    const t = tref('pt:NNN', 'NNN', 'NNN:x:5')
    const ledger = ledgerOf([t], [fill('NNN', 'buy', 100, 5, 'pt:NNN'), fill('NNN', 'sell', 100, 6, 'pt:NNN:stop:1')])
    const loc = local({ tradeId: 'pt:NNN', setupId: 'NNN:x:5', symbol: 'NNN', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, realizedPnl: 100 })
    const a = reconcile(DAY, [loc], ledger, new Map([['NNN', 0]]))
    const b = reconcile(DAY, [loc], ledger, new Map([['NNN', 0]]))
    expect(a.contentSha256).toBe(b.contentSha256)
  })

  it('TEST 16 — content hash detects mutation', () => {
    const t = tref('pt:OOO', 'OOO', 'OOO:x:5')
    const ledger = ledgerOf([t], [fill('OOO', 'buy', 100, 5, 'pt:OOO'), fill('OOO', 'sell', 100, 6, 'pt:OOO:stop:1')])
    const loc = local({ tradeId: 'pt:OOO', setupId: 'OOO:x:5', symbol: 'OOO', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, realizedPnl: 100 })
    const a = reconcile(DAY, [loc], ledger, new Map([['OOO', 0]]))
    const loc2 = { ...loc, realizedPnl: 999 }
    const b = reconcile(DAY, [loc2], ledger, new Map([['OOO', 0]]))
    expect(a.contentSha256).not.toBe(b.contentSha256)
  })

  it('TEST 17 — report contains no credential material', () => {
    const t = tref('pt:PPP', 'PPP', 'PPP:x:5')
    const ledger = ledgerOf([t], [fill('PPP', 'buy', 100, 5, 'pt:PPP'), fill('PPP', 'sell', 100, 6, 'pt:PPP:stop:1')])
    const loc = local({ tradeId: 'pt:PPP', setupId: 'PPP:x:5', symbol: 'PPP', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, realizedPnl: 100 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['PPP', 0]]))
    const s = JSON.stringify(rep)
    expect(s).not.toMatch(/APCA|ALPACA_|SECRET|Authorization|PK[A-Z0-9]{10}/)
  })

  it('retrieval incomplete → nothing VERIFIED', () => {
    const t = tref('pt:QQQ', 'QQQ', 'QQQ:x:5')
    const ledger = ledgerOf([t], [fill('QQQ', 'buy', 100, 5, 'pt:QQQ'), fill('QQQ', 'sell', 100, 6, 'pt:QQQ:stop:1')], false)
    const loc = local({ tradeId: 'pt:QQQ', setupId: 'QQQ:x:5', symbol: 'QQQ', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, realizedPnl: 100 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['QQQ', 0]]))
    expect(classOf(rep, 'pt:QQQ')).toBe('MANUAL_REVIEW')
    expect(rep.summary.verified).toBe(0)
  })

  it('no position snapshot → NOT authoritative (never VERIFIED), flatness unconfirmed', () => {
    const t = tref('pt:RRR', 'RRR', 'RRR:x:5')
    const ledger = ledgerOf([t], [fill('RRR', 'buy', 100, 5, 'pt:RRR'), fill('RRR', 'sell', 100, 6, 'pt:RRR:stop:1')])
    const loc = local({ tradeId: 'pt:RRR', setupId: 'RRR:x:5', symbol: 'RRR', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, realizedPnl: 100 })
    const rep = reconcile(DAY, [loc], ledger, null)
    expect(rep.positionSnapshotAvailable).toBe(false)
    expect(classOf(rep, 'pt:RRR')).toBe('MANUAL_REVIEW')          // fills reconcile, but not authoritative without flatness
    expect(rep.summary.verified).toBe(0)
    expect(rep.perTrade[0].notes.join(' ')).toMatch(/flatness unconfirmed/)
  })
})

describe('reconciliation — Section K dedup (collectDayFills)', () => {
  it('TEST 8 — duplicate broker activity across overlapping pages is not double-counted', async () => {
    const { startMs } = etDayBoundsMs(DAY)
    const iso = new Date(startMs + 60_000).toISOString()
    const row: RawFillActivity = { id: 'act1', order_id: 'o1', symbol: 'ZZZ', side: 'sell', qty: '100', price: '6', transaction_time: iso } as RawFillActivity
    let call = 0
    const res = await collectDayFills({
      day: DAY,
      fetchPage: async () => {
        call++
        if (call === 1) return { rows: [row], nextPageToken: 'p2' }
        if (call === 2) return { rows: [row], nextPageToken: null }   // SAME activity id again
        return { rows: [], nextPageToken: null }
      },
    })
    expect(res.fills.length).toBe(1)         // deduped by activity id
    expect(res.duplicates).toBe(1)
  })
})

describe('reconciliation — historical incident fixtures (synthetic shapes)', () => {
  it('TEST 18 — BIAF: local under-booked winner, broker exited full residual → LOCAL_UNDERBOOKED', () => {
    const t = tref('pt:BIAF', 'BIAF', 'BIAF:breakout:6.46')
    const ledger = ledgerOf([t], [fill('BIAF', 'buy', 938, 6.46, 'pt:BIAF'), fill('BIAF', 'sell', 938, 6.60, 'pt:BIAF:x:t2:1')])
    const loc = local({ tradeId: 'pt:BIAF', setupId: 'BIAF:breakout:6.46', symbol: 'BIAF', entryFillQty: 938, entryFillPrice: 6.46, exits: [{ qty: 530, fillPrice: 6.60 }], openQty: 408, fullyClosed: false, realizedPnl: (6.60 - 6.46) * 530 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['BIAF', 0]]))
    expect(classOf(rep, 'pt:BIAF')).toBe('LOCAL_UNDERBOOKED')
    expect(rep.perTrade[0].delta.exitQty).toBe(408)   // the missing residual the local ledger never booked
  })

  it('TEST 19 — ZETA: partial then residual stop (88+444), local booked only 444 → LOCAL_UNDERBOOKED, $ gap surfaced', () => {
    const t = tref('pt:ZETA', 'ZETA', 'ZETA:x:31')
    const cumAvg = (88 * 31.81 + 444 * 31.79) / 532
    const ledger = ledgerOf([t], [
      fill('ZETA', 'buy', 532, 32.00, 'pt:ZETA'),
      fill('ZETA', 'sell', 88, 31.81, 'pt:ZETA:stop:1'),
      fill('ZETA', 'sell', 444, 31.79, 'pt:ZETA:stop:1'),   // same order, residual
    ])
    expect(ledger.perTrade[0].exitQty).toBe(532)
    expect(ledger.perTrade[0].exitVwap).toBeCloseTo(cumAvg, 8)
    const loc = local({ tradeId: 'pt:ZETA', setupId: 'ZETA:x:31', symbol: 'ZETA', entryFillQty: 532, entryFillPrice: 32.00, exits: [{ qty: 444, fillPrice: 31.79 }], openQty: 88, fullyClosed: false, realizedPnl: (31.79 - 32.00) * 444 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['ZETA', 0]]))
    expect(classOf(rep, 'pt:ZETA')).toBe('LOCAL_UNDERBOOKED')
    // broker realized reconstructable; local under-booked by the 88-share leg (~$46.64 historically)
    expect(rep.perTrade[0].broker.realizedPnl).toBeCloseTo((88 * 31.81 + 444 * 31.79) - 532 * 32.00, 6)
    expect(rep.perTrade[0].delta.exitQty).toBe(88)
  })

  it('TEST 20 — EVGO: broker fully exited, local metadata stale → resolves to VERIFIED', () => {
    const t = tref('pt:EVGO', 'EVGO', 'EVGO:x:9')
    const ledger = ledgerOf([t], [fill('EVGO', 'buy', 7336, 9.00, 'pt:EVGO'), fill('EVGO', 'sell', 7336, 9.20, 'pt:EVGO:x:t1:1')])
    const loc = local({ tradeId: 'pt:EVGO', setupId: 'EVGO:x:9', symbol: 'EVGO', entryFillQty: 7336, entryFillPrice: 9.00, exits: [{ qty: 7336, fillPrice: 9.20 }], openQty: 0, realizedPnl: (9.20 - 9.00) * 7336, reconciliationStatus: 'discrepancy' })
    const rep = reconcile(DAY, [loc], ledger, new Map([['EVGO', 0]]))
    expect(classOf(rep, 'pt:EVGO')).toBe('VERIFIED')   // broker truth resolves the stale local metadata
  })

  it('TEST 21 — USAR: local/broker qty mismatch, broker flat → LOCAL_UNDERBOOKED (broker sold more)', () => {
    const t = tref('pt:USAR', 'USAR', 'USAR:x:12')
    const ledger = ledgerOf([t], [fill('USAR', 'buy', 879, 12.00, 'pt:USAR'), fill('USAR', 'sell', 879, 11.50, 'pt:USAR:stop:1')])
    const loc = local({ tradeId: 'pt:USAR', setupId: 'USAR:x:12', symbol: 'USAR', entryFillQty: 879, entryFillPrice: 12.00, exits: [{ qty: 606, fillPrice: 11.50 }], openQty: 273, fullyClosed: false, realizedPnl: (11.50 - 12.00) * 606 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['USAR', 0]]))
    expect(classOf(rep, 'pt:USAR')).toBe('LOCAL_UNDERBOOKED')
  })

  it('TEST 22 — RARE: local residual, broker flat → LOCAL_NONFLAT_BROKER_FLAT', () => {
    const t = tref('pt:RARE', 'RARE', 'RARE:x:20')
    // Local exit qty MATCHES broker exit qty, but local openQty still shows a residual while broker is flat.
    const ledger = ledgerOf([t], [fill('RARE', 'buy', 1069, 20.00, 'pt:RARE'), fill('RARE', 'sell', 1069, 19.50, 'pt:RARE:stop:1')])
    const loc = local({ tradeId: 'pt:RARE', setupId: 'RARE:x:20', symbol: 'RARE', entryFillQty: 1069, entryFillPrice: 20.00, exits: [{ qty: 1069, fillPrice: 19.50 }], openQty: 14, fullyClosed: false, realizedPnl: (19.50 - 20.00) * 1069 })
    const rep = reconcile(DAY, [loc], ledger, new Map([['RARE', 0]]))
    expect(classOf(rep, 'pt:RARE')).toBe('LOCAL_NONFLAT_BROKER_FLAT')
  })

  it('TEST 23 — CHPT: invalid post-fill geometry, broker $ economics reconstructable → VERIFIED in dollars', () => {
    const t = tref('pt:CHPT', 'CHPT', 'CHPT:opening_drive:9.48', /*plannedRisk*/ -12.35) // negative risk (invalid geometry)
    const ledger = ledgerOf([t], [fill('CHPT', 'buy', 1653, 9.70, 'pt:CHPT'), fill('CHPT', 'sell', 1653, 9.57, 'pt:CHPT:invalid:1')])
    const brokerPnl = 1653 * (9.57 - 9.70)   // -214.89
    const loc = local({ tradeId: 'pt:CHPT', setupId: 'CHPT:opening_drive:9.48', symbol: 'CHPT', entryFillQty: 1653, entryFillPrice: 9.70, exits: [{ qty: 1653, fillPrice: 9.57 }], openQty: 0, realizedPnl: brokerPnl })
    const rep = reconcile(DAY, [loc], ledger, new Map([['CHPT', 0]]))
    expect(rep.perTrade[0].broker.realizedPnl).toBeCloseTo(brokerPnl, 6)   // dollars reconstructable
    expect(classOf(rep, 'pt:CHPT')).toBe('VERIFIED')                        // even though frozen R was invalid
    expect(rep.perTrade[0].broker.realizedPnl).toBeCloseTo(-214.89, 2)
  })
})
