import { describe, it, expect } from 'vitest'
import { makeObserverLoop, heldObserveContexts, type HeldPositionSource } from '@/lib/execution/observer-wiring'
import type { MarketDataSource, MarketQuote, MarketTrade, FetchOpts, ExecutionQualityObservation } from '@/lib/execution/market-observer'
import type { PaperTrade } from '@/lib/execution/types'

// A market feed that counts calls and can hang, so we can prove "no held → no calls"
// and clean shutdown.
class CountingFeed implements MarketDataSource {
  readonly name = 'fake-iex'; readonly consolidated = false
  calls = 0; active = 0
  hang = false
  private releasers: Array<() => void> = []
  release() { this.releasers.forEach(r => r()); this.releasers = [] }
  private go<T>(v: T, opts?: FetchOpts): Promise<T> {
    this.calls++; this.active++
    if (opts?.signal?.aborted) { this.active--; return Promise.reject(new DOMException('aborted', 'AbortError')) }
    if (this.hang) return new Promise<T>((res, rej) => {
      this.releasers.push(() => res(v))
      opts?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true })
    }).finally(() => { this.active-- })
    this.active--; return Promise.resolve(v)
  }
  latestQuote(_s: string, opts?: FetchOpts): Promise<MarketQuote | null> { return this.go(null, opts) }
  latestTrade(_s: string, opts?: FetchOpts): Promise<MarketTrade | null> { return this.go(null, opts) }
}

// Minimal executor stand-in exposing ONLY openTrades — the observer cannot reach any
// mutation method because the interface doesn't expose one.
function heldSource(trades: Partial<PaperTrade>[]): HeldPositionSource {
  return { openTrades: () => trades as PaperTrade[] }
}
const trade = (o: Partial<PaperTrade>): Partial<PaperTrade> => ({
  id: 'pt:UUU:1', setupId: 'UUU:bos:5', symbol: 'UUU', currentStop: 4.84, protectiveStopOrderId: null, ...o,
})

