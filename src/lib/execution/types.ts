/**
 * Execution-layer domain types.
 *
 * The `Broker` interface is deliberately narrow: everything the paper loop needs
 * and nothing more. Alpaca is the first implementation; keeping the surface small
 * means a second venue (or a pure simulator for offline replay) is a new file
 * rather than a rewrite of the executor.
 *
 * Two decisions shape everything downstream:
 *
 * 1. Exit model MATCHES `scaledPnl` in eod-resolver.ts — sell half at T1, move the
 *    stop to breakeven, sell the rest at T2, mark whatever's left at the close.
 *    Any other ladder would make live P&L incomparable to the backtest, and
 *    comparing them is the entire reason for paper trading.
 *
 * 2. Exit DECISIONS are made off the same FMP feed that generated the signal, not
 *    off broker data. Mixing feeds would mean the live loop and the backtest
 *    disagree about what the tape did, reintroducing the ambiguity we're here to
 *    remove. The broker's only job is filling orders.
 */
import type { BuySignalRecord, SetupType } from '@/types'

// ── Broker surface ───────────────────────────────────────────────────────────

export interface BrokerAccount {
  /** Total account value. Position sizing is a fraction of this. */
  equity: number
  cash: number
  buyingPower: number
  /** Day trades in the trailing 5 sessions — irrelevant on a $100k paper account, fatal under $25k live. */
  daytradeCount: number
  /** Broker-side halt. Any of these true means we place nothing. */
  blocked: boolean
}

export interface AssetInfo {
  symbol: string
  tradable: boolean
  fractionable: boolean
  shortable: boolean
  exchange: string
}

export type BrokerOrderStatus =
  | 'pending' | 'open' | 'partially_filled' | 'filled'
  | 'canceled' | 'rejected' | 'expired' | 'unknown'

export interface BrokerOrder {
  id: string
  clientOrderId: string | null
  symbol: string
  side: 'buy' | 'sell'
  status: BrokerOrderStatus
  qty: number
  filledQty: number
  /** Average fill price — null until something fills. This is the number that matters. */
  filledAvgPrice: number | null
  limitPrice: number | null
  submittedAt: number
  /** Broker's own words when it rejects — surfaced verbatim, never swallowed. */
  rejectReason: string | null
}

export interface BrokerPosition {
  symbol: string
  qty: number
  /**
   * Shares free to be sold right now — `qty` minus anything held for a resting
   * order. Sell orders are sized against THIS, not `qty`, or the broker rejects
   * the whole order for insufficient quantity.
   */
  qtyAvailable: number
  avgEntryPrice: number
  currentPrice: number | null
  unrealizedPl: number
}

export interface LimitOrderRequest {
  symbol: string
  qty: number
  side: 'buy' | 'sell'
  /** Marketable limit — the worst price we'll accept. Never a market order; see sizing.ts. */
  limitPrice: number
  /** Premarket/after-hours orders must be limit + DAY at Alpaca, and carry no attached exits. */
  extendedHours: boolean
  /** Ties the broker order back to the signal that caused it. */
  clientOrderId: string
}

/**
 * A resting protective stop for shares already held — the safety net that keeps a
 * position covered if this process dies. Regular hours only: Alpaca accepts no
 * stop orders outside 09:30–16:00, so a premarket position is protected by the
 * polled loop alone.
 */
export interface StopOrderRequest {
  symbol: string
  qty: number
  stopPrice: number
  clientOrderId: string
}

export interface Broker {
  readonly name: string
  getAccount(): Promise<BrokerAccount>
  getAsset(symbol: string): Promise<AssetInfo | null>
  getPositions(): Promise<BrokerPosition[]>
  submitLimit(req: LimitOrderRequest): Promise<BrokerOrder>
  submitStop(req: StopOrderRequest): Promise<BrokerOrder>
  getOrder(id: string): Promise<BrokerOrder | null>
  cancelOrder(id: string): Promise<void>
  /** Cancel every resting order for a symbol — called before we sell, so a resting stop can't fight the exit. */
  cancelOpenOrders(symbol: string): Promise<number>
}

// ── Paper trade record ───────────────────────────────────────────────────────

export type TradeState =
  | 'pending_entry'   // entry limit submitted, nothing filled yet
  | 'open'            // shares held (possibly after a partial scale-out)
  | 'closed'
  | 'aborted'         // entry never filled (canceled / rejected / timed out unfilled)

