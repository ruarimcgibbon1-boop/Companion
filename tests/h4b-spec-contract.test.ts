/**
 * H4B — SPEC ↔ CODE CONTRACT (STEP 8). One canonical definition (H4B_DEFINITION) + one ratified
 * decision policy (H4B_DECISION_POLICY) are the single sources of truth. This test pins them entirely
 * from TRACKED code — it does NOT read any file under reviews/ (an untracked deliverable) so it passes
 * on a clean clone / CI. The review Markdown is generated to embody these values; the runtime contract
 * lives here.
 */
import { describe, it, expect } from 'vitest'
import {
  H4B_DEFINITION, DEFAULT_LEADER_CONTINUATION_CONFIG, experimentConfigHash,
  EXPERIMENT_SPEC_VERSION, EXPERIMENT_EPOCH,
} from '../src/lib/leader/leader-continuation'
import {
  H4B_DECISION_POLICY, decisionPolicyHash, DECISION_POLICY_VERSION, ADDITIVE_BASE_RELATIONSHIPS,
} from '../src/lib/leader/leader-continuation-policy'

// Pinned fingerprints (recomputed from the tracked objects; any change must be deliberate).
const EXPECTED_CONFIG_HASH = '89e8b4e0'      // experiment (candidate/outcome) — MUST stay this
const EXPECTED_DECISION_HASH = 'e3c1fe88'    // decision policy v2 (adds exact population definitions)

describe('H4B experiment definition — tracked contract', () => {
  it('spec version / epoch are the frozen v2 values', () => {
    expect(EXPERIMENT_SPEC_VERSION).toBe('h4b-leadercont-2')
    expect(EXPERIMENT_EPOCH).toBe('h4b-epoch-1')
  })

  it('experimentConfigHash is pinned (candidate/outcome behavior is unchanged)', () => {
    expect(experimentConfigHash(DEFAULT_LEADER_CONTINUATION_CONFIG)).toBe(EXPECTED_CONFIG_HASH)
  })

  it('H4B_DEFINITION snapshot is frozen (gates, identity, bases, outcome origin, eligibility, windows, policies, boundary)', () => {
    expect(H4B_DEFINITION).toMatchObject({
      strategyId: 'LEADER_CONTINUATION', mode: 'shadow',
      specVersion: 'h4b-leadercont-2', epoch: 'h4b-epoch-1',
      gates: ['leaderEpisodePresent', 'lifecycleNotExpired', 'timeframe1m', 'statusAvailable', 'baseDetected', 'reExpansionObserved', 'positiveRiskUnit'],
      identityFields: 'symbol|leaderEpisodeId|baseStartAt|baseEndAt',
      identityVersion: 'lc-id-2',
      structuralBreakoutBasis: 'BASE_HIGH',
      invalidationBasis: 'BASE_LOW',
      riskUnitBasis: 'BASE_HIGH_MINUS_BASE_LOW',
      outcomeReferenceBasis: 'FIRST_CLOSED_BAR_CLOSE_AT_OR_AFTER_CANDIDATE_OBSERVED_AT',
      primaryOutcomeStartRule: 'FIRST_BAR_STRICTLY_AFTER_PRIMARY_START_BAR',
      closedBarEligibility: 'PRIMARY_REQUIRES_CLOSED_START_BAR',
      windowsMin: [5, 15, 30],
      terminalPolicy: 'INVALIDATION_TERMINATES_PRIMARY',
      sameBarPolicy: 'CONSERVATIVE_AMBIGUOUS_NO_CREDIT',
      offHighLegacyBoundaryPct: -5,
    })
  })

  it('config gates match the frozen candidate rule (no tuned magnitude thresholds)', () => {
    const c = DEFAULT_LEADER_CONTINUATION_CONFIG
    expect(c.requireTimeframe1m && c.requireStatusAvailable && c.requireBaseDetected && c.requireReExpansion && c.requirePositiveRiskUnit).toBe(true)
    expect(c.offHighLegacyBoundaryPct).toBe(-5)
    expect(c.primaryWindowsMin).toEqual([5, 15, 30])
  })
})

describe('H4B ratified decision policy — tracked contract (STEP 6/2)', () => {
  it('decision-policy version + hash are pinned (ratification cannot silently drift)', () => {
    expect(DECISION_POLICY_VERSION).toBe('h4b-decision-2')
    expect(decisionPolicyHash()).toBe(EXPECTED_DECISION_HASH)
  })

  it('policy is Path A + the exact frozen minimums and gates', () => {
    expect(H4B_DECISION_POLICY).toMatchObject({
      ratified: true,
      promotionPath: 'A_CONFIRMATORY_EPOCH_1',
      officialCollectionStartStatus: 'READY_NOT_STARTED',
      experimentConfigHash: EXPECTED_CONFIG_HASH,
      collectionMinimum: { candidates: 150, symbolDays: 40, sessions: 10 },
      regimeCondition: 'DESCRIPTIVE_ONLY',
      maxCensorOrDegradedRatePct: 10,
      additiveMinimum: { candidates: 40, symbolDays: 15 },
      primaryPromotionWindowMin: 15,
      gate: {
        medianProspectiveMfeRAtLeast: 0.5,
        medianProspectiveMaeRGreaterThan: -0.75,
        oneRBeforeInvalidationRateAtLeast: 0.4,
        asymmetryRequired: true,
        maxSingleSymbolDaySharePct: 20,
      },
      globalOffHighIsCandidateGate: false,
      automaticExecution: false,
    })
  })

  it('B. the additive population is an EXACT BaseRelationship set (no prose ambiguity)', () => {
    expect([...ADDITIVE_BASE_RELATIONSHIPS].sort()).toEqual([
      'BASE_MONITORED_NO_TRIGGER', 'BASE_TRIGGER_BELOW_TRACKING_FLOOR',
      'BASE_VETO_GRADE', 'BASE_VETO_OFF_HIGH', 'BASE_VETO_OTHER',
      'NOT_IN_BASE_MONITORED_UNIVERSE',
    ])
    // BASE_PASSED and UNKNOWN are NOT additive.
    expect(ADDITIVE_BASE_RELATIONSHIPS.includes('BASE_PASSED' as never)).toBe(false)
    expect(ADDITIVE_BASE_RELATIONSHIPS.includes('UNKNOWN' as never)).toBe(false)
    expect(H4B_DECISION_POLICY.additiveBaseRelationships).toEqual(ADDITIVE_BASE_RELATIONSHIPS)
  })

  it('C/D. censor-rate and concentration denominators are pinned explicitly', () => {
    expect(H4B_DECISION_POLICY.censorRateNumerator).toBe('NOT_SCORABLE_AT_PRIMARY_15M_WINDOW')
    expect(H4B_DECISION_POLICY.censorRateDenominator).toBe('ALL_OFFICIAL_DISTINCT_CANDIDATE_EPISODES')
    expect(H4B_DECISION_POLICY.concentrationDenominator).toBe('ADDITIVE_POPULATION_SCORABLE_EPISODES_15M')
  })

  it('PASS means constrained-paper eligibility only; no state grants automatic execution', () => {
    expect(H4B_DECISION_POLICY.decisionStates.PASS).toMatch(/constrained PAPER/i)
    expect(H4B_DECISION_POLICY.decisionStates.PASS).toMatch(/NOT live money|NOT automatic/i)
    expect(H4B_DECISION_POLICY.automaticExecution).toBe(false)
  })
})
