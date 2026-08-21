import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { sizePosition, entryLimitPrice, exitLimitPrice } from '@/lib/execution/sizing'
import { canOpenPosition, realizedPnlToday, openRisk } from '@/lib/execution/risk'
import { decideExit, slippagePct, PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { newPaperTrade, computeRealized } from '@/lib/execution/types'
import type {
  Broker, BrokerOrder, BrokerFill, PaperTrade, LimitOrderRequest, StopOrderRequest,
} from '@/lib/execution/types'
import { mapStatus, roundToTick, AlpacaBroker } from '@/lib/execution/alpaca'
import type { BuySignalRecord } from '@/types'

// The store writes to $HOME; keep tests off the real filesystem.
vi.mock('@/lib/execution/store', () => ({
  loadTrades: () => [],
  saveTrades: () => {},
  appendEvent: () => {},
  isHalted: () => false,
  haltFile: () => '/tmp/.companion-halt',
  etDayKey: () => '2026-08-07',
  tradesFile: () => '/tmp/trades.json',
  eventsFile: () => '/tmp/events.jsonl',
}))

// 10:00 ET on Friday 2026-08-07 — regular hours, so protective stops are in play.
const REGULAR_HOURS = new Date('2026-08-07T14:00:00Z').getTime()

function signal(overrides: Partial<BuySignalRecord> = {}): BuySignalRecord {
  return {
    id: 'sig-1', setupId: 'setup-1', symbol: 'TEST', timestamp: REGULAR_HOURS,
    setupType: 'premarket_breakout', triggerPrice: 10, entryLow: 9.9, entryHigh: 10,
    invalidation: 9.5, stop: 9.5, targets: [11, 12], score: 70, grade: 'strong',
    rewardRisk: 2, priceAtSignal: 10, ...overrides,
  } as BuySignalRecord
}

function trade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return { ...newPaperTrade(signal(), 100, 10.05, REGULAR_HOURS), ...overrides }
}

// ── Sizing ───────────────────────────────────────────────────────────────────

describe('sizePosition', () => {
  const base = { equity: 100_000, buyingPower: 200_000, entry: 10, stop: 9.5 }

  it('sizes off the risk budget and the stop distance', () => {
    // 0.5% of 100k = $500 risk; $0.50 stop distance → 1000 shares.
    const r = sizePosition(base)
    expect(r.qty).toBe(1000)
    expect(r.plannedRisk).toBeCloseTo(500)
    expect(r.boundBy).toBe('risk')
  })

  it('caps notional so a tight stop cannot imply an absurd position', () => {
    // A 1c stop would ask for 50,000 shares; 20% of equity at $10 allows 2,000.
    const r = sizePosition({ ...base, stop: 9.99 })
    expect(r.qty).toBe(2000)
    expect(r.boundBy).toBe('notional')
  })

  it('caps participation against session volume', () => {
    const r = sizePosition({ ...base, sessionVolume: 50_000 })
    expect(r.qty).toBe(500)          // 1% of 50k
    expect(r.boundBy).toBe('participation')
  })

  it('respects buying power', () => {
    const r = sizePosition({ ...base, buyingPower: 3_000 })
    expect(r.qty).toBe(300)
    expect(r.boundBy).toBe('buying_power')
  })

  it('refuses a stop that is not below the entry', () => {
    expect(sizePosition({ ...base, stop: 10.5 }).qty).toBe(0)
    expect(sizePosition({ ...base, stop: 10 }).reason).toMatch(/not below/)
  })

  it('refuses an absurdly wide stop rather than sizing down to noise', () => {
    const r = sizePosition({ ...base, stop: 8 })   // 20% away, limit is 15%
    expect(r.qty).toBe(0)
    expect(r.reason).toMatch(/exceeds max/)
  })

  it('refuses when the risk budget cannot buy a single share', () => {
    const r = sizePosition({ equity: 1_000, buyingPower: 1_000, entry: 100, stop: 90 })
    expect(r.qty).toBe(0)
  })
})

describe('limit prices', () => {
  it('caps what an entry will pay above the signal level', () => {
    expect(entryLimitPrice(10, 0.5)).toBeCloseTo(10.05)
  })
  it('caps what an exit will give up below the trigger', () => {
    expect(exitLimitPrice(10, 0.5)).toBeCloseTo(9.95)
  })
})

// ── Risk governor ────────────────────────────────────────────────────────────

