/**
 * Local-vs-broker reconciliation — pure, deterministic, READ-ONLY.
 *
 * Consumes the broker-truth ledger (from broker FILL activities, joined to trades by
 * client_order_id) and the local execution ledger, plus an independent broker POSITION
 * snapshot (flatness), and classifies each trade's agreement. It computes; it never
 * touches a trade, an order, or broker state.
 *
 * P&L RULE: broker-realized P&L is only ever the broker ledger's fill-derived figure
 * (Σ sell·price − Σ buy·price). It is NEVER derived from local intent, stops, risk, or
 * quotes. Where broker fills are insufficient (no entry fill, missing price, incomplete
 * retrieval) the result is PNL_UNRESOLVED / MANUAL_REVIEW — never a fabricated number.
 *
 * FLATNESS is independent evidence: the fills ledger balancing to zero does NOT prove
 * the account currently holds zero, and a current-zero position does NOT prove the fill
 * history was complete. Both facts are preserved separately.
 */
import { sha256 } from '@/lib/research/phantom-tape'
import type { BrokerLedger, PerTradeLedger, LedgerFill } from '@/lib/research/broker-ledger'

export type ReconClass =
  | 'VERIFIED'
  | 'LOCAL_UNDERBOOKED'
  | 'LOCAL_OVERBOOKED'
  | 'LOCAL_FLAT_BROKER_NONFLAT'
  | 'LOCAL_NONFLAT_BROKER_FLAT'
  | 'UNMATCHED_BROKER_ORDER_OR_FILL'
  | 'UNMATCHED_LOCAL_TRADE'
  | 'PNL_UNRESOLVED'
  | 'IDENTITY_AMBIGUOUS'
  | 'MANUAL_REVIEW'

/** Minimal local accounting view — decoupled from the full PaperTrade schema for testability. */
export interface LocalTradeAccounting {
  tradeId: string
  setupId: string
  symbol: string
  /** Filled entry quantity (0 for an aborted/unfilled entry). */
  entryFillQty: number
  entryFillPrice: number | null
  /** Filled exit legs only (fillPrice != null). */
  exits: ReadonlyArray<{ qty: number; fillPrice: number | null }>
  openQty: number
  fullyClosed: boolean
  realizedPnl: number | null
  reconciliationStatus: string
  brokerVerifiedQty: number | null
  /** True when the entry never filled (timeout/abort) — nothing to reconcile if broker also shows nothing. */
  aborted?: boolean
}

const QTY_TOL = 0        // shares are integers — exact
const USD_TOL = 0.01     // one cent, for float noise only

export interface PerTradeRecon {
  symbol: string
  setupId: string
  tradeId: string
  local: {
    entryQty: number; entryPrice: number | null; exitQty: number; exitProceeds: number
    openQty: number; fullyClosed: boolean; realizedPnl: number | null
    reconciliationStatus: string; brokerVerifiedQty: number | null
  }
  broker: {
    entryQty: number; entryNotional: number; exitQty: number; exitNotional: number
    netQty: number; flat: boolean | null; realizedPnl: number | null
  }
  delta: { entryQty: number; exitQty: number; netQty: number; pnl: number | null }
  /** Independent current position for the symbol (null if snapshot unavailable). */
  brokerPositionQty: number | null
  classification: ReconClass
  /** 'exact' = matched by client_order_id; 'heuristic' would flag a guessed identity (never emitted — matching is deterministic-only). */
  confidence: 'exact' | 'heuristic'
  notes: string[]
}

export interface ReconciliationReport {
  day: string
  /** Mirrors the ledger: false means broker retrieval was incomplete → nothing may be VERIFIED. */
  retrievalComplete: boolean
  positionSnapshotAvailable: boolean
  perTrade: PerTradeRecon[]
  /** Broker fills that mapped to no local trade (surfaced, never silently merged). */
  unmatchedBrokerFills: LedgerFill[]
  summary: { total: number; verified: number; discrepancies: number; unresolved: number; unmatched: number }
  contentSha256: string
}

const localExitQty = (t: LocalTradeAccounting) => t.exits.reduce((s, e) => s + (e.fillPrice != null ? e.qty : 0), 0)
const localExitProceeds = (t: LocalTradeAccounting) => t.exits.reduce((s, e) => s + (e.fillPrice != null ? e.qty * e.fillPrice : 0), 0)

