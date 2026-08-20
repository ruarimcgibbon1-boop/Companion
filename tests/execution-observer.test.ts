import { describe, it, expect } from 'vitest'
import { ExecutionObserver } from '@/lib/execution/market-observer'
import type { MarketDataSource, MarketQuote, MarketTrade, ExecutionQualityObservation, ObserveContext, FetchOpts } from '@/lib/execution/market-observer'
import { ObserverLoop } from '@/lib/execution/observer-loop'
import { deriveLatencies, effectivePollingCadence, type ExecutionExitRecord, type ExecutionQualityRow } from '@/lib/execution/execution-quality'

class FakeFeed implements MarketDataSource {
  readonly name = 'fake-iex'
  readonly consolidated = false
  quote: MarketQuote | null = null
  trade: MarketTrade | null = null
  throwQuote = false
  throwTrade = false
  hang = false
  active = 0
  maxConcurrent = 0
  private releasers: Array<(v: unknown) => void> = []
  releaseHang() { this.releasers.forEach(r => r(null)); this.releasers = [] }

  private track<T>(make: () => T | null, opts?: FetchOpts): Promise<T | null> {
    // Honor an ALREADY-aborted signal (addEventListener would never fire for it).
    if (opts?.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'))
    this.active++; this.maxConcurrent = Math.max(this.maxConcurrent, this.active)
    const done = () => { this.active-- }
    if (this.hang) {
      return new Promise<T | null>((resolve, reject) => {
        this.releasers.push(() => resolve(make()))
        opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }).finally(done)
    }
    return Promise.resolve(make()).finally(done)
  }
  async latestQuote(symbol: string, opts?: FetchOpts) {
    if (this.throwQuote) { this.active++; this.maxConcurrent = Math.max(this.maxConcurrent, this.active); this.active--; throw new Error('feed down') }
    return this.track(() => this.quote && { ...this.quote, symbol }, opts)
  }
  async latestTrade(symbol: string, opts?: FetchOpts) {
    if (this.throwTrade) throw new Error('feed down')
    return this.track(() => this.trade && { ...this.trade, symbol }, opts)
  }
}

const ctx = (over: Partial<ObserveContext> = {}): ObserveContext => ({
  tradeId: 'pt:UUU:1', setupId: 'UUU:bos:5', symbol: 'UUU', session: 'premarket',
  stopPrice: 4.84, executionPath: 'polled', ...over,
})

describe('ExecutionObserver — passive, read-only, bid/trade evidence separate', () => {
  it('keeps executable BID and last-TRADE breach evidence separate', async () => {
    const feed = new FakeFeed()
    feed.quote = { symbol: 'UUU', bidPrice: 4.80, askPrice: 4.85, sourceTs: 1 }  // bid ≤ 4.84 stop
    feed.trade = { symbol: 'UUU', price: 4.90, sourceTs: 1 }                      // trade > stop
    const rows: ExecutionQualityObservation[] = []
    await new ExecutionObserver(feed, r => rows.push(r), () => 1).observe(ctx())
    expect(rows[0].observedBidAtOrBelowStop).toBe(true)
    expect(rows[0].observedTradeAtOrBelowStop).toBe(false)   // NOT collapsed
    expect(rows[0].observedBreach).toBe(true)
    expect(rows[0].feedConsolidated).toBe(false)
  })

  it('ISOLATION: no method can submit or cancel an order', () => {
    const obs = new ExecutionObserver(new FakeFeed(), () => {})
    const surface = new Set<string>()
    for (let p: object = obs; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) surface.add(k)
    }
    for (const forbidden of ['submit', 'submitLimit', 'submitStop', 'cancel', 'cancelOrder', 'flatten', 'exit', 'tick', 'onSignal']) {
      expect(surface.has(forbidden)).toBe(false)
    }
  })

  it('UNAVAILABLE data → unknowns, never a fabricated breach', async () => {
    const feed = new FakeFeed(); feed.throwQuote = true; feed.throwTrade = true
    const out = await new ExecutionObserver(feed, () => {}, () => 1).observe(ctx())
    expect(out.observedBidAtOrBelowStop).toBeNull()
    expect(out.observedTradeAtOrBelowStop).toBeNull()
    expect(out.observedBreach).toBe(false)
  })

  it('an aborted sample is DROPPED and asserts no breach', async () => {
    const feed = new FakeFeed()
    feed.quote = { symbol: 'UUU', bidPrice: 1.0, askPrice: 1.1, sourceTs: 1 }
    const ac = new AbortController(); ac.abort()
    const out = await new ExecutionObserver(feed, () => {}, () => 1).observe(ctx(), { signal: ac.signal })
    expect(out.observationDropped).toBe(true)
    expect(out.observedBreach).toBe(false)
    expect(out.observedBid).toBeNull()
  })

  it('EFFECTIVE cadence is measured from wall-clock, not the configured 3s', async () => {
    const feed = new FakeFeed(); feed.trade = { symbol: 'UUU', price: 5, sourceTs: 1 }
    let t = 1000
    const rows: ExecutionQualityObservation[] = []
    const obs = new ExecutionObserver(feed, r => rows.push(r), () => t)
    await obs.observe(ctx()); t = 4200; await obs.observe(ctx()); t = 7100; await obs.observe(ctx())
    expect(rows[0].effectivePollIntervalMs).toBeNull()
    expect(rows[1].effectivePollIntervalMs).toBe(3200)
    const stats = effectivePollingCadence(rows.map(r => ({ kind: 'observation', ...r })) as ExecutionQualityRow[])
    expect(stats[0].medianMs).toBe(3050)
  })
})

