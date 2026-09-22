/**
 * QUALITY_ONLY shadow-observation experiment — spec/provenance layer.
 *
 * PAPER/RESEARCH ONLY. This module (and its siblings under
 * `src/lib/experiments/quality-only/`) is purely additive, read-only research
 * code layered on top of the already-computed decision stream. Nothing here is
 * imported by BASE (src/lib/setup-detectors.ts, src/lib/buy-log.ts,
 * src/lib/monitor.ts, scripts/alert-daemon.ts) — those files are treated as
 * frozen/read-only inputs. Nothing here calls the broker or PaperExecutor.
 *
 * ARCHITECTURAL CHOICE (documented per the task instructions): this experiment
 * builds on the LIVE shadow-observation substrate
 * (`src/lib/research/shadow-journal.ts`), which already has a real, daemon-
 * integrated identity/lifecycle/rejection-layer scheme, rather than resurrecting
 * the old H4B epoch/marker/config-hash infrastructure that exists only on
 * unmerged research branches. Where shadow-journal.ts already provides a
 * primitive with the same guarantee, this module reuses it directly and cites
 * the equivalence (see reconstruct-gates.ts and candidate.ts doc comments).
 * Where it does not, the smallest isolated QUALITY_ONLY-specific addition is
 * added here.
 */
import { execSync } from 'child_process'
import { createHash } from 'crypto'

/** Bump this and mint a NEW epoch for ANY change to candidate/freshness/outcome/
 *  collection-minimum/subgroup semantics. Never silently patch epoch 1's meaning —
 *  see "No tuning during epoch 1" in the preregistration doc. */
export const EXPERIMENT_SPEC_VERSION = 'v2-quality-only-1'

/** Fixed for the life of this preregistered epoch. A defect found after collection
 *  starts requires a NEW epoch value, never an in-place edit to this one. */
export const EXPERIMENT_EPOCH = 'quality-only-epoch-1'

/**
 * The exact set of literal thresholds/config this experiment's candidate
 * definition depends on. Anything that could change the eligible population
 * belongs here so configHash changes the moment the definition would drift.
 *
 * The four *_DEFAULT values below are NOT re-derived by arithmetic — they are
 * transcribed, read-only, from src/lib/setup-detectors.ts and cross-checked by
 * the drift-detection tests in tests/quality-only.test.ts (which grep the
 * source file for these exact literals). If setup-detectors.ts changes any of
 * them, the drift tests fail loudly rather than this experiment silently
 * drifting out of sync with BASE.
 */
export interface QualityOnlyConfigInputs {
  specVersion: string
  epoch: string
  /** setup-detectors.ts:195 — ANTI_FADE_TYPES chase gate. */
  maxBelowHighPctDefault: number
  /** setup-detectors.ts:249 — SPACE gate, MIN_SPACE_R env('MIN_SPACE_R', 0.5). */
  minSpaceRDefault: number
  /** setup-detectors.ts:503 — leg-maturity gate, MAX_LEG_RUNUP_PCT env(..., Infinity). */
  maxLegRunupPctDefault: number
  /** setup-detectors.ts:506 — MIN_GREEN_STREAK env(..., 0). */
  minGreenStreakDefault: number
  /** setup-detectors.ts:191 — ANTI_FADE_TYPES contents. */
  antiFadeTypes: string[]
}

export const DEFAULT_CONFIG_INPUTS: QualityOnlyConfigInputs = {
  specVersion: EXPERIMENT_SPEC_VERSION,
  epoch: EXPERIMENT_EPOCH,
  maxBelowHighPctDefault: 5,
  minSpaceRDefault: 0.5,
  maxLegRunupPctDefault: Infinity,
  minGreenStreakDefault: 0,
  antiFadeTypes: ['breakout', 'break_of_structure'],
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v != null && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`
  }
  if (v === Infinity) return '"Infinity"'
  return JSON.stringify(v)
}

/** Deterministic hash of everything that defines the CANDIDATE population. Same
 *  inputs -> same hash, always (see test: "epoch hash stable/deterministic"). */
export function computeConfigHash(inputs: QualityOnlyConfigInputs = DEFAULT_CONFIG_INPUTS): string {
  return createHash('sha256').update(stableStringify(inputs)).digest('hex').slice(0, 16)
}

/**
 * The DECISION POLICY hash — a separate hash of the mapping decision (which
 * sub-checks compose OFF_HIGH / GRADE_FLOOR / SPACE / RUNUP / QUALITY_OTHER,
 * and the freshness/outcome conventions) distinct from `configHash`'s raw
 * threshold values. Kept separate so a threshold tweak (configHash) can be
 * told apart from a policy/mapping tweak (decisionPolicyHash) in provenance.
 */
export interface DecisionPolicy {
  specVersion: string
  epoch: string
  mapping: {
    OFF_HIGH: string
    GRADE_FLOOR: string
    SPACE: string
    RUNUP: string
    QUALITY_OTHER: string
  }
  freshnessRule: string
  outcomeConvention: string
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  specVersion: EXPERIMENT_SPEC_VERSION,
  epoch: EXPERIMENT_EPOCH,
  mapping: {
    OFF_HIGH: 'fadedChase (ANTI_FADE_TYPES + distFromHigh < -MAX_BELOW_HIGH_PCT)',
    GRADE_FLOOR: 'gradeFloorFail (setup.grade === "below" && !GRADE_FLOOR_EXEMPT.has(type))',
    SPACE: 'noRoom (spaceToNextSupply(...).r < MIN_SPACE_R)',
    RUNUP: 'lateInLeg (legRunUpPct(...) > MAX_LEG_RUNUP_PCT)',
    QUALITY_OTHER: 'setup.qualityVetoed === true AND OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR all independently false (production\'s own aggregate residual-quality truth — this experiment does not require proving which private sub-cause fired; unconfirmedKnown/quarantinedKnown are recomputed where causally knowable, descriptive only, not gating)',
  },
  freshnessRule: 'reuses shadow-journal.ts identity: one candidate per (etTradingDay, setupId); earliest valid observation wins, no hindsight replacement',
  outcomeConvention: 'reuses shadow-journal.ts resolveShadowOutcome bar-walking convention: forward bars only, same-bar stop+target ambiguity counts as STOP, no favorable credit after terminal invalidation',
}

export function computeDecisionPolicyHash(policy: DecisionPolicy = DEFAULT_DECISION_POLICY): string {
  return createHash('sha256').update(stableStringify(policy)).digest('hex').slice(0, 16)
}

/** Producer git HEAD, best-effort. Never throws — a research artifact must not
 *  fail to persist because git is unavailable; it records 'unknown' instead
 *  (this is provenance metadata, not a correctness-critical value). */
export function producerGitHead(cwd: string = process.cwd()): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

export function producerGitBranch(cwd: string = process.cwd()): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

/** Provenance block persisted with EVERY official artifact/session (non-negotiable #5). */
export interface Provenance {
  producerGitHead: string
  producerGitBranch: string
  specVersion: string
  epoch: string
  configHash: string
  decisionPolicyHash: string
  generatedAt: string
}

export function buildProvenance(cwd?: string): Provenance {
  return {
    producerGitHead: producerGitHead(cwd),
    producerGitBranch: producerGitBranch(cwd),
    specVersion: EXPERIMENT_SPEC_VERSION,
    epoch: EXPERIMENT_EPOCH,
    configHash: computeConfigHash(),
    decisionPolicyHash: computeDecisionPolicyHash(),
    generatedAt: new Date().toISOString(),
  }
}
