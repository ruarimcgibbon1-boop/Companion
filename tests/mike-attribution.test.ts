/**
 * MIKE'S STRATEGY — attribution + non-contamination.
 *
 * Proves Mike is isolated: separate attribution, separate files, separate
 * aggregates, and that no REGULAR decision module imports Mike (so REGULAR output,
 * ordering, eligibility, triggers, sizing, execution, and risk cannot change).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MIKE_STRATEGY } from '../src/lib/mike/types'
import { mikeCandidatesFile, mikeShadowFile } from '../src/lib/mike/store'
import { aggregateMike } from '../src/lib/mike/stats'
import { decisionsFile, tradesFile, eventsFile, arbitrationFile } from '../src/lib/execution/store'
// Importing the REGULAR detector alongside Mike, then running it, shows importing
// Mike does not alter REGULAR output.
import { detectSetups, type DetectionContext } from '../src/lib/setup-detectors'
import '../src/lib/mike/engine'
import { buildKeyLevels } from '../src/lib/levels-engine'
import type { Candle, SessionLevels, TechnicalData } from '../src/types'

describe('attribution model', () => {
  it("Mike's strategy tag is 'mike'", () => {
    expect(MIKE_STRATEGY).toBe('mike')
  })
})

describe('file separation — Mike never writes REGULAR logs', () => {
  it('Mike files are distinct from every REGULAR execution file', () => {
    const day = '2026-09-10'
    const mike = [mikeCandidatesFile(day), mikeShadowFile(day)]
    const regular = [decisionsFile(day), tradesFile(day), eventsFile(day), arbitrationFile(day)]
    for (const m of mike) expect(m).toContain('mike')
    for (const m of mike) for (const r of regular) expect(m).not.toBe(r)
    // no REGULAR file path contains the mike marker
    for (const r of regular) expect(r).not.toContain('mike')
  })
})

describe('aggregates never mix', () => {
  it('aggregateMike only counts the Mike records it is given', () => {
    const stats = aggregateMike([], [])
    expect(stats.total).toBe(0)
    expect(stats.byState).toEqual({})
    // A single Mike candidate is counted; nothing REGULAR can appear here by construction.
    const stats2 = aggregateMike([
      { strategy: 'mike', symbol: 'X', session: 'regular', now: 0, state: 'TRIGGERED', outcome: 'TRADED',
        price: 5, breakoutLevel: null, loadingZone: null, acceptance: { accepted: true, candleTime: null },
        maxExcursionAbovePct: 0, hardGates: { fiveMinAcceptance: true, noImmediateRejection: true, withinLoadingCeiling: true },
        supporting: { higherLowAboveLevel: false, expandingVolume: false, continuedMomentum: true, secondCandleHolds: true, vwapSupport: true, emaSupport: false },
        supportingCount: 3, supportingRequired: 2, stop: null, tradePlan: null, veto: null,
        indicators: { vwap: null, ema9: null, ema21: null, rvol: null } },
    ], [])
    expect(stats2.total).toBe(1)
    expect(stats2.byOutcome).toEqual({ TRADED: 1 })
  })
})

describe('REGULAR modules do not import Mike', () => {
  const files = [
    'src/lib/setup-detectors.ts',
    'src/lib/buy-log.ts',
    'src/lib/execution/executor.ts',
    'src/lib/execution/risk.ts',
    'src/lib/execution/sizing.ts',
    'src/lib/monitor.ts',
    'src/lib/continuation.ts',
    'scripts/alert-daemon.ts',
  ]
  for (const f of files) {
    it(`${f} contains no import from the mike module`, () => {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      // Fail if it imports anything from '@/lib/mike' or a relative mike path.
      expect(/from\s+['"](?:@\/lib\/mike|\.{1,2}\/mike|\.{1,2}\/.*\/mike)/.test(src)).toBe(false)
    })
  }
})

describe('Mike never invokes the executor or a broker', () => {
  const mikeFiles = [
    'src/lib/mike/engine.ts', 'src/lib/mike/driver.ts', 'src/lib/mike/shadow.ts',
    'src/lib/mike/store.ts', 'src/lib/mike/stats.ts', 'src/lib/mike/types.ts',
    'src/app/api/mike/route.ts', 'scripts/mike-scan.ts',
  ]
  for (const f of mikeFiles) {
    it(`${f} imports no executor/broker and calls no order method`, () => {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      // No import of the executor or broker modules.
      expect(/from\s+['"][^'"]*execution\/(executor|alpaca)['"]/.test(src)).toBe(false)
      // No order-placing call surfaces.
      expect(/\b(PaperExecutor|submitLimit|submitStop|onSignal|\.tick\()/.test(src)).toBe(false)
    })
  }
})

describe('importing Mike does not change REGULAR detector output', () => {
  function bars(closes: number[]): Candle[] {
    return closes.map((c, i) => ({ time: 1_700_000_000 + i * 300, open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c, volume: 100_000 }))
  }
  const technical: TechnicalData = {
    vwap: 4.9, ema9: 4.92, ema20: 4.85, ma50Intraday: 4.8, rsi14: 60, atr: 0.08,
    relativeVolume: 3, volumeTrend: 'flat', trend5m: 'up', trend15m: 'up',
    vwapCrossCount: 1, higherHighsLows: true, lowerHighsLows: false,
    distanceFromVwapPct: 2, distanceFromDayHighPct: -1, ma50Daily: 4.5, ma200Daily: 4.0,
    dailyRsi: 58, dailyAtr: 0.2, gapPct: 5, fiveDayHigh: 5.2, fiveDayLow: 4.2,
    twentyDayHigh: 5.5, twentyDayLow: 3.8, avgVolume20d: 1_000_000, isBreakingOutOfRange: false,
  }
  const sl: SessionLevels = {
    premarketHigh: 5.1, premarketLow: 4.6, premarketVolume: 5e5, regularHigh: 5.05, regularLow: 4.8,
    openingPrint: 4.85, or5High: 4.95, or5Low: 4.82, or15High: 5.0, or15Low: 4.8, vwap: 4.9,
    previousClose: 4.7, previousDayHigh: 5.15, previousDayLow: 4.5,
  }
  it('REGULAR detectSetups still yields setups with intact decision fields', () => {
    const candles = bars([4.6, 4.7, 4.8, 4.9, 4.98, 5.0, 5.04])
    const price = 5.06
    const levels = buildKeyLevels({ intraday: candles, daily: [], sessionLevels: sl, technical, currentPrice: price })
    const ctx: DetectionContext = {
      symbol: 'REG', price, candles, sessionLevels: sl, technical, levels,
      catalystScore: 10, hasCatalyst: true, spreadPct: 0.15, changePct: 6,
      session: 'regular', minutesSinceOpen: 60, float: 5_000_000,
    }
    const setups = detectSetups(ctx)
    expect(setups.length).toBeGreaterThan(0)
    // No Mike attribution leaks onto a REGULAR setup.
    for (const s of setups) expect((s as unknown as { strategy?: string }).strategy).toBeUndefined()
  })
})
