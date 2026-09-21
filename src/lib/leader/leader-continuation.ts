/**
 * H4B — LEADER_CONTINUATION shadow candidate engine (PURE).
 *
 * Turns the H4A `LocalStructureFeatures` + H3C leader state into reason-coded shadow funnel
 * states and, when a distinct structure qualifies, a `ShadowCandidateEvent`. It describes a
 * STRUCTURE; it never pronounces it profitable, never computes an outcome, and never trades.
 *
 * HARD EXECUTION ISOLATION (H4B STEP 11 — load-bearing): this module imports NOTHING from the
 * executor, broker, risk manager, arbitration, or any order/execution-request type. Its only
 * output is a `ShadowCandidateEvent` (pure data). A static test asserts the import closure.
 *
 * The candidate rule is FROZEN by reviews/top-mover-audit/H4B_EXPERIMENT_SPEC.md
 * (experimentSpecVersion h4b-leadercont-1, epoch h4b-epoch-1). Global `offHighPct` is NOT a
 * candidate gate — it is a pre-registered explanatory subgroup only.
 */
import type { LocalStructureFeatures, LocalStructureStatus, QualityFlag } from './local-structure'
import type { LifecycleState, LeaderRole } from './leader-state'

export const H4B_STRATEGY_ID = 'LEADER_CONTINUATION' as const
export const H4B_MODE = 'shadow' as const
export const EXPERIMENT_SPEC_VERSION = 'h4b-leadercont-1'
export const EXPERIMENT_EPOCH = 'h4b-epoch-1'

// ── Config (every candidate-affecting value is fingerprinted) ────────────────────

export interface LeaderContinuationConfig {
  version: string          // experimentSpecVersion
  epoch: string            // experimentEpoch
  requireTimeframe1m: boolean
  requireStatusAvailable: boolean
  requireBaseDetected: boolean
  requireReExpansion: boolean
  requirePositiveRiskUnit: boolean
  /** Pre-registered OFF_HIGH_LEGACY boundary — SUBGROUP COMPARISON ONLY, never an eligibility gate. */
  offHighLegacyBoundaryPct: number
  /** Frozen prospective outcome windows (minutes). */
  primaryWindowsMin: number[]
}

export const DEFAULT_LEADER_CONTINUATION_CONFIG: LeaderContinuationConfig = {
  version: EXPERIMENT_SPEC_VERSION,
  epoch: EXPERIMENT_EPOCH,
  requireTimeframe1m: true,
  requireStatusAvailable: true,
  requireBaseDetected: true,
  requireReExpansion: true,
  requirePositiveRiskUnit: true,
  offHighLegacyBoundaryPct: -5,
  primaryWindowsMin: [5, 15, 30],
}

