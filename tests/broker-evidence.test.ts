/**
 * Step-4 hardening: raw broker evidence archival, pagination completeness, offline
 * replay, hashing/mutation detection, secret-leak, and completeness gating.
 * Fully offline — no network, no credentials, no broker mutation.
 */
import { describe, it, expect } from 'vitest'
import { collectDayFills, normalizeFills, etDayBoundsMs, type FillPage, type RawFillActivity } from '@/lib/research/alpaca-fills'
import {
  hashArtifact, positionsFromRaw, ledgerFillsFromArchive, rebuildBrokerLedgerFromArchive,
  type RawBrokerArchive, type RawPosition,
} from '@/lib/research/broker-acquire'
import { sha256Bytes } from '@/lib/research/session-snapshot'
import { reconcile, localViewFromTrade } from '@/lib/research/broker-reconcile'
import type { LedgerTradeRef } from '@/lib/research/broker-ledger'

const DAY = '2026-09-08'
const inWindowIso = () => new Date(etDayBoundsMs(DAY).startMs + 3_600_000).toISOString()
function act(id: string, orderId: string, sym: string, side: string, qty: number, price: number): RawFillActivity {
  return { id, order_id: orderId, symbol: sym, side, qty, price, transaction_time: inWindowIso() }
}
// paginate an array of rows into pages of `size`, cursor = last id
function pager(rows: RawFillActivity[], size = 100) {
  return async (token: string | null): Promise<FillPage> => {
    const start = token ? rows.findIndex(r => r.id === token) + 1 : 0
    const slice = rows.slice(start, start + size)
    const nextPageToken = slice.length === size ? slice[slice.length - 1].id : null
    return { rows: slice, nextPageToken }
  }
}

describe('pagination completeness (Section 5/6)', () => {
  it('A — one-page response acquires all records, one page', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => act(`a${i}`, `o${i}`, 'AAA', 'sell', 1, 5))
    const r = await collectDayFills({ day: DAY, fetchPage: pager(rows) })
    expect(r.complete).toBe(true); expect(r.pages).toBe(1); expect(r.rawActivities).toHaveLength(10); expect(r.fills).toHaveLength(10)
  })

  it('B — three-page response acquires all records, no omissions', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => act(`a${i}`, `o${i}`, 'BBB', 'sell', 1, 5))
    const r = await collectDayFills({ day: DAY, fetchPage: pager(rows) })
    expect(r.complete).toBe(true); expect(r.pages).toBe(3); expect(r.fills).toHaveLength(250); expect(r.rawActivities).toHaveLength(250)
  })

  it('C — duplicate activity across a page boundary: raw preserved, normalized deduped', async () => {
    const dup = act('dupX', 'o1', 'CCC', 'sell', 100, 6)
    // page1 ends with dup; page2 starts with dup again (overlap)
    const rows = [act('a0', 'o0', 'CCC', 'buy', 100, 5), dup]
    let call = 0
    const r = await collectDayFills({ day: DAY, fetchPage: async () => {
      call++
      if (call === 1) return { rows, nextPageToken: 'dupX' }
      if (call === 2) return { rows: [dup], nextPageToken: null }   // dup appears again
      return { rows: [], nextPageToken: null }
    }})
    expect(r.rawActivities).toHaveLength(3)      // raw evidence preserved as-received (incl. the repeat)
    expect(r.duplicates).toBe(1)                 // one dropped in normalization
    expect(r.fills).toHaveLength(2)              // deduped by activity id
    expect(r.complete).toBe(true)
  })

  it('D — final empty page terminates cleanly', async () => {
    let call = 0
    const r = await collectDayFills({ day: DAY, fetchPage: async () => {
      call++
      if (call === 1) return { rows: [act('a0', 'o0', 'DDD', 'sell', 1, 5)], nextPageToken: 'a0' }
      return { rows: [], nextPageToken: null }
    }})
    expect(r.complete).toBe(true); expect(r.fills).toHaveLength(1)
  })

  it('E — cyclic pagination token fails safe (no infinite loop)', async () => {
    const row = act('a0', 'o0', 'EEE', 'sell', 1, 5)
    const r = await collectDayFills({ day: DAY, fetchPage: async () => ({ rows: [row, act('a1', 'o1', 'EEE', 'sell', 1, 5)], nextPageToken: 'STUCK' }) })
    expect(r.complete).toBe(false)
    expect(r.incompleteReason).toMatch(/cyclic page token/)
  })

  it('F — second-page fetch failure → INCOMPLETE (not authoritative)', async () => {
    let call = 0
    const r = await collectDayFills({ day: DAY, fetchPage: async () => {
      call++
      if (call === 1) return { rows: Array.from({ length: 100 }, (_, i) => act(`a${i}`, `o${i}`, 'FFF', 'sell', 1, 5)), nextPageToken: 'a99' }
      throw new Error('502 upstream')
    }})
    expect(r.complete).toBe(false)
    expect(r.incompleteReason).toMatch(/fetch failed/)
  })

  it('G — malformed pagination token fails closed', async () => {
    const r = await collectDayFills({ day: DAY, fetchPage: async () => ({ rows: [act('a0', 'o0', 'GGG', 'sell', 1, 5)], nextPageToken: ({} as unknown as string) }) })
    expect(r.complete).toBe(false)
    expect(r.incompleteReason).toMatch(/malformed page token/)
  })
})