describe('canOpenPosition', () => {
  const state = {
    equity: 100_000, startingEquity: 100_000, brokerBlocked: false,
    openTrades: [] as PaperTrade[], closedToday: [] as PaperTrade[], halted: false,
    session: 'regular' as const,
  }

  it('allows a first position inside every limit', () => {
    expect(canOpenPosition('TEST', 500, state).allowed).toBe(true)
  })

  it('treats the kill switch as terminal', () => {
    const d = canOpenPosition('TEST', 500, { ...state, halted: true })
    expect(d).toMatchObject({ allowed: false, terminal: true })
  })

  it('treats the daily loss limit as terminal', () => {
    const closed = [trade({ state: 'closed', realizedPnl: -2_100 })]
    const d = canOpenPosition('TEST', 500, { ...state, closedToday: closed })
    expect(d).toMatchObject({ allowed: false, terminal: true })
    if (!d.allowed) expect(d.reason).toMatch(/daily loss limit/)
  })

  it('blocks the concurrency limit without ending the day', () => {
    const open = [trade({ symbol: 'A' }), trade({ symbol: 'B' }), trade({ symbol: 'C' })]
    const d = canOpenPosition('TEST', 500, { ...state, openTrades: open })
    expect(d).toMatchObject({ allowed: false, terminal: false })
  })

  it('refuses to pyramid into a symbol already held', () => {
    const d = canOpenPosition('TEST', 500, { ...state, openTrades: [trade({ symbol: 'TEST' })] })
    expect(d).toMatchObject({ allowed: false, terminal: false })
    if (!d.allowed) expect(d.reason).toMatch(/already holding/)
  })

  it('caps total open risk across positions', () => {
    const open = [trade({ symbol: 'A', plannedRisk: 1_400 })]
    // 1400 + 500 = 1900 > 1.5% of 100k
    const d = canOpenPosition('TEST', 500, { ...state, openTrades: open })
    expect(d.allowed).toBe(false)
  })

  // ── Premarket sub-budget ───────────────────────────────────────────────────
  // On 2026-08-10 all nine fills were premarket and the DAY limit tripped at 09:21,
  // nine minutes before the open, locking out the session the replay says pays ~8x
  // more per trade. Premarket now gets its own slice.

  it('stands premarket down at its own budget, WITHOUT ending the day', () => {
    // -$600 premarket: past the 0.5% premarket budget, nowhere near the 2% day one.
    const closed = [trade({ state: 'closed', realizedPnl: -600, entrySession: 'premarket' })]
    const d = canOpenPosition('TEST', 500, { ...state, session: 'premarket', closedToday: closed })
    expect(d).toMatchObject({ allowed: false, terminal: false })
    if (!d.allowed) expect(d.reason).toMatch(/premarket loss budget/)
  })

  it('still allows the SAME loss to trade at the open — the whole point', () => {
    const closed = [trade({ state: 'closed', realizedPnl: -600, entrySession: 'premarket' })]
    expect(canOpenPosition('TEST', 500, { ...state, session: 'regular', closedToday: closed }).allowed).toBe(true)
  })

  it('counts only premarket-entered trades against the premarket budget', () => {
    // A regular-hours loss must not stand premarket down the next morning.
    const closed = [trade({ state: 'closed', realizedPnl: -900, entrySession: 'regular' })]
    expect(canOpenPosition('TEST', 500, { ...state, session: 'premarket', closedToday: closed }).allowed).toBe(true)
  })

  it('caps premarket trade COUNT so it cannot spend the day on volume alone', () => {
    const open = [
      trade({ symbol: 'A', entrySession: 'premarket', plannedRisk: 1 }),
      trade({ symbol: 'B', entrySession: 'premarket', plannedRisk: 1 }),
      trade({ symbol: 'C', entrySession: 'premarket', plannedRisk: 1 }),
    ]
    const d = canOpenPosition('TEST', 1, { ...state, session: 'premarket', openTrades: [], closedToday: open })
    expect(d).toMatchObject({ allowed: false, terminal: false })
    if (!d.allowed) expect(d.reason).toMatch(/max premarket trades/)
  })

  it('keeps the day limit terminal even when premarket caused it', () => {
    const closed = [trade({ state: 'closed', realizedPnl: -2_100, entrySession: 'premarket' })]
    const d = canOpenPosition('TEST', 500, { ...state, session: 'regular', closedToday: closed })
    expect(d).toMatchObject({ allowed: false, terminal: true })
  })

  it('sums realized P&L and open risk', () => {
    expect(realizedPnlToday([trade({ realizedPnl: 100 }), trade({ realizedPnl: -40 })])).toBe(60)
    expect(openRisk([trade({ plannedRisk: 200 }), trade({ plannedRisk: 300 })])).toBe(500)
  })
})

// ── Exit ladder ──────────────────────────────────────────────────────────────

