/**
 * Paper-trade executor: turns a logged BUY signal into a real order lifecycle,
 * then manages the position to a close.
 *
 * The exit ladder deliberately mirrors `scaledPnl` in eod-resolver.ts — half at
 * T1, stop to breakeven, remainder at T2, mark-to-close whatever survives — so
 * live results and backtest results are the same measurement taken two ways.
 * Adverse-first within a tick, for the same reason the resolver is adverse-first
 * within a bar: never credit an optimistic outcome we can't prove.
 *
 * Exit *decisions* come from the FMP price feed (the one the signals use). The
 * broker only fills orders. A resting broker stop is placed during regular hours
 * as a safety net for a process crash; premarket positions have no such net,
 * because Alpaca rejects stop orders outside 09:30–16:00.
 *
 * Node-only (the store writes files). Never import from a client component.
 */
import type { BuySignalRecord } from '@/types'
import { getSessionType, etMinutesOfDay } from '@/lib/market-hours'

import type { Broker, PaperTrade, ExitReason, ExitLeg } from './types'
import { newPaperTrade, computeRealized } from './types'
import { sizePosition, entryLimitPrice, exitLimitPrice, DEFAULT_SIZING, type SizingConfig } from './sizing'
import { canOpenPosition, DEFAULT_RISK, type RiskConfig } from './risk'
import { loadTrades, saveTrades, appendEvent, isHalted } from './store'

export interface ExecutorConfig {
  sizing: SizingConfig
  risk: RiskConfig
  /** How far above the signal's entry we'll chase, in %. */
  entrySlipTolerancePct: number
  /** How far below an exit level we'll accept on the way out, in %. */
  exitSlipTolerancePct: number
  /** Cancel an unfilled entry after this long — the move left without us. */
  entryTimeoutMs: number
  /** ET minute-of-day to flatten everything. 15:55, ahead of the close auction. */
  flattenEtMinute: number
  /** Log intent, place nothing. */
  dryRun: boolean
}

export const DEFAULT_EXECUTOR: ExecutorConfig = {
  sizing: DEFAULT_SIZING,
  risk: DEFAULT_RISK,
  entrySlipTolerancePct: 0.5,
  exitSlipTolerancePct: 0.5,
  entryTimeoutMs: 90_000,
  flattenEtMinute: 15 * 60 + 55,
  dryRun: false,
}

/** Fetches last prices for the symbols we hold. Injected so the executor stays feed-agnostic and testable. */
export type PriceFetcher = (symbols: string[]) => Promise<Map<string, number>>

export interface ExitDecision {
  reason: ExitReason
  qty: number
  /** The level that triggered the exit — what the backtest would book. */
  intendedPrice: number
}

/**
 * Which exit, if any, does this price trigger? Pure — this is the piece worth
 * unit-testing, and it must stay in lockstep with eod-resolver's ladder.
 *
 * Adverse first: a tick that clears both the stop and a target is scored as the
 * stop, because we cannot know which the tape touched first.
 */
export function decideExit(
  trade: PaperTrade,
  price: number,
  etMinute: number,
  flattenEtMinute: number,
): ExitDecision | null {
  if (trade.state !== 'open' || trade.openQty <= 0) return null

  if (price <= trade.currentStop) {
    return { reason: 'stop', qty: trade.openQty, intendedPrice: trade.currentStop }
  }

  const t1 = trade.targets[0] ?? null
  const t2 = trade.targets[1] ?? null

  if (!trade.t1Done && t1 != null && price >= t1) {
    // Half the FILLED size, floored — with a 1-share position there is no half,
    // so it exits whole at T1 rather than silently skipping the leg.
    const half = Math.max(1, Math.floor(trade.entryFillQty / 2))
    return { reason: 't1', qty: Math.min(half, trade.openQty), intendedPrice: t1 }
  }

  if (trade.t1Done && t2 != null && price >= t2) {
    return { reason: 't2', qty: trade.openQty, intendedPrice: t2 }
  }

  if (etMinute >= flattenEtMinute) {
    return { reason: 'time', qty: trade.openQty, intendedPrice: price }
  }

  return null
}