describe('ET session boundary (Section 9)', () => {
  it('an activity at 00:30 UTC belongs to the PREVIOUS ET trading day (excluded from this day)', async () => {
    // 2026-09-08 00:30 UTC is 2026-09-07 20:30 ET → outside the 2026-09-08 ET window.
    const row: RawFillActivity = { id: 'x', order_id: 'o', symbol: 'AAA', side: 'sell', qty: 1, price: 5, transaction_time: '2026-09-08T00:30:00Z' }
    const r = await collectDayFills({ day: DAY, fetchPage: async () => ({ rows: [row], nextPageToken: null }) })
    expect(r.fills).toHaveLength(0)
    expect(r.outOfWindow).toBe(1)
  })
})

describe('raw archive hashing + offline replay (Sections 1-4, 10)', () => {
  const trades: LedgerTradeRef[] = [{ id: 'pt:AAA', symbol: 'AAA', setupId: 'AAA:x:5', plannedRisk: 100 }]
  const archive: RawBrokerArchive = {
    activities: [act('a0', 'o0', 'AAA', 'buy', 100, 5), act('a1', 'o1', 'AAA', 'sell', 100, 6)],
    ordersClientIds: { o0: 'pt:AAA', o1: 'pt:AAA:stop:1' },
    positions: [] as RawPosition[],   // flat
  }

  it('rebuilds the broker ledger deterministically from the raw archive (offline, twice identical)', () => {
    const a = rebuildBrokerLedgerFromArchive(DAY, archive, trades, true)
    const b = rebuildBrokerLedgerFromArchive(DAY, archive, trades, true)
    expect(a.contentSha256).toBe(b.contentSha256)
    expect(a.perTrade[0].exitQty).toBe(100)
    expect(a.perTrade[0].brokerPnl).toBeCloseTo(100 * 6 - 100 * 5, 6)
  })

  it('full offline replay: raw archive → ledger → reconcile is deterministic', () => {
    const ledger = rebuildBrokerLedgerFromArchive(DAY, archive, trades, true)
    const positions = positionsFromRaw(archive.positions).map
    const local = [localViewFromTrade({ id: 'pt:AAA', setupId: 'AAA:x:5', symbol: 'AAA', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, fullyClosed: true, realizedPnl: 100, reconciliationStatus: 'pending', brokerVerifiedQty: null, state: 'closed' })]
    const r1 = reconcile(DAY, local, ledger, positions)
    const r2 = reconcile(DAY, local, ledger, positions)
    expect(r1.contentSha256).toBe(r2.contentSha256)
    expect(r1.perTrade[0].classification).toBe('VERIFIED')   // complete + positions acquired (flat)
  })

  it('artifact hash detects raw mutation after freeze', () => {
    const h = hashArtifact(archive.activities)
    const mutated = [...archive.activities]
    mutated[1] = { ...mutated[1], qty: 999 }
    const h2 = hashArtifact(mutated)
    expect(h2.sha256).not.toBe(h.sha256)
    // a verifier comparing recomputed vs manifest hash would reject the mutated bytes
    expect(sha256Bytes(hashArtifact(mutated).text)).not.toBe(h.sha256)
  })

  it('ledgerFillsFromArchive attributes client_order_id from the archived orders map', () => {
    const fills = ledgerFillsFromArchive(archive, DAY)
    expect(fills.find(f => f.orderId === 'o1')!.clientOrderId).toBe('pt:AAA:stop:1')
  })
})

