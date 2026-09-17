/**
 * H3A — GATE TELEMETRY CONTRACT (red-team §1).
 *
 * Proves decomposeGates() is a faithful MIRROR of classifyBuy(), never a second truth:
 *   1. classifyBuy() remains the authoritative verdict.
 *   2. decomposeGates().verdict === classifyBuy().verdict on the full meaningful
 *      cross-product (off-high, grade pass/fail/exempt, space, volume, session, runup,
 *      dedupe, same-symbol cap) INCLUDING multi-failure cases.
 *   3. gate attribution is consistent with that verdict: the binding gate(s) name the
 *      verdict's tier; a bound veto ALWAYS has ≥1 veto sub-gate FAIL (never unattributed,
 *      even when gateGeometry is absent/inconsistent); gates past the binding tier are
 *      NOT_APPLICABLE; a logged setup has all gates PASS and none binding.
 */
import { describe, it, expect } from 'vitest'
import { classifyBuy, decomposeGates, type BuyGateRecord } from '../src/lib/buy-log'
import type { DetectedSetup, MonitorResult, BuySignalRecord } from '../src/types'

type GG = NonNullable<DetectedSetup['gateGeometry']>
const GG0: GG = {
  offHighPct: -1, fadedChase: false, runUpPct: 5, lateInLeg: false, unconfirmed: false,
  quarantined: false, spaceR: 1.2, noRoom: false, vetoTriggerActive: false, extended: false, unaccepted: false,
}
function mkSetup(o: Partial<DetectedSetup> = {}, gg: Partial<GG> | null = {}): DetectedSetup {
  const base = {
    id: 'AAA:premarket_breakout:9.00', symbol: 'AAA', type: 'premarket_breakout', direction: 'long',
    triggeredRaw: true, qualityVetoed: false, state: 'triggered', grade: 'C', score: 60, confidence: 60,
    entryFill: 9.0, zoneLower: 8.9, zoneUpper: 9.0, invalidation: 8.5, stopReference: 8.5,
    targets: [{ price: 9.9, label: 'T1', rewardRisk: 1.8 }], rewardRisk: 1.8, spaceR: 1.2,
    breakdown: { levelQuality: 12 }, signal: { triggerPrice: 9.0 },
    gateGeometry: gg === null ? undefined : { ...GG0, ...gg },
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
const PM = Date.parse('2026-08-05T08:00:00-04:00')
const LATE = Date.parse('2026-08-05T15:00:00-04:00')
function buyRec(symbol: string, entryHigh: number, timestamp: number): BuySignalRecord {
  return { symbol, entryHigh, timestamp, setupId: `${symbol}:x`, id: `${symbol}:x:${timestamp}` } as unknown as BuySignalRecord
}
const gate = (gates: BuyGateRecord[], id: string) => gates.find(g => g.gateId === id)!
const VETO_SUBS = ['off_high', 'grade_floor', 'space', 'runup', 'quality_other']

interface Case {
  name: string
  setup: DetectedSetup
  result: MonitorResult
  ctx: { now: number; priorBuys: BuySignalRecord[]; priorLogs: []; priorStates: [] }
  verdict: string
  bindingGates: string[]     // gates expected to have binding !== false
}
const C = (name: string, setup: DetectedSetup, result: MonitorResult, verdict: string, bindingGates: string[],
  extra: Partial<Case['ctx']> = {}): Case =>
  ({ name, setup, result, ctx: { now: PM, priorBuys: [], priorLogs: [], priorStates: [], ...extra }, verdict, bindingGates })

const cap2 = [buyRec('AAA', 8.0, PM - 2000), buyRec('AAA', 8.4, PM - 1000)]
const dup1 = [buyRec('AAA', 9.0, PM - 1000)]

const cases: Case[] = [
  C('clean logged', mkSetup(), mkResult(), 'logged', []),
  C('session fail (after 14:00)', mkSetup(), mkResult({ integrity: { session: 'regular' } as MonitorResult['integrity'], volume: 500_000 }), 'session', ['session'], { now: LATE }),
  C('volume fail (premarket, no surge)', mkSetup(), mkResult({ premarketVolume: 20_000, relativeVolume: 3 }), 'volume', ['premarket_volume']),
  C('off-high only', mkSetup({ qualityVetoed: true }, { fadedChase: true, offHighPct: -8 }), mkResult(), 'veto', ['off_high']),
  C('grade only (non-exempt)', mkSetup({ grade: 'below', type: 'break_of_structure' }), mkResult(), 'veto', ['grade_floor']),
  C('space only', mkSetup({ qualityVetoed: true, spaceR: 0.3 }, { noRoom: true, spaceR: 0.3 }), mkResult(), 'veto', ['space']),
  C('runup only', mkSetup({ qualityVetoed: true }, { lateInLeg: true, runUpPct: 40 }), mkResult(), 'veto', ['runup']),
  C('quality_other (unconfirmed)', mkSetup({ qualityVetoed: true }, { unconfirmed: true }), mkResult(), 'veto', ['quality_other']),
  C('off-high + grade (multi, unknown binding)', mkSetup({ grade: 'below', type: 'break_of_structure', qualityVetoed: true }, { fadedChase: true, offHighPct: -9 }), mkResult(), 'veto', ['off_high', 'grade_floor']),
  C('off-high + space (multi)', mkSetup({ qualityVetoed: true, spaceR: 0.2 }, { fadedChase: true, noRoom: true, spaceR: 0.2 }), mkResult(), 'veto', ['off_high', 'space']),
  C('grade EXEMPT (opening_drive below-grade → not veto → logged)', mkSetup({ grade: 'below', type: 'opening_drive' }, {}), mkResult({ integrity: { session: 'regular' } as MonitorResult['integrity'], volume: 500_000 }), 'logged', []),
  C('catch-all: qualityVetoed but geometry all-false', mkSetup({ qualityVetoed: true }, {}), mkResult(), 'veto', ['quality_other']),
  C('catch-all: qualityVetoed but geometry UNDEFINED', mkSetup({ qualityVetoed: true }, null), mkResult(), 'veto', ['quality_other']),
  C('capped', mkSetup({ entryFill: 9.5, zoneUpper: 9.5, id: 'AAA:premarket_breakout:9.50' }), mkResult({ price: 9.5 }), 'capped', ['same_symbol_cap'], { priorBuys: cap2 }),
  C('dedupe', mkSetup(), mkResult(), 'dup', ['dedupe'], { priorBuys: dup1 }),
  C('multi-tier: session fail dominates a would-be veto', mkSetup({ qualityVetoed: true }, { fadedChase: true, offHighPct: -8 }), mkResult({ integrity: { session: 'regular' } as MonitorResult['integrity'], volume: 500_000 }), 'session', ['session'], { now: LATE }),
  C('multi-tier: volume fail dominates a would-be veto', mkSetup({ qualityVetoed: true }, { fadedChase: true }), mkResult({ premarketVolume: 20_000, relativeVolume: 3 }), 'volume', ['premarket_volume']),
]

describe('H3A gate contract (decomposeGates mirrors classifyBuy)', () => {
  for (const c of cases) {
    it(`${c.name}`, () => {
      const legacy = classifyBuy(c.setup, c.result, c.ctx).verdict
      const { verdict, gates } = decomposeGates(c.setup, c.result, c.ctx)

      // 1 + 2: classifyBuy authoritative; decomposed verdict identical.
      expect(legacy, 'classifyBuy is authoritative for this case').toBe(c.verdict)
      expect(verdict, 'decomposed verdict mirrors classifyBuy').toBe(legacy)

      // 3a: exactly the expected gates are binding.
      const bound = gates.filter(g => g.binding !== false).map(g => g.gateId).sort()
      expect(bound).toEqual([...c.bindingGates].sort())

      // 3b: multi-veto binding is 'unknown'; single is true.
      const boundVetoSubs = gates.filter(g => VETO_SUBS.includes(g.gateId) && g.binding !== false)
      if (verdict === 'veto') {
        expect(boundVetoSubs.length, 'a bound veto always attributes ≥1 sub-gate').toBeGreaterThanOrEqual(1)
        const expectUnknown = boundVetoSubs.length > 1
        for (const g of boundVetoSubs) expect(g.binding).toBe(expectUnknown ? 'unknown' : true)
      }

      // 3c: every binding gate is itself FAIL.
      for (const g of gates) if (g.binding !== false) expect(g.result, `${g.gateId} binding⇒FAIL`).toBe('FAIL')

      // 3d: gates strictly past the binding tier are NOT_APPLICABLE.
      const order = ['session', 'volume', 'off_high', 'grade_floor', 'space', 'runup', 'quality_other', 'stand_down', 'same_symbol_cap', 'dedupe']
      if (verdict === 'session') {
        for (const id of order.slice(2)) expect(gate(gates, id).result, `${id} NA after session`).toBe('NOT_APPLICABLE')
      }
      if (verdict === 'volume') {
        for (const id of order.slice(2)) expect(gate(gates, id).result, `${id} NA after volume`).toBe('NOT_APPLICABLE')
      }
      if (verdict === 'veto') {
        for (const id of ['stand_down', 'same_symbol_cap', 'dedupe']) expect(gate(gates, id).result).toBe('NOT_APPLICABLE')
      }

      // 3e: logged ⇒ all PASS, none binding.
      if (verdict === 'logged') {
        expect(gates.every(g => g.result === 'PASS')).toBe(true)
        expect(gates.every(g => g.binding === false)).toBe(true)
      }
    })
  }
})