describe('decideExit', () => {
  const open = () => trade({ state: 'open', openQty: 100, entryFillQty: 100, entryFillPrice: 10 })

  it('does nothing between the stop and the first target', () => {
    expect(decideExit(open(), 10.5, 600, 955)).toBeNull()
  })

  it('books half at T1', () => {
    expect(decideExit(open(), 11.0, 600, 955)).toEqual({ reason: 't1', qty: 50, intendedPrice: 11 })
  })

  it('exits everything on the stop', () => {
    expect(decideExit(open(), 9.4, 600, 955)).toEqual({ reason: 'stop', qty: 100, intendedPrice: 9.5 })
  })

  it('checks the stop before any target', () => {
    // A polled scalar price can only sit on one side of a sane ladder, so this
    // ordering bites only when the stop has been dragged above a target. It still
    // has to match eod-resolver's adverse-first rule, where a single BAR really
    // can span both and crediting the target would invent a win.
    const t = trade({ state: 'open', openQty: 100, entryFillQty: 100, currentStop: 11.5 })
    expect(decideExit(t, 11.4, 600, 955)?.reason).toBe('stop')
  })

  it('holds the remainder for T2 once T1 has booked', () => {
    const t = trade({ state: 'open', openQty: 50, entryFillQty: 100, t1Done: true, currentStop: 10 })
    expect(decideExit(t, 11.5, 600, 955)).toBeNull()
    expect(decideExit(t, 12.0, 600, 955)).toEqual({ reason: 't2', qty: 50, intendedPrice: 12 })
  })

  it('flattens at the end-of-day cutoff', () => {
    const d = decideExit(open(), 10.5, 955, 955)
    expect(d?.reason).toBe('time')
    expect(d?.qty).toBe(100)
  })

  it('exits a one-share position whole at T1 rather than skipping the leg', () => {
    const t = trade({ state: 'open', openQty: 1, entryFillQty: 1 })
    expect(decideExit(t, 11, 600, 955)).toMatchObject({ reason: 't1', qty: 1 })
  })

  it('ignores trades that are not open', () => {
    expect(decideExit(trade({ state: 'pending_entry' }), 9, 600, 955)).toBeNull()
  })
})

describe('slippagePct', () => {
  it('is positive when a buy pays up', () => {
    expect(slippagePct(10, 10.05)).toBeCloseTo(0.5)
  })
  it('is negative when a sell gives up', () => {
    expect(slippagePct(10, 9.95)).toBeCloseTo(-0.5)
  })
})

// ── Alpaca adapter ───────────────────────────────────────────────────────────

describe('AlpacaBroker', () => {
  it('collapses the status vocabulary to actionable outcomes', () => {
    expect(mapStatus('pending_new')).toBe('open')
    expect(mapStatus('filled')).toBe('filled')
    expect(mapStatus('done_for_day')).toBe('expired')
    expect(mapStatus('rejected')).toBe('rejected')
    expect(mapStatus('something_new_alpaca_added')).toBe('unknown')
  })

  it('rounds to a tick the exchange will accept', () => {
    expect(roundToTick(10.123456)).toBe(10.12)
    expect(roundToTick(0.123456)).toBe(0.1235)
  })

  it('refuses to point at the live trading endpoint', () => {
    expect(() => new AlpacaBroker({
      keyId: 'k', secretKey: 's', baseUrl: 'https://api.alpaca.markets',
    })).toThrow(/paper only/)
  })

  it('accepts the paper endpoint', () => {
    expect(() => new AlpacaBroker({
      keyId: 'k', secretKey: 's', baseUrl: 'https://paper-api.alpaca.markets',
    })).not.toThrow()
  })
})

// ── Executor lifecycle ───────────────────────────────────────────────────────

/** In-memory broker: fills whatever is asked, at the limit price, on the next poll. */
class FakeBroker implements Broker {
  readonly name = 'fake'
  equity = 100_000
  tradable = true
  orders = new Map<string, BrokerOrder>()
  submitted: Array<LimitOrderRequest | StopOrderRequest> = []
  canceled: string[] = []
  /** Orders whose id is in here stay open instead of filling. */
  neverFill = new Set<string>()
  /** Same, by predicate — for orders the executor submits without telling the test their id. */
  holdOrder: (o: BrokerOrder) => boolean = () => false
  /** Override how the NEXT buy order fills (favorable/partial price+qty) — models a fill
   *  that lands better than the limit, e.g. below the stop. Applied to buy orders only. */
  buyFill: { price?: number; qty?: number; status?: BrokerOrder['status'] } | null = null
  /** symbol → shares held, moved by fills. */
  held = new Map<string, number>()
  /** Broker-side fill ledger — what getRecentFills reads, incl. external sells. */
  fills: BrokerFill[] = []
  rejected: Array<{ qty: number; available: number }> = []
  /** When set, the NEXT sell/stop rejects with this exact message (one-shot). Models
   *  Alpaca's "cannot be sold short" / "stop price must be less than current price". */
  rejectNextSellWith: string | null = null
  private seq = 0

  async getAccount() {
    return { equity: this.equity, cash: this.equity, buyingPower: this.equity * 2, daytradeCount: 0, blocked: false }
  }
  async getAsset(symbol: string) {
    return this.tradable
      ? { symbol, tradable: true, fractionable: false, shortable: true, exchange: 'NASDAQ' }
      : null
  }
  async getPositions() {
    return [...this.held.entries()].filter(([, q]) => q > 0).map(([symbol, qty]) => ({
      symbol, qty, qtyAvailable: this.availableQty(symbol),
      avgEntryPrice: 0, currentPrice: null, unrealizedPl: 0,
    }))
  }
  async getPosition(symbol: string) {
    const qty = this.held.get(symbol) ?? 0
    if (qty <= 0) return null
    return { symbol, qty, qtyAvailable: this.availableQty(symbol), avgEntryPrice: 0, currentPrice: null, unrealizedPl: 0 }
  }

