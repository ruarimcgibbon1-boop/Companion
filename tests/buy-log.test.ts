import { describe, it, expect } from 'vitest'
import { classifyBuy, passesTrackingFloor } from '../src/lib/buy-log'
import type { DetectedSetup, MonitorResult, BuySignalRecord, SetupLog, SetupStateRecord } from '../src/types'

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
    // Restored 2026-08-11 after VATE filled 3× for −$1,306 (65% of that day's loss)
    // with the cap off. Two priors >3% apart, so the third is caught by the CAP and
    // not merely by the entry-cluster dedup.
    const prior = [buyRec('AAA', 8.0, PM - 2000), buyRec('AAA', 8.4, PM - 1000)]
    const s3 = mkSetup({ entryFill: 9.5, zoneUpper: 9.5, id: 'AAA:premarket_breakout:9.50' })
    expect(classifyBuy(s3, mkResult({ price: 9.5 }), ctx(prior)).verdict).toBe('capped')
    // Near-high + 40× RVOL no longer buys a higher ceiling (see reverted override).
    const rStrong = mkResult({ price: 9.5, relativeVolume: 40, technicals: { distanceFromDayHighPct: -0.5 } as MonitorResult['technicals'] })
    expect(classifyBuy(s3, rStrong, ctx(prior)).verdict).toBe('capped')
  })

  it('dedups a near-identical re-fire before the cap is even reached', () => {
    const prior = [buyRec('AAA', 9.0, PM - 1000)]
    expect(classifyBuy(mkSetup(), mkResult(), ctx(prior)).verdict).toBe('dup')
  })

  it('dedups a near-identical re-fire on the same name', () => {
    expect(classifyBuy(mkSetup(), mkResult(), ctx([buyRec('AAA', 9.0, PM - 1000)])).verdict).toBe('dup')
  })
})

// ── One decision engine: the win/loss cap and failed-bounce stand-down ─────────
// These two gates read priorLogs / priorStates. The alert daemon and the recall
// harness pass [] for both (they don't run the full state machine), so those gates
// no-op there — but the LIVE client (useMonitor) and the REPLAY (backtest) BOTH now
// feed real logs/states into this same classifyBuy. These tests pin that shared
// behaviour so live and replay can't diverge on the cap or the stand-down.
function mkLog(o: Partial<SetupLog>): SetupLog {
  return { id: 'AAA:s1', symbol: 'AAA', direction: 'long', outcome: 'invalidated', resolvedAt: PM - 1000, ...o } as unknown as SetupLog
}
function mkState(o: Partial<SetupStateRecord>): SetupStateRecord {
  return { symbol: 'AAA', type: 'vwap_bounce', state: 'failed', updatedAt: PM - 1000, ...o } as unknown as SetupStateRecord
}

describe('classifyBuy — win/loss cap and stand-down (live + replay paths)', () => {
  // A prior LOGGED entry on the name whose setup log has since latched to a loss
  // stands the whole name down for the cooldown (BRAI 2026-07-13). The loss is only
  // seen when priorLogs+priorBuys are supplied — the daemon, passing [], would log.
  it('caps a name after a prior logged entry became a loss', () => {
    const priorBuys = [buyRec('AAA', 6.0, PM - 3000)]
    priorBuys[0].setupId = 'AAA:s1'   // ties the buy to the losing log below
    const ctxWithLoss = { now: PM, priorBuys, priorLogs: [mkLog({ id: 'AAA:s1', outcome: 'invalidated' })], priorStates: [] }
    // Entry far from the prior (6.0) so this is the CAP firing, not the dedup.
    const s = mkSetup({ entryFill: 9.0, zoneUpper: 9.0 })
    expect(classifyBuy(s, mkResult(), ctxWithLoss).verdict).toBe('capped')
    // Same inputs but the loss unknown (daemon/recall style) → it logs. This IS the
    // live-vs-daemon difference, and why live + replay must pass the logs.
    expect(classifyBuy(s, mkResult(), { now: PM, priorBuys, priorLogs: [], priorStates: [] }).verdict).toBe('logged')
  })

  it('caps a name after 2 banked wins', () => {
    const priorLogs = [mkLog({ id: 'AAA:w1', outcome: 'target_hit' }), mkLog({ id: 'AAA:w2', outcome: 'target_hit' })]
    const s = mkSetup({ entryFill: 9.0, zoneUpper: 9.0 })
    expect(classifyBuy(s, mkResult(), { now: PM, priorBuys: [], priorLogs, priorStates: [] }).verdict).toBe('capped')
  })

  it('stands a bounce setup down after a recent failed bounce on the name', () => {
    const s = mkSetup({ type: 'vwap_bounce', id: 'AAA:vwap_bounce:9.00' })
    const stood = { now: PM, priorBuys: [], priorLogs: [], priorStates: [mkState({ type: 'vwap_bounce' })] }
    expect(classifyBuy(s, mkResult(), stood).verdict).toBe('standDown')
    // No failed-bounce state → the same setup logs. The gate is the state, nothing else.
    expect(classifyBuy(s, mkResult(), { now: PM, priorBuys: [], priorLogs: [], priorStates: [] }).verdict).toBe('logged')
  })

  it('does NOT stand a momentum breakout down for a failed bounce (only bounce types)', () => {
    const s = mkSetup({ type: 'break_of_structure', grade: 'C', id: 'AAA:break_of_structure:9.00' })
    const r = mkResult({ technicals: { distanceFromDayHighPct: -0.5 } as MonitorResult['technicals'] })
    expect(classifyBuy(s, r, { now: PM, priorBuys: [], priorLogs: [], priorStates: [mkState({ type: 'vwap_bounce' })] }).verdict).toBe('logged')
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
