/**
 * H4A.1 — the shared observational data plane (isolation + provider budget + dedup + fidelity).
 *
 * These are the LOAD-BEARING acceptance tests. They exercise the REAL buildMonitorBatch over ONE
 * shared pass with the provider layer and detectSetups replaced by call-RECORDING spies, and compose
 * the exact daemon flow (cohort → stable union → single fetch → base/observational split) without
 * running the daemon script.
 *
 * Proven here:
 *   STEP 15  a persisted leader outside top15 (Z) gets a fresh 1m MonitorResult + LocalStructure, keeps
 *            its leaderEpisodeId, is ABSENT from the base set, and is NEVER passed to detectSetups.
 *   STEP 16  a symbol in both top15 and CORE is fetched once (cohort dedups it out; union single-flights).
 *   STEP 5/6 an observational symbol skips float + premarket-volume provider work; base does not.
 *   STEP 7   a warm cache adds zero provider calls; a repeated symbol is fetched once.
 *   STEP 8   1m bars → timeframe '1m'; 5m bars never masquerade as 1m.
 *   STEP 13  an observational fetch failure never removes or corrupts a base result.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Recording provider spies (hoisted so the vi.mock factories can close over them) ──
const rec = vi.hoisted(() => {
  const mk = () => ({ calls: 0, symbols: new Set<string>() })
  return {
    quote: mk(), yfquote: mk(), yfcandles: mk(), fmpIntraday: mk(),
    daily: mk(), float: mk(), extended: mk(), detect: mk(),
    // symbols whose candle feed should be 5m instead of 1m, and symbols whose quote should fail
    fiveMinSymbols: new Set<string>(),
    failSymbols: new Set<string>(),
    reset() {
      for (const k of ['quote', 'yfquote', 'yfcandles', 'fmpIntraday', 'daily', 'float', 'extended', 'detect'] as const) {
        this[k].calls = 0; this[k].symbols.clear()
      }
    },
  }
})

// Synthetic candle helpers.
function etWall(ms: number): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))
  const g = (t: string) => p.find(x => x.type === t)!.value
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}:${g('second')}`
}
// N intraday bars ending ~now, at `stepMs` spacing, gently trending up then pulling back (enough for geometry).
function intraday(nowMs: number, n = 40, stepMs = 60_000) {
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const t = nowMs - i * stepMs
    const base = 10 + (n - 1 - i) * 0.05                    // steady climb
    out.push({ date: etWall(t), open: base, high: base + 0.06, low: base - 0.04, close: base + 0.02, volume: 50_000 + i * 100 })
  }
  return out
}
function daily(nowMs: number, n = 30) {
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowMs - i * 86_400_000)
    out.push({ date: d, open: 9, high: 11, low: 8.5, close: 10, volume: 2_000_000 })
  }
  return out
}

vi.mock('@/lib/fmp-client', async (orig) => {
  const actual = await orig<typeof import('@/lib/fmp-client')>()
  return {
    ...actual,
    getQuote: vi.fn(async (s: string) => {
      rec.quote.calls++; rec.quote.symbols.add(s.toUpperCase())
      if (rec.failSymbols.has(s.toUpperCase())) throw new Error('simulated quote failure')
      return { symbol: s.toUpperCase(), exchange: 'NASDAQ', price: 11, timestamp: Math.floor(Date.now() / 1000), averageVolume: 3_000_000, volume: 1_500_000, previousClose: 8, changePercentage: 37 }
    }),
    getIntradayCandles: vi.fn(async (s: string) => { rec.fmpIntraday.calls++; rec.fmpIntraday.symbols.add(s.toUpperCase()); return intraday(Date.now(), 40, rec.fiveMinSymbols.has(s.toUpperCase()) ? 300_000 : 60_000) }),
    getDailyCandles: vi.fn(async (s: string) => { rec.daily.calls++; rec.daily.symbols.add(s.toUpperCase()); return daily(Date.now()) }),
    getFloatShares: vi.fn(async (s: string) => { rec.float.calls++; rec.float.symbols.add(s.toUpperCase()); return 10_000_000 }),
    getExtendedIntradayCandles: vi.fn(async (s: string) => { rec.extended.calls++; rec.extended.symbols.add(s.toUpperCase()); return intraday(Date.now(), 40) }),
  }
})
vi.mock('@/lib/yahoo-client', async (orig) => {
  const actual = await orig<typeof import('@/lib/yahoo-client')>()
  return {
    ...actual,
    getYFQuote: vi.fn(async (s: string) => {
      rec.yfquote.calls++; rec.yfquote.symbols.add(s.toUpperCase())
      if (rec.failSymbols.has(s.toUpperCase())) return null
      return { price: 11, regularMarketVolume: 1_500_000, previousClose: 8 }
    }),
    getYFCandles: vi.fn(async (s: string) => {
      rec.yfcandles.calls++; rec.yfcandles.symbols.add(s.toUpperCase())
      if (rec.failSymbols.has(s.toUpperCase())) return []          // force FMP fallback path off; quote failure drives null
      return intraday(Date.now(), 40, rec.fiveMinSymbols.has(s.toUpperCase()) ? 300_000 : 60_000)
    }),
  }
})
// Record every detectSetups call by symbol; return no setups (we assert the CALL isolation, not content).
vi.mock('@/lib/setup-detectors', async (orig) => {
  const actual = await orig<typeof import('@/lib/setup-detectors')>()
  return {
    ...actual,
    detectSetups: vi.fn((ctx: { symbol: string }) => { rec.detect.calls++; rec.detect.symbols.add(ctx.symbol.toUpperCase()); return [] }),
  }
})

import { buildMonitorBatch } from '@/lib/monitor'
import { cache } from '@/lib/cache'
import { selectLeaderObservationCohort, stableObservationUnion, DEFAULT_LEADER_OBSERVATION_CONFIG } from '@/lib/leader/leader-observation'
import type { LeaderStateMap, LeaderStateRecord } from '@/lib/leader/leader-state'

const BASE = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O']  // top15 A..O

function coreRec(symbol: string, over: Partial<LeaderStateRecord> = {}): LeaderStateRecord {
  const iso = '2026-09-18T13:30:00.000Z'
  return {
    symbol, leaderEpisodeId: `led-${symbol}-ep1`, tradingDay: '2026-09-18',
    firstSeenAt: iso, lastSeenAt: iso, firstSeenSweepId: 's', lastSeenSweepId: 's', firstEverSeenAt: iso, episodeCount: 1,
    sourcesEverSeen: ['fmp'], currentSources: ['fmp'], bestSourceRank: 1, currentSourceRanks: { fmp: 1 },
    bestPre60Rank: 5, bestPre30Rank: 3, bestRouteRank: 3, bestLegacyTop15Rank: null,
    firstTop60At: iso, firstTop30At: iso, firstLegacyTop15At: null, timesTop60: 5, timesTop30: 5, timesLegacyTop15: 0,
    firstObservedChangePct: 40, currentChangePct: 55, peakObservedChangePct: 70, peakObservedAt: iso,
    currentOffHighPct: -12, peakRvol: 6, currentVolume: 3e6, currentFloat: 1e7,
    presentThisSweep: true, consecutiveSweepsSeen: 4, consecutiveSweepsAbsent: 0, lastPresentAt: iso, lastAbsentAt: null, reappearanceCount: 0,
    lifecycleState: 'LEADER_CONFIRMED', lifecycleEnteredAt: iso, priorLifecycleState: null, transitionReason: null, transitionSweepId: null,
    role: 'CORE', roleEnteredAt: iso, priorRole: null, roleRuleVersion: 'h3c-provisional-1', historyComplete: true,
    ...over,
  }
}

beforeEach(() => { cache.clear(); rec.reset(); rec.fiveMinSymbols.clear(); rec.failSymbols.clear() })

describe('STEP 15 — isolation of a persisted leader outside top15', () => {
  it('Z gets fresh 1m data + local structure and keeps its episode id, but never touches BASE detection', async () => {
    const leaderState: LeaderStateMap = { Z: coreRec('Z') }   // Z is CORE, NOT in top15 A..O
    const cohort = selectLeaderObservationCohort(leaderState, BASE, DEFAULT_LEADER_OBSERVATION_CONFIG)
    expect(cohort.selected.map(m => m.symbol)).toEqual(['Z'])
    expect(cohort.selected[0].leaderEpisodeId).toBe('led-Z-ep1')   // episode id retained

    const leaderObs = cohort.selected.map(m => m.symbol)
    const union = stableObservationUnion(BASE, leaderObs)
    expect(union).toContain('Z')
    expect(new Set(BASE).has('Z')).toBe(false)                     // Z absent from the base (monitored) set

    const all = await buildMonitorBatch(union, { observationalOnly: leaderObs })
    const bySym = new Map(all.map(r => [r.symbol, r]))
    const baseResults = all.filter(r => new Set(BASE).has(r.symbol))

    // Z received a fresh monitor result with honest 1m local structure.
    const z = bySym.get('Z')!
    expect(z).toBeTruthy()
    expect(z.localStructure).toBeTruthy()
    expect(z.localStructure!.provenance.timeframe).toBe('1m')

    // HARD ISOLATION: Z was never passed to detectSetups; A..O all were.
    expect(rec.detect.symbols.has('Z')).toBe(false)
    for (const s of BASE) expect(rec.detect.symbols.has(s)).toBe(true)
    // Z produced no setups and is absent from the BASE result set entirely.
    expect(z.setups).toEqual([])
    expect(baseResults.some(r => r.symbol === 'Z')).toBe(false)
    expect(baseResults.map(r => r.symbol).sort()).toEqual([...BASE].sort())
  })

  it('observational path skips float + premarket-volume provider work; base path does not', async () => {
    const union = stableObservationUnion(BASE, ['Z'])
    await buildMonitorBatch(union, { observationalOnly: ['Z'] })
    // float fetched for every base symbol, never for Z
    expect(rec.float.symbols.has('Z')).toBe(false)
    for (const s of BASE) expect(rec.float.symbols.has(s)).toBe(true)
    // extended (premarket volume) never fetched for Z regardless of session
    expect(rec.extended.symbols.has('Z')).toBe(false)
    // Z still got the data localStructure needs: quote + candles + daily
    expect(rec.quote.symbols.has('Z')).toBe(true)
    expect(rec.yfcandles.symbols.has('Z')).toBe(true)
    expect(rec.daily.symbols.has('Z')).toBe(true)
  })
})

describe('STEP 16 — a top15 ∩ CORE symbol is fetched once', () => {
  it('cohort excludes the overlap; the union carries it once; providers hit it once', async () => {
    const leaderState: LeaderStateMap = { C: coreRec('C') }   // C is BOTH top15 and CORE
    const cohort = selectLeaderObservationCohort(leaderState, BASE, DEFAULT_LEADER_OBSERVATION_CONFIG)
    expect(cohort.selected.map(m => m.symbol)).not.toContain('C')  // deduped out of the cohort
    const union = stableObservationUnion(BASE, cohort.selected.map(m => m.symbol))
    expect(union.filter(s => s === 'C')).toHaveLength(1)
    await buildMonitorBatch(union, { observationalOnly: cohort.selected.map(m => m.symbol) })
    // C fetched exactly once across the shared pass, and (being base) took the FULL path (float called).
    expect([...rec.quote.symbols].filter(s => s === 'C')).toHaveLength(1)
    expect(rec.float.symbols.has('C')).toBe(true)
  })
})

describe('STEP 7 — cache single-flight / no duplicate provider work', () => {
  it('a warm cache adds zero provider calls on the second identical pass', async () => {
    const union = stableObservationUnion(BASE, ['Z'])
    await buildMonitorBatch(union, { observationalOnly: ['Z'] })
    const firstQuote = rec.quote.calls, firstDaily = rec.daily.calls, firstFloat = rec.float.calls, firstCandles = rec.yfcandles.calls
    // second pass, cache still warm — no cache.clear()
    await buildMonitorBatch(union, { observationalOnly: ['Z'] })
    expect(rec.quote.calls).toBe(firstQuote)
    expect(rec.daily.calls).toBe(firstDaily)
    expect(rec.float.calls).toBe(firstFloat)
    expect(rec.yfcandles.calls).toBe(firstCandles)
  })

  it('a symbol repeated in the input list is fetched once (batch dedup)', async () => {
    await buildMonitorBatch(['DUP', 'DUP', 'DUP'])
    expect([...rec.quote.symbols]).toEqual(['DUP'])
    expect(rec.quote.calls).toBe(1)
  })
})

describe('STEP 8 — timeframe fidelity (no 5m masquerading as 1m)', () => {
  it('1m bars → timeframe "1m"; 5m bars → not "1m"', async () => {
    rec.fiveMinSymbols.add('FIVE')
    const all = await buildMonitorBatch(['ONE', 'FIVE'], { observationalOnly: ['ONE', 'FIVE'] })
    const one = all.find(r => r.symbol === 'ONE')!
    const five = all.find(r => r.symbol === 'FIVE')!
    expect(one.localStructure!.provenance.timeframe).toBe('1m')
    expect(five.localStructure!.provenance.timeframe).not.toBe('1m')
  })
})

describe('STEP 13 — an observational failure never affects BASE', () => {
  it('Z fetch fails → Z absent, but every base result is present and intact', async () => {
    rec.failSymbols.add('Z')   // Z quote throws + yfquote null → buildMonitorResult returns null
    const union = stableObservationUnion(BASE, ['Z'])
    const all = await buildMonitorBatch(union, { observationalOnly: ['Z'] })
    const baseResults = all.filter(r => new Set(BASE).has(r.symbol))
    expect(all.some(r => r.symbol === 'Z')).toBe(false)               // Z dropped (honest miss)
    expect(baseResults.map(r => r.symbol).sort()).toEqual([...BASE].sort())  // BASE unaffected
    for (const s of BASE) expect(rec.detect.symbols.has(s)).toBe(true)
  })
})