/**
 * Reconcile local trades against broker truth. `brokerPositions` maps symbol → current
 * broker qty (from a read-only positions snapshot); null when no snapshot was acquired.
 */
export function reconcile(
  day: string,
  local: readonly LocalTradeAccounting[],
  ledger: BrokerLedger,
  brokerPositions: ReadonlyMap<string, number> | null,
): ReconciliationReport {
  const positionSnapshotAvailable = brokerPositions != null
  const byTradeId = new Map<string, PerTradeLedger>()
  for (const p of ledger.perTrade) byTradeId.set(p.tradeId, p)
  const matchedLedgerIds = new Set<string>()

  const perTrade: PerTradeRecon[] = []

  for (const t of local) {
    const bl = byTradeId.get(t.tradeId)
    if (bl) matchedLedgerIds.add(t.tradeId)
    const notes: string[] = []

    const lView = {
      entryQty: t.entryFillQty, entryPrice: t.entryFillPrice,
      exitQty: localExitQty(t), exitProceeds: localExitProceeds(t),
      openQty: t.openQty, fullyClosed: t.fullyClosed, realizedPnl: t.realizedPnl,
      reconciliationStatus: t.reconciliationStatus, brokerVerifiedQty: t.brokerVerifiedQty,
    }

    const posQty = positionSnapshotAvailable ? (brokerPositions!.get(t.symbol) ?? 0) : null
    const brokerFlat: boolean | null = posQty == null ? null : posQty === 0

    // Broker-side aggregates (from fills). Absent ledger → zeros, and the trade is
    // unmatched on the broker side.
    const bEntryQty = bl?.entryQty ?? 0
    const bExitQty = bl?.exitQty ?? 0
    const bEntryNotional = (bl?.entryFills ?? []).reduce((s, f) => s + f.qty * f.price, 0)
    const bExitNotional = (bl?.exitFills ?? []).reduce((s, f) => s + f.qty * f.price, 0)
    const bNetQty = bl?.residualQty ?? 0
    // Broker realized P&L is only meaningful once the position is FULLY exited on the
    // broker side (entry cost basis fully allocated). While a residual is still open,
    // Σsell−Σbuy charges the whole entry against a partial exit — an unrealized figure,
    // not comparable to local realized. So require residualQty<=0 too.
    const brokerFullyClosed = !!bl && bNetQty <= 0
    const brokerPnlComputable = !!bl && bEntryQty > 0 && bExitQty > 0 && brokerFullyClosed
    const brokerPnl = brokerPnlComputable ? bl!.brokerPnl : null

    const broker = {
      entryQty: bEntryQty, entryNotional: bEntryNotional, exitQty: bExitQty,
      exitNotional: bExitNotional, netQty: bNetQty, flat: brokerFlat, realizedPnl: brokerPnl,
    }
    const delta = {
      entryQty: bEntryQty - lView.entryQty,
      exitQty: bExitQty - lView.exitQty,
      netQty: bNetQty - (lView.entryQty - lView.exitQty),
      pnl: (brokerPnl != null && lView.realizedPnl != null) ? brokerPnl - lView.realizedPnl : null,
    }

    let classification: ReconClass
    if (!ledger.retrievalComplete) {
      classification = 'MANUAL_REVIEW'
      notes.push('broker fill retrieval incomplete — nothing can be VERIFIED')
    } else if (t.aborted && !bl) {
      // Aborted locally with no broker fills. "No trade" can only be VERIFIED with
      // authoritative POSITION evidence proving the broker is flat — never on absence alone.
      if (!positionSnapshotAvailable) {
        classification = 'MANUAL_REVIEW'
        notes.push('aborted/unfilled locally, no broker fills, but NO position snapshot — flatness unconfirmed, cannot VERIFY')
      } else if (posQty !== 0) {
        classification = 'LOCAL_FLAT_BROKER_NONFLAT'
        notes.push(`aborted/unfilled locally but broker holds ${posQty}`)
      } else {
        classification = 'VERIFIED'
        notes.push('aborted/unfilled locally, no broker fills, broker position flat — agree (no trade)')
      }
    } else if (!bl) {
      classification = 'UNMATCHED_LOCAL_TRADE'
      notes.push('local trade has no broker fills mapped by client_order_id')
    } else if (bEntryQty === 0 && bExitQty > 0) {
      classification = 'PNL_UNRESOLVED'
      notes.push('broker exit fills without an entry fill — cost basis unknown; P&L not reconstructable')
    } else if (delta.exitQty > QTY_TOL) {
      classification = 'LOCAL_UNDERBOOKED'
      notes.push(`broker exit qty ${bExitQty} > local ${lView.exitQty} (+${delta.exitQty})`)
    } else if (delta.exitQty < -QTY_TOL) {
      classification = 'LOCAL_OVERBOOKED'
      notes.push(`broker exit qty ${bExitQty} < local ${lView.exitQty} (${delta.exitQty})`)
    } else if (posQty != null && lView.openQty === 0 && posQty > 0) {
      classification = 'LOCAL_FLAT_BROKER_NONFLAT'
      notes.push(`local flat but broker holds ${posQty}`)
    } else if (posQty != null && lView.openQty > 0 && posQty === 0) {
      classification = 'LOCAL_NONFLAT_BROKER_FLAT'
      notes.push(`local holds ${lView.openQty} but broker flat`)
    } else if (posQty != null && posQty !== lView.openQty) {
      // Both hold, but different quantities — an unexplained residual disagreement.
      classification = 'MANUAL_REVIEW'
      notes.push(`open-position mismatch: local ${lView.openQty} vs broker ${posQty}`)
    } else if (!positionSnapshotAvailable) {
      // No independent flatness evidence → NOT authoritative. Fills may reconcile, but
      // broker-flat cannot be confirmed, so this never earns VERIFIED (Section 7/8).
      classification = 'MANUAL_REVIEW'
      notes.push('broker position snapshot unavailable — fills-only, NOT authoritative (flatness unconfirmed)')
    } else if (bNetQty > 0 || lView.openQty > 0) {
      // Still-open position and exposure agrees. Realized P&L is not yet meaningful;
      // verify agreement on quantities/exposure, not on P&L.
      classification = 'VERIFIED'
      notes.push('position still open; exit quantities and exposure agree, realized P&L pending full exit')
    } else if (!brokerPnlComputable) {
      classification = 'PNL_UNRESOLVED'
      notes.push('broker P&L not reconstructable from available fills')
    } else if (brokerPnl == null || !Number.isFinite(brokerPnl)) {
      // A non-finite broker P&L (e.g. from a malformed fill reaching ledger arithmetic) is
      // INVALID EVIDENCE. It must NOT reach the tolerance comparison, where Math.abs(NaN) > tol
      // silently evaluates false and falls through to VERIFIED (P1-008-C).
      classification = 'MANUAL_REVIEW'
      notes.push('broker P&L is non-finite (invalid evidence) — cannot VERIFY')
    } else if (lView.realizedPnl == null || !Number.isFinite(lView.realizedPnl)) {
      // A filled, closed trade cannot be VERIFIED while local realized P&L is missing/non-finite:
      // there is no finite input to compare (P1-008-B). delta.pnl would be null and skip the guard.
      classification = 'PNL_UNRESOLVED'
      notes.push('local realized P&L missing/non-finite — P&L comparison input unavailable, cannot VERIFY')
    } else if (delta.pnl == null || !Number.isFinite(delta.pnl)) {
      classification = 'MANUAL_REVIEW'
      notes.push('P&L delta is null/non-finite — invalid evidence, cannot VERIFY')
    } else if (Math.abs(delta.pnl) > USD_TOL) {
      classification = 'MANUAL_REVIEW'
      notes.push(`P&L delta ${delta.pnl.toFixed(4)} exceeds tolerance with matched quantities`)
    } else {
      // VERIFIED only after every prerequisite is proven: complete retrieval, matched fills,
      // position evidence, finite local & broker P&L, quantities reconcile, P&L within tolerance.
      classification = 'VERIFIED'
    }

    if (bl?.flags?.length) notes.push(`ledger flags: ${bl.flags.join(',')}`)

    perTrade.push({
      symbol: t.symbol, setupId: t.setupId, tradeId: t.tradeId,
      local: lView, broker, delta, brokerPositionQty: posQty,
      classification, confidence: 'exact', notes,
    })
  }

  // Broker fills that mapped to a trade id not present in the local set → unmatched broker.
  const localIds = new Set(local.map(t => t.tradeId))
  const brokerOnly: PerTradeRecon[] = []
  for (const p of ledger.perTrade) {
    if (localIds.has(p.tradeId)) continue
    brokerOnly.push({
      symbol: p.symbol, setupId: p.setupId, tradeId: p.tradeId,
      local: { entryQty: 0, entryPrice: null, exitQty: 0, exitProceeds: 0, openQty: 0, fullyClosed: false, realizedPnl: null, reconciliationStatus: 'none', brokerVerifiedQty: null },
      broker: {
        entryQty: p.entryQty, entryNotional: p.entryFills.reduce((s, f) => s + f.qty * f.price, 0),
        exitQty: p.exitQty, exitNotional: p.exitFills.reduce((s, f) => s + f.qty * f.price, 0),
        netQty: p.residualQty, flat: null,
        realizedPnl: (p.entryQty > 0 && p.exitQty > 0) ? p.brokerPnl : null,
      },
      delta: { entryQty: p.entryQty, exitQty: p.exitQty, netQty: p.residualQty, pnl: null },
      brokerPositionQty: positionSnapshotAvailable ? (brokerPositions!.get(p.symbol) ?? 0) : null,
      classification: 'UNMATCHED_BROKER_ORDER_OR_FILL',
      confidence: 'exact',
      notes: ['broker fills for a trade id absent from the local ledger'],
    })
  }
  const all = [...perTrade, ...brokerOnly]

  const DISCREPANCY: ReconClass[] = ['LOCAL_UNDERBOOKED', 'LOCAL_OVERBOOKED', 'LOCAL_FLAT_BROKER_NONFLAT', 'LOCAL_NONFLAT_BROKER_FLAT']
  const UNRESOLVED: ReconClass[] = ['PNL_UNRESOLVED', 'IDENTITY_AMBIGUOUS', 'MANUAL_REVIEW']
  const UNMATCHED: ReconClass[] = ['UNMATCHED_BROKER_ORDER_OR_FILL', 'UNMATCHED_LOCAL_TRADE']
  const summary = {
    total: all.length,
    verified: all.filter(r => r.classification === 'VERIFIED').length,
    discrepancies: all.filter(r => DISCREPANCY.includes(r.classification)).length,
    unresolved: all.filter(r => UNRESOLVED.includes(r.classification)).length,
    unmatched: all.filter(r => UNMATCHED.includes(r.classification)).length,
  }

  const bodyNoHash = {
    day,
    retrievalComplete: ledger.retrievalComplete,
    positionSnapshotAvailable,
    perTrade: all,
    unmatchedBrokerFills: ledger.unmapped,
    summary,
  }
  return { ...bodyNoHash, contentSha256: sha256(JSON.stringify(bodyNoHash)) }
}

/** Adapter: build the reconcile input view from a raw PaperTrade JSON object (CLI use). */
export function localViewFromTrade(t: Record<string, unknown>): LocalTradeAccounting {
  const exits = Array.isArray(t.exits) ? (t.exits as Array<Record<string, unknown>>) : []
  const entryFillQty = Number(t.entryFillQty ?? 0)
  return {
    tradeId: String(t.id),
    setupId: String(t.setupId),
    symbol: String(t.symbol),
    entryFillQty,
    entryFillPrice: t.entryFillPrice == null ? null : Number(t.entryFillPrice),
    exits: exits.map(e => ({ qty: Number(e.qty ?? 0), fillPrice: e.fillPrice == null ? null : Number(e.fillPrice) })),
    openQty: Number(t.openQty ?? 0),
    fullyClosed: Boolean(t.fullyClosed),
    realizedPnl: t.realizedPnl == null ? null : Number(t.realizedPnl),
    reconciliationStatus: String(t.reconciliationStatus ?? 'pending'),
    brokerVerifiedQty: t.brokerVerifiedQty == null ? null : Number(t.brokerVerifiedQty),
    aborted: t.state === 'aborted' || entryFillQty === 0,
  }
}
