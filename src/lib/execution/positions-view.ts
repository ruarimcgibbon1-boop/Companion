/**
 * Broker → UI position view.
 *
 * Pure join between Alpaca's authoritative broker positions and the Companion
 * execution ledger (PaperTrade). No fs, no network, no credentials — safe to
 * import from a server route AND to unit-test in isolation. The API route does
 * the I/O (query the broker, read the ledger from disk) and hands the two lists
 * here; everything about attribution, stops/targets and reconciliation lives in
 * one testable function.
 *
 * Broker truth is absolute: qty, avgEntry, currentPrice and unrealised P&L come
 * only from the broker payload. The ledger contributes INTENT metadata (setup,
 * stops, targets, reconciliation) and never overrides an exposure number.
 */
import type { BrokerPosition, PaperTrade } from './types'

/**
 * Attribution audit (2026-08-19). Alpaca's /v2/positions returns an AGGREGATE per
 * symbol — it carries no order identity (no client_order_id, no `pt:` prefix, no
 * order IDs), so the strong chain signalId → tradeId → pt: → brokerOrderId cannot
 * be read off a position object. Reconstructing it would need a separate /v2/orders
 * fetch and a fill→position rollup, out of scope here. And the daemon dedupes
 * entries by setupId, not symbol, so two setups on one symbol each open a trade
 * while the broker still shows ONE summed position that binds to neither.
 *
 * Therefore the strongest identity available at the position level is
 * "symbol + a UNIQUE active Companion trade". Anything less certain is not guessed
 * as COMPANION: ambiguous or stale-only matches are UNATTRIBUTED, and symbols the
 * ledger never traded are EXTERNAL.
 */
export type PositionSource = 'companion' | 'external' | 'unattributed'

export type ReconciliationStatus = PaperTrade['reconciliationStatus']

export type TargetState = 'none' | 't1_hit' | 't2_hit'

/**
 * One broker position, sanitized for the client. Contains no credentials and no
 * raw broker envelope — only the fields the blotter renders.
 */
export interface BrokerPositionView {
  symbol: string
  /** Derived from the sign of broker qty. */
  direction: 'long' | 'short'
  /** Absolute share count the broker reports we hold. Authoritative. */
  qty: number
  /** Shares free to trade right now (qty minus held-for-orders). Authoritative. */
  qtyAvailable: number
  avgEntryPrice: number
  currentPrice: number | null
  unrealizedPnl: number | null
  unrealizedPnlPct: number | null

  source: PositionSource
  /** Ledger linkage — null on EXTERNAL positions. */
  tradeId: string | null
  signalId: string | null
  setupType: string | null
  initialStop: number | null
  currentStop: number | null
  /**
   * True only when the ledger records a resting broker protective stop order for
   * this position. Lets the UI distinguish a broker-protected stop from a merely
   * *intended* strategy stop — Alpaca rejects stop orders outside 09:30–16:00, so
   * a premarket position has a `currentStop` with no broker order behind it.
   */
  hasProtectiveStop: boolean
  t1: number | null
  t2: number | null
  targetState: TargetState | null
  reconciliationStatus: ReconciliationStatus | null

  /** When the linked ledger record was last touched; falls back to `asOf`. */
  lastUpdatedAt: number
}

export interface PaperPositionsPayload {
  ok: true
  source: 'alpaca-paper'
  /** Server clock when the broker was queried. */
  asOf: number
  positions: BrokerPositionView[]
  counts: {
    open: number
    companion: number
    external: number
    unattributed: number
    /** Sum of unrealised P&L across positions where the broker reported it. */
    unrealizedPnl: number
  }
}

export interface PaperPositionsError {
  ok: false
  source: 'alpaca-paper'
  asOf: number
  /** Human-readable, credential-free reason the broker could not be reached. */
  error: string
}

export type PaperPositionsResponse = PaperPositionsPayload | PaperPositionsError

/** How far along the target ladder the ledger says this trade is. */
function targetState(trade: PaperTrade): TargetState {
  if (trade.exits.some(l => l.reason === 't2' && l.fillPrice != null)) return 't2_hit'
  if (trade.t1Done) return 't1_hit'
  return 'none'
}

export interface Attribution {
  /** The ledger trade whose metadata this position carries — null unless COMPANION. */
  trade: PaperTrade | null
  source: PositionSource
  /** Human-readable classification rationale, surfaced in the row tooltip. */
  reason: string
}

const ACTIVE_STATES: ReadonlySet<PaperTrade['state']> = new Set(['open', 'pending_entry'])