function timerHarness() {
  const timers: Array<{ cb: () => void }> = []
  const setTimer = (cb: () => void) => { const t = { cb }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) } }
  const fireAll = () => { const snap = timers.splice(0); snap.forEach(t => t.cb()) }
  return { setTimer, fireAll, pending: () => timers.length }
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

describe('ObserverLoop — TRUE single-in-flight via end-to-end abort', () => {
  it('a timed-out request is ABORTED and settles before the slot is released — never two physical requests', async () => {
    const feed = new FakeFeed(); feed.hang = true
    const h = timerHarness()
    const loop = new ObserverLoop(new ExecutionObserver(feed, () => {}, () => 1), () => [ctx()], { cadenceMs: 3000, timeoutMs: 1500 }, { setTimer: h.setTimer })

    await loop.runRound()                 // dispatch #1 — hangs on its quote fetch
    expect(loop.inFlightSymbols()).toEqual(['UUU'])
    await loop.runRound()                 // would-be #2 — SKIPPED while #1 in flight
    expect(loop.stats.skippedInFlight).toBe(1)
    expect(feed.active).toBe(1)           // exactly ONE physical request active (fetches are sequential)

    h.fireAll(); await flush()            // timeout fires → abort → hung request rejects → observe settles
    expect(loop.stats.timedOut).toBe(1)
    expect(loop.inFlightSymbols()).toEqual([])   // slot released ONLY after the real request settled
    expect(feed.active).toBe(0)

    await loop.runRound(); await flush()  // now a fresh dispatch is allowed
    expect(loop.stats.dispatched).toBe(2)
    // Never more than one physical request per symbol at any instant.
    expect(feed.maxConcurrent).toBe(1)
  })

  it('runRound never awaits a hung observation (cannot back-pressure)', async () => {
    const feed = new FakeFeed(); feed.hang = true
    const { setTimer } = timerHarness()
    const loop = new ObserverLoop(new ExecutionObserver(feed, () => {}, () => 1), () => [ctx()], { cadenceMs: 3000, timeoutMs: 1500 }, { setTimer })
    await expect(loop.runRound()).resolves.toBeUndefined()
  })

  it('a position that CLOSES unsubscribes; an in-flight sample settles harmlessly', async () => {
    const feed = new FakeFeed(); feed.hang = true
    const forgotten: string[] = []
    const obs = new ExecutionObserver(feed, () => {}, () => 1)
    const orig = obs.forget.bind(obs); obs.forget = (id) => { forgotten.push(id); orig(id) }
    const h = timerHarness()
    let held: ObserveContext[] = [ctx()]
    const loop = new ObserverLoop(obs, () => held, { cadenceMs: 3000, timeoutMs: 1500 }, { setTimer: h.setTimer })
    await loop.runRound(); held = []; await loop.runRound()
    expect(loop.stats.unsubscribed).toBe(1)
    expect(forgotten).toContain('pt:UUU:1')
    feed.releaseHang(); await flush()     // hung sample resolves — must not throw
  })

  it('a completed observation clears the slot and cancels its timeout', async () => {
    const feed = new FakeFeed(); feed.trade = { symbol: 'UUU', price: 5, sourceTs: 1 }
    const h = timerHarness()
    const loop = new ObserverLoop(new ExecutionObserver(feed, () => {}, () => 1), () => [ctx()], { cadenceMs: 3000, timeoutMs: 1500 }, { setTimer: h.setTimer })
    await loop.runRound(); await flush()
    expect(loop.stats.completed).toBe(1)
    expect(loop.inFlightSymbols()).toEqual([])
    expect(h.pending()).toBe(0)
  })
})