/**
 * Shares reserved by exit legs that are submitted but not yet filled.
 *
 * The broker counts these in `held_for_orders` and subtracts them from the qty
 * available to any *other* sell order — so they cannot also back a protective
 * stop. They are not unprotected: a resting limit is already working them.
 */
export function workingExitQty(trade: PaperTrade): number {
  return trade.exits.reduce((n, l) => (l.orderId && l.fillPrice == null ? n + l.qty : n), 0)
}

/** Signed slippage in %, positive = worse for a buy, negative = worse for a sell. */
export function slippagePct(intended: number, fill: number): number | null {
  if (!(intended > 0)) return null
  return ((fill - intended) / intended) * 100
}

export class PaperExecutor {
  private trades: PaperTrade[] = []
  private startingEquity = 0
  private equity = 0
  private brokerBlocked = false
  /** Set when the governor returns a terminal verdict — no more entries today. */
  private haltedForDay: string | null = null

  constructor(
    private readonly broker: Broker,
    private readonly getPrices: PriceFetcher,
    private readonly config: ExecutorConfig = DEFAULT_EXECUTOR,
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {}

  async init(): Promise<void> {
    this.trades = loadTrades()
    const account = await this.broker.getAccount()
    this.equity = account.equity
    this.brokerBlocked = account.blocked
    // Restart-safe: the day's starting equity is whatever the first surviving
    // trade recorded, else today's opening read. Without this a mid-day restart
    // would reset the daily loss limit and hand the loop a fresh budget.
    this.startingEquity = this.trades.length > 0 && this.trades[0].notes.length > 0
      ? this.startingEquityFromNotes() ?? account.equity
      : account.equity
    this.log(
      `executor ready · ${this.broker.name} · equity ${account.equity.toFixed(2)} · ` +
      `${this.openTrades().length} open / ${this.trades.length} today` +
      (this.config.dryRun ? ' · DRY_RUN' : ''),
    )
    appendEvent({ event: 'init', broker: this.broker.name, equity: account.equity, restored: this.trades.length })
  }

  private startingEquityFromNotes(): number | null {
    for (const t of this.trades) {
      for (const n of t.notes) {
        const m = n.match(/^startingEquity=([\d.]+)$/)
        if (m) return Number(m[1])
      }
    }
    return null
  }

  openTrades(): PaperTrade[] {
    return this.trades.filter(t => t.state === 'pending_entry' || t.state === 'open')
  }

  closedToday(): PaperTrade[] {
    return this.trades.filter(t => t.state === 'closed')
  }

  allTrades(): PaperTrade[] {
    return this.trades
  }

  private persist(): void {
    saveTrades(this.trades)
  }

  private touch(trade: PaperTrade, note?: string): void {
    trade.updatedAt = Date.now()
    if (note) trade.notes.push(note)
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  /**
   * Consider a freshly logged BUY. Returns the verdict so the daemon can log it
   * next to the alert — a skip is data (how many signals are untradeable?), not
   * a silent no-op.
   */
  async onSignal(
    signal: BuySignalRecord,
    ctx: { sessionVolume?: number | null } = {},
  ): Promise<{ taken: boolean; reason?: string }> {
    // One trade per setup per day — classifyBuy can re-fire the same setup across sweeps.
    if (this.trades.some(t => t.setupId === signal.setupId)) {
      return { taken: false, reason: 'already traded this setup' }
    }
    if (this.haltedForDay) {
      return { taken: false, reason: this.haltedForDay }
    }

    const account = await this.broker.getAccount()
    this.equity = account.equity
    this.brokerBlocked = account.blocked

    const sizing = sizePosition({
      equity: account.equity,
      buyingPower: account.buyingPower,
      entry: signal.entryHigh,
      stop: signal.stop,
      sessionVolume: ctx.sessionVolume ?? null,
    }, this.config.sizing)

    if (sizing.qty < 1) {
      appendEvent({ event: 'entry_skipped', symbol: signal.symbol, reason: sizing.reason ?? 'zero size' })
      return { taken: false, reason: sizing.reason ?? 'zero size' }
    }

    const verdict = canOpenPosition(signal.symbol, sizing.plannedRisk, {
      equity: account.equity,
      startingEquity: this.startingEquity,
      brokerBlocked: account.blocked,
      openTrades: this.openTrades(),
      closedToday: this.closedToday(),
      halted: isHalted(),
    }, this.config.risk)

    if (!verdict.allowed) {
      if (verdict.terminal) {
        this.haltedForDay = verdict.reason
        this.log(`RISK HALT — ${verdict.reason}`)
      }
      appendEvent({ event: 'entry_blocked', symbol: signal.symbol, reason: verdict.reason, terminal: verdict.terminal })
      return { taken: false, reason: verdict.reason }
    }

    // Alpaca lists no OTC names and flags some low-float movers untradable. On
    // this strategy that is a meaningful miss rate, so record it explicitly.
    const asset = await this.broker.getAsset(signal.symbol)
    if (!asset || !asset.tradable) {
      appendEvent({ event: 'entry_skipped', symbol: signal.symbol, reason: 'not tradable at broker' })
      return { taken: false, reason: `${signal.symbol} not tradable at ${this.broker.name}` }
    }

    const now = Date.now()
    const limit = entryLimitPrice(signal.entryHigh, this.config.entrySlipTolerancePct)
    const trade = newPaperTrade(signal, sizing.qty, limit, now)
    trade.plannedRisk = sizing.plannedRisk
    trade.notes.push(`size boundBy=${sizing.boundBy}`)
    if (this.trades.length === 0) trade.notes.push(`startingEquity=${this.startingEquity}`)

    if (this.config.dryRun) {
      trade.notes.push('dry-run: no order placed')
      trade.state = 'aborted'
      this.trades.push(trade)
      this.persist()
      this.log(`[dry-run] would buy ${sizing.qty} ${signal.symbol} @ ≤${limit.toFixed(4)} (risk $${sizing.plannedRisk.toFixed(0)})`)
      return { taken: false, reason: 'dry run' }
    }

    const session = getSessionType(now)
    const order = await this.broker.submitLimit({
      symbol: signal.symbol,
      qty: sizing.qty,
      side: 'buy',
      limitPrice: limit,
      extendedHours: session === 'premarket' || session === 'afterhours',
      clientOrderId: trade.id,
    })

    if (order.status === 'rejected') {
      trade.state = 'aborted'
      this.touch(trade, `entry rejected: ${order.rejectReason ?? 'unknown'}`)
      this.trades.push(trade)
      this.persist()
      this.log(`REJECT ${signal.symbol}: ${order.rejectReason}`)
      appendEvent({ event: 'entry_rejected', symbol: signal.symbol, tradeId: trade.id, reason: order.rejectReason })
      return { taken: false, reason: `broker rejected: ${order.rejectReason}` }
    }

    trade.entryOrderId = order.id
    trade.entrySubmittedAt = now
    this.trades.push(trade)
    this.persist()
    this.log(`ENTRY ${signal.symbol} ${sizing.qty} sh @ ≤${limit.toFixed(4)} (risk $${sizing.plannedRisk.toFixed(0)}, ${sizing.boundBy})`)
    appendEvent({
      event: 'entry_submitted', symbol: signal.symbol, tradeId: trade.id, orderId: order.id,
      qty: sizing.qty, limitPrice: limit, intendedEntry: signal.entryHigh, stop: signal.stop,
      targets: signal.targets, plannedRisk: sizing.plannedRisk, boundBy: sizing.boundBy,
    })
    return { taken: true }
  }

  // ── Lifecycle tick ─────────────────────────────────────────────────────────

  /** Reconcile working orders, then run exits. Safe to call every sweep. */
  async tick(now: number = Date.now()): Promise<void> {
    const live = this.openTrades()
    if (live.length === 0) return

    for (const trade of live) {
      try {
        if (trade.state === 'pending_entry') await this.reconcileEntry(trade, now)
      } catch (e) {
        this.log(`entry reconcile failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }

    // Settle any exit legs that were working from a previous tick before asking
    // for new ones, so openQty is current when decideExit runs.
    for (const trade of this.openTrades()) {
      try {
        if (trade.state === 'open') await this.reconcileExits(trade)
      } catch (e) {
        this.log(`exit reconcile failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }

    const holding = this.trades.filter(t => t.state === 'open' && t.openQty > 0)
    if (holding.length === 0) { this.persist(); return }

    let prices: Map<string, number>
    try {
      prices = await this.getPrices([...new Set(holding.map(t => t.symbol))])
    } catch (e) {
      this.log(`price fetch failed, holding positions untouched: ${(e as Error).message}`)
      this.persist()
      return
    }

    const etMinute = etMinutesOfDay(now)
    for (const trade of holding) {
      const price = prices.get(trade.symbol)
      if (price == null || !(price > 0)) {
        this.touch(trade, `no price at ${new Date(now).toISOString()}`)
        continue
      }
      try {
        await this.manageOpen(trade, price, etMinute, now)
      } catch (e) {
        this.log(`manage failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }
    this.persist()
  }

  private async reconcileEntry(trade: PaperTrade, now: number): Promise<void> {
    if (!trade.entryOrderId) { trade.state = 'aborted'; return }
    const order = await this.broker.getOrder(trade.entryOrderId)
    if (!order) return

    const timedOut = trade.entrySubmittedAt != null && now - trade.entrySubmittedAt > this.config.entryTimeoutMs

    if (order.status === 'filled' || (order.filledQty > 0 && (timedOut || order.status === 'canceled'))) {
      this.bookEntryFill(trade, order.filledQty, order.filledAvgPrice ?? trade.limitPrice, now)
      if (order.status !== 'filled') await this.broker.cancelOrder(trade.entryOrderId)
      return
    }

    if (order.status === 'rejected' || order.status === 'canceled' || order.status === 'expired') {
      trade.state = 'aborted'
      this.touch(trade, `entry ${order.status} unfilled`)
      appendEvent({ event: 'entry_aborted', symbol: trade.symbol, tradeId: trade.id, status: order.status })
      return
    }

    if (timedOut) {
      // Unfilled at the limit means price moved away without us. That is a clean,
      // countable outcome — and a much better one than paying up to chase.
      await this.broker.cancelOrder(trade.entryOrderId)
      if (order.filledQty > 0) {
        this.bookEntryFill(trade, order.filledQty, order.filledAvgPrice ?? trade.limitPrice, now)
      } else {
        trade.state = 'aborted'
        this.touch(trade, `entry timed out unfilled after ${Math.round(this.config.entryTimeoutMs / 1000)}s`)
        this.log(`NO FILL ${trade.symbol} — limit ${trade.limitPrice.toFixed(4)} never traded`)
        appendEvent({ event: 'entry_timeout', symbol: trade.symbol, tradeId: trade.id, limitPrice: trade.limitPrice })
      }
    }
  }

  private bookEntryFill(trade: PaperTrade, qty: number, price: number, now: number): void {
    trade.state = 'open'
    trade.entryFillQty = qty
    trade.entryFillPrice = price
    trade.entryFilledAt = now
    trade.openQty = qty
    trade.entrySlippagePct = slippagePct(trade.intendedEntry, price)
    // Risk is re-derived from the real fill: a worse fill on the same stop is
    // strictly more dollars at risk, and the governor should see the true number.
    trade.plannedRisk = qty * Math.max(price - trade.initialStop, 0)
    this.touch(trade)
    const slip = trade.entrySlippagePct
    this.log(
      `FILL ${trade.symbol} ${qty} sh @ ${price.toFixed(4)} ` +
      `(intended ${trade.intendedEntry.toFixed(4)}, slip ${slip == null ? '—' : `${slip >= 0 ? '+' : ''}${slip.toFixed(2)}%`})`,
    )
    appendEvent({
      event: 'entry_filled', symbol: trade.symbol, tradeId: trade.id,
      qty, fillPrice: price, intendedEntry: trade.intendedEntry, slippagePct: slip,
    })
  }

  /** Settle working exit legs and the protective stop against the broker. */
  private async reconcileExits(trade: PaperTrade): Promise<void> {
    for (const leg of trade.exits) {
      if (leg.fillPrice != null || !leg.orderId) continue
      const order = await this.broker.getOrder(leg.orderId)
      if (!order) continue
      if (order.filledQty > 0 && order.filledAvgPrice != null) {
        this.bookExitFill(trade, leg, order.filledQty, order.filledAvgPrice)
      } else if (order.status === 'canceled' || order.status === 'rejected' || order.status === 'expired') {
        // The leg died without filling — drop it so the level can re-trigger.
        leg.orderId = null
        this.touch(trade, `exit leg ${leg.reason} ${order.status}, will retry`)
      }
    }

    if (trade.protectiveStopOrderId) {
      const stopOrder = await this.broker.getOrder(trade.protectiveStopOrderId)
      if (stopOrder && stopOrder.filledQty > 0 && stopOrder.filledAvgPrice != null) {
        const leg: ExitLeg = {
          // A broker-side stop fires without us observing a price, so there is no
          // decision price — the gap/concession split doesn't apply to this path.
          qty: stopOrder.filledQty, reason: 'stop', intendedPrice: trade.currentStop,
          decisionPrice: null,
          orderId: stopOrder.id, fillPrice: null, filledAt: null, slippagePct: null,
        }
        trade.exits.push(leg)
        trade.protectiveStopOrderId = null
        this.bookExitFill(trade, leg, stopOrder.filledQty, stopOrder.filledAvgPrice)
      } else if (stopOrder && (stopOrder.status === 'canceled' || stopOrder.status === 'expired' || stopOrder.status === 'rejected')) {
        trade.protectiveStopOrderId = null
      }
    }

    trade.exits = trade.exits.filter(l => l.fillPrice != null || l.orderId != null)
    if (trade.openQty <= 0) this.closeTrade(trade)
  }

  private bookExitFill(trade: PaperTrade, leg: ExitLeg, qty: number, price: number): void {
    leg.qty = qty
    leg.fillPrice = price
    leg.filledAt = Date.now()
    leg.slippagePct = slippagePct(leg.intendedPrice, price)
    trade.openQty = Math.max(0, trade.openQty - qty)
    if (leg.reason === 't1') {
      trade.t1Done = true
      // Breakeven stop on the remainder — matches the resolver's ladder exactly.
      if (trade.entryFillPrice != null) trade.currentStop = trade.entryFillPrice
    }
    this.touch(trade)
    this.log(
      `EXIT ${trade.symbol} ${qty} sh @ ${price.toFixed(4)} (${leg.reason}, ` +
      `level ${leg.intendedPrice.toFixed(4)}, slip ${leg.slippagePct == null ? '—' : `${leg.slippagePct.toFixed(2)}%`}) ` +
      `· ${trade.openQty} left`,
    )
    appendEvent({
      event: 'exit_filled', symbol: trade.symbol, tradeId: trade.id, reason: leg.reason,
      qty, fillPrice: price, intendedPrice: leg.intendedPrice, slippagePct: leg.slippagePct,
      decisionPrice: leg.decisionPrice,
      // The actionable split: gap is latency (poll faster), concession is the limit tolerance.
      gapPct: leg.decisionPrice != null ? slippagePct(leg.intendedPrice, leg.decisionPrice) : null,
      concessionPct: leg.decisionPrice != null ? slippagePct(leg.decisionPrice, price) : null,
      openQtyAfter: trade.openQty,
    })
    if (trade.openQty <= 0) this.closeTrade(trade)
  }

  private closeTrade(trade: PaperTrade): void {
    trade.state = 'closed'
    trade.fullyClosed = trade.exits.every(l => l.reason !== 'time')
    const realized = computeRealized(trade)
    trade.realizedPnl = realized?.pnl ?? null
    trade.realizedPnlPct = realized?.pnlPct ?? null
    this.touch(trade)
    this.log(
      `CLOSED ${trade.symbol} · P&L ${trade.realizedPnl == null ? '—' : `$${trade.realizedPnl.toFixed(2)}`} ` +
      `(${trade.realizedPnlPct == null ? '—' : `${trade.realizedPnlPct.toFixed(2)}%`})`,
    )
    appendEvent({
      event: 'trade_closed', symbol: trade.symbol, tradeId: trade.id,
      realizedPnl: trade.realizedPnl, realizedPnlPct: trade.realizedPnlPct,
      entrySlippagePct: trade.entrySlippagePct, fullyClosed: trade.fullyClosed,
      legs: trade.exits.map(l => ({ reason: l.reason, qty: l.qty, fill: l.fillPrice, slip: l.slippagePct })),
    })
  }

  private async manageOpen(trade: PaperTrade, price: number, etMinute: number, now: number): Promise<void> {
    const decision = decideExit(trade, price, etMinute, this.config.flattenEtMinute)

    if (!decision) {
      await this.ensureProtectiveStop(trade, now)
      return
    }
    // An exit leg for this reason is already working — don't stack duplicates.
    if (trade.exits.some(l => l.reason === decision.reason && l.fillPrice == null && l.orderId)) return

    // Cancel everything resting first: a live protective stop and a fresh sell
    // would together try to sell more shares than we hold.
    await this.broker.cancelOpenOrders(trade.symbol)
    trade.protectiveStopOrderId = null

    const session = getSessionType(now)
    const limit = exitLimitPrice(Math.min(price, decision.intendedPrice), this.config.exitSlipTolerancePct)
    const leg: ExitLeg = {
      qty: decision.qty, reason: decision.reason, intendedPrice: decision.intendedPrice,
      decisionPrice: price,
      orderId: null, fillPrice: null, filledAt: null, slippagePct: null,
    }

    const order = await this.broker.submitLimit({
      symbol: trade.symbol,
      qty: decision.qty,
      side: 'sell',
      limitPrice: limit,
      extendedHours: session === 'premarket' || session === 'afterhours',
      clientOrderId: `${trade.id}:x:${decision.reason}:${Math.floor(now / 1000)}`,
    })

    if (order.status === 'rejected') {
      this.touch(trade, `exit ${decision.reason} rejected: ${order.rejectReason ?? 'unknown'}`)
      this.log(`EXIT REJECT ${trade.symbol} (${decision.reason}): ${order.rejectReason}`)
      appendEvent({ event: 'exit_rejected', symbol: trade.symbol, tradeId: trade.id, reason: decision.reason, detail: order.rejectReason })
      return
    }

    leg.orderId = order.id
    trade.exits.push(leg)
    this.touch(trade)
    this.log(`EXIT ORDER ${trade.symbol} ${decision.qty} sh (${decision.reason}) @ ≥${limit.toFixed(4)} — price ${price.toFixed(4)}`)
    appendEvent({
      event: 'exit_submitted', symbol: trade.symbol, tradeId: trade.id, reason: decision.reason,
      qty: decision.qty, limitPrice: limit, triggerPrice: price, intendedPrice: decision.intendedPrice,
    })

    // Fills on a marketable limit are usually immediate; settling now keeps the
    // ladder moving within one tick rather than waiting for the next sweep.
    await this.reconcileExits(trade)
  }

  /**
   * Keep a resting broker stop under the position during regular hours, so a
   * crashed daemon leaves a covered position rather than a naked one. Replaced
   * whenever the stop level or share count changes (i.e. after T1).
   *
   * Sized to the shares NOT already reserved by a working exit leg. Asking for
   * the full `openQty` while a T1 limit rests on half of it is rejected outright
   * ("insufficient qty available"), which used to leave the runner with no
   * resting stop at all — exactly the case this exists to cover.
   */
  private async ensureProtectiveStop(trade: PaperTrade, now: number): Promise<void> {
    if (getSessionType(now) !== 'regular') return   // Alpaca rejects stops outside RTH
    if (trade.openQty <= 0) return

    const coverQty = trade.openQty - workingExitQty(trade)

    if (trade.protectiveStopOrderId) {
      const existing = await this.broker.getOrder(trade.protectiveStopOrderId)
      // Anything not still working is replaced: a canceled stop that happens to
      // match on size would otherwise be left standing as phantom cover.
      const good = existing && existing.status === 'open' && existing.qty === coverQty
      if (good) return
      await this.broker.cancelOrder(trade.protectiveStopOrderId)
      trade.protectiveStopOrderId = null
    }

    // Every open share is working an exit leg — covered by that limit, not by a stop.
    if (coverQty <= 0) return

    const order = await this.broker.submitStop({
      symbol: trade.symbol,
      qty: coverQty,
      stopPrice: trade.currentStop,
      clientOrderId: `${trade.id}:stop:${Math.floor(now / 1000)}`,
    })
    if (order.status === 'rejected') {
      this.touch(trade, `protective stop rejected: ${order.rejectReason ?? 'unknown'}`)
      return
    }
    trade.protectiveStopOrderId = order.id
    this.touch(trade)
    appendEvent({
      event: 'protective_stop', symbol: trade.symbol, tradeId: trade.id,
      qty: coverQty, stopPrice: trade.currentStop, orderId: order.id,
    })
  }

  /** Cancel everything and flatten — the kill switch and the shutdown path. */
  async flattenAll(reason: ExitReason = 'risk_halt'): Promise<void> {
    const holding = this.trades.filter(t => t.state === 'open' && t.openQty > 0)
    for (const trade of holding) {
      try {
        await this.broker.cancelOpenOrders(trade.symbol)
        trade.protectiveStopOrderId = null
        const prices = await this.getPrices([trade.symbol])
        const price = prices.get(trade.symbol)
        if (price == null) { this.touch(trade, 'flatten: no price'); continue }
        const leg: ExitLeg = {
          qty: trade.openQty, reason, intendedPrice: price, decisionPrice: price,
          orderId: null, fillPrice: null, filledAt: null, slippagePct: null,
        }
        const order = await this.broker.submitLimit({
          symbol: trade.symbol, qty: trade.openQty, side: 'sell',
          limitPrice: exitLimitPrice(price, this.config.exitSlipTolerancePct),
          extendedHours: getSessionType() !== 'regular',
          clientOrderId: `${trade.id}:flat:${Math.floor(Date.now() / 1000)}`,
        })
        if (order.status === 'rejected') { this.touch(trade, `flatten rejected: ${order.rejectReason}`); continue }
        leg.orderId = order.id
        trade.exits.push(leg)
        await this.reconcileExits(trade)
      } catch (e) {
        this.log(`flatten failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }
    this.persist()
  }

  /** One-line end-of-session summary — the numbers paper trading exists to produce. */
  summary(): string {
    const closed = this.closedToday()
    const filled = this.trades.filter(t => t.entryFillPrice != null)
    const aborted = this.trades.filter(t => t.state === 'aborted')
    const pnl = closed.reduce((s, t) => s + (t.realizedPnl ?? 0), 0)
    const wins = closed.filter(t => (t.realizedPnl ?? 0) > 0).length
    const entrySlips = filled.map(t => t.entrySlippagePct).filter((n): n is number => n != null)
    const exitSlips = this.trades.flatMap(t => t.exits.map(l => l.slippagePct)).filter((n): n is number => n != null)
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    const fmt = (n: number | null) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
    // Split exit slippage into what we can fix by polling faster (gap) vs what the
    // limit tolerance costs (concession). On 2026-08-10 that was −2.35% / −0.50%.
    const legs = this.trades.flatMap(t => t.exits).filter(l => l.fillPrice != null && l.decisionPrice != null)
    const gaps = legs.map(l => slippagePct(l.intendedPrice, l.decisionPrice!)).filter((n): n is number => n != null)
    const concessions = legs.map(l => slippagePct(l.decisionPrice!, l.fillPrice!)).filter((n): n is number => n != null)
    return [
      `signals→trades: ${this.trades.length} considered, ${filled.length} filled, ${aborted.length} never filled`,
      `closed ${closed.length} · ${wins}W/${closed.length - wins}L · P&L $${pnl.toFixed(2)}`,
      `mean entry slip ${fmt(mean(entrySlips))} · mean exit slip ${fmt(mean(exitSlips))}`,
      `  exit slip split — market gap ${fmt(mean(gaps))} (latency) · concession ${fmt(mean(concessions))} (limit tolerance)`,
    ].join('\n')
  }
}
