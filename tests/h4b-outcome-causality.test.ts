/**
 * H4B — causal outcome evaluator: separated structural vs PROSPECTIVE outcome, frozen time origin,
 * terminal causality, same-bar ambiguity, tape completeness, missing bars, no-lookahead, session-end.
 * Golden A–F + M–T. Asserts research integrity, not profit.
 *
 * Frozen origin: primary outcome starts at the FIRST bar at/after candidateObservedAt; its close is
 * the outcome reference; prospective metrics are measured over bars STRICTLY AFTER that start bar.
 */
import { describe, it, expect } from 'vitest'
import { evaluateCandidateOutcome } from '../src/lib/leader/leader-continuation-outcome'
import type { ShadowCandidateEvent } from '../src/lib/leader/leader-continuation'
import type { TapeEvent, TapeCompleteness } from '../src/lib/research/tape-1m-replay'

const ANCHOR = Date.parse('2026-09-18T14:00:00Z')
const T0 = Math.floor(ANCHOR / 1000)   // anchor in unix sec; the start bar sits exactly here

// Structural: base.high 100, base.low 90 → structural R = 10.
function candidate(over: Partial<ShadowCandidateEvent> = {}): ShadowCandidateEvent {
  return {
    eventType: 'leader_continuation_candidate', strategyId: 'LEADER_CONTINUATION', mode: 'shadow',
    experimentSpecVersion: 'h4b-leadercont-2', experimentConfigHash: 'cfg', experimentEpoch: 'h4b-epoch-1',
    shadowCandidateId: 'lc-test', canonicalCandidateKey: 'lc|lc-id-2|AAA|ep-1|bs=1|be=2|cfg=cfg',
    symbol: 'AAA', leaderEpisodeId: 'ep-1', setupId: null,
    runId: 'r1', sweepId: 's1', candidateObservedAt: new Date(ANCHOR).toISOString(),
    leaderRole: 'CORE', leaderLifecycle: 'REEXPANDING', historyComplete: true,
    globalOffHighPct: -20, offHighGroup: 'OFF_HIGH_LEGACY', dayChangePct: 60,
    impulsePct: 40, pullbackPct: 8, baseStartAt: T0 - 300, baseEndAt: T0 - 60,
    baseHigh: 100, baseLow: 90, baseRangePct: 11, baseDurationBars: 4,
    localExtensionPct: 0.5, spaceToSessionHighPct: 8, downsideToBaseLowPct: 10, reExpansionObserved: true,
    signalBarTime: T0 - 60, referencePrice: 100, referencePriceBasis: 'BASE_HIGH_BREAKOUT',
    invalidationPrice: 90, invalidationBasis: 'BASE_LOW', riskUnitPrice: 10, riskUnitPct: 10,
    monitoredRank: null, inBaseTop15: false, inTop30: null, inTop60: null,
    baseRelationship: 'NOT_IN_BASE_MONITORED_UNIVERSE', timeframe: '1m', dataQualityStatus: 'AVAILABLE',
    qualityFlags: [], localFeatureConfigHash: 'abcd', leaderConfigHash: 'ee', leaderObservationConfigHash: 'ff',
    ...over,
  }
}

function bar(minFromStart: number, o: number, h: number, l: number, c: number, opts: { observedAtMs?: number; rev?: number } = {}): TapeEvent {
  const barTimeSec = T0 + minFromStart * 60
  return {
    eventType: 'bar_observation', symbol: 'AAA', timeframe: '1m', barTimeSec,
    open: o, high: h, low: l, close: c, volume: 1000,
    observedAtMs: opts.observedAtMs ?? (barTimeSec + 60) * 1000, revisionSequence: opts.rev ?? 0,
    barStatus: 'CLOSED', barFingerprint: `${o}|${h}|${l}|${c}`, source: 'yahoo', requestKind: 'BASE',
  } as TapeEvent
}
// The start bar sits at minute 0 (== anchor). Its close is the outcome reference.
const START = bar(0, 100, 100.5, 99.5, 100)   // outcomeReferencePrice = 100
function flat(fromMin: number, toMin: number): TapeEvent[] {
  const out: TapeEvent[] = []
  for (let m = fromMin; m <= toMin; m++) out.push(bar(m, 100, 100.5, 99.5, 100))
  return out
}
const COMPLETE: TapeCompleteness = 'COMPLETE'
const w = (o: ReturnType<typeof evaluateCandidateOutcome>, min: number) => o.windows.find(x => x.windowMin === min)!

