/**
 * H4B — causal outcome evaluator: terminal causality, same-bar ambiguity, tape completeness,
 * missing bars, no-lookahead, session-end (golden M–T). Asserts research integrity, not profit.
 */
import { describe, it, expect } from 'vitest'
import { evaluateCandidateOutcome } from '../src/lib/leader/leader-continuation-outcome'
import type { ShadowCandidateEvent } from '../src/lib/leader/leader-continuation'
import type { TapeEvent, TapeCompleteness } from '../src/lib/research/tape-1m-replay'

const ANCHOR = Date.parse('2026-09-18T14:00:00Z')
const T0 = Math.floor(ANCHOR / 1000)   // anchor in unix sec

// Reference 100, invalidation 90 → R = 10.
function candidate(over: Partial<ShadowCandidateEvent> = {}): ShadowCandidateEvent {
  return {
    eventType: 'leader_continuation_candidate', strategyId: 'LEADER_CONTINUATION', mode: 'shadow',
    experimentSpecVersion: 'h4b-leadercont-1', experimentConfigHash: 'cfg', experimentEpoch: 'h4b-epoch-1',
    shadowCandidateId: 'lc-test', symbol: 'AAA', leaderEpisodeId: 'ep-1', setupId: null,
    runId: 'r1', sweepId: 's1', candidateObservedAt: new Date(ANCHOR).toISOString(),
    leaderRole: 'CORE', leaderLifecycle: 'REEXPANDING', historyComplete: true,
    globalOffHighPct: -20, offHighGroup: 'OFF_HIGH_LEGACY', dayChangePct: 60,
    impulsePct: 40, pullbackPct: 8, baseStartAt: T0 - 300, baseEndAt: T0 - 60,
    baseHigh: 100, baseLow: 90, baseRangePct: 11, baseDurationBars: 4,
    localExtensionPct: 0.5, spaceToSessionHighPct: 8, downsideToBaseLowPct: 10, reExpansionObserved: true,
    signalBarTime: T0 - 60, referencePrice: 100, referencePriceBasis: 'BASE_HIGH_BREAKOUT',
    invalidationPrice: 90, invalidationBasis: 'BASE_LOW', riskUnitPrice: 10, riskUnitPct: 10,
    monitoredRank: null, inBaseTop15: false, inTop30: null, inTop60: null,
    baseRelationship: 'NOT_IN_BASE_MONITORED_UNIVERSE',
    timeframe: '1m', dataQualityStatus: 'AVAILABLE', qualityFlags: [],
    localFeatureConfigHash: 'abcd', leaderConfigHash: 'ee', leaderObservationConfigHash: 'ff',
    ...over,
  }
}

// A bar_observation tape event. observedAtMs defaults to bar close (barSec+60)*1000.
function bar(barMinAfterAnchor: number, o: number, h: number, l: number, c: number, opts: { observedAtMs?: number; rev?: number; v?: number } = {}): TapeEvent {
  const barTimeSec = T0 + barMinAfterAnchor * 60
  return {
    eventType: 'bar_observation', symbol: 'AAA', timeframe: '1m', barTimeSec,
    open: o, high: h, low: l, close: c, volume: opts.v ?? 1000,
    observedAtMs: opts.observedAtMs ?? (barTimeSec + 60) * 1000, revisionSequence: opts.rev ?? 0,
    barStatus: 'CLOSED', barFingerprint: `${o}|${h}|${l}|${c}`, source: 'yahoo', requestKind: 'BASE',
  } as TapeEvent
}

// Fill a window with flat neutral bars (high 101, low 99) so coverage is satisfied without triggering thresholds.
function flat(fromMin: number, toMin: number): TapeEvent[] {
  const out: TapeEvent[] = []
  for (let m = fromMin; m <= toMin; m++) out.push(bar(m, 100, 101, 99, 100))
  return out
}
const COMPLETE: TapeCompleteness = 'COMPLETE'

describe('H4B outcome — terminal causality & thresholds', () => {
  it('M. candidate then +1R (no invalidation) → timeTo1R set, not invalidated', () => {
    const bars = [bar(1, 100, 105, 99.5, 104), bar(2, 104, 111, 103, 110), ...flat(3, 31)]
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE })
    const w15 = o.windows.find(w => w.windowMin === 15)!
    expect(w15.scorable).toBe(true)
    expect(w15.invalidationHit).toBe(false)
    expect(w15.timeTo1RSec).not.toBeNull()   // reached 110 = ref + 1R
    expect(w15.causalMfeR).toBeGreaterThanOrEqual(1)
  })

  it('N. invalidation BEFORE a later +2R → invalidationHit, +2R NOT credited, counterfactual records it', () => {
    // bar1 breaches 90 (invalidation); bar2 later spikes to 121 (+2R) — must NOT earn primary credit.
    const bars = [bar(1, 100, 101, 89, 92), bar(2, 92, 121, 92, 120), ...flat(3, 31)]
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE })
    const w15 = o.windows.find(w => w.windowMin === 15)!
    expect(w15.invalidationHit).toBe(true)
    expect(w15.timeTo2RSec).toBeNull()                       // post-terminal rally earns no primary credit
    expect(w15.timeTo1RSec).toBeNull()
    expect(w15.counterfactualPostTerminalMfePct).not.toBeNull()  // recorded separately, clearly counterfactual
    expect(w15.counterfactualPostTerminalMfePct!).toBeGreaterThan(15)
  })

  it('post-terminal rally can never raise primary MFE above the pre-terminal path', () => {
    const bars = [bar(1, 100, 102, 89, 92), bar(2, 92, 500, 92, 480), ...flat(3, 31)]
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE })
    const w15 = o.windows.find(w => w.windowMin === 15)!
    // MFE is taken through the prior completed bar (bar1 excluded as the terminal bar) → ~0, never 480.
    expect(w15.causalMfePct == null || w15.causalMfePct < 5).toBe(true)
  })

  it('O. same-bar invalidation + (+1R) → AMBIGUOUS_SAME_BAR, +1R not credited', () => {
    const bars = [bar(1, 100, 112, 89, 95), ...flat(2, 31)]   // one bar: high 112 (+1R) AND low 89 (invalidation)
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE })
    const w15 = o.windows.find(w => w.windowMin === 15)!
    expect(w15.terminalState).toBe('AMBIGUOUS_SAME_BAR')
    expect(w15.ambiguousSameBar).toBe(true)
    expect(w15.timeTo1RSec).toBeNull()
    expect(w15.ambiguousBarHigh).toBe(112)
    expect(w15.ambiguousBarLow).toBe(89)
    expect(w15.invalidationHit).toBe(true)
  })
})

