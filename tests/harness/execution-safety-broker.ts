/**
 * DeterministicBroker — an offline, fully-scripted broker double for the P0
 * execution-safety reproduction harness (Phase P0-R).
 *
 * NOT production code. Lives under tests/. Never makes a network call.
 *
 * The whole point of this double is to keep BROKER TRUTH and the executor's LOCAL
 * TRUTH separable and independently observable. The broker's authoritative position
 * is `truthQty(symbol)`; the executor's belief lives on the PaperTrade. Every P0 here
 * is a divergence between those two, so the double never silently mirrors executor
 * intent — it only moves broker truth when a fill is scripted to happen.
 *
 * Modelling notes that make the reproductions faithful to Alpaca:
 *  - A DELETE (cancelOrder) does NOT guarantee the order is dead. Alpaca moves it to
 *    `pending_cancel`, and it CAN still fill during that window. `raceFillOnCancel`
 *    models exactly that: the cancel request lands, but the broker completes the buy.
 *  - `getOrder` returns the broker's CURRENT view. `holdWorking` keeps an order
 *    `open`/unfilled (the broker has not filled it yet), so a caller that reads it once
 *    sees filledQty 0 even if a later action (a racing cancel) fills it.
 *  - `pending_cancel` is what the Alpaca adapter (mapStatus) collapses to `canceled`.
 *    `reportStatus` lets a test hand the executor a BrokerOrder whose status is already
 *    the adapter's output, so we exercise the real executor branch on that mapped value.
 */
import type {
  Broker, BrokerAccount, BrokerOrder, BrokerOrderStatus, BrokerPosition,
  AssetInfo, LimitOrderRequest, StopOrderRequest, BrokerFill,
} from '@/lib/execution/types'
import type { BuySignalRecord } from '@/types'
import { BrokerDataError } from '@/lib/execution/alpaca'

export interface RaceFill {
  qty?: number
  price?: number
  /** Status the order reports AFTER the racing fill (default: filled/partially_filled by qty). */
  status?: BrokerOrderStatus
}

export class DeterministicBroker implements Broker {
  readonly name = 'deterministic-paper'
  equity = 100_000
  tradable = true

  // ── Observability: broker truth + a full record of what was asked of the broker ──
  /** symbol → shares the BROKER actually holds. This is broker truth, moved ONLY by fills. */
  private readonly positions = new Map<string, number>()
  readonly orders = new Map<string, BrokerOrder>()
  readonly submittedBuys: LimitOrderRequest[] = []
  readonly submittedSells: Array<LimitOrderRequest | StopOrderRequest> = []
  readonly canceled: string[] = []
  readonly fills: BrokerFill[] = []

  // ── Adversarial scripting knobs ─────────────────────────────────────────────
  /** Order ids getOrder must leave working (open, filledQty 0) — the broker hasn't filled them. */
  readonly holdWorking = new Set<string>()
  /** Order id → fill applied to BROKER TRUTH when cancelOrder(id) is called (the cancel/fill race). */
  readonly raceFillOnCancel = new Map<string, RaceFill>()
  /** Order id → status getOrder should report verbatim (e.g. the adapter's mapping of pending_cancel). */
  readonly reportStatus = new Map<string, BrokerOrderStatus>()
  /** Order id → filledQty getOrder should report verbatim. */
  readonly reportFilledQty = new Map<string, number>()
  /**
   * Order id → a queue of evolving broker views, one consumed per getOrder call (after the
   * verbatim overrides above). Models a broker whose truth changes across reads — e.g. a
   * pending_cancel (status 'open') that later settles to 'canceled' or 'filled'. A step with
   * filledQty greater than the last reported books the increment into broker truth.
   */
  readonly stepQueue = new Map<string, Array<{ status: BrokerOrderStatus; filledQty: number; price?: number }>>()
  /** Order ids for which getOrder throws (models a broker read failure). */
  readonly failGetOrder = new Set<string>()
  /** Order ids for which cancelOrder throws (models a failed cancel request). */
  readonly failCancel = new Set<string>()
  /**
   * Symbols for which getPosition / getPositions throws a BrokerDataError — models the real
   * AlpacaBroker adapter rejecting malformed/missing broker numerics, or an unreadable
   * position snapshot, mid-lifecycle. Callers must fail closed (never treat it as flat).
   */
  readonly failGetPosition = new Set<string>()
  /**
   * One-shot: the NEXT sell order to be read via getOrder fills only this many shares
   * (cumulative) and STAYS working (partially_filled), reserving the unfilled remainder.
   * Models a partial exit whose remainder is still held_for_orders at the broker. Consumed
   * when first applied; re-reads keep the order at the same partial (it does not complete).
   */
  partialSellOnce: number | null = null
  /**
   * Steps assigned to the NEXT submitted SELL order's stepQueue at submit time — models a
   * flatten/exit that settles ACROSS reads (working/unfilled on the first read, then filled
   * on a later one, exactly like the real FPS flatten that filled ~0.5s after submit). The
   * flatten order's id is only known at submit time, so this one-shot seeds it then; the
   * existing stepQueue consumption in getOrder drives the rest. Consumed by the next sell.
   */
  sellStepsOnce: Array<{ status: BrokerOrderStatus; filledQty: number; price?: number }> | null = null

