/**
 * Read-only reconstruction of `classifyBuy`'s short-circuited 'veto' verdict.
 *
 * PROBLEM: on this branch, `classifyBuy()` (src/lib/buy-log.ts) collapses BOTH
 * `setup.qualityVetoed` (itself an OR of several distinct quality sub-checks
 * computed inside setup-detectors.ts's `buildSetup`) AND `gradeFloorFail` into a
 * single `'veto'` verdict, and short-circuits before ever checking
 * standDown/capped/dup for a 'veto' row. There is no `decomposeGates()`-style
 * multi-gate output on this branch (that exists only on the unmerged frozen
 * research branch, which this module does NOT depend on).
 *
 * ── REVISION (coordinator correction, definitional-alignment fix) ───────────
 * The first version of this module tried to PROVE which private sub-cause fired
 * whenever `qualityVetoed` was true, and treated `buildSetup`'s sixth,
 * module-private disjunct (`args.vetoTrigger?.active`, currently
 * `longBounceRolledOver(ctx)` for the bounce-family detectors) as an
 * unreconstructable cause that had to exclude the row entirely. That was overly
 * conservative: it silently narrowed QUALITY_OTHER to `unconfirmed OR
 * quarantined` ONLY, which is NOT what the six-session retrospective
 * provenance audit measured — that audit's QUALITY_OTHER was the residual
 * quality-veto family AFTER OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR are separated out,
 * with NO further sub-decomposition required.
 *
 * FIX: use production's own trusted `setup.qualityVetoed` boolean directly as
 * the aggregate residual-quality truth. This module does NOT need to prove
 * which private sub-cause fired — production's own OR already guarantees that
 * if `qualityVetoed` is true and OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR are ALL
 * independently false, SOME quality cause fired, and by elimination it can only
 * be one of: `unconfirmed`, `quarantined`, or the module-private
 * `vetoTrigger.active` disjunct (currently `longBounceRolledOver`, but this
 * representation stays correct even if production adds another private
 * disjunct later — nothing here names it). `unconfirmed`/`quarantined` are
 * still recomputed where causally knowable (DESCRIPTIVE ONLY — they do not
 * gate inclusion) using the same exported functions/literals as before.
 *
 * This makes QUALITY_OTHER (prospective) match the six-session retrospective
 * audit's gate-level concept exactly: the residual quality-veto family once
 * OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR are separated — no reverse-engineering of
 * `longBounceRolledOver()` (or any other private disjunct) required or
 * attempted.
 */
import type { KeyLevel, SetupType } from '@/types'
import {
  spaceToNextSupply, legRunUpPct, greenStreak, TRIGGERS_QUARANTINED,
} from '@/lib/setup-detectors'
import { GRADE_FLOOR_EXEMPT } from '@/lib/buy-log'
import { DEFAULT_CONFIG_INPUTS } from './spec'

/** Transcribed literals — see spec.ts doc comment and the drift-detection tests. */
const MAX_BELOW_HIGH_PCT = DEFAULT_CONFIG_INPUTS.maxBelowHighPctDefault
const MIN_SPACE_R = DEFAULT_CONFIG_INPUTS.minSpaceRDefault
const MAX_LEG_RUNUP_PCT = DEFAULT_CONFIG_INPUTS.maxLegRunupPctDefault
const MIN_GREEN_STREAK = DEFAULT_CONFIG_INPUTS.minGreenStreakDefault
const ANTI_FADE_TYPES = new Set<string>(DEFAULT_CONFIG_INPUTS.antiFadeTypes)

/** Minimal shape needed to reconstruct — deliberately narrow so callers can pass
 *  either a live DetectedSetup or a persisted candidate-time snapshot. */
export interface ReconstructGatesInput {
  type: SetupType
  direction: 'long' | 'short'
  /** production's own trusted flag — the aggregate residual-quality truth we
   *  build on, never re-derived by OR-ing our own sub-checks. */
  qualityVetoed: boolean
  grade: 'A' | 'B' | 'C' | 'below' | string
  distanceFromDayHighPct: number | null   // r.technicals?.distanceFromDayHighPct at signal time
  candles: import('@/types').Candle[]     // bars up to and including signal time — no lookahead
  price: number
  levels: KeyLevel[]
  entryFill: number
  riskDist: number                        // entryFill - stopReference
}

export interface ReconstructedGateVector {
  /** Production's own trusted flag, passed through unmodified. */
  qualityVetoed: boolean
  fadedChase: boolean       // OFF_HIGH — causally reconstructed, exact
  gradeFloorFail: boolean   // GRADE_FLOOR — causally reconstructed, exact
  noRoom: boolean           // SPACE — causally reconstructed, exact
  lateInLeg: boolean        // RUNUP — causally reconstructed, exact
  /** DESCRIPTIVE ONLY, not gating: recomputed where causally knowable via the
   *  same exported functions as before. */
  unconfirmedKnown: boolean
  quarantinedKnown: boolean
  /** true iff qualityVetoed && none of the four named dimensions fired — the
   *  residual-quality condition PRIMARY eligibility keys on. Production's OR
   *  guarantees SOME quality cause fired in this state; which one is not
   *  required knowledge. */
  residualQualityTrue: boolean
  /** true iff residualQualityTrue AND neither unconfirmedKnown nor
   *  quarantinedKnown explains it — i.e. the fired cause is the module-private
   *  disjunct (today: longBounceRolledOver; deliberately NOT named, so this
   *  stays correct if production adds another private disjunct later). */
  qualityOtherResidualPrivate: boolean
  /**
   * Diagnostic-only field for NON-PRIMARY, multi-fail rows: when qualityVetoed
   * is true AND at least one of OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR is ALSO true,
   * we cannot prove whether a residual quality cause additionally co-fired
   * (qualityVetoed is an aggregate OR, not a bitmask) — so it is marked
   * 'UNKNOWN' rather than invented. PRIMARY eligibility never depends on this
   * field (those rows are excluded by the named-dimension checks regardless).
   */
  residualQualityPresence: 'TRUE' | 'FALSE' | 'UNKNOWN'
}