describe('H4B outcome — tape integrity', () => {
  it('P. missing bars (a gap before the window end) → DATA_GAP, not scorable', () => {
    // bars at +1,+2 then a jump to +10 (8-minute gap) before the 15m window completes.
    const bars = [bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), bar(10, 100, 101, 99, 100), ...flat(11, 31)]
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE })
    const w15 = o.windows.find(w => w.windowMin === 15)!
    expect(w15.terminalState).toBe('DATA_GAP')
    expect(w15.scorable).toBe(false)
  })

  it('Q. tape INCOMPLETE → primary not eligible, terminal TAPE_INCOMPLETE, never scored as zero', () => {
    const bars = [...flat(1, 31)]
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: 'INCOMPLETE' })
    expect(o.primaryEligible).toBe(false)
    const w15 = o.windows.find(w => w.windowMin === 15)!
    expect(w15.terminalState).toBe('TAPE_INCOMPLETE')
    expect(w15.scorable).toBe(false)
    expect(w15.causalMfePct).toBeNull()
  })

  it('DEGRADED_COMPLETE → recorded but not primary-eligible', () => {
    const bars = [...flat(1, 31)]
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: 'DEGRADED_COMPLETE' })
    expect(o.primaryEligible).toBe(false)
    expect(o.windows.find(w => w.windowMin === 15)!.scorable).toBe(false)
  })

  it('T. CONTINUED (cross-midnight, not yet joined) → not primary-eligible', () => {
    const bars = [...flat(1, 31)]
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: 'CONTINUED' })
    expect(o.primaryEligible).toBe(false)
    expect(o.windows.find(w => w.windowMin === 15)!.terminalState).toBe('TAPE_INCOMPLETE')
  })

  it('S. session end before 30m → 5m scorable, 30m INSUFFICIENT_TAPE', () => {
    const bars = [...flat(1, 6)]   // only ~6 minutes of tape after the anchor
    const o = evaluateCandidateOutcome(candidate(), bars, { tapeCompleteness: COMPLETE })
    expect(o.windows.find(w => w.windowMin === 5)!.scorable).toBe(true)
    const w30 = o.windows.find(w => w.windowMin === 30)!
    expect(w30.terminalState).toBe('INSUFFICIENT_TAPE')
    expect(w30.scorable).toBe(false)
  })
})

describe('H4B outcome — NO LOOKAHEAD (R)', () => {
  it('R. a later bar revision does not change an earlier as-of replay', () => {
    // Bar at +1 first observed (rev0) high 105; later revised (rev1) to high 130.
    const barSec = T0 + 1 * 60
    const obsEarly = (barSec + 60) * 1000
    const obsLate = obsEarly + 5 * 60 * 1000
    const events: TapeEvent[] = [
      bar(1, 100, 105, 99.5, 104, { observedAtMs: obsEarly, rev: 0 }),
      bar(1, 100, 130, 99.5, 128, { observedAtMs: obsLate, rev: 1 }),
      ...flat(2, 31).map(e => e), // later flat bars, all observed at their close
    ]
    // As of BEFORE the revision → sees high 105 (≈ +0.5R), NOT 130.
    const before = evaluateCandidateOutcome(candidate(), events, { tapeCompleteness: COMPLETE, asOfMs: obsEarly + 1 })
    const w15before = before.windows.find(w => w.windowMin === 15)!
    // MFE reflects the original 105, and +1R (110) was NOT reached.
    expect(w15before.timeTo1RSec).toBeNull()
    expect(w15before.causalMfeR!).toBeLessThan(1)
    // As of AFTER the revision → sees 130 (+3R).
    const after = evaluateCandidateOutcome(candidate(), events, { tapeCompleteness: COMPLETE, asOfMs: obsLate + 1 })
    const w15after = after.windows.find(w => w.windowMin === 15)!
    expect(w15after.timeTo1RSec).not.toBeNull()
    expect(w15after.causalMfeR!).toBeGreaterThan(2)
  })
})