describe('H4B outcome — structural vs prospective separation', () => {
  it('outcome reference is the post-observation start-bar close, not base.high', () => {
    const o = evaluateCandidateOutcome(candidate(), [START, ...flat(1, 31)], { tapeCompleteness: COMPLETE })
    expect(o.structuralBreakoutPrice).toBe(100)
    expect(o.structuralInvalidationPrice).toBe(90)
    expect(o.structuralRiskUnit).toBe(10)
    expect(o.outcomeReferencePrice).toBe(100)          // START close
    expect(o.primaryOutcomeStartSec).toBe(T0)
    expect(o.structuralExtensionAtObsPct).toBeCloseTo(0, 6)  // observed exactly at breakout here
  })

  it('A. a breakout BEFORE candidate observation earns ZERO prospective credit', () => {
    // A big up-bar BEFORE the anchor must not count; only post-start bars are scanned.
    const pre = bar(-1, 90, 140, 90, 135)   // huge move before observation
    const o = evaluateCandidateOutcome(candidate(), [pre, START, ...flat(1, 31)], { tapeCompleteness: COMPLETE })
    const w15 = w(o, 15)
    expect(o.outcomeReferencePrice).toBe(100)           // still the start-bar close
    expect(w15.prospectiveMfePct == null || w15.prospectiveMfePct < 1).toBe(true)  // flat forward → ~0
    expect(w15.prospectiveTimeTo1RSec).toBeNull()
  })

  it('B. invalidation BEFORE observation does not terminate the prospective path', () => {
    const preInval = bar(-1, 100, 101, 80, 85)   // breached 90 before the anchor
    const o = evaluateCandidateOutcome(candidate(), [preInval, START, ...flat(1, 31)], { tapeCompleteness: COMPLETE })
    const w15 = w(o, 15)
    expect(w15.invalidationHit).toBe(false)             // pre-observation breach ignored
    expect(w15.scorable).toBe(true)
  })

  it('D. already-above-breakout at observation does NOT grant prospective timeTo1R at/before T', () => {
    // Start bar closes at 108 (already +0.8 structural-R above base.high); forward path is flat.
    const startHigh = bar(0, 100, 109, 100, 108)
    const o = evaluateCandidateOutcome(candidate(), [startHigh, ...flat(1, 31).map(e => e)], { tapeCompleteness: COMPLETE })
    const w15 = w(o, 15)
    expect(o.outcomeReferencePrice).toBe(108)
    expect(o.structuralExtensionAtObsPct).toBeCloseTo(8, 6)  // 8% above base.high, recorded as STRUCTURAL, not credit
    expect(w15.prospectiveTimeTo1RSec).toBeNull()             // no forward +1R
  })
})

describe('H4B outcome — terminal causality & thresholds (post-observation)', () => {
  it('M. after observation reaches +1R → timeTo1R set, not invalidated', () => {
    const bars = [START, bar(1, 100, 105, 99.5, 104), bar(2, 104, 111, 103, 110), ...flat(3, 31)]
    const w15 = w(evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE }), 15)
    expect(w15.scorable).toBe(true)
    expect(w15.invalidationHit).toBe(false)
    expect(w15.prospectiveTimeTo1RSec).not.toBeNull()   // 110 = ref(100) + 1R(10)
    expect(w15.prospectiveMfeR!).toBeGreaterThanOrEqual(1)
  })

  it('N/E. invalidation BEFORE a later +2R → +2R not credited; counterfactual records it', () => {
    const bars = [START, bar(1, 100, 101, 89, 92), bar(2, 92, 121, 92, 120), ...flat(3, 31)]
    const w15 = w(evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE }), 15)
    expect(w15.invalidationHit).toBe(true)
    expect(w15.prospectiveTimeTo2RSec).toBeNull()
    expect(w15.prospectiveTimeTo1RSec).toBeNull()
    expect(w15.counterfactualPostTerminalMfePct).not.toBeNull()
    expect(w15.counterfactualPostTerminalMfePct!).toBeGreaterThan(15)
  })

  it('post-terminal rally never raises primary MFE', () => {
    const bars = [START, bar(1, 100, 102, 89, 92), bar(2, 92, 500, 92, 480), ...flat(3, 31)]
    const w15 = w(evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE }), 15)
    expect(w15.prospectiveMfePct == null || w15.prospectiveMfePct < 5).toBe(true)
  })

  it('O/F. same-bar invalidation + (+1R) after observation → AMBIGUOUS_SAME_BAR, no +1R credit', () => {
    const bars = [START, bar(1, 100, 112, 89, 95), ...flat(2, 31)]
    const w15 = w(evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE }), 15)
    expect(w15.terminalState).toBe('AMBIGUOUS_SAME_BAR')
    expect(w15.ambiguousSameBar).toBe(true)
    expect(w15.prospectiveTimeTo1RSec).toBeNull()
    expect(w15.ambiguousBarHigh).toBe(112)
    expect(w15.invalidationHit).toBe(true)
  })
})

