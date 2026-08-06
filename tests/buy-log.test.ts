import { describe, it, expect } from 'vitest'
import { classifyBuy, passesTrackingFloor } from '../src/lib/buy-log'
import type { DetectedSetup, MonitorResult, BuySignalRecord } from '../src/types'

// Minimal fixtures — only the fields classifyBuy / passesTrackingFloor read.
function mkSetup(o: Partial<DetectedSetup> = {}): DetectedSetup {
  const base = {
    id: 'AAA:premarket_breakout:9.00', symbol: 'AAA', type: 'premarket_breakout',
    direction: 'long', triggeredRaw: true, qualityVetoed: false,
    grade: 'C', score: 60, confidence: 60,
    entryFill: 9.0, zoneLower: 8.9, zoneUpper: 9.0, invalidation: 8.5, stopReference: 8.5,
    targets: [{ price: 9.9, label: 'T1', rewardRisk: 1.8 }], rewardRisk: 1.8,
    breakdown: { levelQuality: 12 }, signal: { triggerPrice: 9.0 },
  }
  return { ...base, ...o } as unknown as DetectedSetup
}
function mkResult(o: Partial<MonitorResult> = {}): MonitorResult {
  const base = {
    symbol: 'AAA', price: 9.0, volume: 200_000, relativeVolume: 5, premarketVolume: 100_000,
    integrity: { session: 'premarket' },
    technicals: { distanceFromDayHighPct: -1, trend15m: 'up', distanceFromVwapPct: 1, higherHighsLows: true, atrPct: 5 },
  }
  return { ...base, ...o } as unknown as MonitorResult
}
function buyRec(symbol: string, entryHigh: number, timestamp: number): BuySignalRecord {
  return { symbol, entryHigh, timestamp, setupId: `${symbol}:x`, id: `${symbol}:x:${timestamp}` } as unknown as BuySignalRecord
}

const PM = Date.parse('2026-08-05T08:00:00-04:00')    // premarket ET
const RTH = Date.parse('2026-08-05T10:00:00-04:00')   // regular, before the 14:00 cutoff
const LATE = Date.parse('2026-08-05T15:00:00-04:00')  // regular, after the 14:00 cutoff
const ctx = (buys: BuySignalRecord[] = [], now = PM) => ({ now, priorBuys: buys, priorLogs: [], priorStates: [] })

describe('classifyBuy', () => {
  it('logs a clean premarket breakout', () => {
    expect(classifyBuy(mkSetup(), mkResult(), ctx()).verdict).toBe('logged')
  })

  it('floors a below-grade, non-exempt setup', () => {
    const s = mkSetup({ grade: 'below', type: 'break_of_structure' })
    const r = mkResult({ relativeVolume: 4, technicals: { distanceFromDayHighPct: -6 } as MonitorResult['technicals'] })
    expect(classifyBuy(s, r, ctx()).verdict).toBe('veto')
  })

  // The grade floor holds even for a near-high, huge-RVOL breakout. A
  // "strong continuation" override that exempted exactly this case was shipped
  // 2026-08-06 and reverted 2026-08-07: a clean A/B showed it added 38 signals
  // but cut expectancy from +0.76% to +0.41%/trade. Locking the behaviour in.
  it('does NOT exempt a below-grade near-high high-RVOL breakout (reverted override)', () => {
    const s = mkSetup({ grade: 'below', type: 'break_of_structure' })
    const r = mkResult({ relativeVolume: 40, technicals: { distanceFromDayHighPct: -0.5 } as MonitorResult['technicals'] })
    expect(classifyBuy(s, r, ctx()).verdict).toBe('veto')
  })

  it('drops a premarket signal below the volume floor with no surge', () => {
    expect(classifyBuy(mkSetup(), mkResult({ premarketVolume: 20_000, relativeVolume: 3 }), ctx()).verdict).toBe('volume')
  })

  it('a strong RVOL surge clears the premarket volume floor (YXT fix)', () => {
    expect(classifyBuy(mkSetup(), mkResult({ premarketVolume: 20_000, relativeVolume: 15 }), ctx()).verdict).toBe('logged')
  })

  it('blocks regular-hours entries after 14:00 ET, allows them before', () => {
    const r = mkResult({ integrity: { session: 'regular' } as MonitorResult['integrity'], volume: 500_000 })
    expect(classifyBuy(mkSetup(), r, ctx([], LATE)).verdict).toBe('session')
    expect(classifyBuy(mkSetup(), r, ctx([], RTH)).verdict).toBe('logged')
  })

  it('caps a name at 2 logs per session — including a strong runner', () => {
    const prior = [buyRec('AAA', 8.0, PM - 2000), buyRec('AAA', 8.4, PM - 1000)]  // 2 prior, >3% apart
    const s3 = mkSetup({ entryFill: 9.5, zoneUpper: 9.5, id: 'AAA:premarket_breakout:9.50' })
    expect(classifyBuy(s3, mkResult({ price: 9.5 }), ctx(prior)).verdict).toBe('capped')
    // Near-high + 40× RVOL no longer buys a higher ceiling (see reverted override).
    const rStrong = mkResult({ price: 9.5, relativeVolume: 40, technicals: { distanceFromDayHighPct: -0.5 } as MonitorResult['technicals'] })
    expect(classifyBuy(s3, rStrong, ctx(prior)).verdict).toBe('capped')
  })

  it('dedups a near-identical re-fire on the same name', () => {
    expect(classifyBuy(mkSetup(), mkResult(), ctx([buyRec('AAA', 9.0, PM - 1000)])).verdict).toBe('dup')
  })
})

describe('passesTrackingFloor', () => {
  it('passes a high score regardless of level quality', () => {
    expect(passesTrackingFloor(mkSetup({ score: 70, confidence: 20, breakdown: { levelQuality: 0 } as DetectedSetup['breakdown'] }), 40)).toBe(true)
  })
  it('drops a low score with weak level quality and confidence', () => {
    expect(passesTrackingFloor(mkSetup({ score: 40, confidence: 20, breakdown: { levelQuality: 1 } as DetectedSetup['breakdown'] }), 40)).toBe(false)
  })
})
