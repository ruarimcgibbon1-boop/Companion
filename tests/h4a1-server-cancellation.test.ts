/**
 * H4A.1 — server-side observational cancellation (red-team RT″-1/RT″-2/RT″-5).
 *
 * Proves the AbortSignal is threaded all the way into the observational provider fetches, so an aborted
 * observational pass tears its server-side provider work down promptly (bounded lifetime) and stops
 * scheduling new symbols — a stale observational batch cannot linger into the next BASE sweep. BASE (no
 * signal) is never cancellable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const rec = vi.hoisted(() => ({
  daily: { calls: 0, lastSignal: undefined as AbortSignal | undefined },
  yfq: { calls: 0 }, yfc: { calls: 0 },
  hangSymbols: new Set<string>(),   // getDailyCandles hangs until aborted for these
  reset() { this.daily.calls = 0; this.daily.lastSignal = undefined; this.yfq.calls = 0; this.yfc.calls = 0; this.hangSymbols.clear() },
}))

function etWall(ms: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))
  const g = (t: string) => p.find(x => x.type === t)!.value
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`
}
const intraday = (now: number, n = 40) => Array.from({ length: n }, (_, k) => { const i = n - 1 - k; const t = now - i * 60_000; const b = 10 + k * 0.05; return { date: etWall(t), open: b, high: b + 0.06, low: b - 0.04, close: b + 0.02, volume: 50_000 + i } })
const daily = (now: number, n = 30) => Array.from({ length: n }, (_, k) => ({ date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now - (n - 1 - k) * 86_400_000), open: 9, high: 11, low: 8.5, close: 10, volume: 2_000_000 }))

// Reject as soon as the signal aborts; otherwise never settle. Models a provider that honours cancellation.
function hangUntilAbort<T>(signal?: AbortSignal): Promise<T> {
  return new Promise<T>((_, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
}

vi.mock('@/lib/fmp-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/fmp-client')>()),
  getQuote: vi.fn(async () => ({ exchange: 'NASDAQ', price: 11, timestamp: Math.floor(Date.now() / 1000), averageVolume: 3e6, volume: 15e5, previousClose: 8, changePercentage: 37 })),
  getIntradayCandles: vi.fn(async () => intraday(Date.now())),
  getDailyCandles: vi.fn(async (s: string, signal?: AbortSignal) => {
    rec.daily.calls++; rec.daily.lastSignal = signal
    if (rec.hangSymbols.has(s.toUpperCase())) return hangUntilAbort<ReturnType<typeof daily>>(signal)
    return daily(Date.now())
  }),
  getFloatShares: vi.fn(async () => 1e7),
  getExtendedIntradayCandles: vi.fn(async () => intraday(Date.now())),
}))
vi.mock('@/lib/yahoo-client', async (orig) => ({
  ...(await orig<typeof import('@/lib/yahoo-client')>()),
  getYFQuote: vi.fn(async () => { rec.yfq.calls++; return { price: 11, regularMarketVolume: 15e5, previousClose: 8 } }),
  getYFCandles: vi.fn(async () => { rec.yfc.calls++; return intraday(Date.now()) }),
}))

import { buildMonitorBatch } from '@/lib/monitor'
import { cache } from '@/lib/cache'

beforeEach(() => { cache.clear(); rec.reset() })

describe('RT″-1/RT″-2 provider fetches observe the observational abort', () => {
  it('an aborted observational pass settles PROMPTLY and the provider saw an aborted signal', async () => {
    rec.hangSymbols.add('HANG')
    const ac = new AbortController()
    const start = Date.now()
    setTimeout(() => ac.abort(), 100)
    const results = await buildMonitorBatch(['HANG'], { observationalOnly: ['HANG'], signal: ac.signal })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(1000)                 // bounded by the abort, not left hanging
    expect(results.find(r => r.symbol === 'HANG')).toBeUndefined()   // honest miss
    expect(rec.daily.lastSignal?.aborted).toBe(true)   // the signal reached the provider fetch
  })

  it('after abort, NO new observational symbols are scheduled', async () => {
    for (let i = 0; i < 12; i++) rec.hangSymbols.add(`H${i}`)
    const syms = Array.from({ length: 12 }, (_, i) => `H${i}`)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 60)
    await buildMonitorBatch(syms, { observationalOnly: syms, signal: ac.signal })
    // concurrency is 6: the first wave is in flight when the abort fires; no further symbols start.
    expect(rec.daily.calls).toBeLessThanOrEqual(6)
    expect(rec.daily.calls).toBeGreaterThan(0)
  })
})

describe('RT″-5 bounded lifetime → no overlap with the next BASE sweep', () => {
  it('a hung observational batch settles within the abort deadline (well under a 15s sweep)', async () => {
    rec.hangSymbols.add('Z0'); rec.hangSymbols.add('Z1')
    const ac = new AbortController()
    const DEADLINE = 200            // stands in for the route's hard server deadline (10s in prod, < 15s sweep)
    setTimeout(() => ac.abort(), DEADLINE)
    const start = Date.now()
    const results = await buildMonitorBatch(['Z0', 'Z1'], { observationalOnly: ['Z0', 'Z1'], signal: ac.signal })
    expect(Date.now() - start).toBeLessThan(DEADLINE + 800)   // provider work does not outlive the deadline
    expect(results).toEqual([])                               // both aborted → honest empty
  })
})

describe('BASE (no signal) is never cancellable', () => {
  it('a BASE batch passes no signal to providers and completes normally', async () => {
    const results = await buildMonitorBatch(['A', 'B', 'C'])   // no observationalOnly, no signal
    expect(results.map(r => r.symbol).sort()).toEqual(['A', 'B', 'C'])
    expect(rec.daily.lastSignal).toBeUndefined()               // BASE daily fetch received no signal
  })
})
