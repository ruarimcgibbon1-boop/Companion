/**
 * H4B — RATIFIED decision / promotion policy (analysis metadata; NOT candidate production).
 *
 * This is the human-ratified promotion policy for the LEADER_CONTINUATION shadow experiment. It is
 * pure metadata used ONLY by later, separately-reviewed analysis. It does NOT touch candidate
 * generation, the outcome evaluator, BASE, or execution, so it has its OWN version/hash and does NOT
 * change `experimentConfigHash` (which fingerprints candidate/outcome behavior only).
 *
 * "Promotion" here means SHADOW → eligible for a SEPARATELY REVIEWED constrained paper-execution
 * trial. It is NOT proven profitability, NOT live-money approval, and NOT automatic execution.
 * No decision state grants PaperExecutor access.
 */
import { experimentConfigHash, DEFAULT_LEADER_CONTINUATION_CONFIG, type BaseRelationship } from './leader-continuation'

// v2 (pre-collection): makes the decision-population definitions machine-exact (additive
// BASE-relationship set, censor-rate denominator, concentration denominator). No numerical threshold
// changed. The prior policy `h4b-decision-1` had ZERO collected data.
export const DECISION_POLICY_VERSION = 'h4b-decision-2'

/**
 * The EXACT additive population: candidates BASE missed/rejected, PLUS symbols BASE never monitored.
 * `BASE_PASSED` and `UNKNOWN` are excluded (an additive claim requires a definite non-pass BASE fact).
 */
export const ADDITIVE_BASE_RELATIONSHIPS: readonly BaseRelationship[] = [
  'BASE_VETO_OFF_HIGH', 'BASE_VETO_GRADE', 'BASE_VETO_OTHER',
  'BASE_TRIGGER_BELOW_TRACKING_FLOOR', 'BASE_MONITORED_NO_TRIGGER',
  'NOT_IN_BASE_MONITORED_UNIVERSE',
] as const
export function isAdditiveBaseRelationship(rel: BaseRelationship): boolean {
  return ADDITIVE_BASE_RELATIONSHIPS.includes(rel)
}

export interface H4BDecisionPolicy {
  version: string
  ratified: true
  promotionPath: 'A_CONFIRMATORY_EPOCH_1'
  officialCollectionStartStatus: 'READY_NOT_STARTED'
  /** The experiment config this policy ratifies (binds the two together). */
  experimentConfigHash: string
  // Collection minimum (objective; regime is descriptive only).
  collectionMinimum: { candidates: number; symbolDays: number; sessions: number }
  regimeCondition: 'DESCRIPTIVE_ONLY'
  // Research-integrity gate.
  maxCensorOrDegradedRatePct: number
  // Additive population = the EXACT BaseRelationship set in `additiveBaseRelationships`.
  additiveBaseRelationships: readonly BaseRelationship[]
  additiveMinimum: { candidates: number; symbolDays: number }
  // Exact denominators (no prose ambiguity for a later analyst).
  censorRateNumerator: 'NOT_SCORABLE_AT_PRIMARY_15M_WINDOW'
  censorRateDenominator: 'ALL_OFFICIAL_DISTINCT_CANDIDATE_EPISODES'
  concentrationDenominator: 'ADDITIVE_POPULATION_SCORABLE_EPISODES_15M'
  // Bounded-risk gate at the pre-registered primary window.
  primaryPromotionWindowMin: 15
  gate: {
    medianProspectiveMfeRAtLeast: number
    medianProspectiveMaeRGreaterThan: number
    oneRBeforeInvalidationRateAtLeast: number
    asymmetryRequired: true            // median MFE R > |median MAE R|
    maxSingleSymbolDaySharePct: number
  }
  offHighComparison: 'PRE_REGISTERED_DESCRIPTIVE_NEITHER_MUST_WIN'
  globalOffHighIsCandidateGate: false
  decisionStates: {
    PASS: string
    FAIL: string
    INCONCLUSIVE: string
  }
  automaticExecution: false
}

export const H4B_DECISION_POLICY: H4BDecisionPolicy = {
  version: DECISION_POLICY_VERSION,
  ratified: true,
  promotionPath: 'A_CONFIRMATORY_EPOCH_1',
  officialCollectionStartStatus: 'READY_NOT_STARTED',
  experimentConfigHash: experimentConfigHash(DEFAULT_LEADER_CONTINUATION_CONFIG),
  collectionMinimum: { candidates: 150, symbolDays: 40, sessions: 10 },
  regimeCondition: 'DESCRIPTIVE_ONLY',
  maxCensorOrDegradedRatePct: 10,
  additiveBaseRelationships: ADDITIVE_BASE_RELATIONSHIPS,
  additiveMinimum: { candidates: 40, symbolDays: 15 },
  censorRateNumerator: 'NOT_SCORABLE_AT_PRIMARY_15M_WINDOW',
  censorRateDenominator: 'ALL_OFFICIAL_DISTINCT_CANDIDATE_EPISODES',
  concentrationDenominator: 'ADDITIVE_POPULATION_SCORABLE_EPISODES_15M',
  primaryPromotionWindowMin: 15,
  gate: {
    medianProspectiveMfeRAtLeast: 0.50,
    medianProspectiveMaeRGreaterThan: -0.75,
    oneRBeforeInvalidationRateAtLeast: 0.40,
    asymmetryRequired: true,
    maxSingleSymbolDaySharePct: 20,
  },
  offHighComparison: 'PRE_REGISTERED_DESCRIPTIVE_NEITHER_MUST_WIN',
  globalOffHighIsCandidateGate: false,
  decisionStates: {
    PASS: 'eligible for a separately reviewed constrained PAPER-execution trial (NOT live money, NOT automatic execution)',
    FAIL: 'remains shadow; no automatic rule tuning',
    INCONCLUSIVE: 'insufficient additive sample / concentration exceeded / evidence lacking; continue collection under unchanged rules',
  },
  automaticExecution: false,
}

/** FNV-1a 8-hex over a canonical, order-stable serialization of every ratified decision value. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
export function decisionPolicyCanonical(p: H4BDecisionPolicy): string {
  const g = p.gate
  return [
    'h4b-decision', `v=${p.version}`, `path=${p.promotionPath}`,
    `min=${p.collectionMinimum.candidates}/${p.collectionMinimum.symbolDays}/${p.collectionMinimum.sessions}`,
    `regime=${p.regimeCondition}`, `censorMax=${p.maxCensorOrDegradedRatePct}`,
    `censorNum=${p.censorRateNumerator}`, `censorDen=${p.censorRateDenominator}`,
    `add=${[...p.additiveBaseRelationships].join(',')}`,
    `addMin=${p.additiveMinimum.candidates}/${p.additiveMinimum.symbolDays}`, `win=${p.primaryPromotionWindowMin}`,
    `mfeR>=${g.medianProspectiveMfeRAtLeast}`, `maeR>${g.medianProspectiveMaeRGreaterThan}`,
    `r1>=${g.oneRBeforeInvalidationRateAtLeast}`, `asym=${g.asymmetryRequired}`, `conc<=${g.maxSingleSymbolDaySharePct}`,
    `concDen=${p.concentrationDenominator}`,
    `offHigh=${p.offHighComparison}`, `offHighGate=${p.globalOffHighIsCandidateGate}`,
    `autoExec=${p.automaticExecution}`, `start=${p.officialCollectionStartStatus}`,
    `expCfg=${p.experimentConfigHash}`,
  ].join('|')
}
export function decisionPolicyHash(p: H4BDecisionPolicy = H4B_DECISION_POLICY): string {
  return fnv1a(decisionPolicyCanonical(p))
}
