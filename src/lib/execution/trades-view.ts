/**
 * Ledger → Journal view.
 *
 * Pure sanitizer for the execution ledger (PaperTrade) into what the Journal UI
 * is allowed to render for a Companion-originated PAPER trade. No fs, no
 * network — safe to import from a server route and unit-test in isolation.
 *
 * Two rules mirror positions-view.ts:
 *
 * 1. Every row here comes from the ledger, which the daemon only ever writes
 *    for a trade IT placed (setupId + signalId always present). There is no
 *    path by which an externally-opened Alpaca position reaches this file, so
 *    "fabricating provenance for an external position" is structurally
 *    impossible here — the risk that matters is a *client* inventing a ledger
 *    row for a broker position it can't attribute (guarded in positions-view).
 *
 * 2. Realized P&L is read verbatim from `trade.realizedPnl` / `realizedPnlPct`
 *    — computed once, in the executor, off broker fills. This file never
 *    re-derives P&L from prices; that would be a second accounting
 *    implementation living in the UI layer, which is exactly what the ledger
 *    exists to prevent.
 */
import type { PaperTrade, ExitLeg } from './types'

export type BrokerLinkStatus = 'linked' | 'none'

/** One exit fill, sanitized for the client — order id + fill evidence, nothing else. */
export interface JournalExitView {
  reason: ExitLeg['reason']
  qty: number
  orderId: string | null
  fillPrice: number | null
  filledAt: number | null
  slippagePct: number | null
}

/**
 * One row in the Journal's broker-linked section. Always `brokerLink: 'linked'`
 * — a row only exists here because the ledger recorded it, which means a
 * setupId/signalId and (once submitted) a broker entry order stand behind it.
 */
export interface BrokerTradeView {
  tradeId: string
  signalId: string
  setupId: string
  symbol: string
  setupType: string
  state: PaperTrade['state']
  brokerLink: BrokerLinkStatus

  qty: number
  openQty: number
  entryOrderId: string | null
  entryFillPrice: number | null
  entryFilledAt: number | null
  entrySlippagePct: number | null

  exits: JournalExitView[]

  /** Verbatim from the ledger — never recomputed here. */
  realizedPnl: number | null
  realizedPnlPct: number | null
  fullyClosed: boolean

  reconciliationStatus: PaperTrade['reconciliationStatus']
  executionWarnings: string[]

  createdAt: number
  updatedAt: number
}

export function toTradeView(t: PaperTrade): BrokerTradeView {
  return {
    tradeId: t.id,
    signalId: t.signalId,
    setupId: t.setupId,
    symbol: t.symbol,
    setupType: t.setupType,
    state: t.state,
    brokerLink: 'linked',

    qty: t.qty,
    openQty: t.openQty,
    entryOrderId: t.entryOrderId,
    entryFillPrice: t.entryFillPrice,
    entryFilledAt: t.entryFilledAt,
    entrySlippagePct: t.entrySlippagePct,

    exits: t.exits.map(e => ({
      reason: e.reason,
      qty: e.qty,
      orderId: e.orderId,
      fillPrice: e.fillPrice,
      filledAt: e.filledAt,
      slippagePct: e.slippagePct,
    })),

    realizedPnl: t.realizedPnl,
    realizedPnlPct: t.realizedPnlPct,
    fullyClosed: t.fullyClosed,

    reconciliationStatus: t.reconciliationStatus,
    executionWarnings: t.executionWarnings,

    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

export interface JournalTradesPayload {
  ok: true
  asOf: number
  trades: BrokerTradeView[]
  counts: {
    total: number
    closed: number
    open: number
    verified: number
    manualReview: number
  }
}

/** Build the sanitized journal payload from a set of ledger trades (any day range the caller loaded). */
export function buildTradeJournalView(trades: PaperTrade[], asOf: number = Date.now()): JournalTradesPayload {
  const rows = trades
    .map(toTradeView)
    .sort((a, b) => b.createdAt - a.createdAt)

  return {
    ok: true,
    asOf,
    trades: rows,
    counts: {
      total: rows.length,
      closed: rows.filter(r => r.state === 'closed').length,
      open: rows.filter(r => r.state === 'open' || r.state === 'pending_entry').length,
      verified: rows.filter(r => r.reconciliationStatus === 'verified').length,
      manualReview: rows.filter(r => r.reconciliationStatus === 'manual_review').length,
    },
  }
}