describe('H4B outcome — tape integrity', () => {
  it('P. missing bars (gap before window end) → DATA_GAP, not scorable', () => {
    const bars = [START, bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), bar(10, 100, 101, 99, 100), ...flat(11, 31)]
    const w15 = w(evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE }), 15)
    expect(w15.terminalState).toBe('DATA_GAP')
    expect(w15.scorable).toBe(false)
  })

  it('Q. tape INCOMPLETE → not primary-eligible, TAPE_INCOMPLETE, never scored as zero', () => {
    const o = evaluateCandidateOutcome(candidate(), [START, ...flat(1, 31)], { tapeCompleteness: 'INCOMPLETE' })
    expect(o.primaryEligible).toBe(false)
    const w15 = w(o, 15)
    expect(w15.terminalState).toBe('TAPE_INCOMPLETE')
    expect(w15.prospectiveMfePct).toBeNull()
  })

  it('DEGRADED_COMPLETE / CONTINUED → not primary-eligible', () => {
    expect(evaluateCandidateOutcome(candidate(), [START, ...flat(1, 31)], { tapeCompleteness: 'DEGRADED_COMPLETE' }).primaryEligible).toBe(false)
    const cont = evaluateCandidateOutcome(candidate(), [START, ...flat(1, 31)], { tapeCompleteness: 'CONTINUED' })
    expect(cont.primaryEligible).toBe(false)
    expect(w(cont, 15).terminalState).toBe('TAPE_INCOMPLETE')
  })

  it('no bar at/after observation → NO_OUTCOME_START_BAR, not eligible', () => {
    const o = evaluateCandidateOutcome(candidate(), [bar(-2, 100, 101, 99, 100)], { tapeCompleteness: COMPLETE })
    expect(o.primaryEligible).toBe(false)
    expect(w(o, 15).terminalState).toBe('NO_OUTCOME_START_BAR')
  })

  it('S. session end before 30m → 5m scorable, 30m INSUFFICIENT_TAPE', () => {
    const o = evaluateCandidateOutcome(candidate(), [START, ...flat(1, 6)], { tapeCompleteness: COMPLETE })
    expect(w(o, 5).scorable).toBe(true)
    expect(w(o, 30).terminalState).toBe('INSUFFICIENT_TAPE')
    expect(w(o, 30).scorable).toBe(false)
  })
})

describe('H4B outcome — NO LOOKAHEAD (R) + two clocks', () => {
  it('R. a later bar revision does not change an earlier as-of replay', () => {
    const barSec = T0 + 1 * 60
    const obsEarly = (barSec + 60) * 1000
    const obsLate = obsEarly + 5 * 60 * 1000
    const events: TapeEvent[] = [
      START,
      bar(1, 100, 105, 99.5, 104, { observedAtMs: obsEarly, rev: 0 }),
      bar(1, 100, 130, 99.5, 128, { observedAtMs: obsLate, rev: 1 }),
      ...flat(2, 31),
    ]
    const before = w(evaluateCandidateOutcome(candidate(), events, { tapeCompleteness: COMPLETE, asOfMs: obsEarly + 1 }), 15)
    expect(before.prospectiveTimeTo1RSec).toBeNull()      // original 105 = ref+0.5R only
    expect(before.prospectiveMfeR!).toBeLessThan(1)
    const after = w(evaluateCandidateOutcome(candidate(), events, { tapeCompleteness: COMPLETE, asOfMs: obsLate + 1 }), 15)
    expect(after.prospectiveTimeTo1RSec).not.toBeNull()   // revised 130 = ref+3R
    expect(after.prospectiveMfeR!).toBeGreaterThan(2)
  })
})
