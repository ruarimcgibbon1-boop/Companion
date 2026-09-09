/**
 * Accounting-correctness regression suite (Pre-V2 Step 3).
 *
 * Focus: fill ingestion, cumulative-vs-incremental fills, terminal idempotency,
 * openQty arithmetic, fullyClosed=flat, reconciliation-status resolution, and the
 * broker-truth boundary. Historical incident SHAPES (BIAF/ZETA/EVGO/USAR/RARE) are
 * reproduced synthetically — no historical tickers hardcoded in production.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import type {
  Broker, BrokerAccount, AssetInfo, BrokerOrder, BrokerPosition, BrokerFill,
  LimitOrderRequest, StopOrderRequest, BrokerOrderStatus,
} from '@/lib/execution/types'
import { appendEvent } from '@/lib/execution/store'
import * as store from '@/lib/execution/store'
import { vi } from 'vitest'

// ---- controllable stub broker: scripts each order's fill trajectory across polls ----
interface OrderScript {
  // successive cumulative (filledQty, status) observations returned by getOrder, one per poll
  polls: Array<{ filledQty: number; avg: number | null; status: BrokerOrderStatus }>
}
class StubBroker implements Broker {
  readonly name = 'stub'
  private orders = new Map<string, BrokerOrder>()
  private scripts = new Map<string, OrderScript>()
  private pollIdx = new Map<string, number>()
  position: BrokerPosition | null = null
  recentFills: BrokerFill[] = []
  private seq = 0
  submitted: Array<LimitOrderRequest | StopOrderRequest> = []

  async getAccount(): Promise<BrokerAccount> {
    return { equity: 100_000, cash: 100_000, buyingPower: 200_000, daytradeCount: 0, blocked: false }
  }
  async getAsset(symbol: string): Promise<AssetInfo> {
    return { symbol, tradable: true, fractionable: false, shortable: true, exchange: 'NASDAQ' }
  }
  async getPositions(): Promise<BrokerPosition[]> { return this.position ? [this.position] : [] }
  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    return this.position && this.position.symbol === symbol ? this.position : null
  }
  async getRecentFills(): Promise<BrokerFill[]> { return this.recentFills }
  async cancelOrder(): Promise<void> {}
  async cancelOpenOrders(): Promise<number> { return 0 }

  // Register a scripted sell order id up front, then return successive polls.
  script(id: string, s: OrderScript) { this.scripts.set(id, s); this.pollIdx.set(id, 0) }

  async getOrder(id: string): Promise<BrokerOrder | null> {
    const s = this.scripts.get(id)
    if (!s) return this.orders.get(id) ?? null
    const i = Math.min(this.pollIdx.get(id)!, s.polls.length - 1)
    this.pollIdx.set(id, this.pollIdx.get(id)! + 1)
    const p = s.polls[i]
    return {
      id, clientOrderId: null, symbol: 'TST', side: 'sell', status: p.status,
      qty: p.filledQty, filledQty: p.filledQty, filledAvgPrice: p.avg,
      limitPrice: null, submittedAt: 0, rejectReason: null,
    }
  }
  // Entry/exit submission — returns a filled buy for entries; records sells.
  async submitLimit(req: LimitOrderRequest): Promise<BrokerOrder> {
    this.submitted.push(req)
    const id = `o${++this.seq}`
    const isBuy = req.side === 'buy'
    const o: BrokerOrder = {
      id, clientOrderId: req.clientOrderId ?? null, symbol: req.symbol, side: req.side,
      status: isBuy ? 'filled' : 'open', qty: req.qty,
      filledQty: isBuy ? req.qty : 0, filledAvgPrice: isBuy ? req.limitPrice : null,
      limitPrice: req.limitPrice, submittedAt: Date.now(), rejectReason: null,
    }
    this.orders.set(id, o)
    return o
  }
  async submitStop(req: StopOrderRequest): Promise<BrokerOrder> {
    this.submitted.push(req)
    const id = `s${++this.seq}`
    const o: BrokerOrder = {
      id, clientOrderId: req.clientOrderId ?? null, symbol: req.symbol, side: 'sell',
      status: 'open', qty: req.qty, filledQty: 0, filledAvgPrice: null,
      limitPrice: null, submittedAt: Date.now(), rejectReason: null,
    }
    this.orders.set(id, o)
    return o
  }
}

// Capture appendEvent output without touching the filesystem.
let events: Array<Record<string, unknown>> = []
beforeEach(() => {
  events = []
  vi.spyOn(store, 'appendEvent').mockImplementation((e) => { events.push(e as Record<string, unknown>) })
  vi.spyOn(store, 'loadTrades').mockReturnValue([])
  vi.spyOn(store, 'saveTrades').mockImplementation(() => {})
  vi.spyOn(store, 'isHalted').mockReturnValue(false)
})
const closes = () => events.filter(e => e.event === 'trade_closed')
const exitFills = () => events.filter(e => e.event === 'exit_filled')

describe('accounting — invariants documented as executable checks', () => {
  // Unit-level: exercise the fill-ingestion math directly through a minimal harness.
  // We build a trade object and drive reconcileExits via a scripted stop order.
  function buildExecutor(broker: StubBroker) {
    return new PaperExecutor(broker, async () => new Map(), { ...DEFAULT_EXECUTOR }, () => {})
  }

  // Helper: fabricate an open trade with one entry fill and a resting protective stop.
  function openTrade(broker: StubBroker, stopOrderId: string, qty = 500, entry = 10) {
    const trade: any = {
      id: 'pt:TST', signalId: 'sig', setupId: 'TST:breakout:10', symbol: 'TST', setupType: 'breakout',
      state: 'open', intendedEntry: entry, limitPrice: entry, initialStop: 9, currentStop: 9,
      targets: [11, 12], qty, plannedRisk: 100, entryOrderId: 'e1', entrySubmittedAt: 0,
      entrySession: 'regular', entryFilledAt: 0, entryFillPrice: entry, entryFillQty: qty, entrySlippagePct: 0,
      openQty: qty, t1Done: false, exits: [], protectiveStopOrderId: stopOrderId,
      realizedPnl: null, realizedPnlPct: null, fullyClosed: false, terminalBooked: false,
      createdAt: 0, updatedAt: 0, notes: [], reconciliationStatus: 'pending',
      brokerVerifiedQty: null, lastReconciledAt: null, executionWarnings: [],
    }
    return trade
  }

  it('TEST 3/4/11 — cumulative stop fill 88 → 532 books full 532 exactly once, no double count', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 88, avg: 9.0, status: 'partially_filled' },
      { filledQty: 200, avg: 9.0, status: 'partially_filled' },
      { filledQty: 532, avg: 9.0, status: 'filled' },
    ]})
    const trade = openTrade(broker, 's1', 532, 10)
    ;(ex as any).trades = [trade]
    // three ticks of exit reconciliation
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    const bookedQty = trade.exits.reduce((s: number, l: any) => s + (l.fillPrice != null ? l.qty : 0), 0)
    expect(bookedQty).toBe(532)                 // full residual, not stranded at 88
    expect(trade.openQty).toBe(0)               // 532 entry - 532 exit
    expect(trade.fullyClosed).toBe(true)
    expect(closes().length).toBe(1)             // exactly one terminal event
    // incremental exit_filled qtys: 88, 112, 332  (sum 532, never 88+200+532)
    const incs = exitFills().map(e => e.qty)
    expect(incs).toEqual([88, 112, 332])
    // realized = (9.0 - 10) * 532
    expect(trade.realizedPnl).toBeCloseTo((9.0 - 10) * 532, 6)
  })

  it('TEST 10 — repeated identical cumulative poll (88,88,88) counts once', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 88, avg: 9.5, status: 'partially_filled' },
      { filledQty: 88, avg: 9.5, status: 'partially_filled' },
      { filledQty: 88, avg: 9.5, status: 'partially_filled' },
    ]})
    const trade = openTrade(broker, 's1', 500, 10)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    const bookedQty = trade.exits.reduce((s: number, l: any) => s + (l.fillPrice != null ? l.qty : 0), 0)
    expect(bookedQty).toBe(88)
    expect(trade.openQty).toBe(412)             // 500 - 88, exactly once
    expect(exitFills().length).toBe(1)          // one increment event only
  })

  it('TEST 2 — T1 partial + stop residual both incorporated, one terminal event', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    // A T1 limit leg (o-t1) fills 250, then the stop (s1) fills the remaining 250.
    broker.script('ot1', { polls: [{ filledQty: 250, avg: 11, status: 'filled' }] })
    broker.script('s1', { polls: [{ filledQty: 250, avg: 9, status: 'filled' }] })
    const trade = openTrade(broker, 's1', 500, 10)
    trade.exits.push({ qty: 0, reason: 't1', intendedPrice: 11, decisionPrice: 11, orderId: 'ot1', fillPrice: null, filledAt: null, slippagePct: null })
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    expect(trade.openQty).toBe(0)
    expect(trade.fullyClosed).toBe(true)
    expect(closes().length).toBe(1)
    // realized = (11-10)*250 + (9-10)*250 = 250 - 250 = 0
    expect(trade.realizedPnl).toBeCloseTo(0, 6)
    expect(trade.t1Done).toBe(true)
  })

  it('TEST 8 — duplicate closeTrade invocation → one trade_closed, no P&L doubling', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    broker.script('s1', { polls: [{ filledQty: 500, avg: 9, status: 'filled' }] })
    const trade = openTrade(broker, 's1', 500, 10)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)         // closes once
    const pnl1 = trade.realizedPnl
    ;(ex as any).closeTrade(trade)                  // explicit second close
    ;(ex as any).closeTrade(trade)                  // and a third
    expect(closes().length).toBe(1)
    expect(trade.realizedPnl).toBe(pnl1)            // unchanged
  })

  it('TEST 14 — openQty never goes negative under over-observation', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 400, avg: 9, status: 'partially_filled' },
      { filledQty: 700, avg: 9, status: 'filled' },   // broker reports MORE than entry qty (pathological)
    ]})
    const trade = openTrade(broker, 's1', 500, 10)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    expect(trade.openQty).toBe(0)                   // clamped, never negative
    expect(trade.openQty).toBeGreaterThanOrEqual(0)
  })

  it('out-of-order poll returning a LOWER cumulative never regresses leg qty', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 400, avg: 9, status: 'partially_filled' },
      { filledQty: 200, avg: 9, status: 'partially_filled' },  // stale/out-of-order lower value
      { filledQty: 400, avg: 9, status: 'filled' },
    ]})
    const trade = openTrade(broker, 's1', 500, 10)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)   // books 400
    await (ex as any).reconcileExits(trade)   // sees 200 → ignored
    await (ex as any).reconcileExits(trade)   // sees 400 (same) → ignored
    const bookedQty = trade.exits.reduce((s: number, l: any) => s + (l.fillPrice != null ? l.qty : 0), 0)
    expect(bookedQty).toBe(400)
    expect(trade.openQty).toBe(100)           // 500 - 400, never 500-400+200
    expect(exitFills().length).toBe(1)
  })

  it('TEST 15 — terminal event retains setupId/tradeId and canonical realized P&L', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    broker.script('s1', { polls: [{ filledQty: 500, avg: 9.5, status: 'filled' }] })
    const trade = openTrade(broker, 's1', 500, 10)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    const c = closes()[0]
    expect(c.tradeId).toBe('pt:TST')
    expect(c.setupId).toBe('TST:breakout:10')
    expect(c.realizedPnl).toBeCloseTo((9.5 - 10) * 500, 6)
  })
})

describe('accounting — cumulative avg-price / notional (Alpaca filled_avg_price is cumulative VWAP)', () => {
  function buildExecutor(broker: StubBroker) {
    return new PaperExecutor(broker, async () => new Map(), { ...DEFAULT_EXECUTOR }, () => {})
  }
  function openTrade(broker: StubBroker, stopOrderId: string, qty: number, entry: number) {
    return {
      id: 'pt:TST', signalId: 'sig', setupId: 'TST:breakout:30', symbol: 'TST', setupType: 'breakout',
      state: 'open', intendedEntry: entry, limitPrice: entry, initialStop: entry - 2, currentStop: entry - 2,
      targets: [entry + 2], qty, plannedRisk: 100, entryOrderId: 'e1', entrySubmittedAt: 0,
      entrySession: 'regular', entryFilledAt: 0, entryFillPrice: entry, entryFillQty: qty, entrySlippagePct: 0,
      openQty: qty, t1Done: false, exits: [], protectiveStopOrderId: stopOrderId,
      realizedPnl: null, realizedPnlPct: null, fullyClosed: false, terminalBooked: false, closeCount: 0,
      createdAt: 0, updatedAt: 0, notes: [], reconciliationStatus: 'pending',
      brokerVerifiedQty: null, lastReconciledAt: null, executionWarnings: [],
    } as any
  }
  const proceeds = (t: any) => t.exits.reduce((s: number, l: any) => s + (l.fillPrice != null ? l.qty * l.fillPrice : 0), 0)

  it('TEST A — 88@31.81 then cumulative 532@31.79: proceeds = 532*31.79 exactly (NOT 444*31.79)', async () => {
    const broker = new StubBroker(); const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 88, avg: 31.81, status: 'partially_filled' },
      { filledQty: 532, avg: 31.79, status: 'filled' },
    ]})
    const trade = openTrade(broker, 's1', 532, 30)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    expect(exitFills().map(e => e.qty)).toEqual([88, 444])       // qty increment = 444
    const totalQty = trade.exits.reduce((s: number, l: any) => s + (l.fillPrice != null ? l.qty : 0), 0)
    expect(totalQty).toBe(532)
    // total exit proceeds reconcile EXACTLY to the broker cumulative notional
    expect(proceeds(trade)).toBeCloseTo(532 * 31.79, 6)
    // the wrong (incremental-avg) model would give 88*31.81 + 444*31.79 = 16914.04 ≠ 16912.28
    expect(proceeds(trade)).not.toBeCloseTo(88 * 31.81 + 444 * 31.79, 6)
    expect(trade.realizedPnl).toBeCloseTo((31.79 - 30) * 532, 6)
  })

  it('ZETA economics — one order, cumulative VWAP reconciles to per-fill notional 88@31.81 + 444@31.79', async () => {
    // Historical ZETA: 88 filled ~31.81 then 444 more ~31.79 on ONE stop order. Alpaca reports
    // cumulative filled_avg_price, so at 532 it is the VWAP of all fills. cumQty*cumAvg must equal
    // the true per-fill notional — the exact $ that was previously under-booked (~$46.64 lost).
    const inc1 = { q: 88, px: 31.81 }, inc2q = 444, inc2px = 31.79
    const trueNotional = inc1.q * inc1.px + inc2q * inc2px          // 16914.04
    const cumAvgFinal = trueNotional / 532                          // Alpaca's cumulative avg @532
    const broker = new StubBroker(); const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 88, avg: 31.81, status: 'partially_filled' },
      { filledQty: 532, avg: cumAvgFinal, status: 'filled' },
    ]})
    const entry = 32                                                // a loss (exits below entry)
    const trade = openTrade(broker, 's1', 532, entry)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    expect(proceeds(trade)).toBeCloseTo(trueNotional, 6)           // full 532 notional, nothing lost
    expect(trade.realizedPnl).toBeCloseTo(trueNotional - entry * 532, 6)
    expect(trade.openQty).toBe(0)
    expect(closes().length).toBe(1)
  })

  it('TEST B — 88@31.81 → 200@31.76 → 532@31.79 cumulative: final proceeds = 532*31.79', async () => {
    const broker = new StubBroker(); const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 88, avg: 31.81, status: 'partially_filled' },
      { filledQty: 200, avg: 31.76, status: 'partially_filled' },
      { filledQty: 532, avg: 31.79, status: 'filled' },
    ]})
    const trade = openTrade(broker, 's1', 532, 30)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    await (ex as any).reconcileExits(trade)
    expect(exitFills().map(e => e.qty)).toEqual([88, 112, 332])
    expect(proceeds(trade)).toBeCloseTo(532 * 31.79, 6)          // intermediates don't distort the total
    expect(trade.realizedPnl).toBeCloseTo((31.79 - 30) * 532, 6)
  })

  it('TEST C — same cumulative qty + unchanged avg re-observed: zero new qty, zero new P&L', async () => {
    const broker = new StubBroker(); const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 88, avg: 31.81, status: 'partially_filled' },
      { filledQty: 88, avg: 31.81, status: 'partially_filled' },
    ]})
    const trade = openTrade(broker, 's1', 532, 30)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    const p1 = proceeds(trade)
    await (ex as any).reconcileExits(trade)
    expect(exitFills().length).toBe(1)
    expect(proceeds(trade)).toBe(p1)
  })

  it('TEST D — lower/out-of-order cumulative later: neither qty NOR notional regresses', async () => {
    const broker = new StubBroker(); const ex = buildExecutor(broker)
    broker.script('s1', { polls: [
      { filledQty: 400, avg: 31.80, status: 'partially_filled' },
      { filledQty: 200, avg: 31.70, status: 'partially_filled' },  // stale/out-of-order
    ]})
    const trade = openTrade(broker, 's1', 500, 30)
    ;(ex as any).trades = [trade]
    await (ex as any).reconcileExits(trade)
    const qtyAfter1 = trade.exits.reduce((s: number, l: any) => s + (l.fillPrice != null ? l.qty : 0), 0)
    const proceedsAfter1 = proceeds(trade)
    await (ex as any).reconcileExits(trade)
    expect(trade.exits.reduce((s: number, l: any) => s + (l.fillPrice != null ? l.qty : 0), 0)).toBe(qtyAfter1) // 400
    expect(proceeds(trade)).toBe(proceedsAfter1)                  // 400*31.80, not regressed
    expect(qtyAfter1).toBe(400)
  })
})

describe('accounting — restart persistence + late-fill reopen', () => {
  function buildExecutor(broker: StubBroker) {
    return new PaperExecutor(broker, async () => new Map(), { ...DEFAULT_EXECUTOR }, () => {})
  }
  const roundtrip = (t: any) => JSON.parse(JSON.stringify(t))
  function closedTrade(over: Record<string, unknown> = {}) {
    return {
      id: 'pt:TST', signalId: 's', setupId: 'TST:x:1', symbol: 'TST', setupType: 'breakout',
      state: 'closed', intendedEntry: 10, limitPrice: 10, initialStop: 9, currentStop: 9,
      targets: [11], qty: 500, plannedRisk: 100, entryOrderId: 'e1', entrySubmittedAt: 0,
      entrySession: 'regular', entryFilledAt: 0, entryFillPrice: 10, entryFillQty: 500, entrySlippagePct: 0,
      openQty: 0, t1Done: false,
      exits: [{ qty: 500, reason: 'stop', intendedPrice: 9, decisionPrice: null, orderId: null, fillPrice: 9, filledAt: 0, slippagePct: 0 }],
      realizedPnl: -500, realizedPnlPct: -10, fullyClosed: true, terminalBooked: true, closeCount: 1,
      createdAt: 0, updatedAt: 0, notes: [], reconciliationStatus: 'pending',
      brokerVerifiedQty: null, lastReconciledAt: null, executionWarnings: [], ...over,
    } as any
  }

  it('restart: serialized closed trade reloaded + reconciled → no duplicate trade_closed, P&L unchanged', async () => {
    const broker = new StubBroker(); broker.position = null
    const ex = buildExecutor(broker)
    const reloaded = roundtrip(closedTrade())           // JSON round-trip, not the same object
    expect(reloaded.terminalBooked).toBe(true)          // marker survived serialization
    const pnl = reloaded.realizedPnl
    await (ex as any).reconcile(reloaded)
    expect(closes().length).toBe(0)                     // no new terminal event
    expect(reloaded.realizedPnl).toBe(pnl)              // P&L untouched
    expect(reloaded.reconciliationStatus).toBe('verified')
  })

  it('legacy: reloaded closed trade with terminalBooked/closeCount ABSENT is handled safely', async () => {
    const broker = new StubBroker(); broker.position = null
    const ex = buildExecutor(broker)
    const legacy = roundtrip(closedTrade())
    delete legacy.terminalBooked; delete legacy.closeCount   // pre-migration JSON shape
    await (ex as any).reconcile(legacy)
    // reconcile equality (0==0) promotes to verified WITHOUT calling closeTrade → no duplicate
    expect(closes().length).toBe(0)
    expect(legacy.reconciliationStatus).toBe('verified')
  })

  it('late fill after close: invalid-geometry residual reopens, resets terminalBooked, re-close is distinguishable (closeCount=2)', async () => {
    const broker = new StubBroker()
    const ex = buildExecutor(broker)
    // Invalid-geometry closed trade (plannedRisk<=0), broker later shows a residual position.
    const t = roundtrip(closedTrade({ plannedRisk: -5, realizedPnl: -20, closeCount: 1, terminalBooked: true }))
    broker.position = { symbol: 'TST', qty: 100, qtyAvailable: 100, avgEntryPrice: 10, currentPrice: 9 } as BrokerPosition
    await (ex as any).reconcile(t)
    // Reopened explicitly, terminalBooked reset, closeCount preserved, NO trade_closed yet.
    expect(t.state).toBe('open')
    expect(t.terminalBooked).toBe(false)
    expect(t.closeCount).toBe(1)
    expect(events.filter(e => e.event === 'invalid_geometry_residual_recovered').length).toBe(1)
    expect(closes().length).toBe(0)
    // Now the reopened residual is flattened locally → second close episode is distinguishable.
    t.openQty = 0
    ;(ex as any).closeTrade(t)
    const c = closes()
    expect(c.length).toBe(1)
    expect(c[0].closeCount).toBe(2)                     // NOT an indistinguishable duplicate
  })
})

describe('accounting — reconciliation status semantics', () => {
  function buildExecutor(broker: StubBroker) {
    return new PaperExecutor(broker, async () => new Map(), { ...DEFAULT_EXECUTOR }, () => {})
  }
  function closedTrade(status: 'pending' | 'discrepancy', openQty = 0) {
    return {
      id: 'pt:TST', signalId: 's', setupId: 'TST:x:1', symbol: 'TST', setupType: 'breakout',
      state: 'closed', intendedEntry: 10, limitPrice: 10, initialStop: 9, currentStop: 9,
      targets: [11], qty: 500, plannedRisk: 100, entryOrderId: 'e1', entrySubmittedAt: 0,
      entrySession: 'regular', entryFilledAt: 0, entryFillPrice: 10, entryFillQty: 500, entrySlippagePct: 0,
      openQty, t1Done: false, exits: [{ qty: 500, reason: 'stop', intendedPrice: 9, decisionPrice: null, orderId: null, fillPrice: 9, filledAt: 0, slippagePct: 0 }],
      realizedPnl: -500, realizedPnlPct: -10, fullyClosed: true, terminalBooked: true,
      createdAt: 0, updatedAt: 0, notes: [], reconciliationStatus: status,
      brokerVerifiedQty: null, lastReconciledAt: null, executionWarnings: [],
    } as any
  }

  it('TEST 5/6 — discrepancy resolves to verified once broker agrees (flat==flat)', async () => {
    const broker = new StubBroker()
    broker.position = null // broker flat
    const ex = buildExecutor(broker)
    const trade = closedTrade('discrepancy', 0)
    const pnlBefore = trade.realizedPnl
    const brokerQty = await (ex as any).reconcile(trade)
    expect(brokerQty).toBe(0)
    expect(trade.reconciliationStatus).toBe('verified')  // no longer sticky
    expect(trade.brokerVerifiedQty).toBe(0)
    expect(trade.realizedPnl).toBe(pnlBefore)            // P&L untouched by reconciliation
    expect(closes().length).toBe(0)                      // no duplicate terminal event
  })

  it('TEST 9 — repeated reconcile on a verified flat trade is idempotent', async () => {
    const broker = new StubBroker()
    broker.position = null
    const ex = buildExecutor(broker)
    const trade = closedTrade('pending', 0)
    await (ex as any).reconcile(trade)
    expect(trade.reconciliationStatus).toBe('verified')
    await (ex as any).reconcile(trade)
    await (ex as any).reconcile(trade)
    expect(trade.reconciliationStatus).toBe('verified')
    expect(closes().length).toBe(0)
  })

  it('TEST 13 — local flat but broker non-flat → NOT claimed verified', async () => {
    const broker = new StubBroker()
    broker.position = { symbol: 'TST', qty: 300, qtyAvailable: 300, avgEntryPrice: 10, currentPrice: 10 } as BrokerPosition
    const ex = buildExecutor(broker)
    const trade = closedTrade('pending', 0)
    trade.plannedRisk = 100 // valid risk so the invalid-residual branch does not fire
    await (ex as any).reconcile(trade)
    expect(trade.reconciliationStatus).not.toBe('verified') // broker shows 300, we are flat
    expect(trade.brokerVerifiedQty).toBe(300)
  })

  it('TEST 12 — forced-flat with NO broker fill prices → manual_review, P&L not fabricated', async () => {
    const broker = new StubBroker()
    // Broker is flat, but has NO recent fills to price the remainder with.
    broker.position = null
    broker.recentFills = []
    const ex = buildExecutor(broker)
    const trade = {
      ...closedTrade('pending', 200), state: 'open', openQty: 200, terminalBooked: false,
      exits: [], realizedPnl: null, realizedPnlPct: null, fullyClosed: false,
    } as any
    await (ex as any).reconcile(trade)
    expect(trade.reconciliationStatus).toBe('manual_review')
    // No external fills existed → no priced remainder leg → realized stays null (never invented).
    expect(trade.realizedPnl).toBeNull()
    const ff = events.filter(e => e.event === 'reconcile_forced_flat')
    expect(ff.length).toBe(1)                            // the missing-evidence condition is surfaced
  })
})