  /**
   * Shares a resting sell order has reserved. This is the real Alpaca
   * constraint the executor has to size against — modelling it is the only way
   * this suite can catch an oversized stop.
   */
  private availableQty(symbol: string): number {
    let held = 0
    for (const o of this.orders.values()) {
      if (o.symbol === symbol && o.side === 'sell' && o.status === 'open') held += o.qty
    }
    return (this.held.get(symbol) ?? 0) - held
  }

  /** Mirrors Alpaca's 40310000 reject for a sell bigger than the free share count. */
  private rejectSell(
    symbol: string, qty: number, clientOrderId: string, limitPrice: number | null,
  ): BrokerOrder | null {
    const available = this.availableQty(symbol)
    if (qty <= available) return null
    this.rejected.push({ qty, available })
    return {
      id: '', clientOrderId, symbol, side: 'sell', status: 'rejected',
      qty, filledQty: 0, filledAvgPrice: limitPrice, limitPrice,
      submittedAt: Date.now(),
      rejectReason: `{"available":"${available}","code":40310000,"message":"insufficient qty available for order (requested: ${qty}, available: ${available})","symbol":"${symbol}"}`,
    }
  }

  /** One-shot custom rejection, e.g. "cannot be sold short". Consumed on use. */
  private customReject(symbol: string, qty: number, clientOrderId: string, limitPrice: number | null): BrokerOrder | null {
    if (this.rejectNextSellWith == null) return null
    const rejectReason = this.rejectNextSellWith
    this.rejectNextSellWith = null
    return {
      id: '', clientOrderId, symbol, side: 'sell', status: 'rejected',
      qty, filledQty: 0, filledAvgPrice: limitPrice, limitPrice, submittedAt: Date.now(), rejectReason,
    }
  }

  async submitLimit(req: LimitOrderRequest): Promise<BrokerOrder> {
    this.submitted.push(req)
    if (req.side === 'sell') {
      const custom = this.customReject(req.symbol, req.qty, req.clientOrderId, req.limitPrice)
      if (custom) return custom
      const reject = this.rejectSell(req.symbol, req.qty, req.clientOrderId, req.limitPrice)
      if (reject) return reject
    }
    const id = `o${++this.seq}`
    const order: BrokerOrder = {
      id, clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side,
      status: 'open', qty: req.qty, filledQty: 0, filledAvgPrice: null,
      limitPrice: req.limitPrice, submittedAt: Date.now(), rejectReason: null,
    }
    this.orders.set(id, order)
    return order
  }

  async submitStop(req: StopOrderRequest): Promise<BrokerOrder> {
    this.submitted.push(req)
    const custom = this.customReject(req.symbol, req.qty, req.clientOrderId, null)
    if (custom) return custom
    const reject = this.rejectSell(req.symbol, req.qty, req.clientOrderId, null)
    if (reject) return reject
    const id = `o${++this.seq}`
    const order: BrokerOrder = {
      id, clientOrderId: req.clientOrderId, symbol: req.symbol, side: 'sell',
      status: 'open', qty: req.qty, filledQty: 0, filledAvgPrice: null,
      limitPrice: null, submittedAt: Date.now(), rejectReason: null,
    }
    this.orders.set(id, order)
    this.neverFill.add(id)   // a resting stop only fills if the test says so
    return order
  }

  async getOrder(id: string): Promise<BrokerOrder | null> {
    const o = this.orders.get(id)
    if (!o) return null
    if (o.status === 'open' && !this.neverFill.has(id) && !this.holdOrder(o)) {
      if (o.side === 'buy' && this.buyFill) {
        const fq = this.buyFill.qty ?? o.qty
        o.filledQty = fq
        o.filledAvgPrice = this.buyFill.price ?? o.limitPrice
        o.status = this.buyFill.status ?? (fq >= o.qty ? 'filled' : 'canceled')
        this.held.set(o.symbol, (this.held.get(o.symbol) ?? 0) + fq)
        this.fills.push({ symbol: o.symbol, side: 'buy', qty: fq, price: o.filledAvgPrice ?? 0, filledAt: Date.now(), orderId: o.id })
        return o
      }
      o.status = 'filled'
      o.filledQty = o.qty
      o.filledAvgPrice = o.limitPrice
      const before = this.held.get(o.symbol) ?? 0
      this.held.set(o.symbol, before + (o.side === 'buy' ? o.filledQty : -o.filledQty))
      this.fills.push({ symbol: o.symbol, side: o.side, qty: o.filledQty, price: o.filledAvgPrice ?? 0, filledAt: Date.now(), orderId: o.id })
    }
    return o
  }

