/**
 * H4B — LEADER_CONTINUATION shadow candidate engine (golden tests A–L + subgroups + dedup).
 * Asserts RESEARCH FACTS about candidate representation — never profitability.
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateLeaderContinuation, shadowCandidateId, offHighGroupOf, deriveBaseRelationship,
  DEFAULT_LEADER_CONTINUATION_CONFIG, experimentConfigHash, EXPERIMENT_EPOCH, EXPERIMENT_SPEC_VERSION,
  type LeaderContinuationInput,
} from '../src/lib/leader/leader-continuation'
import type { LocalStructureFeatures, LocalStructureStatus, ResetState } from '../src/lib/leader/local-structure'
import type { LifecycleState, LeaderRole } from '../src/lib/leader/leader-state'

// Minimal LocalStructureFeatures factory — only the fields the engine reads matter.
function ls(over: {
  status?: LocalStructureStatus; timeframe?: string; resetState?: ResetState
  offHighPct?: number | null; dayChangePct?: number | null
  baseDetected?: boolean; baseStartAt?: number | null; baseEndAt?: number | null; baseHigh?: number | null; baseLow?: number | null
  reExpansion?: boolean; impulsePct?: number | null; pullbackPct?: number | null
  localExtensionPct?: number | null; spaceToSessionHighPct?: number | null; downsideToBaseLowPct?: number | null
} = {}): LocalStructureFeatures {
  return {
    status: over.status ?? 'AVAILABLE',
    qualityFlags: [],
    resetState: over.resetState ?? 'SHALLOW',
    global: { sessionHigh: 12, offHighPct: over.offHighPct ?? -1, dayChangePct: over.dayChangePct ?? 50, distanceFromVWAPPct: null, distanceFromEMA9Pct: null, distanceFromEMA21Pct: null, timeSinceSessionHighSec: null },
    impulse: { detected: true, startAt: 100, startPrice: 8, peakAt: 160, peakPrice: 11, pct: over.impulsePct ?? 37, durationBars: 6, volume: 1000, volumeVsWindowRatio: 2, dominantImpulsePct: 37 },
    pullback: { startAt: 160, lowAt: 220, lowPrice: 10, pctFromImpulsePeak: over.pullbackPct ?? 9, maxPct: 9, durationBars: 6, retracementRatio: 0.3, stillPullingBack: false },
    base: {
      detected: over.baseDetected ?? true, startAt: over.baseStartAt ?? 220, endAt: over.baseEndAt ?? 340, durationBars: 4,
      high: over.baseHigh ?? 10.8, low: over.baseLow ?? 10.2, rangePct: 5.5, rangeContraction: 0.7, volumeContraction: 0.6, realizedVolContraction: 0.7, slopePctPerBar: 0.1, upperTests: 2, lowerTests: 2,
    },
    localExtension: { referencePrice: over.baseHigh ?? 10.8, distanceFromBaseHighPct: 1, distanceFromBaseLowPct: 6, localExtensionPct: over.localExtensionPct ?? 0.5, downsideToBaseLowPct: over.downsideToBaseLowPct ?? 5.5, spaceToSessionHighPct: over.spaceToSessionHighPct ?? 8, globalVsLocalExtensionRatio: 4 },
    reExpansion: { observed: over.reExpansion ?? true, breakoutAboveBaseHighPct: 1.2, volumeExpansion: 2, barsSinceBaseBreak: 1, reclaimedVWAP: true, reclaimedEMA9: true },
    pathRisk: { recentLocalMAEProxy: 9, distanceToBaseLowPct: 5.5, distanceToImpulseLowPct: 20, atrPct: 2, realizedVolPct: 3, spreadPct: null },
    provenance: {
      symbol: 'AAA', leaderEpisodeId: 'ep-1', sweepId: 's1', runId: 'r1', asOfUtc: '2026-09-18T14:00:00Z',
      timeframe: (over.timeframe ?? '1m') as LocalStructureFeatures['provenance']['timeframe'],
      barsStartAt: 100, barsEndAt: 400, barsCount: 60, dataFreshnessMs: 1000, discontinuityInWindow: false,
      sessionsInWindow: ['regular'], containsSessionBoundary: false, cadenceConsistency: 1,
      featureSchemaVersion: 1, localFeatureConfigVersion: 'h4a-provisional-1', localFeatureConfigHash: 'abcd1234',
    },
  }
}

function leader(over: { lifecycle?: LifecycleState; role?: LeaderRole; historyComplete?: boolean; episodeId?: string | null } = {}) {
  return { leaderEpisodeId: over.episodeId === undefined ? 'ep-1' : over.episodeId, lifecycleState: over.lifecycle ?? 'REEXPANDING', role: over.role ?? 'CORE', historyComplete: over.historyComplete ?? true }
}

function input(over: Partial<LeaderContinuationInput> = {}): LeaderContinuationInput {
  return {
    symbol: 'AAA', localStructure: ls(), leader: leader(),
    baseRelationship: 'NOT_IN_BASE_MONITORED_UNIVERSE',
    ranks: { monitoredRank: null, inBaseTop15: false, inTop30: null, inTop60: null },
    runId: 'r1', sweepId: 's1', nowMs: Date.parse('2026-09-18T14:05:00Z'),
    ...over,
  }
}

describe('H4B candidate engine — golden facts', () => {
  it('A. established leader + tight reset + re-expansion → candidate', () => {
    const res = evaluateLeaderContinuation(input())
    expect(res.state).toBe('REEXPANSION_CANDIDATE')
    expect(res.candidate).not.toBeNull()
    expect(res.candidate!.strategyId).toBe('LEADER_CONTINUATION')
    expect(res.candidate!.mode).toBe('shadow')
    expect(res.candidate!.referencePrice).toBe(10.8)
    expect(res.candidate!.invalidationPrice).toBe(10.2)
    expect(res.candidate!.riskUnitPrice).toBeCloseTo(0.6, 6)
    expect(res.candidate!.experimentEpoch).toBe(EXPERIMENT_EPOCH)
    expect(res.candidate!.experimentSpecVersion).toBe(EXPERIMENT_SPEC_VERSION)
  })

  it('B. globally EXTENDED (off-high −40%) still qualifies → OFF_HIGH_LEGACY (off-high is NOT a gate)', () => {
    const res = evaluateLeaderContinuation(input({ localStructure: ls({ offHighPct: -40 }) }))
    expect(res.state).toBe('REEXPANSION_CANDIDATE')
    expect(res.candidate!.offHighGroup).toBe('OFF_HIGH_LEGACY')
    expect(res.candidate!.globalOffHighPct).toBe(-40)
  })

  it('C. near-HOD (off-high −1%) same rule → NEAR_HIGH', () => {
    const res = evaluateLeaderContinuation(input({ localStructure: ls({ offHighPct: -1 }) }))
    expect(res.state).toBe('REEXPANSION_CANDIDATE')
    expect(res.candidate!.offHighGroup).toBe('NEAR_HIGH')
  })

  it('D. no base → NO_BASE (no candidate)', () => {
    const res = evaluateLeaderContinuation(input({ localStructure: ls({ baseDetected: false }) }))
    expect(res.state).toBe('NO_BASE')
    expect(res.candidate).toBeNull()
  })

  it('E. base but no re-expansion → BASE_PRESENT_NO_REEXPANSION', () => {
    const res = evaluateLeaderContinuation(input({ localStructure: ls({ reExpansion: false }) }))
    expect(res.state).toBe('BASE_PRESENT_NO_REEXPANSION')
    expect(res.candidate).toBeNull()
  })

  it('F. repeated sweeps of the SAME structure → ONE candidate id (dedup is by structural identity)', () => {
    const a = evaluateLeaderContinuation(input({ nowMs: 1000 }))
    const b = evaluateLeaderContinuation(input({ nowMs: 16000 }))  // a later sweep, same structure
    expect(a.candidate!.shadowCandidateId).toBe(b.candidate!.shadowCandidateId)
  })

  it('G. a later DISTINCT reset/base → NEW candidate id', () => {
    const a = evaluateLeaderContinuation(input())
    const b = evaluateLeaderContinuation(input({ localStructure: ls({ baseStartAt: 500, baseEndAt: 620 }) }))
    expect(a.candidate!.shadowCandidateId).not.toBe(b.candidate!.shadowCandidateId)
  })

  it('G2. expiry + a new leaderEpisodeId → NEW candidate id', () => {
    const a = evaluateLeaderContinuation(input())
    const b = evaluateLeaderContinuation(input({ leader: leader({ episodeId: 'ep-2' }) }))
    expect(a.candidate!.shadowCandidateId).not.toBe(b.candidate!.shadowCandidateId)
  })

  it('H. candidate OUTSIDE BASE top15 is supported', () => {
    const res = evaluateLeaderContinuation(input({ ranks: { monitoredRank: null, inBaseTop15: false, inTop30: true, inTop60: true } }))
    expect(res.candidate).not.toBeNull()
    expect(res.candidate!.inBaseTop15).toBe(false)
    expect(res.candidate!.inTop30).toBe(true)
  })

  it('I. candidate simultaneously in BASE + H3C → BASE relationship captured, still a candidate', () => {
    const res = evaluateLeaderContinuation(input({ baseRelationship: 'BASE_PASSED', ranks: { monitoredRank: 3, inBaseTop15: true, inTop30: true, inTop60: true } }))
    expect(res.candidate!.baseRelationship).toBe('BASE_PASSED')
    expect(res.candidate!.inBaseTop15).toBe(true)
  })

  it('J. invalid local risk geometry (baseHigh <= baseLow) → INVALID_GEOMETRY', () => {
    const res = evaluateLeaderContinuation(input({ localStructure: ls({ baseHigh: 10, baseLow: 10 }) }))
    expect(res.state).toBe('INVALID_GEOMETRY')
    expect(res.candidate).toBeNull()
  })

  it('K. incomplete H3C history → historyComplete recorded false, still a candidate', () => {
    const res = evaluateLeaderContinuation(input({ leader: leader({ historyComplete: false }) }))
    expect(res.candidate).not.toBeNull()
    expect(res.candidate!.historyComplete).toBe(false)
  })

  it('L. data-quality failure (status != AVAILABLE) → DATA_QUALITY_UNUSABLE', () => {
    const res = evaluateLeaderContinuation(input({ localStructure: ls({ status: 'STALE_BARS' }) }))
    expect(res.state).toBe('DATA_QUALITY_UNUSABLE')
    expect(res.candidate).toBeNull()
  })

  it('no leader episode → NO_LEADER_EPISODE; EXPIRED lifecycle → LEADER_EXPIRED', () => {
    expect(evaluateLeaderContinuation(input({ leader: null })).state).toBe('NO_LEADER_EPISODE')
    expect(evaluateLeaderContinuation(input({ leader: leader({ episodeId: null }) })).state).toBe('NO_LEADER_EPISODE')
    expect(evaluateLeaderContinuation(input({ leader: leader({ lifecycle: 'EXPIRED' }) })).state).toBe('LEADER_EXPIRED')
  })

  it('non-1m timeframe → UNSUPPORTED_TIMEFRAME', () => {
    expect(evaluateLeaderContinuation(input({ localStructure: ls({ timeframe: '5m' }) })).state).toBe('UNSUPPORTED_TIMEFRAME')
  })
})

describe('H4B identity + subgroups + BASE relationship', () => {
  it('shadowCandidateId is deterministic and config-hash bound', () => {
    const args = { symbol: 'AAA', leaderEpisodeId: 'ep-1', baseStartAt: 220, baseEndAt: 340, experimentConfigHash: 'deadbeef' }
    expect(shadowCandidateId(args)).toBe(shadowCandidateId(args))
    expect(shadowCandidateId(args)).not.toBe(shadowCandidateId({ ...args, experimentConfigHash: 'feedface' }))
  })

  it('offHighGroupOf uses the pre-registered −5 boundary', () => {
    const cfg = DEFAULT_LEADER_CONTINUATION_CONFIG
    expect(offHighGroupOf(-6, cfg)).toBe('OFF_HIGH_LEGACY')
    expect(offHighGroupOf(-5, cfg)).toBe('NEAR_HIGH')
    expect(offHighGroupOf(-4.9, cfg)).toBe('NEAR_HIGH')
    expect(offHighGroupOf(null, cfg)).toBe('UNKNOWN')
  })

  it('experimentConfigHash is stable and changes when the rule changes', () => {
    const h = experimentConfigHash(DEFAULT_LEADER_CONTINUATION_CONFIG)
    expect(h).toBe(experimentConfigHash(DEFAULT_LEADER_CONTINUATION_CONFIG))
    expect(h).not.toBe(experimentConfigHash({ ...DEFAULT_LEADER_CONTINUATION_CONFIG, offHighLegacyBoundaryPct: -6 }))
  })

  it('deriveBaseRelationship never infers a verdict BASE did not make', () => {
    expect(deriveBaseRelationship({ monitored: false, hadRawTrigger: false, passedTrackingFloor: false, verdict: null, offHighGateBinding: false, gradeGateBinding: false })).toBe('NOT_IN_BASE_MONITORED_UNIVERSE')
    expect(deriveBaseRelationship({ monitored: true, hadRawTrigger: false, passedTrackingFloor: false, verdict: null, offHighGateBinding: false, gradeGateBinding: false })).toBe('BASE_MONITORED_NO_TRIGGER')
    expect(deriveBaseRelationship({ monitored: true, hadRawTrigger: true, passedTrackingFloor: false, verdict: null, offHighGateBinding: false, gradeGateBinding: false })).toBe('BASE_TRIGGER_BELOW_TRACKING_FLOOR')
    expect(deriveBaseRelationship({ monitored: true, hadRawTrigger: true, passedTrackingFloor: true, verdict: 'logged', offHighGateBinding: false, gradeGateBinding: false })).toBe('BASE_PASSED')
    expect(deriveBaseRelationship({ monitored: true, hadRawTrigger: true, passedTrackingFloor: true, verdict: 'vetoed', offHighGateBinding: true, gradeGateBinding: false })).toBe('BASE_VETO_OFF_HIGH')
    expect(deriveBaseRelationship({ monitored: true, hadRawTrigger: true, passedTrackingFloor: true, verdict: 'vetoed', offHighGateBinding: false, gradeGateBinding: true })).toBe('BASE_VETO_GRADE')
    expect(deriveBaseRelationship({ monitored: true, hadRawTrigger: true, passedTrackingFloor: true, verdict: 'vetoed', offHighGateBinding: false, gradeGateBinding: false })).toBe('BASE_VETO_OTHER')
  })
})
