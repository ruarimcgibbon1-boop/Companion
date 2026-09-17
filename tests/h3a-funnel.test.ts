/**
 * H3A — full-funnel observability tests.
 *
 * Proves: sweep identity; gate decomposition truthfully represents off-high / grade /
 * multi-fail / pass; the legacy classifyBuy verdict is UNCHANGED and equals the
 * decomposed verdict (BASE invariance for the gate stack); telemetry write failure is
 * non-throwing and mutates nothing; schema/secret safety.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { classifyBuy, decomposeGates } from '../src/lib/buy-log'
import {
  emitFunnel, newSweepId, funnelFile, funnelDegraded, FUNNEL_SCHEMA_VERSION, type SweepContext,
} from '../src/lib/telemetry/funnel'
import type { DetectedSetup, MonitorResult, BuySignalRecord } from '../src/types'

// ── fixtures (only the fields the gate stack reads) ──────────────────────────
function mkSetup(o: Partial<DetectedSetup> = {}): DetectedSetup {
  const base = {
    id: 'AAA:premarket_breakout:9.00', symbol: 'AAA', type: 'premarket_breakout',
    direction: 'long', triggeredRaw: true, qualityVetoed: false, state: 'triggered',
    grade: 'C', score: 60, confidence: 60,
    entryFill: 9.0, zoneLower: 8.9, zoneUpper: 9.0, invalidation: 8.5, stopReference: 8.5,
    targets: [{ price: 9.9, label: 'T1', rewardRisk: 1.8 }], rewardRisk: 1.8,
    breakdown: { levelQuality: 12 }, signal: { triggerPrice: 9.0 }, spaceR: 1.2,
    gateGeometry: {
      offHighPct: -1, fadedChase: false, runUpPct: 5, lateInLeg: false, unconfirmed: false,
      quarantined: false, spaceR: 1.2, noRoom: false, vetoTriggerActive: false, extended: false, unaccepted: false,
    },
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
const ctx = (buys: BuySignalRecord[] = [], now = PM) => ({ now, priorBuys: buys, priorLogs: [], priorStates: [] })
const gate = (gates: ReturnType<typeof decomposeGates>['gates'], id: string) => gates.find(g => g.gateId === id)!

// ── A. sweep identity ────────────────────────────────────────────────────────
describe('H3A sweep identity', () => {
  it('mints distinct ids across sweeps', () => {
    const a = newSweepId(); const b = newSweepId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^sweep-\d+-\d+-[a-z0-9]+$/)
  })
})

// ── B/C. gate telemetry + BASE invariance (decomposed verdict === classifyBuy) ──
describe('H3A gate decomposition', () => {
  const cases: Array<[string, DetectedSetup, MonitorResult]> = [
    ['clean pass', mkSetup(), mkResult()],
    ['grade floor', mkSetup({ grade: 'below', type: 'break_of_structure' }),
      mkResult({ technicals: { distanceFromDayHighPct: -1 } as MonitorResult['technicals'] })],
    ['off-high veto', mkSetup({ qualityVetoed: true, gateGeometry: {
      offHighPct: -8, fadedChase: true, runUpPct: 30, lateInLeg: false, unconfirmed: false, quarantined: false,
      spaceR: 1.1, noRoom: false, vetoTriggerActive: false, extended: false, unaccepted: false } }), mkResult()],
    ['off-high + grade', mkSetup({ grade: 'below', type: 'break_of_structure', qualityVetoed: true,
      gateGeometry: { offHighPct: -9, fadedChase: true, runUpPct: 30, lateInLeg: false, unconfirmed: false,
        quarantined: false, spaceR: 1.1, noRoom: false, vetoTriggerActive: false, extended: false, unaccepted: false } }),
      mkResult()],
    ['no room', mkSetup({ qualityVetoed: true, spaceR: 0.3, gateGeometry: {
      offHighPct: -1, fadedChase: false, runUpPct: 5, lateInLeg: false, unconfirmed: false, quarantined: false,
      spaceR: 0.3, noRoom: true, vetoTriggerActive: false, extended: false, unaccepted: false } }), mkResult()],
    ['volume floor', mkSetup(), mkResult({ premarketVolume: 20_000, relativeVolume: 3 })],
  ]

  it('decomposed verdict always equals the legacy classifyBuy verdict (BASE invariance)', () => {
    for (const [name, s, r] of cases) {
      const legacy = classifyBuy(s, r, ctx()).verdict
      const decomposed = decomposeGates(s, r, ctx()).verdict
      expect(decomposed, name).toBe(legacy)
    }
  })

  it('represents an off-high-only veto explicitly and as binding', () => {
    const [, s, r] = cases[2]
    const { verdict, gates } = decomposeGates(s, r, ctx())
    expect(verdict).toBe('veto')
    expect(gate(gates, 'off_high').result).toBe('FAIL')
    expect(gate(gates, 'off_high').observedValue).toBe(-8)
    expect(gate(gates, 'off_high').binding).toBe(true)      // sole failing quality gate
    expect(gate(gates, 'grade_floor').result).toBe('PASS')
  })

  it('represents a grade-only veto explicitly', () => {
    const [, s, r] = cases[1]
    const { gates } = decomposeGates(s, r, ctx())
    expect(gate(gates, 'grade_floor').result).toBe('FAIL')
    expect(gate(gates, 'grade_floor').binding).toBe(true)
    expect(gate(gates, 'off_high').result).toBe('PASS')
  })

  it('marks multiple simultaneous veto sub-gates as binding=unknown', () => {
    const [, s, r] = cases[3]
    const { gates } = decomposeGates(s, r, ctx())
    expect(gate(gates, 'off_high').result).toBe('FAIL')
    expect(gate(gates, 'grade_floor').result).toBe('FAIL')
    expect(gate(gates, 'off_high').binding).toBe('unknown')
    expect(gate(gates, 'grade_floor').binding).toBe('unknown')
  })

  it('marks gates after the binding tier NOT_APPLICABLE (short-circuit truth)', () => {
    // volume fails → veto/dedupe tiers were never reached by classifyBuy.
    const { verdict, gates } = decomposeGates(mkSetup(), mkResult({ premarketVolume: 20_000, relativeVolume: 3 }), ctx())
    expect(verdict).toBe('volume')
    expect(gate(gates, 'off_high').result).toBe('NOT_APPLICABLE')
    expect(gate(gates, 'dedupe').result).toBe('NOT_APPLICABLE')
  })

  it('a clean pass shows all gates PASS and none binding', () => {
    const { verdict, gates } = decomposeGates(mkSetup(), mkResult(), ctx())
    expect(verdict).toBe('logged')
    expect(gates.every(g => g.result === 'PASS')).toBe(true)
    expect(gates.every(g => g.binding === false)).toBe(true)
  })
})

// ── D/E/F/G. emit: schema, secret-safety, failure semantics ──────────────────
describe('H3A funnel emit', () => {
  let dir: string
  const sweep: SweepContext = { sweepId: 'sweep-test-1', producerHead: 'abc123' }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'funnel-')); process.env.COMPANION_FUNNEL_DIR = dir })
  afterEach(() => { delete process.env.COMPANION_FUNNEL_DIR; rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  const readAll = () => {
    const f = readdirSync(dir).find(n => n.startsWith('.companion-funnel-'))
    return f ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  }

  it('stamps schemaVersion, tsUtc, sweepId, producerHead, eventType', () => {
    emitFunnel(sweep, 'sweep_started', { session: 'premarket', universeSize: 15 })
    const [rec] = readAll()
    expect(rec.schemaVersion).toBe(FUNNEL_SCHEMA_VERSION)
    expect(rec.eventType).toBe('sweep_started')
    expect(rec.sweepId).toBe('sweep-test-1')
    expect(rec.producerHead).toBe('abc123')
    expect(typeof rec.tsUtc).toBe('string')
    expect(rec.universeSize).toBe(15)
  })

  it('all events from one sweep share the sweepId; a new sweep differs', () => {
    emitFunnel(sweep, 'sweep_started', {})
    emitFunnel(sweep, 'gate_evaluation', { symbol: 'AAA' })
    const other: SweepContext = { sweepId: newSweepId(), producerHead: 'abc123' }
    emitFunnel(other, 'sweep_started', {})
    const recs = readAll()
    expect(recs.filter(r => r.sweepId === 'sweep-test-1')).toHaveLength(2)
    expect(recs.filter(r => r.sweepId === other.sweepId)).toHaveLength(1)
    expect(other.sweepId).not.toBe('sweep-test-1')
  })

  it('redacts secret-shaped keys (never writes credentials)', () => {
    emitFunnel(sweep, 'discovery_observed', {
      symbol: 'AAA', apiKey: 'sk-should-not-appear', nested: { fmpSecret: 'zzz', accessToken: 'ttt', safe: 1 },
    })
    const raw = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')
    expect(raw).not.toContain('sk-should-not-appear')
    expect(raw).not.toContain('zzz')
    expect(raw).not.toContain('ttt')
    expect(raw).toContain('[REDACTED]')
    expect(JSON.parse(raw).nested.safe).toBe(1)
  })

  it('a write failure never throws, never blocks, and reports degraded after repeats', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Point the sink at a directory that does not exist → appendFileSync throws ENOENT
    // (it does not create parent dirs). This exercises the REAL failure path.
    process.env.COMPANION_FUNNEL_DIR = join(dir, 'does', 'not', 'exist')
    expect(() => { for (let i = 0; i < 6; i++) emitFunnel(sweep, 'sweep_started', { i }) }).not.toThrow()
    expect(funnelDegraded()).toBe(true)
    // recovers on the next successful write (back to the real temp dir)
    process.env.COMPANION_FUNNEL_DIR = dir
    emitFunnel(sweep, 'sweep_started', { ok: true })
    expect(funnelDegraded()).toBe(false)
  })

  it('RESEARCH INTEGRITY: recovery writes a durable telemetry_gap marker recording the loss', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.env.COMPANION_FUNNEL_DIR = join(dir, 'nope')     // all writes fail
    for (let i = 0; i < 3; i++) emitFunnel(sweep, 'sweep_started', { i })
    process.env.COMPANION_FUNNEL_DIR = dir                    // recover
    emitFunnel(sweep, 'gate_evaluation', { symbol: 'AAA' })
    const recs = readAll()
    const gap = recs.find(r => r.eventType === 'telemetry_gap')
    expect(gap, 'a telemetry_gap marker is persisted on recovery').toBeTruthy()
    expect(gap.droppedEvents).toBe(3)
    expect(gap.sweepId).toBe('sweep-test-1')
    // A later audit reading ONLY the file can now see the session dropped events.
    expect(recs.some(r => r.eventType === 'gate_evaluation')).toBe(true)
  })

  it('funnelFile honors the test dir override and defaults to a per-day name', () => {
    expect(funnelFile('2026-09-17')).toBe(join(dir, '.companion-funnel-2026-09-17.jsonl'))
    expect(existsSync(dir)).toBe(true)
  })

  it('END-TO-END JOIN: a full sweep is joinable by sweepId / symbol / setupId (§5)', () => {
    const s: SweepContext = { sweepId: newSweepId(), producerHead: 'abc123' }
    const sid = 'MEDS:breakout:6.00'
    // one sweep, one symbol MEDS with one setup, through every stage
    emitFunnel(s, 'sweep_started', { session: 'premarket', universeSize: 15 })
    emitFunnel(s, 'discovery_observed', { symbols: [{ symbol: 'MEDS', source: 'webull', changePct: 300, mergedEligible: true }] })
    emitFunnel(s, 'universe_decision', { symbol: 'MEDS', strategyId: 'BASE', monitored: true })
    emitFunnel(s, 'strategy_trigger', { symbol: 'MEDS', strategyId: 'BASE', setupId: sid, setupType: 'breakout', verdict: 'veto' })
    emitFunnel(s, 'gate_evaluation', { symbol: 'MEDS', strategyId: 'BASE', setupId: sid, setupType: 'breakout', verdict: 'veto', gates: [] })
    emitFunnel(s, 'arbitration_decision', { eligibleSetupIds: [sid] })
    emitFunnel(s, 'execution_handoff', { symbol: 'MEDS', strategyId: 'BASE', setupId: sid, submitted: false })
    const recs = readAll().filter(r => r.sweepId === s.sweepId)

    // sweepId threads every event of the sweep.
    expect(recs).toHaveLength(7)
    expect(recs.every(r => r.sweepId === s.sweepId)).toBe(true)
    // symbol joins the per-symbol stages.
    const bySymbol = recs.filter(r => r.symbol === 'MEDS')
    expect(bySymbol.map(r => r.eventType).sort()).toEqual(
      ['execution_handoff', 'gate_evaluation', 'strategy_trigger', 'universe_decision'])
    // setupId gives an UNAMBIGUOUS 1:1:1 join trigger↔gate↔handoff, and links arbitration.
    const bySetup = recs.filter(r => r.setupId === sid)
    expect(bySetup.map(r => r.eventType).sort()).toEqual(['execution_handoff', 'gate_evaluation', 'strategy_trigger'])
    const arb = recs.find(r => r.eventType === 'arbitration_decision')!
    expect(arb.eligibleSetupIds).toContain(sid)
    // discovery is per-symbol (no setupId) — the legitimate 1→many symbol→setups edge.
    const disc = recs.find(r => r.eventType === 'discovery_observed')!
    expect(disc.symbols[0].symbol).toBe('MEDS')
    // strategyId present wherever a strategy is known.
    expect(recs.filter(r => r.strategyId).every(r => r.strategyId === 'BASE')).toBe(true)
  })
})