/**
 * Classify a broker position against the execution ledger. COMPANION is granted
 * ONLY when exactly one active (open/pending_entry) trade for the symbol exists —
 * an unambiguous binding. Everything less certain is refused rather than guessed:
 *
 *   • ≥2 active trades for the symbol   → UNATTRIBUTED (aggregate binds to none)
 *   • only closed/aborted (stale) trades → UNATTRIBUTED (no active trade to bind;
 *                                          attaching stale stops/targets would lie)
 *   • no ledger trade for the symbol     → EXTERNAL (Companion never traded it)
 *
 * UNATTRIBUTED never carries strategy metadata — the caller must not treat it as
 * Companion evidence.
 */
export function attributePosition(symbol: string, trades: PaperTrade[]): Attribution {
  const sym = symbol.toUpperCase()
  const forSymbol = trades.filter(t => t.symbol.toUpperCase() === sym)
  if (forSymbol.length === 0) {
    return { trade: null, source: 'external', reason: 'no Companion trade for symbol' }
  }

  const active = forSymbol.filter(t => ACTIVE_STATES.has(t.state))
  if (active.length === 1) {
    return { trade: active[0], source: 'companion', reason: 'unique active Companion trade' }
  }
  if (active.length > 1) {
    return {
      trade: null,
      source: 'unattributed',
      reason: `${active.length} active Companion trades for ${sym} — aggregate position binds to none`,
    }
  }
  return {
    trade: null,
    source: 'unattributed',
    reason: 'only closed/stale Companion trades for symbol — no active trade to bind',
  }
}

function pctFromPrices(avg: number, current: number | null, dir: 1 | -1): number | null {
  if (current == null || !(avg > 0)) return null
  return ((current - avg) / avg) * 100 * dir
}

/** Build one sanitized view row from a broker position and its attribution. */
export function toPositionView(
  pos: BrokerPosition,
  attribution: Attribution,
  asOf: number,
): BrokerPositionView {
  const direction: 'long' | 'short' = pos.qty < 0 ? 'short' : 'long'
  const dir = direction === 'long' ? 1 : -1
  const qtyAbs = Math.abs(pos.qty)
  // Metadata is attached ONLY for a confirmed COMPANION binding. An UNATTRIBUTED
  // row must never carry stops/targets/reconciliation — that would be the guess
  // this hardening exists to prevent.
  const trade = attribution.source === 'companion' ? attribution.trade : null

  return {
    symbol: pos.symbol.toUpperCase(),
    direction,
    qty: qtyAbs,
    qtyAvailable: Math.abs(pos.qtyAvailable),
    avgEntryPrice: pos.avgEntryPrice,
    currentPrice: pos.currentPrice,
    unrealizedPnl: pos.unrealizedPl,
    unrealizedPnlPct: pctFromPrices(pos.avgEntryPrice, pos.currentPrice, dir),

    source: attribution.source,
    tradeId: trade?.id ?? null,
    signalId: trade?.signalId ?? null,
    setupType: trade?.setupType ?? null,
    initialStop: trade?.initialStop ?? null,
    currentStop: trade?.currentStop ?? null,
    hasProtectiveStop: trade?.protectiveStopOrderId != null,
    t1: trade?.targets?.[0] ?? null,
    t2: trade?.targets?.[1] ?? null,
    targetState: trade ? targetState(trade) : null,
    reconciliationStatus: trade?.reconciliationStatus ?? null,
    lastUpdatedAt: trade?.updatedAt ?? asOf,
  }
}

/**
 * Join broker positions with the execution ledger into the client payload.
 * Broker positions are the spine: every row corresponds to a real broker
 * position, so a phantom local record can never invent one and a closed-on-broker
 * position can never linger. A symbol the broker no longer reports is simply
 * absent from the result.
 */
export function buildPositionView(
  brokerPositions: BrokerPosition[],
  trades: PaperTrade[],
  asOf: number = Date.now(),
): PaperPositionsPayload {
  const positions = brokerPositions.map(p => toPositionView(p, attributePosition(p.symbol, trades), asOf))

  return {
    ok: true,
    source: 'alpaca-paper',
    asOf,
    positions,
    counts: {
      open: positions.length,
      companion: positions.filter(p => p.source === 'companion').length,
      external: positions.filter(p => p.source === 'external').length,
      unattributed: positions.filter(p => p.source === 'unattributed').length,
      unrealizedPnl: positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0),
    },
  }
}
