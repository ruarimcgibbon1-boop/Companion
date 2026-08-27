/**
 * Broker-truth ledger — pure accounting core (no network, no fs, no broker state).
 *
 * Given the broker's own FILL activity and the day's paper trades, reconstruct
 * exact per-trade broker economics from primary fills — so nightly reconciliation
 * never has to fall back to equity subtraction (Session-3 finding B).
 *
 * READ-ONLY BY CONSTRUCTION: this module computes; it never mutates a trade, an
 * order, or broker state. The executor and its reconciliation are untouched.
 *
 * Ownership mapping uses the executor's own `client_order_id` convention:
 *   entry  = `<trade.id>`
 *   exits  = `<trade.id>:x:<reason>:<ts>` | `<trade.id>:stop:<ts>` | `<trade.id>:flat:<ts>` | …
 * so a fill is owned by trade T iff its clientOrderId === T.id or starts with `T.id:`.
 * A fill that maps to no known trade is reported as `unmapped` (external), never
 * silently dropped.
 */
import { sha256 } from '@/lib/research/phantom-tape'

export interface LedgerFill {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  filledAt: number
  orderId: string | null
  /** Resolved by the I/O shell via getOrder(orderId).clientOrderId; null if unavailable. */
  clientOrderId: string | null
}

export interface LedgerTradeRef {
  id: string
  symbol: string
  setupId: string
  plannedRisk?: number | null
}

export interface PerTradeLedger {
  tradeId: string
  setupId: string
  symbol: string
  entryFills: LedgerFill[]
  exitFills: LedgerFill[]
  entryQty: number
  exitQty: number
  entryVwap: number | null
  exitVwap: number | null
  /** Long-only paper convention: Σ(sell qty·price) − Σ(buy qty·price). */
  brokerPnl: number
  brokerR: number | null
  /** entryQty − exitQty; >0 means the broker ledger still shows open exposure. */
  residualQty: number
  flags: string[]
}

export interface BrokerLedger {
  day: string
  source: string
  /**
   * FALSE means the underlying FILL retrieval was incomplete (pagination failed /
   * truncated). When false the ledger is NOT authoritative broker truth — callers
   * must fail closed rather than trust `totals.brokerPnl`.
   */
  retrievalComplete: boolean
  perTrade: PerTradeLedger[]
  unmapped: LedgerFill[]
  totals: {
    brokerPnl: number
    mappedTrades: number
    mappedFills: number
    unmappedFills: number
  }
  /** SHA-256 over the content (excludes any volatile generation timestamp). */
  contentSha256: string
}

/** The trade that owns a fill by client_order_id, or null (external/unmapped). */
export function ownerOf(clientOrderId: string | null, trades: readonly LedgerTradeRef[]): LedgerTradeRef | null {
  if (!clientOrderId) return null
  // Longest id first so a trade id that is a prefix of another can't mis-claim.
  const byLen = [...trades].sort((a, b) => b.id.length - a.id.length)
  for (const t of byLen) {
    if (clientOrderId === t.id || clientOrderId.startsWith(`${t.id}:`)) return t
  }
  return null
}

function vwap(fills: readonly LedgerFill[]): number | null {
  const q = fills.reduce((s, f) => s + f.qty, 0)
  if (q <= 0) return null
  return fills.reduce((s, f) => s + f.price * f.qty, 0) / q
}

/**
 * Build the per-trade broker ledger from raw fills. Pure: same inputs → same
 * output (and same contentSha256). `source` is a provenance label only.
 */
export function buildBrokerLedger(
  day: string,
  fills: readonly LedgerFill[],
  trades: readonly LedgerTradeRef[],
  source = 'alpaca-paper-activities/FILL',
  retrievalComplete = true,
): BrokerLedger {
  const byTrade = new Map<string, LedgerFill[]>()
  const unmapped: LedgerFill[] = []

  for (const f of fills) {
    const owner = ownerOf(f.clientOrderId, trades)
    if (!owner) { unmapped.push(f); continue }
    const arr = byTrade.get(owner.id) ?? []
    arr.push(f)
    byTrade.set(owner.id, arr)
  }

  const perTrade: PerTradeLedger[] = []
  let totalPnl = 0
  let mappedFills = 0

  for (const t of trades) {
    const owned = (byTrade.get(t.id) ?? []).slice().sort((a, b) => a.filledAt - b.filledAt)
    if (owned.length === 0) continue // trade with no broker fills at all (e.g. aborted/unfilled)
    const entryFills = owned.filter(f => f.side === 'buy')
    const exitFills = owned.filter(f => f.side === 'sell')
    const entryQty = entryFills.reduce((s, f) => s + f.qty, 0)
    const exitQty = exitFills.reduce((s, f) => s + f.qty, 0)
    const buyCost = entryFills.reduce((s, f) => s + f.price * f.qty, 0)
    const sellProceeds = exitFills.reduce((s, f) => s + f.price * f.qty, 0)
    const brokerPnl = sellProceeds - buyCost
    const risk = t.plannedRisk ?? null
    const flags: string[] = []
    if (entryQty === 0) flags.push('no_entry_fill')
    if (exitQty > entryQty) flags.push('over_exit')
    if (entryQty - exitQty > 0) flags.push('residual_exposure')

    perTrade.push({
      tradeId: t.id,
      setupId: t.setupId,
      symbol: t.symbol,
      entryFills,
      exitFills,
      entryQty,
      exitQty,
      entryVwap: vwap(entryFills),
      exitVwap: vwap(exitFills),
      brokerPnl,
      brokerR: risk && risk > 0 ? brokerPnl / risk : null,
      residualQty: entryQty - exitQty,
      flags,
    })
    totalPnl += brokerPnl
    mappedFills += owned.length
  }

  const ledgerNoHash = {
    day,
    source,
    retrievalComplete,
    perTrade,
    unmapped,
    totals: {
      brokerPnl: totalPnl,
      mappedTrades: perTrade.length,
      mappedFills,
      unmappedFills: unmapped.length,
    },
  }
  return { ...ledgerNoHash, contentSha256: sha256(JSON.stringify(ledgerNoHash)) }
}