  private seq = 0

  // ── Broker-truth accessors (tests assert on these) ──────────────────────────
  truthQty(symbol: string): number {
    return this.positions.get(symbol) ?? 0
  }
  private moveTruth(symbol: string, delta: number): void {
    this.positions.set(symbol, this.truthQty(symbol) + delta)
  }

  async getAccount(): Promise<BrokerAccount> {
    return { equity: this.equity, cash: this.equity, buyingPower: this.equity * 2, daytradeCount: 0, blocked: false }
  }

  async getAsset(symbol: string): Promise<AssetInfo | null> {
    return this.tradable
      ? { symbol, tradable: true, fractionable: false, shortable: true, exchange: 'NASDAQ' }
      : null
  }

  async getPositions(): Promise<BrokerPosition[]> {
    if (this.failGetPosition.size) throw new BrokerDataError('position snapshot unavailable/malformed')
    return [...this.positions.entries()]
      .filter(([, q]) => q !== 0)
      .map(([symbol, qty]) => ({ symbol, qty, qtyAvailable: qty, avgEntryPrice: 0, currentPrice: null, unrealizedPl: 0 }))
  }

  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    if (this.failGetPosition.has(symbol)) throw new BrokerDataError(`position for ${symbol} unavailable/malformed`)
    const qty = this.truthQty(symbol)
    if (qty <= 0) return null
    return { symbol, qty, qtyAvailable: qty, avgEntryPrice: 0, currentPrice: null, unrealizedPl: 0 }
  }

  async submitLimit(req: LimitOrderRequest): Promise<BrokerOrder> {
    if (req.side === 'buy') this.submittedBuys.push(req)
    else this.submittedSells.push(req)
    const id = `o${++this.seq}`
    const order: BrokerOrder = {
      id, clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side,
      status: 'open', qty: req.qty, filledQty: 0, filledAvgPrice: null,
      limitPrice: req.limitPrice, submittedAt: Date.now(), rejectReason: null,
    }
    this.orders.set(id, order)
    // One-shot: script the NEXT sell's evolving broker view (a flatten that settles late).
    if (req.side === 'sell' && this.sellStepsOnce) {
      this.stepQueue.set(id, this.sellStepsOnce)
      this.sellStepsOnce = null
    }
    return order
  }

  async submitStop(req: StopOrderRequest): Promise<BrokerOrder> {
    this.submittedSells.push(req)
    const id = `o${++this.seq}`
    const order: BrokerOrder = {
      id, clientOrderId: req.clientOrderId, symbol: req.symbol, side: 'sell',
      status: 'open', qty: req.qty, filledQty: 0, filledAvgPrice: null,
      limitPrice: null, submittedAt: Date.now(), rejectReason: null,
    }
    this.orders.set(id, order)
    this.holdWorking.add(id)   // a resting stop only fills if a test scripts it
    return order
  }

  async getOrder(id: string): Promise<BrokerOrder | null> {
    if (this.failGetOrder.has(id)) throw new Error(`getOrder failed for ${id}`)
    const o = this.orders.get(id)
    if (!o) return null

    // CRITICAL FIDELITY: the real Alpaca adapter (toOrder) constructs a FRESH object on
    // every read, and cancelOrder issues a DELETE that never mutates a previously-returned
    // object. So a caller that read the order BEFORE a racing cancel holds a STALE snapshot.
    // Returning a copy here (never the internal reference) reproduces exactly that — it is
    // the crux of the P0-002 timeout-path defect.

    // Verbatim overrides: hand the executor exactly the (adapter-produced) view a test wants.
    if (this.reportStatus.has(id) || this.reportFilledQty.has(id)) {
      return {
        ...o,
        status: this.reportStatus.get(id) ?? o.status,
        filledQty: this.reportFilledQty.get(id) ?? o.filledQty,
      }
    }

    // Evolving broker truth: consume one scripted step per read. A step whose filledQty
    // exceeds what was last reported moves broker truth by the increment (a real fill).
    const steps = this.stepQueue.get(id)
    if (steps && steps.length) {
      const step = steps.shift()!
      const inc = step.filledQty - o.filledQty
      o.status = step.status
      o.filledQty = step.filledQty
      if (inc > 0) {
        o.filledAvgPrice = step.price ?? o.limitPrice
        this.moveTruth(o.symbol, o.side === 'buy' ? inc : -inc)
        this.fills.push({ symbol: o.symbol, side: o.side, qty: inc, price: o.filledAvgPrice ?? 0, filledAt: Date.now(), orderId: o.id })
      }
      return { ...o }
    }

    // A working order the broker has not filled stays exactly as it is (filledQty 0, open).
    // Checked BEFORE partialSellOnce so a resting protective stop (added to holdWorking by
    // submitStop) is never consumed by the one-shot partial — only a genuine working exit is.
    if (this.holdWorking.has(id)) return { ...o }

    // One-shot partial SELL that stays working (partially_filled), reserving the remainder.
    if (o.side === 'sell' && this.partialSellOnce != null && this.partialSellOnce < o.qty && o.filledQty < this.partialSellOnce) {
      const target = this.partialSellOnce
      const inc = target - o.filledQty
      o.filledQty = target
      o.filledAvgPrice = o.limitPrice
      o.status = 'partially_filled'
      this.moveTruth(o.symbol, -inc)
      this.fills.push({ symbol: o.symbol, side: 'sell', qty: inc, price: o.filledAvgPrice ?? 0, filledAt: Date.now(), orderId: o.id })
      return { ...o }   // stays working at `target`; re-reads keep it partial (does not complete)
    }

    // Default: an open order fills in full and moves broker truth (persisted on the stored order).
    if (o.status === 'open') {
      o.status = 'filled'
      o.filledQty = o.qty
      o.filledAvgPrice = o.limitPrice
      this.moveTruth(o.symbol, o.side === 'buy' ? o.qty : -o.qty)
      this.fills.push({ symbol: o.symbol, side: o.side, qty: o.qty, price: o.filledAvgPrice ?? 0, filledAt: Date.now(), orderId: o.id })
    }
    return { ...o }
  }

  async getRecentFills(symbol: string, sinceMs: number): Promise<BrokerFill[]> {
    return this.fills.filter(f => f.symbol === symbol && f.filledAt >= sinceMs)
  }

  async cancelOrder(id: string): Promise<void> {
    if (this.failCancel.has(id)) throw new Error(`cancelOrder failed for ${id}`)
    this.canceled.push(id)
    const o = this.orders.get(id)
    if (!o) return
    // THE RACE: the cancel request lands, but the broker completes the buy anyway
    // (Alpaca `pending_cancel` → `filled`). Broker truth moves; the order object now
    // reflects the fill — but a caller holding a PRE-cancel snapshot never sees it.
    const rf = this.raceFillOnCancel.get(id)
    if (rf && o.side === 'buy') {
      this.raceFillOnCancel.delete(id)   // one-shot
      const fq = rf.qty ?? o.qty
      o.filledQty = fq
      o.filledAvgPrice = rf.price ?? o.limitPrice
      o.status = rf.status ?? (fq >= o.qty ? 'filled' : 'partially_filled')
      this.moveTruth(o.symbol, fq)
      this.fills.push({ symbol: o.symbol, side: 'buy', qty: fq, price: o.filledAvgPrice ?? 0, filledAt: Date.now(), orderId: o.id })
      return
    }
    // A working order goes terminal on cancel; a partially_filled order becomes `canceled`
    // while KEEPING its already-filled quantity (Alpaca semantics).
    if (o.status === 'open' || o.status === 'partially_filled') o.status = 'canceled'
  }

  async cancelOpenOrders(symbol: string): Promise<number> {
    let n = 0
    for (const o of this.orders.values()) {
      // Alpaca's `GET /v2/orders?status=open` returns ALL non-terminal working orders,
      // including partially_filled — so a partially-filled entry/exit remainder is cancelled
      // too. Model that faithfully (was only 'open').
      if (o.symbol === symbol && (o.status === 'open' || o.status === 'partially_filled')) {
        await this.cancelOrder(o.id); n++
      }
    }
    return n
  }

  /** Directly seat a broker-truth position (e.g. a partial that filled before we observed). */
  seedPosition(symbol: string, qty: number): void {
    this.positions.set(symbol, qty)
  }

  /** Count of working (open) orders left at the broker — a non-zero count after
   *  shutdown means the process could exit with an order still live. */
  workingOrderCount(symbol?: string): number {
    let n = 0
    for (const o of this.orders.values()) {
      if (o.status === 'open' && (symbol == null || o.symbol === symbol)) n++
    }
    return n
  }
}

/** A minimal, valid BUY signal. Overridable per test. */
export function makeSignal(overrides: Partial<BuySignalRecord> = {}): BuySignalRecord {
  const REGULAR_HOURS = new Date('2026-08-07T14:00:00Z').getTime()   // 10:00 ET, regular session
  return {
    id: 'sig-1', setupId: 'setup-1', symbol: 'TEST', timestamp: REGULAR_HOURS,
    setupType: 'premarket_breakout', triggerPrice: 10, entryLow: 9.9, entryHigh: 10,
    invalidation: 9.5, stop: 9.5, targets: [11, 12], score: 70, grade: 'strong',
    rewardRisk: 2, priceAtSignal: 10, ...overrides,
  } as BuySignalRecord
}

/** 10:00 ET Friday 2026-08-07 — regular hours, matching the existing execution suite. */
export const REGULAR_HOURS = new Date('2026-08-07T14:00:00Z').getTime()