export function reconstructGateVector(input: ReconstructGatesInput): ReconstructedGateVector {
  const { type, direction, qualityVetoed, grade, distanceFromDayHighPct, candles, price, levels, entryFill, riskDist } = input

  const fadedChase = ANTI_FADE_TYPES.has(type) &&
    distanceFromDayHighPct != null && distanceFromDayHighPct < -MAX_BELOW_HIGH_PCT

  const gradeFloorFail = grade === 'below' && !GRADE_FLOOR_EXEMPT.has(type)

  const runUp = direction === 'long' ? legRunUpPct(candles, price) : null
  const lateInLeg = runUp != null && runUp > MAX_LEG_RUNUP_PCT

  const unconfirmedKnown = direction === 'long' && MIN_GREEN_STREAK > 0 &&
    greenStreak(candles) < MIN_GREEN_STREAK

  const quarantinedKnown = TRIGGERS_QUARANTINED.has(type)

  const space = spaceToNextSupply(levels, entryFill, riskDist, direction)
  const noRoom = space.r != null && space.r < MIN_SPACE_R

  const anyNamedFired = fadedChase || gradeFloorFail || noRoom || lateInLeg
  const residualQualityTrue = qualityVetoed && !anyNamedFired
  const qualityOtherResidualPrivate = residualQualityTrue && !unconfirmedKnown && !quarantinedKnown

  let residualQualityPresence: 'TRUE' | 'FALSE' | 'UNKNOWN'
  if (!qualityVetoed) residualQualityPresence = 'FALSE'
  else if (!anyNamedFired) residualQualityPresence = 'TRUE'
  else residualQualityPresence = 'UNKNOWN'   // multi-fail: can't prove residual co-fired or not

  return {
    qualityVetoed, fadedChase, gradeFloorFail, noRoom, lateInLeg,
    unconfirmedKnown, quarantinedKnown, residualQualityTrue, qualityOtherResidualPrivate,
    residualQualityPresence,
  }
}

/**
 * The 11 top-level named dimensions this experiment reasons about (matches the
 * task's dimension list): OFF_HIGH, GRADE_FLOOR, QUALITY_OTHER, SPACE, SESSION,
 * VOLUME, CAPPED, DUP, TRACKING_FLOOR, STANDDOWN, RUNUP.
 */
export type NamedDimension =
  | 'OFF_HIGH' | 'GRADE_FLOOR' | 'QUALITY_OTHER' | 'SPACE' | 'SESSION'
  | 'VOLUME' | 'CAPPED' | 'DUP' | 'TRACKING_FLOOR' | 'STANDDOWN' | 'RUNUP'

/** The full failed-dimension vector for a row (quality-decomposition dims only —
 *  session/volume/standDown/capped/dup/trackingFloor are independently confirmed
 *  by the caller in candidate.ts using the exported buy-log functions and folded
 *  in there, since they are not part of setup.qualityVetoed at all).
 *  QUALITY_OTHER is reported whenever `residualQualityTrue` (aggregate) is true —
 *  regardless of whether it's the "known" (unconfirmed/quarantined) or "private"
 *  sub-case, both are the same named dimension. */
export function failedQualityDimensions(v: ReconstructedGateVector): NamedDimension[] {
  const out: NamedDimension[] = []
  if (v.fadedChase) out.push('OFF_HIGH')
  if (v.gradeFloorFail) out.push('GRADE_FLOOR')
  if (v.noRoom) out.push('SPACE')
  if (v.lateInLeg) out.push('RUNUP')
  if (v.residualQualityTrue) out.push('QUALITY_OTHER')
  return out
}

/**
 * A row belongs to the PRIMARY QUALITY_ONLY population iff:
 *   setup.qualityVetoed === true
 *   AND OFF_HIGH == false AND SPACE == false AND RUNUP == false AND GRADE_FLOOR == false
 * (higher-level gates — TRACKING_FLOOR/SESSION/VOLUME/STANDDOWN/CAPPED/DUP/no-BASE-TAKE/
 * freshness — are enforced by the caller in candidate.ts, not here). Under this
 * definition `residualQualityTrue` is TRUE exactly when the row qualifies —
 * production's own OR guarantees some quality cause fired, without this module
 * needing to prove WHICH one. Multi-fail rows (QUALITY_OTHER+SPACE,
 * GRADE_FLOOR+QUALITY_OTHER, OFF_HIGH+QUALITY_OTHER, RUNUP+QUALITY_OTHER) are
 * excluded by construction because failedQualityDimensions returns more than
 * one entry, or an entry other than QUALITY_OTHER alone.
 */
export function isPrimaryQualityOther(v: ReconstructedGateVector): boolean {
  const dims = failedQualityDimensions(v)
  return dims.length === 1 && dims[0] === 'QUALITY_OTHER'
}