  /** Model an order the daemon never placed (dashboard flatten / broker liquidation):
   *  it moves broker shares and lands in the fill ledger with a foreign order id. */
  injectExternalSell(symbol: string, qty: number, price: number) {
    this.held.set(symbol, (this.held.get(symbol) ?? 0) - qty)
    this.fills.push({ symbol, side: 'sell', qty, price, filledAt: Date.now(), orderId: 'external-1' })
  }

  async getRecentFills(symbol: string, sinceMs: number): Promise<BrokerFill[]> {
    return this.fills.filter(f => f.symbol === symbol && f.filledAt >= sinceMs)
  }

  async cancelOrder(id: string) {
    this.canceled.push(id)
    const o = this.orders.get(id)
    if (o && o.status === 'open') o.status = 'canceled'
  }

  async cancelOpenOrders(symbol: string) {
    let n = 0
    for (const o of this.orders.values()) {
      if (o.symbol === symbol && o.status === 'open') { await this.cancelOrder(o.id); n++ }
    }
    return n
  }
}

describe('PaperExecutor', () => {
  let broker: FakeBroker
  let price: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR },
    () => {},
  )

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    broker = new FakeBroker()
    price = 10
  })
  afterEach(() => { vi.useRealTimers() })

  it('runs a signal through the full scale-out ladder', async () => {
    const ex = build()
    await ex.init()

    const res = await ex.onSignal(signal(), { sessionVolume: 10_000_000 })
    expect(res.taken).toBe(true)

    const t = () => ex.allTrades()[0]
    expect(t().state).toBe('pending_entry')
    expect(t().qty).toBe(1000)                       // $500 risk / $0.50 stop

    // Entry fills at the limit — 0.5% worse than the signal's assumed 10.00.
    await ex.tick()
    expect(t().state).toBe('open')
    expect(t().entryFillPrice).toBeCloseTo(10.05)
    expect(t().entrySlippagePct).toBeCloseTo(0.5)
    expect(t().openQty).toBe(1000)

    // T1: half out, stop to breakeven.
    price = 11.2
    await ex.tick()
    expect(t().t1Done).toBe(true)
    expect(t().openQty).toBe(500)
    expect(t().currentStop).toBeCloseTo(10.05)

    // T2: the remainder.
    price = 12.3
    await ex.tick()
    expect(t().state).toBe('closed')
    expect(t().openQty).toBe(0)
    expect(t().exits.map(l => l.reason)).toEqual(['t1', 't2'])
    expect(t().realizedPnl).toBeGreaterThan(0)
    expect(t().fullyClosed).toBe(true)
  })

  // ── Post-fill stop inversion — fail closed (ADXN 2026-08-21) ────────────────
  describe('post-fill stop inversion', () => {
    it('long fill BELOW stop: detected, flattened, never a zero-risk open position', async () => {
      broker.buyFill = { price: 9.4 }   // fills below the 9.5 stop
      price = 9.4
      const ex = build()
      await ex.init()
      await ex.onSignal(signal(), { sessionVolume: 10_000_000 })
      await ex.tick()
      const t = ex.allTrades()[0]
      expect(t.state).toBe('closed')                                   // not a normal open position
      expect(t.executionWarnings.some(w => w.startsWith('INVALID_POST_FILL_GEOMETRY'))).toBe(true)
      expect(t.plannedRisk).toBeLessThan(0)                            // REAL negative risk, never clamped to 0
      expect(t.plannedRisk).not.toBe(0)
      expect(t.exits.some(l => l.reason === 'invalid_geometry')).toBe(true)  // filled qty flattened
      expect(broker.submitted.some(o => 'stopPrice' in o)).toBe(false)       // no protective stop placed
      expect(broker.held.get('TEST') ?? 0).toBe(0)                    // shares unwound
    })

    it('long fill EXACTLY at stop: same fail-closed behaviour', async () => {
      broker.buyFill = { price: 9.5 }   // exactly the stop → riskPerShare 0, not > 0
      price = 9.5
      const ex = build()
      await ex.init()
      await ex.onSignal(signal(), { sessionVolume: 10_000_000 })
      await ex.tick()
      const t = ex.allTrades()[0]
      expect(t.state).toBe('closed')
      expect(t.executionWarnings.some(w => w.startsWith('INVALID_POST_FILL_GEOMETRY'))).toBe(true)
      expect(t.exits.some(l => l.reason === 'invalid_geometry')).toBe(true)
      expect(t.plannedRisk).toBeLessThanOrEqual(0)
    })

    it('PARTIAL fill through stop: only filled qty flattened, remainder cancelled, idempotent', async () => {
      broker.buyFill = { price: 9.4, qty: 700, status: 'canceled' }   // 700/1000 filled below stop, remainder unfilled
      price = 9.4
      const ex = build()
      await ex.init()
      await ex.onSignal(signal(), { sessionVolume: 10_000_000 })
      await ex.tick()
      const t = ex.allTrades()[0]
      expect(t.entryFillQty).toBe(700)                                 // only the 700 that filled
      expect(broker.canceled.length).toBeGreaterThan(0)               // remainder cancelled
      const invalidLegs = t.exits.filter(l => l.reason === 'invalid_geometry')
      expect(invalidLegs).toHaveLength(1)                             // exactly one flatten, for the 700
      expect(invalidLegs[0].qty).toBe(700)
      expect(t.state).toBe('closed')
      expect(broker.held.get('TEST') ?? 0).toBe(0)
      // Idempotent: a repeat tick must not submit a second flatten or reopen anything.
      const sellsBefore = broker.submitted.filter(o => (o as LimitOrderRequest).side === 'sell').length
      await ex.tick()
      const sellsAfter = broker.submitted.filter(o => (o as LimitOrderRequest).side === 'sell').length
      expect(sellsAfter).toBe(sellsBefore)
      expect(t.exits.filter(l => l.reason === 'invalid_geometry')).toHaveLength(1)
    })

    it('WORSE-but-valid fill above stop: recomputes larger positive risk, normal lifecycle', async () => {
      broker.buyFill = { price: 10.2 }   // worse than intended 10, still above 9.5 stop
      price = 10.2
      const ex = build()
      await ex.init()
      await ex.onSignal(signal(), { sessionVolume: 10_000_000 })
      await ex.tick()
      const t = ex.allTrades()[0]
      expect(t.state).toBe('open')
      expect(t.executionWarnings.some(w => w.startsWith('INVALID_POST_FILL_GEOMETRY'))).toBe(false)
      expect(t.plannedRisk).toBeCloseTo(1000 * (10.2 - 9.5), 5)       // more dollars at risk — existing behaviour
      expect(t.exits.some(l => l.reason === 'invalid_geometry')).toBe(false)
    })

    it('FAVORABLE-but-valid fill above stop: smaller positive risk, normal lifecycle', async () => {
      broker.buyFill = { price: 9.7 }    // better than intended 10, still above 9.5 stop
      price = 9.7
      const ex = build()
      await ex.init()
      await ex.onSignal(signal(), { sessionVolume: 10_000_000 })
      await ex.tick()
      const t = ex.allTrades()[0]
      expect(t.state).toBe('open')
      expect(t.plannedRisk).toBeCloseTo(1000 * (9.7 - 9.5), 5)        // smaller but positive
      expect(t.plannedRisk).toBeGreaterThan(0)
      expect(t.exits.some(l => l.reason === 'invalid_geometry')).toBe(false)
    })

    it('backstop: an open trade with non-positive planned risk fails canOpenPosition closed', () => {
      const bad = trade({ symbol: 'TEST', state: 'open', plannedRisk: -50 })
      const s = {
        equity: 100_000, startingEquity: 100_000, brokerBlocked: false,
        openTrades: [bad] as PaperTrade[], closedToday: [] as PaperTrade[], halted: false,
        session: 'regular' as const,
      }
      const d = canOpenPosition('OTHER', 500, s)
      expect(d.allowed).toBe(false)
      if (!d.allowed) expect(d.reason).toMatch(/invalid open-position risk/i)
    })
  })

  it('places a protective stop while a position is open in regular hours', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    await ex.tick()          // fills the entry
    await ex.tick()          // nothing triggers → protective stop goes on
    const stops = broker.submitted.filter(o => 'stopPrice' in o)
    expect(stops).toHaveLength(1)
    expect((stops[0] as StopOrderRequest).stopPrice).toBeCloseTo(9.5)
    expect(ex.allTrades()[0].protectiveStopOrderId).toBeTruthy()
  })

  // Regression: 2026-08-07 paper session. Price tagged T1, the limit rested
  // unfilled, price fell back — and the stop was then sized to the whole
  // position, half of which the broker had already reserved. Alpaca rejected
  // every attempt, so the position ran naked until the daemon's own poll caught it.
  it('sizes the protective stop to shares a resting exit has not reserved', async () => {
    broker.holdOrder = o => o.clientOrderId?.includes(':x:t1') ?? false
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    await ex.tick()                       // entry fills: 1000 shares
    await ex.tick()                       // protective stop on the full 1000

    price = 11.2                          // tags T1 — limit for 500 goes out, rests
    await ex.tick()
    const t = ex.allTrades()[0]
    expect(t.openQty).toBe(1000)          // nothing sold yet
    expect(t.exits.filter(l => l.reason === 't1' && l.orderId)).toHaveLength(1)

    price = 10.5                          // falls back between stop and T1
    await ex.tick()

    const stops = broker.submitted.filter(o => 'stopPrice' in o) as StopOrderRequest[]
    expect(stops[stops.length - 1].qty).toBe(500)   // the unreserved half, not 1000
    expect(broker.rejected).toEqual([])
    expect(ex.allTrades()[0].protectiveStopOrderId).toBeTruthy()
  })

  it('does not place a stop when every open share is already working an exit', async () => {
    broker.holdOrder = o => o.clientOrderId?.includes(':x:') ?? false
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    await ex.tick()
    price = 9.2                           // stop breaks — full-size exit rests unfilled
    await ex.tick()
    const before = broker.submitted.filter(o => 'stopPrice' in o).length

    price = 9.6                           // back above the stop, exit still resting
    await ex.tick()

    expect(broker.submitted.filter(o => 'stopPrice' in o)).toHaveLength(before)
    expect(broker.rejected).toEqual([])
  })

  it('cancels resting orders before selling, so it cannot double-sell', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    await ex.tick()
    await ex.tick()                       // protective stop resting
    const stopId = ex.allTrades()[0].protectiveStopOrderId
    price = 9.2                           // stop breaks
    await ex.tick()
    expect(broker.canceled).toContain(stopId)
    expect(ex.allTrades()[0].state).toBe('closed')
    expect(ex.allTrades()[0].exits[0].reason).toBe('stop')
  })

  it('abandons an entry that never fills instead of chasing', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    const orderId = ex.allTrades()[0].entryOrderId!
    broker.neverFill.add(orderId)

    await ex.tick()
    expect(ex.allTrades()[0].state).toBe('pending_entry')

    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()
    expect(ex.allTrades()[0].state).toBe('aborted')
    expect(broker.canceled).toContain(orderId)
  })

  it('will not trade the same setup twice', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    const second = await ex.onSignal(signal({ id: 'sig-2' }))
    expect(second.taken).toBe(false)
    expect(second.reason).toMatch(/already traded/)
    expect(ex.allTrades()).toHaveLength(1)
  })

  it('skips symbols the broker will not trade', async () => {
    broker.tradable = false
    const ex = build()
    await ex.init()
    const res = await ex.onSignal(signal())
    expect(res.taken).toBe(false)
    expect(res.reason).toMatch(/not tradable/)
  })

  it('flattens open positions on shutdown', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    await ex.tick()
    expect(ex.allTrades()[0].openQty).toBe(1000)

    await ex.flattenAll('risk_halt')
    expect(ex.allTrades()[0].state).toBe('closed')
    expect(ex.allTrades()[0].exits[0].reason).toBe('risk_halt')
  })

  it('records the decision price so exit slippage splits into gap vs concession', async () => {
    // The whole point: on 2026-08-10 AUUD's −2.84% exit had to be reverse-engineered
    // by hand into −2.35% latency + −0.50% tolerance. It must fall out of the record.
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    await ex.tick()                    // entry fills
    price = 9.0                        // gaps well below the 9.50 stop before we look
    await ex.tick()

    const leg = ex.allTrades()[0].exits[0]
    expect(leg.reason).toBe('stop')
    expect(leg.decisionPrice).toBe(9.0)
    expect(leg.intendedPrice).toBeCloseTo(9.5)
    // gap = observed vs the level we aimed at; concession = fill vs observed.
    const gap = ((leg.decisionPrice! - leg.intendedPrice) / leg.intendedPrice) * 100
    const concession = ((leg.fillPrice! - leg.decisionPrice!) / leg.decisionPrice!) * 100
    expect(gap).toBeCloseTo(-5.26, 1)
    expect(concession).toBeCloseTo(-0.5, 1)
    expect(ex.summary()).toMatch(/market gap -5\.26% \(latency\)/)
    expect(ex.summary()).toMatch(/concession -0\.50% \(limit tolerance\)/)
  })

  it('reports slippage in the session summary', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal())
    await ex.tick()
    expect(ex.summary()).toMatch(/mean entry slip \+0\.50%/)
  })

  // ── Monday 2026-08-17 regression fixture ─────────────────────────────────────
  // Real broker sequences from the first profitable live session, each a failure
  // mode the reconciliation ledger must now handle. Names match the live trades.

  it('TEST A — STFS fast move: clean scale-out reaches VERIFIED', async () => {
    // A winner that runs through both targets must close and reconcile to verified.
    const ex = build()
    await ex.init()
    await ex.onSignal(signal({ symbol: 'STFS' }))
    await ex.tick()                       // entry fills
    price = 11.2; await ex.tick()         // T1
    price = 12.3; await ex.tick()         // T2 → closed
    const t = ex.allTrades()[0]
    expect(t.state).toBe('closed')
    expect(t.reconciliationStatus).toBe('verified')
    expect(t.brokerVerifiedQty).toBe(0)
    expect(t.executionWarnings).toEqual([])
  })

  it('TEST B — CAPR normal stop: reconciles local position to zero, verified', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal({ symbol: 'CAPR' }))
    await ex.tick()
    price = 9.0; await ex.tick()          // stop breaks → marketable-limit exit
    const t = ex.allTrades()[0]
    expect(t.state).toBe('closed')
    expect(t.openQty).toBe(0)
    expect(t.reconciliationStatus).toBe('verified')
  })

  it('TEST C — FIGR stale stop: external close is detected, no new sell, verified flat', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal({ symbol: 'FIGR' }))
    await ex.tick()                       // entry fills; broker.held FIGR = qty
    const t = ex.allTrades()[0]
    expect(t.state).toBe('open')
    const qtyHeld = t.openQty

    // An EXTERNAL order flattens the position — the broker is now flat, but the
    // executor never saw a Companion fill (this is the exact FIGR bug).
    broker.held.set('FIGR', 0)
    const sellsBefore = broker.submitted.filter(o => 'side' in o && (o as LimitOrderRequest).side === 'sell').length

    price = 34.4; await ex.tick()         // next management tick

    expect(t.state).toBe('closed')
    expect(t.openQty).toBe(0)
    expect(qtyHeld).toBeGreaterThan(0)
    // No NEW sell was submitted against the already-flat position (no stale short).
    const sellsAfter = broker.submitted.filter(o => 'side' in o && (o as LimitOrderRequest).side === 'sell').length
    expect(sellsAfter).toBe(sellsBefore)
    // Closed on broker truth we can't price → quarantined from learning.
    expect(t.reconciliationStatus).toBe('manual_review')
    expect(t.executionWarnings.join(' ')).toMatch(/external order/)
    expect(ex.verifiedClosedTrades()).not.toContain(t)
  })

  it('TEST C2 — external close is PRICED from broker fills (P&L reconciles, still manual_review)', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal({ symbol: 'EL' }))
    await ex.tick()                       // entry fills at 10.05; broker.held EL = qty
    const t = ex.allTrades()[0]
    const qtyHeld = t.openQty
    expect(t.state).toBe('open')
    expect(t.entryFillPrice).toBeCloseTo(10.05)

    // An external order (dashboard flatten) sells the whole position at 11.00 —
    // ABOVE our entry, so this trade was actually a WINNER the naive path booked as $0.
    broker.injectExternalSell('EL', qtyHeld, 11.00)

    price = 11.0; await ex.tick()         // reconcile sees broker flat, prices the close

    expect(t.state).toBe('closed')
    expect(t.openQty).toBe(0)
    // P&L is now reconstructed from the broker's own fill, not lost as null.
    expect(t.realizedPnl).toBeCloseTo((11.00 - 10.05) * qtyHeld)
    expect(t.realizedPnl!).toBeGreaterThan(0)
    expect(t.exits.some(l => l.reason === 'external')).toBe(true)
    // Still quarantined from learning — pricing it doesn't make it a trusted W/L.
    expect(t.reconciliationStatus).toBe('manual_review')
    expect(ex.verifiedClosedTrades()).not.toContain(t)
  })

  it('TEST D — rejected protective stop reconciles instead of looping the impossible order', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(signal({ symbol: 'WOK' }))
    // The FIRST protective-stop placement (same tick as the entry fill) is rejected:
    // price already through the stop. The buy is unaffected; only the sell rejects.
    broker.rejectNextSellWith = 'stop price must be less than current price'
    await ex.tick()                       // entry fills → stop attempt → rejected → reconcile

    const t = ex.allTrades()[0]
    // Still long (reconcile confirmed the broker still holds it), no protective stop set,
    // and it did not keep the impossible order.
    expect(t.state).toBe('open')
    expect(t.protectiveStopOrderId).toBeNull()
    expect(t.brokerVerifiedQty).toBe(t.openQty)
    // A real stop break on the next tick exits via a marketable limit (the WOK path).
    price = 9.0; await ex.tick()
    expect(t.state).toBe('closed')
    expect(t.reconciliationStatus).toBe('verified')
  })

  it('TEST E — partial fill: broker qty overrides the assumed remainder', async () => {
    // CAPR case — a stop fills partially, local believes the remainder is open, but
    // the broker is already flat. reconcile must adopt broker truth, not local.
    const ex = build()
    await ex.init()
    await ex.onSignal(signal({ symbol: 'CAPR' }))
    await ex.tick()
    const t = ex.allTrades()[0]

    // Simulate: our record still shows shares open, but the broker filled the rest
    // externally/behind our polling and is now flat.
    broker.held.set('CAPR', 0)
    price = 11.0; await ex.tick()         // T1 territory, but reconcile runs first

    expect(t.openQty).toBe(0)
    expect(t.brokerVerifiedQty).toBe(0)
    expect(t.state).toBe('closed')
  })
})

describe('computeRealized', () => {
  it('books P&L against the actual entry fill, not the intended one', () => {
    const t = trade({
      entryFillPrice: 10.05, entryFillQty: 100,
      exits: [
        { qty: 50, reason: 't1', intendedPrice: 11, decisionPrice: 11, orderId: 'a', fillPrice: 11, filledAt: 1, slippagePct: 0 },
        { qty: 50, reason: 't2', intendedPrice: 12, decisionPrice: 12, orderId: 'b', fillPrice: 12, filledAt: 2, slippagePct: 0 },
      ],
    })
    const r = computeRealized(t)!
    expect(r.pnl).toBeCloseTo(50 * 0.95 + 50 * 1.95)
    expect(r.pnlPct).toBeCloseTo((r.pnl / (10.05 * 100)) * 100)
  })

  it('is null before anything fills', () => {
    expect(computeRealized(trade())).toBeNull()
  })
})
