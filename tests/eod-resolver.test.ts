import { describe, it, expect } from 'vitest'
import { resolveLogAgainstCandles, resolveOpenLogs, sameEtDay, isDayClosed, scaledPnl, resolveBuyPnl } from '../src/lib/eod-resolver'
import type { Candle, SetupLog, BuySignalRecord } from '../src/types'

// 2026-07-23 13:00 ET ≈ 17:00 UTC (EDT = UTC-4). A weekday.
const DAY_ET_1PM = Date.UTC(2026, 6, 23, 17, 0, 0)

function candle(hhmmUtc: [number, number], o: number, h: number, l: number, c: number): Candle {
  const time = Math.floor(Date.UTC(2026, 6, 23, hhmmUtc[0], hhmmUtc[1], 0) / 1000)
  return { time, open: o, high: h, low: l, close: c, volume: 100_000 }
}

function log(over: Partial<SetupLog> = {}): SetupLog {
  return {
    id: 'T:opening_range_break:130.00', symbol: 'TEST', type: 'opening_range_break',
    direction: 'long', identifiedAt: DAY_ET_1PM, priceAtIdentification: 130.0,
    zoneLower: 129.9, zoneUpper: 130.0, score: 60, grade: 'B', confirmation: [],
    invalidation: 129.0, targets: [{ price: 132.0, label: 'T1', rewardRisk: 2 }],
    statesReached: ['triggered'], maxFavorablePrice: 130.0, maxAdversePrice: 130.0,
    maxFavorablePct: 0, maxAdversePct: 0, outcome: 'open', outcomeReason: null,
    triggeredAt: DAY_ET_1PM, resolvedAt: null, relativeVolumeAtId: 3, sessionAtId: 'regular',
    testCount: 0, ...over,
  }
}

describe('sameEtDay / isDayClosed', () => {
  it('treats two ET-same-day instants as the same day', () => {
    expect(sameEtDay(DAY_ET_1PM, DAY_ET_1PM + 3_600_000)).toBe(true)
  })
  it('a prior calendar day is always closed', () => {
    const now = Date.UTC(2026, 6, 24, 14, 0, 0) // next day
    expect(isDayClosed(DAY_ET_1PM, now)).toBe(true)
  })
  it('today is not closed while the regular session is still open', () => {
    const now = Date.UTC(2026, 6, 23, 18, 0, 0) // 14:00 ET, mid-session
    expect(isDayClosed(DAY_ET_1PM, now)).toBe(false)
  })
  it('today is closed once past the 16:00 ET close', () => {
    const now = Date.UTC(2026, 6, 23, 20, 30, 0) // 16:30 ET, after-hours
    expect(isDayClosed(DAY_ET_1PM, now)).toBe(true)
  })
})

describe('resolveLogAgainstCandles — first-touch binary', () => {
  const day = [
    candle([17, 0], 130.0, 130.5, 129.8, 130.4), // 13:00 ET signal bar
    candle([17, 5], 130.4, 131.0, 130.2, 130.9),
  ]

  it('marks target_hit when the high reaches T1 first', () => {
    const r = resolveLogAgainstCandles(log(), [...day, candle([17, 10], 130.9, 132.2, 130.7, 132.0)])
    expect(r!.outcome).toBe('target_hit')
    expect(r!.maxFavorablePct).toBeCloseTo(((132.2 - 130) / 130) * 100, 4)
  })

  it('marks invalidated when the low reaches the stop first', () => {
    const r = resolveLogAgainstCandles(log(), [...day, candle([17, 10], 130.9, 131.1, 128.9, 129.1)])
    expect(r!.outcome).toBe('invalidated')
    expect(r!.maxAdversePct).toBeCloseTo(((128.9 - 130) / 130) * 100, 4)
  })

  it('scores a bar straddling both stop and target as the adverse outcome', () => {
    // one bar that tags 132.0 high AND 129.0 low — intrabar order unknown
    const r = resolveLogAgainstCandles(log(), [candle([17, 0], 130.0, 132.5, 128.9, 130.0)])
    expect(r!.outcome).toBe('invalidated')
  })

  it('expires when neither stop nor target is touched by the close', () => {
    const r = resolveLogAgainstCandles(log(), day)
    expect(r!.outcome).toBe('expired')
    expect(r!.resolvedAt).toBe(day[day.length - 1].time * 1000)
  })

  it('ignores candles before the signal bar', () => {
    const pre = candle([16, 30], 130.0, 133.0, 128.0, 130.0) // 12:30 ET, before signal — would falsely hit both
    const r = resolveLogAgainstCandles(log(), [pre, ...day])
    expect(r!.outcome).toBe('expired')
  })

  it('resolves a short by mirroring', () => {
    const s = log({ direction: 'short', invalidation: 131.0, targets: [{ price: 128.0, label: 'T1', rewardRisk: 2 }] })
    const r = resolveLogAgainstCandles(s, [candle([17, 0], 130.0, 130.2, 127.8, 128.0)])
    expect(r!.outcome).toBe('target_hit')
  })

  it('returns null for an already-resolved log', () => {
    expect(resolveLogAgainstCandles(log({ outcome: 'target_hit' }), day)).toBeNull()
  })

  it('returns null when no candles fall on the log day', () => {
    expect(resolveLogAgainstCandles(log(), [])).toBeNull()
  })
})