describe('deriveLatencies — bid vs trade kept separate, unknown ≠ zero', () => {
  const exit = (over: Partial<ExecutionExitRecord> = {}): ExecutionExitRecord => ({
    kind: 'exit', recordedAt: '2026-08-19T13:35:00Z', tradeId: 'pt:UUU:1', setupId: null,
    symbol: 'UUU', session: 'premarket', stopPrice: 4.84, exitType: 'stop', executionPath: 'polled',
    decisionTs: 1000, decisionPrice: 4.52, submitTs: 1100, ackTs: 1200, fillTs: 1400,
    fillPrice: 4.55, fillQty: 244, plannedR: -1, realizedR: -2.82, ...over,
  })
  const obs = (over: Partial<ExecutionQualityObservation>): ExecutionQualityObservation => ({
    observedAt: '2026-08-19T13:34:59Z', tradeId: 'pt:UUU:1', setupId: null, symbol: 'UUU', session: 'premarket',
    stopPrice: 4.84, executionPath: 'polled', observedFeed: 'fake-iex', feedConsolidated: false,
    observedTradePrice: null, observedTradeTs: null, observedBid: null, observedAsk: null, observedQuoteTs: null,
    observedBidAtOrBelowStop: null, observedTradeAtOrBelowStop: null, observedBreach: false, observationDropped: false,
    monitorPrice: 4.86, monitorRequestStartTs: 900, monitorResponseTs: 1000, monitorQuoteTs: null,
    effectivePollIntervalMs: 3000, ...over,
  })

  it('computes SEPARATE bid- and trade-breach latencies, both flagged non-SIP', () => {
    const d = deriveLatencies(exit(), [
      obs({ observedBid: 4.80, observedQuoteTs: 300, observedBidAtOrBelowStop: true }),      // bid breach @300
      obs({ observedTradePrice: 4.70, observedTradeTs: 500, observedTradeAtOrBelowStop: true }), // trade breach @500
    ])
    expect(d.earliestObservedBidAtOrBelowStopTs).toBe(300)
    expect(d.bidBreachToDetectionMs).toBe(700)     // 1000 − 300
    expect(d.earliestObservedTradeAtOrBelowStopTs).toBe(500)
    expect(d.tradeBreachToDetectionMs).toBe(500)   // 1000 − 500
    expect(d.observedBreachIsConsolidated).toBe(false)
    expect(d.unknowns.join(' ')).toMatch(/single-venue|LOWER BOUND/)
  })

  it('bid breach present, trade breach absent → trade latency is UNKNOWN, not zero', () => {
    const d = deriveLatencies(exit(), [obs({ observedBid: 4.80, observedQuoteTs: 300, observedBidAtOrBelowStop: true })])
    expect(d.bidBreachToDetectionMs).toBe(700)
    expect(d.tradeBreachToDetectionMs).toBeNull()
    expect(d.unknowns.join(' ')).toMatch(/tradeBreachToDetectionMs/)
  })

  it('a broker-native stop (no decision price) → gap UNKNOWN', () => {
    const d = deriveLatencies(exit({ decisionPrice: null }), [])
    expect(d.productionGapAtDetectionPct).toBeNull()
    expect(d.detectionToSubmitMs).toBe(100)
  })
})