export type ExitReason =
  | 't1'              // first target — sells half
  | 't2'              // second target — sells the remainder
  | 'stop'            // initial stop, or breakeven stop after T1
  | 'time'            // end-of-day flatten (the resolver's mark-to-close)
  | 'risk_halt'       // governor pulled the plug mid-trade

export interface ExitLeg {
  qty: number
  reason: ExitReason
  /** The level whose break triggered this leg — what the backtest would book. */
  intendedPrice: number
  orderId: string | null
  fillPrice: number | null
  filledAt: number | null
  /** Signed: negative means we sold below the level we aimed at. */
  slippagePct: number | null
}

export interface PaperTrade {
  id: string
  /** The BuySignalRecord.id that caused this trade — joins execution back to signal research. */
  signalId: string
  setupId: string
  symbol: string
  setupType: SetupType
  state: TradeState

  // ── Intent (what the signal asked for) ────────────────────────────────────
  /** The fill price the signal assumed (BuySignalRecord.entryHigh). Backtest P&L uses this. */
  intendedEntry: number
  limitPrice: number
  /** The signal's initial stop — never mutated, so the original plan stays legible. */
  initialStop: number
  /** Live stop: initial stop, then entry (breakeven) once T1 books. */
  currentStop: number
  targets: number[]
  /** Shares the sizer asked for. */
  qty: number
  /** Dollars at risk if the stop fills exactly: qty × (intendedEntry − initialStop). */
  plannedRisk: number

  // ── Reality (what the broker did) ─────────────────────────────────────────
  entryOrderId: string | null
  entrySubmittedAt: number | null
  entryFilledAt: number | null
  entryFillPrice: number | null
  entryFillQty: number
  /**
   * Signed entry slippage in %: (fill − intended) / intended × 100. Positive means
   * we paid up. THE number this whole exercise exists to measure — backtest
   * expectancy is +0.4–0.8%/trade, so a systematic +0.5% here is the edge, gone.
   */
  entrySlippagePct: number | null

  /** Shares still held. Reaches 0 → state 'closed'. */
  openQty: number
  /** True once T1 has booked — gates the breakeven stop and the T2 leg. */
  t1Done: boolean
  exits: ExitLeg[]
  /** Resting broker stop protecting `openQty`, if one is placed. */
  protectiveStopOrderId: string | null

  /** Realized $ P&L across filled exit legs, fills only — nothing modelled. */
  realizedPnl: number | null
  /** Realized return on the filled entry notional, comparable to BuySignalRecord.pnlPct. */
  realizedPnlPct: number | null
  /** False when shares were still held at the flatten (marked out, not a clean exit). */
  fullyClosed: boolean

  createdAt: number
  updatedAt: number
  /** Anything worth reading at review time: rejects, retries, gate notes. */
  notes: string[]
}

export function newPaperTrade(
  signal: BuySignalRecord,
  qty: number,
  limitPrice: number,
  now: number,
): PaperTrade {
  const intendedEntry = signal.entryHigh
  return {
    id: `pt:${signal.id}`,
    signalId: signal.id,
    setupId: signal.setupId,
    symbol: signal.symbol,
    setupType: signal.setupType,
    state: 'pending_entry',
    intendedEntry,
    limitPrice,
    initialStop: signal.stop,
    currentStop: signal.stop,
    targets: signal.targets,
    qty,
    plannedRisk: qty * Math.max(intendedEntry - signal.stop, 0),
    entryOrderId: null,
    entrySubmittedAt: null,
    entryFilledAt: null,
    entryFillPrice: null,
    entryFillQty: 0,
    entrySlippagePct: null,
    openQty: 0,
    t1Done: false,
    exits: [],
    protectiveStopOrderId: null,
    realizedPnl: null,
    realizedPnlPct: null,
    fullyClosed: false,
    createdAt: now,
    updatedAt: now,
    notes: [],
  }
}

/** Realized P&L across filled exit legs, against the actual entry fill. */
export function computeRealized(trade: PaperTrade): { pnl: number; pnlPct: number } | null {
  const entry = trade.entryFillPrice
  if (entry == null || trade.entryFillQty === 0) return null
  let pnl = 0
  let soldQty = 0
  for (const leg of trade.exits) {
    if (leg.fillPrice == null) continue
    pnl += (leg.fillPrice - entry) * leg.qty
    soldQty += leg.qty
  }
  if (soldQty === 0) return null
  // Percent is on the notional actually put to work, so it lines up with the
  // resolver's per-share return convention rather than being diluted by unsold shares.
  return { pnl, pnlPct: (pnl / (entry * soldQty)) * 100 }
}
