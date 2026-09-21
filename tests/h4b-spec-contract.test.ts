/**
 * H4B — SPEC ↔ CODE CONTRACT (STEP 8/9). One canonical definition (H4B_DEFINITION) is the single
 * source of truth; runtime behavior and the report/spec values derive from it. This test fails on any
 * behavior-affecting drift: it snapshots the frozen definition, pins the experimentConfigHash, and
 * asserts the pre-registration markdown embodies the same version/epoch/hash/gates/boundary/windows.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  H4B_DEFINITION, DEFAULT_LEADER_CONTINUATION_CONFIG, experimentConfigHash,
  EXPERIMENT_SPEC_VERSION, EXPERIMENT_EPOCH,
} from '../src/lib/leader/leader-continuation'
import { H4B_DECISION_POLICY, decisionPolicyHash, DECISION_POLICY_VERSION } from '../src/lib/leader/leader-continuation-policy'

// The frozen v2 fingerprint (recomputed independently below; pinned so any change is deliberate).
const EXPECTED_CONFIG_HASH = '89e8b4e0'
// The ratified decision-policy fingerprint (pinned so the human ratification cannot silently drift).
const EXPECTED_DECISION_HASH = 'cc3ae918'

describe('H4B spec ↔ code contract', () => {
  it('EXPERIMENT_SPEC_VERSION / EPOCH are the frozen v2 values', () => {
    expect(EXPERIMENT_SPEC_VERSION).toBe('h4b-leadercont-2')
    expect(EXPERIMENT_EPOCH).toBe('h4b-epoch-1')
  })

  it('experimentConfigHash is pinned (any behavior-affecting change must bump this deliberately)', () => {
    expect(experimentConfigHash(DEFAULT_LEADER_CONTINUATION_CONFIG)).toBe(EXPECTED_CONFIG_HASH)
  })

  it('H4B_DEFINITION snapshot is frozen (single source of truth)', () => {
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

  it('the config gates match the frozen candidate rule (no tuned magnitude thresholds)', () => {
    const c = DEFAULT_LEADER_CONTINUATION_CONFIG
    expect(c.requireTimeframe1m && c.requireStatusAvailable && c.requireBaseDetected && c.requireReExpansion && c.requirePositiveRiskUnit).toBe(true)
    expect(c.offHighLegacyBoundaryPct).toBe(-5)   // subgroup boundary, NOT a candidate gate
    expect(c.primaryWindowsMin).toEqual([5, 15, 30])
  })

  it('the pre-registration markdown embodies the same version/epoch/hash/boundary/windows', () => {
    const specPath = join(process.cwd(), 'reviews/top-mover-audit/H4B_EXPERIMENT_SPEC.md')
    // The spec is an untracked deliverable; it must be present for the contract to be verifiable.
    expect(existsSync(specPath), `missing ${specPath}`).toBe(true)
    const md = readFileSync(specPath, 'utf8')
    expect(md).toContain('h4b-leadercont-2')
    expect(md).toContain('h4b-epoch-1')
    expect(md).toContain(EXPECTED_CONFIG_HASH)
    expect(md).toContain('OFF_HIGH_LEGACY')
    expect(md).toMatch(/-5/)
    expect(md).toMatch(/5m|5 ?min/); expect(md).toMatch(/15m|15 ?min/); expect(md).toMatch(/30m|30 ?min/)
    expect(md).toContain('BASE_HIGH'); expect(md).toContain('BASE_LOW')
    // structural vs prospective separation must be documented
    expect(md).toMatch(/outcomeReferencePrice|OUTCOME REFERENCE|prospective/i)
    // ratified + ready, not yet started
    expect(md).toContain('RATIFIED')
    expect(md).toMatch(/READY_NOT_STARTED|READY FOR PROSPECTIVE COLLECTION/)
    expect(md).toMatch(/COLLECTION NOT YET STARTED|not.*started/i)
  })
})

describe('H4B ratified decision policy — pinned (STEP 6)', () => {
  it('decision-policy version + hash are pinned (human ratification cannot silently drift)', () => {
    expect(DECISION_POLICY_VERSION).toBe('h4b-decision-1')
    expect(decisionPolicyHash()).toBe(EXPECTED_DECISION_HASH)
  })

  it('the ratified policy is Path A + the exact frozen minimums and gates', () => {
    expect(H4B_DECISION_POLICY).toMatchObject({
      ratified: true,
      promotionPath: 'A_CONFIRMATORY_EPOCH_1',
      officialCollectionStartStatus: 'READY_NOT_STARTED',
      experimentConfigHash: EXPECTED_CONFIG_HASH,     // binds the policy to the exact experiment
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

  it('PASS means constrained-paper eligibility only; no state grants automatic execution', () => {
    expect(H4B_DECISION_POLICY.decisionStates.PASS).toMatch(/constrained PAPER/i)
    expect(H4B_DECISION_POLICY.decisionStates.PASS).toMatch(/NOT live money|NOT automatic/i)
    expect(H4B_DECISION_POLICY.automaticExecution).toBe(false)
  })

  it('the pre-registration markdown embodies the ratified policy values', () => {
    const specPath = join(process.cwd(), 'reviews/top-mover-audit/H4B_EXPERIMENT_SPEC.md')
    if (!existsSync(specPath)) throw new Error(`missing ${specPath}`)
    const md = readFileSync(specPath, 'utf8')
    expect(md).toContain('h4b-decision-1')
    expect(md).toContain(EXPECTED_DECISION_HASH)
    expect(md).toContain('A — CONFIRMATORY EPOCH 1')
    expect(md).toMatch(/150/); expect(md).toMatch(/40/); expect(md).toMatch(/15m/)
    expect(md).toMatch(/0\.50R|0\.5R/); expect(md).toMatch(/-0\.75R/); expect(md).toMatch(/40%/); expect(md).toMatch(/20%/)
    expect(md).toMatch(/constrained.*paper/i)
  })
})