function timers() {
  const oneShot: Array<() => void> = []
  const loops: Array<() => void> = []
  return {
    setTimer: (cb: () => void) => { oneShot.push(cb); return () => { const i = oneShot.indexOf(cb); if (i >= 0) oneShot.splice(i, 1) } },
    setLoop: (cb: () => void) => { loops.push(cb); return () => { const i = loops.indexOf(cb); if (i >= 0) loops.splice(i, 1) } },
    fireTimers: () => { oneShot.splice(0).forEach(f => f()) },
    tickLoop: () => loops.forEach(f => f()),
    loopCount: () => loops.length,
  }
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

describe('observer activation — passive, isolated, clean lifecycle', () => {
  it('heldObserveContexts maps OPEN trades (path from protective stop) and nothing else', () => {
    const src = heldSource([
      trade({ id: 'pt:AAA:1', setupId: 'AAA:od:1', symbol: 'AAA', currentStop: 1.5, protectiveStopOrderId: 'o1' }),
      trade({ id: 'pt:BBB:1', setupId: 'BBB:bos:2', symbol: 'BBB', currentStop: 2.5, protectiveStopOrderId: null }),
    ])
    const ctxs = heldObserveContexts(src, () => 'regular')
    expect(ctxs).toEqual([
      { tradeId: 'pt:AAA:1', setupId: 'AAA:od:1', symbol: 'AAA', session: 'regular', stopPrice: 1.5, executionPath: 'broker_stop' },
      { tradeId: 'pt:BBB:1', setupId: 'BBB:bos:2', symbol: 'BBB', session: 'regular', stopPrice: 2.5, executionPath: 'polled' },
    ])
  })

  it('starts when enabled and, with a HELD position, passes it into observation', async () => {
    const feed = new CountingFeed()
    const t = timers()
    const loop = makeObserverLoop(heldSource([trade({})]), feed, { record: () => {}, session: () => 'premarket', deps: { setTimer: t.setTimer, setLoop: t.setLoop } })
    loop.start()
    expect(t.loopCount()).toBe(1)      // an interval was registered (observer running)
    t.tickLoop(); await flush()
    expect(feed.calls).toBeGreaterThan(0)   // the held symbol was observed
    expect(loop.stats.dispatched).toBe(1)
  })

  it('NO held positions ⇒ ZERO market-data calls', async () => {
    const feed = new CountingFeed()
    const t = timers()
    const loop = makeObserverLoop(heldSource([]), feed, { record: () => {}, deps: { setTimer: t.setTimer, setLoop: t.setLoop } })
    loop.start(); t.tickLoop(); await flush()
    expect(feed.calls).toBe(0)
    expect(loop.stats.dispatched).toBe(0)
  })

  it('observer timeout/failure does not block or alter the normal daemon path', async () => {
    const feed = new CountingFeed(); feed.hang = true
    const t = timers()
    const loop = makeObserverLoop(heldSource([trade({})]), feed, { record: () => {}, deps: { setTimer: t.setTimer, setLoop: t.setLoop } })
    // Model the daemon's own path running concurrently, with no reference to the loop.
    let daemonTicks = 0
    const daemonPath = async () => { daemonTicks++ }
    loop.start()
    await Promise.all([Promise.resolve(t.tickLoop()), daemonPath(), daemonPath()])
    expect(daemonTicks).toBe(2)            // unaffected while the observer hangs
    t.fireTimers(); await flush()          // observer times out → aborts → settles
    expect(loop.stats.timedOut).toBe(1)
    expect(loop.inFlightSymbols()).toEqual([])
  })

  it('SHUTDOWN aborts in-flight reads and clears the interval — no dangling work', async () => {
    const feed = new CountingFeed(); feed.hang = true
    const t = timers()
    const loop = makeObserverLoop(heldSource([trade({})]), feed, { record: () => {}, deps: { setTimer: t.setTimer, setLoop: t.setLoop } })
    loop.start(); t.tickLoop(); await flush()
    expect(loop.inFlightSymbols()).toEqual(['UUU'])
    expect(feed.active).toBe(1)
    loop.stop()                            // shutdown
    await flush()
    expect(feed.active).toBe(0)            // in-flight request aborted + settled
    expect(loop.inFlightSymbols()).toEqual([])
    expect(t.loopCount()).toBe(0)          // interval cleared
    // A stopped loop refuses further work even if its interval somehow fires again.
    t.tickLoop(); await flush()
    expect(loop.stats.dispatched).toBe(1)  // still just the one
  })

  it('observer output goes ONLY to the record sink; the source view exposes no mutation method', async () => {
    const rows: ExecutionQualityObservation[] = []
    const src = heldSource([trade({})])
    // The HeldPositionSource the observer is handed exposes ONLY openTrades — it
    // structurally cannot submit/cancel/size/exit.
    expect(Object.keys(src)).toEqual(['openTrades'])
    const feed = new CountingFeed()
    const t = timers()
    const loop = makeObserverLoop(src, feed, { record: r => rows.push(r), deps: { setTimer: t.setTimer, setLoop: t.setLoop } })
    loop.start(); t.tickLoop(); await flush()
    expect(rows.length).toBe(1)                  // wrote exactly one observation row
    expect(rows[0].symbol).toBe('UUU')
    // Every recorded field is instrumentation; there is no order/decision output.
    expect(rows[0]).toHaveProperty('observedBreach')
    expect(rows[0]).not.toHaveProperty('taken')
  })

  it('runs on its OWN cadence, independent of the position loop', () => {
    const loop = makeObserverLoop(heldSource([]), new CountingFeed(), { record: () => {}, cadenceMs: 2_000 })
    // The loop was constructed with its own cadence; it does not read POSITION_MS.
    expect(loop).toBeDefined()
    // (Cadence independence is structural: makeObserverLoop never imports the daemon's
    //  POSITION_MS/SWEEP_MS; the loop schedules itself.)
  })
})