/** FNV-1a 8-hex over a canonical, order-stable serialization of every candidate-affecting value. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
export function leaderContinuationConfigCanonical(c: LeaderContinuationConfig): string {
  return [
    'h4b', `v=${c.version}`, `epoch=${c.epoch}`,
    `tf1m=${c.requireTimeframe1m}`, `avail=${c.requireStatusAvailable}`,
    `base=${c.requireBaseDetected}`, `reexp=${c.requireReExpansion}`, `posR=${c.requirePositiveRiskUnit}`,
    `offHighLegacy=${c.offHighLegacyBoundaryPct}`, `windows=${c.primaryWindowsMin.join(',')}`,
  ].join('|')
}
export function experimentConfigHash(c: LeaderContinuationConfig): string {
  return fnv1a(leaderContinuationConfigCanonical(c))
}

// ── Reason-coded shadow funnel states (STEP 9 — no silent filtering) ──────────────

export type ShadowFunnelState =
  | 'NO_LEADER_EPISODE'        // symbol carries no persistent leaderEpisodeId
  | 'LEADER_EXPIRED'           // lifecycle EXPIRED — not eligible
  | 'NO_LOCAL_STRUCTURE'       // features unavailable
  | 'UNSUPPORTED_TIMEFRAME'    // features not on honest 1m
  | 'DATA_QUALITY_UNUSABLE'    // status !== AVAILABLE
  | 'NO_BASE'                  // no local base/reset represented
  | 'BASE_PRESENT_NO_REEXPANSION'
  | 'INVALID_GEOMETRY'         // non-finite / non-positive local risk unit
  | 'DUPLICATE_STRUCTURE'      // same structure already emitted this run (dedup)
  | 'REEXPANSION_CANDIDATE'    // a distinct candidate was produced

// ── BASE relationship (STEP 12) ──────────────────────────────────────────────────

export type BaseRelationship =
  | 'BASE_PASSED'
  | 'BASE_VETO_OFF_HIGH'
  | 'BASE_VETO_GRADE'
  | 'BASE_VETO_OTHER'
  | 'BASE_TRIGGER_BELOW_TRACKING_FLOOR'
  | 'BASE_MONITORED_NO_TRIGGER'
  | 'NOT_IN_BASE_MONITORED_UNIVERSE'
  | 'UNKNOWN'

/**
 * Derive the BASE relationship from actual per-sweep BASE telemetry facts. A BASE verdict is
 * NEVER inferred for a symbol BASE did not evaluate: not-monitored → NOT_IN_BASE_MONITORED_UNIVERSE;
 * monitored but no raw long trigger → BASE_MONITORED_NO_TRIGGER.
 */
export function deriveBaseRelationship(f: {
  monitored: boolean
  hadRawTrigger: boolean
  passedTrackingFloor: boolean
  verdict: 'logged' | 'vetoed' | 'skipped' | null
  offHighGateBinding: boolean
  gradeGateBinding: boolean
}): BaseRelationship {
  if (!f.monitored) return 'NOT_IN_BASE_MONITORED_UNIVERSE'
  if (!f.hadRawTrigger) return 'BASE_MONITORED_NO_TRIGGER'
  if (!f.passedTrackingFloor) return 'BASE_TRIGGER_BELOW_TRACKING_FLOOR'
  if (f.verdict === 'logged') return 'BASE_PASSED'
  if (f.verdict === 'vetoed' || f.verdict === 'skipped') {
    if (f.offHighGateBinding) return 'BASE_VETO_OFF_HIGH'
    if (f.gradeGateBinding) return 'BASE_VETO_GRADE'
    return 'BASE_VETO_OTHER'
  }
  return 'UNKNOWN'
}

// ── Candidate event contract (STEP 10 — no bar arrays; bars live in the H4B-PREP tape) ──

export type OffHighGroup = 'OFF_HIGH_LEGACY' | 'NEAR_HIGH' | 'UNKNOWN'

export interface ShadowCandidateEvent {
  eventType: 'leader_continuation_candidate'
  strategyId: typeof H4B_STRATEGY_ID
  mode: typeof H4B_MODE
  experimentSpecVersion: string
  experimentConfigHash: string
  experimentEpoch: string

  shadowCandidateId: string
  symbol: string
  leaderEpisodeId: string
  setupId: string | null

  runId: string | null
  sweepId: string | null
  candidateObservedAt: string      // ISO

  // leader facts
  leaderRole: LeaderRole
  leaderLifecycle: LifecycleState
  historyComplete: boolean

  // global-extension explanatory variables (NOT gates)
  globalOffHighPct: number | null
  offHighGroup: OffHighGroup       // pre-registered subgroup; comparison only
  dayChangePct: number | null

  // local structure
  impulsePct: number | null
  pullbackPct: number | null
  baseStartAt: number | null
  baseEndAt: number | null
  baseHigh: number | null
  baseLow: number | null
  baseRangePct: number | null
  baseDurationBars: number | null
  localExtensionPct: number | null
  spaceToSessionHighPct: number | null
  downsideToBaseLowPct: number | null
  reExpansionObserved: boolean