describe('completeness gating (Section 7)', () => {
  const trades: LedgerTradeRef[] = [{ id: 'pt:AAA', symbol: 'AAA', setupId: 'AAA:x:5', plannedRisk: 100 }]
  const archive: RawBrokerArchive = {
    activities: [act('a0', 'o0', 'AAA', 'buy', 100, 5), act('a1', 'o1', 'AAA', 'sell', 100, 6)],
    ordersClientIds: { o0: 'pt:AAA', o1: 'pt:AAA:stop:1' }, positions: [],
  }
  const local = [localViewFromTrade({ id: 'pt:AAA', setupId: 'AAA:x:5', symbol: 'AAA', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, fullyClosed: true, realizedPnl: 100, reconciliationStatus: 'pending', brokerVerifiedQty: null, state: 'closed' })]

  it('incomplete activities → nothing VERIFIED', () => {
    const ledger = rebuildBrokerLedgerFromArchive(DAY, archive, trades, /*complete*/ false)
    const rep = reconcile(DAY, local, ledger, positionsFromRaw(archive.positions).map)
    expect(rep.summary.verified).toBe(0)
    expect(rep.perTrade[0].classification).toBe('MANUAL_REVIEW')
  })

  it('positions not acquired → nothing authoritative-VERIFIED', () => {
    const ledger = rebuildBrokerLedgerFromArchive(DAY, archive, trades, true)
    const rep = reconcile(DAY, local, ledger, /*positions*/ null)
    expect(rep.summary.verified).toBe(0)
  })
})

describe('secret-leak regression (Section 11)', () => {
  it('no ALPACA credential strings appear in any evidence artifact', () => {
    process.env.ALPACA_API_KEY = 'super-secret-key'
    process.env.ALPACA_SECRET_KEY = 'super-secret-secret'
    const trades: LedgerTradeRef[] = [{ id: 'pt:AAA', symbol: 'AAA', setupId: 'AAA:x:5', plannedRisk: 100 }]
    const archive: RawBrokerArchive = {
      activities: [act('a0', 'o0', 'AAA', 'buy', 100, 5), act('a1', 'o1', 'AAA', 'sell', 100, 6)],
      ordersClientIds: { o0: 'pt:AAA', o1: 'pt:AAA:stop:1' }, positions: [{ symbol: 'AAA', qty: 0 }],
    }
    const ledger = rebuildBrokerLedgerFromArchive(DAY, archive, trades, true)
    const local = [localViewFromTrade({ id: 'pt:AAA', setupId: 'AAA:x:5', symbol: 'AAA', entryFillQty: 100, entryFillPrice: 5, exits: [{ qty: 100, fillPrice: 6 }], openQty: 0, fullyClosed: true, realizedPnl: 100, reconciliationStatus: 'pending', brokerVerifiedQty: null, state: 'closed' })]
    const report = reconcile(DAY, local, ledger, positionsFromRaw(archive.positions).map)
    const blobs = [
      hashArtifact(archive.activities).text, hashArtifact(archive.ordersClientIds).text,
      hashArtifact(archive.positions).text, hashArtifact(ledger).text, hashArtifact(report).text,
    ].join('\n')
    expect(blobs).not.toMatch(/super-secret-key|super-secret-secret/)
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY
  })
})
