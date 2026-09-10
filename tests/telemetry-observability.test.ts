/**
 * Telemetry-observability guardrails.
 *
 * These prove the evidence-collection additions are OBSERVATIONAL: they surface
 * values already computed, and they change no decision, gate, or slot arithmetic.
 *
 *  - DetectedSetup.levelStrength / .spaceR are exposed copies of the values the
 *    scorer and the SPACE gate already computed. `spaceR` is asserted EQUAL to the
 *    gate's own spaceToNextSupply reading, so exposing it cannot change the veto
 *    (the veto reads the same local value).
 *  - PaperExecutor.observeCapacity() is read-only: it mutates nothing and calls the
 *    broker for nothing.
 */
import { describe, it, expect } from 'vitest'
import {
  detectSetups, spaceToNextSupply, type DetectionContext,
} from '../src/lib/setup-detectors'
import { buildKeyLevels } from '../src/lib/levels-engine'
import { PaperExecutor, DEFAULT_EXECUTOR, type PriceFetcher } from '../src/lib/execution/executor'
import type { Broker } from '../src/lib/execution/types'
import type { Candle, SessionLevels, TechnicalData } from '../src/types'

// ── Shared detection-context harness (mirrors tests/signal-quality.test.ts) ──
function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 300,
    open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c, volume: 100_000,
  }))
}
function technical(over: Partial<TechnicalData> = {}): TechnicalData {
  return {
    vwap: 4.9, ema9: 4.92, ema20: 4.85, ma50Intraday: 4.8, rsi14: 60, atr: 0.08,
    relativeVolume: 3, volumeTrend: 'flat', trend5m: 'up', trend15m: 'up',
    vwapCrossCount: 1, higherHighsLows: true, lowerHighsLows: false,
    distanceFromVwapPct: 2, distanceFromDayHighPct: -1, ma50Daily: 4.5, ma200Daily: 4.0,
    dailyRsi: 58, dailyAtr: 0.2, gapPct: 5, fiveDayHigh: 5.2, fiveDayLow: 4.2,
    twentyDayHigh: 5.5, twentyDayLow: 3.8, avgVolume20d: 1_000_000, isBreakingOutOfRange: false,
    ...over,
  }
}
function session(over: Partial<SessionLevels> = {}): SessionLevels {
  return {
    premarketHigh: 5.1, premarketLow: 4.6, premarketVolume: 500_000, regularHigh: 5.05,
    regularLow: 4.8, openingPrint: 4.85, or5High: 4.95, or5Low: 4.82, or15High: 5.0,
    or15Low: 4.8, vwap: 4.9, previousClose: 4.7, previousDayHigh: 5.15, previousDayLow: 4.5,
    ...over,
  }
}
function ctx(candles: Candle[], price: number, over: Partial<DetectionContext> = {}): DetectionContext {
  const sl = session({ vwap: over.sessionLevels?.vwap ?? price })
  const t = technical(over.technical)
  const levels = buildKeyLevels({ intraday: candles, daily: [], sessionLevels: sl, technical: t, currentPrice: price })
  return {
    symbol: 'TEST', price, candles, sessionLevels: sl, technical: t, levels,
    catalystScore: 10, hasCatalyst: true, spreadPct: 0.15, changePct: 6,
    session: 'regular', minutesSinceOpen: 60, float: 5_000_000, ...over,
  }
}

describe('additive setup telemetry (levelStrength, spaceR)', () => {
  const rising = bars([4.6, 4.7, 4.8, 4.9, 4.98, 5.0, 5.04])
  const setups = detectSetups(ctx(rising, 5.06))

  it('produces setups, and each carries the two observational fields', () => {
    expect(setups.length).toBeGreaterThan(0)
    for (const s of setups) {
      // present, and of the right shape (number OR explicit null — never fabricated)
      expect(s.levelStrength === null || typeof s.levelStrength === 'number').toBe(true)
      expect(s.spaceR === null || typeof s.spaceR === 'number').toBe(true)
    }
  })

  it('spaceR EQUALS the SPACE gate\'s own reading (so exposing it cannot change the veto)', () => {
    const levels = ctx(rising, 5.06).levels   // the same levels the detectors saw
    for (const s of setups) {
      const riskDist = Math.abs(s.entryFill! - s.stopReference)
      const recomputed = spaceToNextSupply(levels, s.entryFill!, riskDist, s.direction).r
      expect(s.spaceR ?? null).toBe(recomputed ?? null)
    }
  })

  it('leaves the decision-relevant fields intact and well-formed', () => {
    for (const s of setups) {
      expect(typeof s.score).toBe('number')
      expect(['identified', 'approaching', 'at_level', 'confirming', 'triggered', 'failed', 'expired']).toContain(s.state)
      expect(typeof s.triggeredRaw === 'boolean' || s.triggeredRaw === undefined).toBe(true)
    }
  })
})

// ── observeCapacity: read-only, no broker call ───────────────────────────────
class ThrowingBroker implements Broker {
  readonly name = 'throwing'
  calls = 0
  async getAccount(): Promise<never> { this.calls++; throw new Error('observeCapacity must not call the broker') }
  async getAsset(): Promise<never> { this.calls++; throw new Error('no broker calls') }
  async getPositions(): Promise<never> { this.calls++; throw new Error('no broker calls') }
  async getPosition(): Promise<never> { this.calls++; throw new Error('no broker calls') }
  async submitLimit(): Promise<never> { this.calls++; throw new Error('no broker calls') }
  async submitStop(): Promise<never> { this.calls++; throw new Error('no broker calls') }
  async getOrder(): Promise<never> { this.calls++; throw new Error('no broker calls') }
  async cancelOrder(): Promise<void> { this.calls++; throw new Error('no broker calls') }
  async cancelOpenOrders(): Promise<never> { this.calls++; throw new Error('no broker calls') }
}
const noPrices: PriceFetcher = async () => new Map()

describe('PaperExecutor.observeCapacity — observational only', () => {
  it('reports free slots from local state without calling the broker', () => {
    const broker = new ThrowingBroker()
    const ex = new PaperExecutor(broker, noPrices, DEFAULT_EXECUTOR, () => {})
    const before = ex.allTrades()
    const cap = ex.observeCapacity('regular')

    expect(broker.calls).toBe(0)                                  // no broker touched
    expect(ex.allTrades()).toBe(before)                           // no mutation (same array ref)
    expect(cap.maxConcurrentPositions).toBe(DEFAULT_EXECUTOR.risk.maxConcurrentPositions)
    expect(cap.openCount).toBe(0)
    expect(cap.freeConcurrentSlots).toBe(DEFAULT_EXECUTOR.risk.maxConcurrentPositions)
    expect(cap.session).toBe('regular')
    // regular session → premarket-budget fields are explicit null
    expect(cap.premarketTradeCount).toBeNull()
    expect(cap.maxPremarketTrades).toBeNull()
  })

  it('populates the premarket-budget fields only in premarket', () => {
    const ex = new PaperExecutor(new ThrowingBroker(), noPrices, DEFAULT_EXECUTOR, () => {})
    const cap = ex.observeCapacity('premarket')
    expect(cap.maxPremarketTrades).toBe(DEFAULT_EXECUTOR.risk.maxPremarketTrades)
    expect(cap.premarketTradeCount).toBe(0)
    expect(typeof cap.premarketLossLimit).toBe('number')
  })
})