  // signal / reference / risk (research only — NOT execution)
  signalBarTime: number | null     // unix sec of the base-break reference bar
  referencePrice: number
  referencePriceBasis: 'BASE_HIGH_BREAKOUT'
  invalidationPrice: number
  invalidationBasis: 'BASE_LOW'
  riskUnitPrice: number            // 1R in price units (referencePrice - invalidationPrice)
  riskUnitPct: number              // 1R as % of referencePrice

  // rank facts (a symbol need NOT stay in top15)
  monitoredRank: number | null
  inBaseTop15: boolean
  inTop30: boolean | null
  inTop60: boolean | null

  baseRelationship: BaseRelationship

  // provenance
  timeframe: string
  dataQualityStatus: LocalStructureStatus
  qualityFlags: QualityFlag[]
  localFeatureConfigHash: string | null
  leaderConfigHash: string | null
  leaderObservationConfigHash: string | null
}

// ── Identity (STEP 6) ────────────────────────────────────────────────────────────

/** Deterministic structural identity: one distinct local-reset/re-expansion episode. */
export function shadowCandidateId(input: {
  symbol: string
  leaderEpisodeId: string
  baseStartAt: number | null
  baseEndAt: number | null
  experimentConfigHash: string
}): string {
  const key = [
    input.symbol.toUpperCase(), input.leaderEpisodeId,
    input.baseStartAt ?? 'na', input.baseEndAt ?? 'na',
    input.experimentConfigHash,
  ].join('|')
  return `lc-${fnv1a(key)}`
}

export function offHighGroupOf(offHighPct: number | null, cfg: LeaderContinuationConfig): OffHighGroup {
  if (offHighPct == null || !Number.isFinite(offHighPct)) return 'UNKNOWN'
  return offHighPct < cfg.offHighLegacyBoundaryPct ? 'OFF_HIGH_LEGACY' : 'NEAR_HIGH'
}

// ── The evaluator (PURE) ─────────────────────────────────────────────────────────

export interface LeaderContinuationInput {
  symbol: string
  localStructure: LocalStructureFeatures | null
  leader: { leaderEpisodeId: string | null; lifecycleState: LifecycleState | null; role: LeaderRole; historyComplete: boolean } | null
  baseRelationship: BaseRelationship
  ranks: { monitoredRank: number | null; inBaseTop15: boolean; inTop30: boolean | null; inTop60: boolean | null }
  runId: string | null
  sweepId: string | null
  nowMs: number
  setupId?: string | null
  leaderConfigHash?: string | null
  leaderObservationConfigHash?: string | null
  config?: LeaderContinuationConfig
}

export interface LeaderContinuationResult {
  state: ShadowFunnelState
  candidate: ShadowCandidateEvent | null
}

/**
 * Evaluate one symbol. Returns a reason-coded funnel state and, when a distinct structure
 * qualifies, the candidate event. Dedup (DUPLICATE_STRUCTURE) is the CALLER's responsibility
 * via `shadowCandidateId` — this pure function always produces the candidate when the structure
 * qualifies, so the same structure yields the SAME id across sweeps (the caller suppresses repeats).
 */
