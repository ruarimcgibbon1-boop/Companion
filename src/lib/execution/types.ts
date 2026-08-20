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
import type { SessionType } from '@/lib/market-hours'

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

/** One broker-side execution — a single fill, the atomic unit of the account's truth. */
export interface BrokerFill {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  filledAt: number
  /** The order this fill belongs to, so fills from our own legs can be told apart from external ones. */
  orderId: string | null
}

export interface Broker {
  readonly name: string
  getAccount(): Promise<BrokerAccount>
  getAsset(symbol: string): Promise<AssetInfo | null>
  getPositions(): Promise<BrokerPosition[]>
  /** The broker's position for one symbol — the authority on what we actually hold. Null = flat. */
  getPosition(symbol: string): Promise<BrokerPosition | null>
  submitLimit(req: LimitOrderRequest): Promise<BrokerOrder>
  submitStop(req: StopOrderRequest): Promise<BrokerOrder>
  getOrder(id: string): Promise<BrokerOrder | null>
  cancelOrder(id: string): Promise<void>
  /** Cancel every resting order for a symbol — called before we sell, so a resting stop can't fight the exit. */
  cancelOpenOrders(symbol: string): Promise<number>
  /**
   * Fills for one symbol at/after `sinceMs`, oldest first. Optional: a broker that
   * can't report its own fills simply omits it, and reconciliation falls back to
   * leaving an externally-closed trade's P&L unreconstructed (manual_review, null).
   * When present it lets the executor price an external close from broker truth.
   */
  getRecentFills?(symbol: string, sinceMs: number): Promise<BrokerFill[]>
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
  | 'external'        // closed by an order the daemon never placed (dashboard flatten,
                      //   broker liquidation) — priced from the broker's own fills so
                      //   P&L reconciles, but kept out of learning (manual_review)

export interface ExitLeg {
  qty: number
  reason: ExitReason
  /** The level whose break triggered this leg — what the backtest would book. */
  intendedPrice: number
  /**
   * The price we actually observed when we decided to exit. Splits total slippage
   * into the two things that cause it, which need different fixes:
   *   market gap  = decisionPrice vs intendedPrice — how far price ran before we
   *                 SAW it. Fixed by polling faster.
   *   concession  = fillPrice vs decisionPrice — what we gave up to guarantee a
   *                 fill. Fixed, if at all, by the limit tolerance.
   * On 2026-08-10 AUUD's −2.84% was −2.35% gap and −0.50% concession: 82% latency.
   * Without this field that split had to be reverse-engineered by hand.
   */
  decisionPrice: number | null
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
  /**
   * Session the ENTRY filled in. Stored rather than derived so the premarket risk
   * budget survives a restart, and so a day's stats can be split by session.
   */
  entrySession: SessionType | null
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

  // ── Broker-authoritative reconciliation (ledger v1, 2026-08-18) ─────────────
  // The daemon used to treat its own local state as truth. On 2026-08-17 that
  // desynced from Alpaca: CAPR's stop filled in two partials but only the first
  // was recorded (local believed 2007 still open, broker was flat); FIGR was
  // flattened by an EXTERNAL order the daemon never saw, so it kept a stale 553
  // open and re-submitted a protective stop that expired. Alpaca is the authority
  // for what actually executed; local state only expresses INTENT.
  /**
   * Where local state stands relative to the broker:
   *   pending        — not yet reconciled against the broker
   *   verified       — broker position matches local; safe for research/learning
   *   discrepancy    — broker and local disagreed; local was corrected to broker
   *   manual_review  — closed on broker truth but P&L can't be reconstructed
   * Only `verified` trades may auto-enter the research/learning dataset.
   */
  reconciliationStatus: 'pending' | 'verified' | 'discrepancy' | 'manual_review'
  /** Broker's position qty at the last reconcile — the fact local must not override. */
  brokerVerifiedQty: number | null
  lastReconciledAt: number | null
  /** Execution anomalies worth surfacing: stale-state closes, qty mismatches, rejects. */
  executionWarnings: string[]
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
    entrySession: null,
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
    reconciliationStatus: 'pending',
    brokerVerifiedQty: null,
    lastReconciledAt: null,
    executionWarnings: [],
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