describe('resolveOpenLogs — batch', () => {
  const now = Date.UTC(2026, 6, 24, 14, 0, 0) // next day: the log day is closed

  it('fetches once per symbol and resolves only stale-open logs', async () => {
    const winner = candle([17, 10], 130.9, 132.2, 130.7, 132.0)
    const fetches: string[] = []
    const fetchCandles = async (sym: string) => {
      fetches.push(sym)
      return [candle([17, 0], 130.0, 130.5, 129.8, 130.4), winner]
    }
    const logs = [
      log({ id: 'a', symbol: 'AAA' }),
      log({ id: 'b', symbol: 'AAA' }),              // same symbol → one fetch
      log({ id: 'c', symbol: 'BBB', outcome: 'target_hit' }), // already resolved → skipped
    ]
    const resolved = await resolveOpenLogs(logs, now, fetchCandles)
    expect(fetches).toEqual(['AAA'])           // BBB never fetched (nothing open)
    expect(resolved.map(l => l.id).sort()).toEqual(['a', 'b'])
    expect(resolved.every(l => l.outcome === 'target_hit')).toBe(true)
  })

  it('leaves logs open when the fetch throws', async () => {
    const fetchCandles = async () => { throw new Error('network') }
    const resolved = await resolveOpenLogs([log({ id: 'a' })], now, fetchCandles)
    expect(resolved).toEqual([])
  })

  it('skips logs whose day is not yet closed', async () => {
    const midSession = Date.UTC(2026, 6, 23, 18, 0, 0) // 14:00 ET same day
    let called = false
    await resolveOpenLogs([log()], midSession, async () => { called = true; return [] })
    expect(called).toBe(false)
  })
})

describe('scaledPnl — ½ T1, ½ T2, breakeven after T1', () => {
  // entry 100, stop 98 (2% risk), T1 102 (+2%), T2 105 (+5%).
  const entry = 100, stop = 98, targets = [102, 105]
  const run = (cs: Candle[]) => scaledPnl(entry, stop, targets, cs, DAY_ET_1PM)

  it('books ½ at T1 and ½ at T2 for a full winner', () => {
    const r = run([
      candle([17, 5], 100, 102.5, 100.2, 102),   // hits T1
      candle([17, 10], 102, 105.2, 101.5, 105),  // hits T2
    ])!
    expect(r.pnlPct).toBeCloseTo(0.5 * 2 + 0.5 * 5, 6) // 3.5%
    expect(r.fullyClosed).toBe(true)
  })

  it('takes a full loss at the stop when it hits before T1', () => {
    const r = run([candle([17, 5], 100, 100.5, 97.5, 98)])!
    expect(r.pnlPct).toBeCloseTo(-2, 6)
    expect(r.legs[0].reason).toBe('stop')
  })

  it('breakeven-stops the remainder after T1 (half the T1 gain, not a loss)', () => {
    const r = run([
      candle([17, 5], 100, 102.3, 100.2, 102),   // T1 → book ½ +2%, stop to 100
      candle([17, 10], 101, 101.5, 99.5, 100),   // dips to breakeven → book ½ at 0%
    ])!
    expect(r.pnlPct).toBeCloseTo(1, 6) // 0.5*2 + 0.5*0
    expect(r.legs.some(l => l.reason === 'breakeven')).toBe(true)
  })

  it('marks the remainder to the close when neither T2 nor breakeven is hit', () => {
    const r = run([
      candle([17, 5], 100, 102.3, 100.2, 102),   // T1
      candle([17, 10], 102, 103, 100.5, 103),    // drifts, closes 103
    ])!
    expect(r.pnlPct).toBeCloseTo(0.5 * 2 + 0.5 * 3, 6) // 2.5%
    expect(r.fullyClosed).toBe(false)
  })

  it('scores a bar straddling stop and T1 as the adverse (stop) outcome', () => {
    const r = run([candle([17, 5], 100, 103, 97, 100)])! // both 98 and 102 tagged
    expect(r.pnlPct).toBeCloseTo(-2, 6)
  })

  it('books both legs when one bar clears T1 and T2', () => {
    const r = run([candle([17, 5], 100, 106, 100.5, 105)])!
    expect(r.pnlPct).toBeCloseTo(3.5, 6)
    expect(r.fullyClosed).toBe(true)
  })

  it('returns null with no candles on the day', () => {
    expect(run([])).toBeNull()
  })
})

describe('resolveBuyPnl — batch', () => {
  const now = Date.UTC(2026, 6, 24, 14, 0, 0) // next day: closed
  function buy(over: Partial<BuySignalRecord> = {}): BuySignalRecord {
    return {
      id: 'x', setupId: 'x', symbol: 'AAA', timestamp: DAY_ET_1PM, setupType: 'opening_range_break',
      triggerPrice: 100, entryLow: 99.5, entryHigh: 100, invalidation: 98, stop: 98,
      targets: [102, 105], score: 60, grade: 'B', rewardRisk: 2, priceAtSignal: 100, ...over,
    }
  }

  it('prices only unpriced, day-closed buys and skips the rest', async () => {
    const fetches: string[] = []
    const fetchCandles = async (s: string) => {
      fetches.push(s)
      return [candle([17, 5], 100, 102.5, 100.2, 102), candle([17, 10], 102, 105.2, 101.5, 105)]
    }
    const priced = await resolveBuyPnl([
      buy({ id: 'a' }),
      buy({ id: 'b', pnlPct: 1.2 }),          // already priced → skipped
    ], now, fetchCandles)
    expect(fetches).toEqual(['AAA'])
    expect(priced.map(b => b.id)).toEqual(['a'])
    expect(priced[0].pnlPct).toBeCloseTo(3.5, 6)
  })

  it('skips buys whose day has not closed', async () => {
    const midSession = Date.UTC(2026, 6, 23, 18, 0, 0)
    let called = false
    await resolveBuyPnl([buy()], midSession, async () => { called = true; return [] })
    expect(called).toBe(false)
  })
})