export function evaluateLeaderContinuation(input: LeaderContinuationInput): LeaderContinuationResult {
  const cfg = input.config ?? DEFAULT_LEADER_CONTINUATION_CONFIG
  const cfgHash = experimentConfigHash(cfg)
  const ls = input.localStructure
  const leader = input.leader

  const leaderEpisodeId = leader?.leaderEpisodeId ?? null
  if (!leaderEpisodeId) return { state: 'NO_LEADER_EPISODE', candidate: null }
  if (leader?.lifecycleState === 'EXPIRED') return { state: 'LEADER_EXPIRED', candidate: null }
  if (!ls) return { state: 'NO_LOCAL_STRUCTURE', candidate: null }
  if (cfg.requireTimeframe1m && ls.provenance.timeframe !== '1m') return { state: 'UNSUPPORTED_TIMEFRAME', candidate: null }
  if (cfg.requireStatusAvailable && ls.status !== 'AVAILABLE') return { state: 'DATA_QUALITY_UNUSABLE', candidate: null }
  if (cfg.requireBaseDetected && !ls.base.detected) return { state: 'NO_BASE', candidate: null }
  if (cfg.requireReExpansion && !ls.reExpansion.observed) return { state: 'BASE_PRESENT_NO_REEXPANSION', candidate: null }

  const baseHigh = ls.base.high
  const baseLow = ls.base.low
  const referencePrice = baseHigh
  const invalidationPrice = baseLow
  if (referencePrice == null || invalidationPrice == null || !Number.isFinite(referencePrice) || !Number.isFinite(invalidationPrice)) {
    return { state: 'INVALID_GEOMETRY', candidate: null }
  }
  const riskUnitPrice = referencePrice - invalidationPrice
  if (cfg.requirePositiveRiskUnit && !(riskUnitPrice > 0)) return { state: 'INVALID_GEOMETRY', candidate: null }
  const riskUnitPct = referencePrice > 0 ? (riskUnitPrice / referencePrice) * 100 : NaN
  if (!Number.isFinite(riskUnitPct)) return { state: 'INVALID_GEOMETRY', candidate: null }

  const offHighPct = ls.global.offHighPct
  const id = shadowCandidateId({ symbol: input.symbol, leaderEpisodeId, baseStartAt: ls.base.startAt, baseEndAt: ls.base.endAt, experimentConfigHash: cfgHash })

  const candidate: ShadowCandidateEvent = {
    eventType: 'leader_continuation_candidate',
    strategyId: H4B_STRATEGY_ID,
    mode: H4B_MODE,
    experimentSpecVersion: cfg.version,
    experimentConfigHash: cfgHash,
    experimentEpoch: cfg.epoch,

    shadowCandidateId: id,
    symbol: input.symbol.toUpperCase(),
    leaderEpisodeId,
    setupId: input.setupId ?? null,

    runId: input.runId,
    sweepId: input.sweepId,
    candidateObservedAt: new Date(input.nowMs).toISOString(),

    leaderRole: leader?.role ?? 'NONE',
    leaderLifecycle: leader?.lifecycleState ?? 'DISCOVERED',
    historyComplete: leader?.historyComplete ?? false,

    globalOffHighPct: offHighPct,
    offHighGroup: offHighGroupOf(offHighPct, cfg),
    dayChangePct: ls.global.dayChangePct,

    impulsePct: ls.impulse.pct,
    pullbackPct: ls.pullback.pctFromImpulsePeak,
    baseStartAt: ls.base.startAt,
    baseEndAt: ls.base.endAt,
    baseHigh, baseLow,
    baseRangePct: ls.base.rangePct,
    baseDurationBars: ls.base.durationBars,
    localExtensionPct: ls.localExtension.localExtensionPct,
    spaceToSessionHighPct: ls.localExtension.spaceToSessionHighPct,
    downsideToBaseLowPct: ls.localExtension.downsideToBaseLowPct,
    reExpansionObserved: ls.reExpansion.observed,

    signalBarTime: ls.base.endAt,
    referencePrice,
    referencePriceBasis: 'BASE_HIGH_BREAKOUT',
    invalidationPrice,
    invalidationBasis: 'BASE_LOW',
    riskUnitPrice,
    riskUnitPct,

    monitoredRank: input.ranks.monitoredRank,
    inBaseTop15: input.ranks.inBaseTop15,
    inTop30: input.ranks.inTop30,
    inTop60: input.ranks.inTop60,

    baseRelationship: input.baseRelationship,

    timeframe: ls.provenance.timeframe,
    dataQualityStatus: ls.status,
    qualityFlags: ls.qualityFlags,
    localFeatureConfigHash: ls.provenance.localFeatureConfigHash ?? null,
    leaderConfigHash: input.leaderConfigHash ?? null,
    leaderObservationConfigHash: input.leaderObservationConfigHash ?? null,
  }
  return { state: 'REEXPANSION_CANDIDATE', candidate }
}
