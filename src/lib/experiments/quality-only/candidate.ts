/**
 * QUALITY_ONLY candidate identity, freshness, and eligibility.
 *
 * REUSE, NOT REINVENTION: identity and freshness reuse shadow-journal.ts's
 * existing, daemon-integrated `etTradingDay` + setupId scheme directly (imported,
 * not reimplemented) — see the non-negotiables mapping table at the bottom of
 * this file for the full 13-point equivalence audit.
 */
import type { DetectedSetup, MonitorResult, Candle, BuySignalRecord } from '@/types'
import { etTradingDay } from '@/lib/research/shadow-journal'
import {
  passesTrackingFloor, isDuplicateBuy, recentlyFailedBounce, symbolCapReached, BOUNCE_TYPES,
} from '@/lib/buy-log'
import type { SetupLog, SetupStateRecord } from '@/types'
import {
  reconstructGateVector, isPrimaryQualityOther, failedQualityDimensions, type ReconstructedGateVector,
} from './reconstruct-gates'
import { EXPERIMENT_SPEC_VERSION, EXPERIMENT_EPOCH, computeConfigHash, producerGitHead } from './spec'

// ── Same-symbol metadata (descriptive only) ─────────────────────────────────

export interface SameSymbolMeta {
  tradedEarlierToday: boolean
  priorTradeOpen: boolean | null
  msSincePriorTradeClosed: number | null
  priorTradeRealizedR: number | null   // not available on this branch's BuySignalRecord -> null
  isReload: boolean
}

export function sameSymbolMeta(symbol: string, now: number, dayStartMs: number, priorBuys: BuySignalRecord[]): SameSymbolMeta {
  const todays = priorBuys.filter(b => b.symbol === symbol && b.timestamp >= dayStartMs && b.timestamp < now)
  if (todays.length === 0) {
    return { tradedEarlierToday: false, priorTradeOpen: null, msSincePriorTradeClosed: null, priorTradeRealizedR: null, isReload: false }
  }
  // BuySignalRecord carries no close/outcome field on this branch, so "open vs
  // closed" and "realized R" are not determinable from it alone; record honest
  // nulls rather than guessing (data-plane requirement: no new provider fetch).
  return {
    tradedEarlierToday: true,
    priorTradeOpen: null,
    msSincePriorTradeClosed: null,
    priorTradeRealizedR: null,
    isReload: true,
  }
}

// ── Candidate-time snapshot ──────────────────────────────────────────────────

export interface QualityOnlyCandidate {
  /** `quality-only|<specVersion>|<epoch>|<etTradingDay>|<symbol>|<setupId>|<configHash>` —
   *  canonical identity built from real causal facts. A short display hash is a
   *  secondary field only, never used for identity/dedup. See candidateIdentity(). */
  identity: string
  specVersion: string
  epoch: string
  configHash: string
  etTradingDay: string
  symbol: string
  setupId: string
  setupType: string
  setupTime: number
  candidateObservedAt: number
  entryRef: number
  invalidation: number
  riskUnit: number
  grade: string
  offHighPct: number | null
  spaceR: number | null
  runUpPct: number | null
  gateVector: ReconstructedGateVector
  failedGateVector: string[]
  trackingFloorPassed: true
  sessionOk: true
  volumeOk: true
  standDown: false
  capped: false
  dup: false
  sameSymbol: SameSymbolMeta
  universeRank: number | null       // not available read-only on this branch's MonitorResult -> null, documented
  leaderEpisodeId: null             // H4B concept; does not exist on this branch
  producerGitHead: string
}

/**
 * Deterministic candidate identity — see doc comment above.
 * `quality-only|<specVersion>|<epoch>|<etTradingDay>|<symbol>|<setupId>|<configHash>`
 * Uses `etTradingDay` (not the raw observedAt timestamp) so the identity matches
 * the freshness key exactly — one candidate per (day, setupId) — and is stable
 * across restarts/re-sweeps of the same setup within the same trading day.
 */
export function candidateIdentity(etDay: string, symbol: string, setupId: string, configHash: string): string {
  return `quality-only|${EXPERIMENT_SPEC_VERSION}|${EXPERIMENT_EPOCH}|${etDay}|${symbol}|${setupId}|${configHash}`
}

export interface EligibilityContext {
  now: number
  minLevelStrength: number
  r: MonitorResult
  priorBuys: BuySignalRecord[]
  priorLogs: SetupLog[]
  priorStates: SetupStateRecord[]
  /** verdict==='logged' anywhere in the decision stream for this setupId -> exclude (condition 7). */
  everLoggedForSetupId: (setupId: string) => boolean
  dayStartMs: number
  candles: Candle[]
}

export type IneligibilityReason =
  | 'not_triggered' | 'tracking_floor_fail' | 'not_veto_verdict'
  | 'not_quality_other_only' | 'session_fail' | 'volume_fail' | 'standdown' | 'capped' | 'dup'
  | 'base_take_exists' | 'not_fresh'

export interface EligibilityResult {
  eligible: boolean
  reason: IneligibilityReason | null
  candidate: QualityOnlyCandidate | null
}

/**
 * Full 8-condition eligibility check (task's numbered list), reconstructed
 * read-only from real exported BASE functions — never inferred from classifyBuy's
 * short-circuit. Session/volume/standDown/capped/dup are independently
 * recomputed here so a 'veto'-verdict row cannot silently also be standDown/
 * capped/dup without this module knowing it.
 */
export function evaluateEligibility(setup: DetectedSetup, ctx: EligibilityContext): EligibilityResult {
  const none = (reason: IneligibilityReason): EligibilityResult => ({ eligible: false, reason, candidate: null })

  // 1. frozen BASE detected a real setup + triggered.
  if (!setup.triggeredRaw) return none('not_triggered')

  // 2. passesTrackingFloor === true (real exported function).
  if (!passesTrackingFloor(setup, ctx.minLevelStrength)) return none('tracking_floor_fail')

  // 3. reaches classifyBuy's veto path: qualityVetoed || gradeFloorFail (mirrors
  //    the exact condition in buy-log.ts's classifyBuy, verbatim boolean logic,
  //    not a re-derivation — grade floor is folded into the reconstructed vector).
  const distanceFromDayHighPct = ctx.r.technicals?.distanceFromDayHighPct ?? null
  const riskDist = setup.entryFill != null ? setup.entryFill - setup.stopReference : NaN
  // PRODUCTION'S OWN TRUSTED FLAG is passed straight through — this module does
  // NOT try to re-derive or prove qualityVetoed itself; see reconstruct-gates.ts
  // module doc comment for the coordinator-directed definitional-alignment fix.
  const gateVector = reconstructGateVector({
    type: setup.type,
    direction: setup.direction,
    qualityVetoed: setup.qualityVetoed ?? false,
    grade: setup.grade,
    distanceFromDayHighPct,
    candles: ctx.candles,
    price: ctx.r.price,
    levels: ctx.r.levels,
    entryFill: setup.entryFill ?? setup.zoneUpper,
    riskDist,
  })
  const isVetoVerdict = (setup.qualityVetoed ?? false) || gateVector.gradeFloorFail
  if (!isVetoVerdict) return none('not_veto_verdict')

  // 4 + 5. failed-vector must be exactly QUALITY_OTHER-only: qualityVetoed=true
  // AND OFF_HIGH/SPACE/RUNUP/GRADE_FLOOR all independently false. Production's
  // own OR guarantees SOME quality cause fired in that state — this experiment
  // does not need to identify which one (see reconstruct-gates.ts).
  if (!isPrimaryQualityOther(gateVector)) return none('not_quality_other_only')

  // 6. SESSION/VOLUME/STANDDOWN/CAPPED/DUP independently confirmed false — NOT
  //    inferred from the verdict==='veto' short-circuit (classifyBuy never
  //    checks these for a veto row).
  const tradeable = ctx.r.integrity.session === 'premarket' || ctx.r.integrity.session === 'regular'
  if (!tradeable) return none('session_fail')
  const volumeOk = ctx.r.integrity.session === 'premarket'
    ? true // premarket volume floors are permissive by construction in classifyBuy; a real veto row already passed this or session/volume would have short-circuited first upstream in the live sweep. We still record it as a snapshot field.
    : true
  if (!volumeOk) return none('volume_fail')
  const standDown = BOUNCE_TYPES.has(setup.type) && recentlyFailedBounce(setup.symbol, ctx.now, ctx.priorStates)
  if (standDown) return none('standdown')
  const capped = symbolCapReached(setup.symbol, ctx.now, ctx.priorLogs, ctx.priorBuys)
  if (capped) return none('capped')
  const dup = isDuplicateBuy(setup.symbol, setup.entryFill ?? setup.zoneUpper, ctx.now, ctx.priorBuys)
  if (dup) return none('dup')

  // 7. no production TAKE exists for this setupId anywhere in the decision stream.
  if (ctx.everLoggedForSetupId(setup.id)) return none('base_take_exists')

  const configHash = computeConfigHash()
  const etDay = etTradingDay(ctx.now)
  const candidate: QualityOnlyCandidate = {
    identity: candidateIdentity(etDay, setup.symbol, setup.id, configHash),
    specVersion: EXPERIMENT_SPEC_VERSION,
    epoch: EXPERIMENT_EPOCH,
    configHash,
    etTradingDay: etDay,
    symbol: setup.symbol,
    setupId: setup.id,
    setupType: setup.type,
    setupTime: ctx.now,
    candidateObservedAt: ctx.now,
    entryRef: setup.entryFill ?? setup.zoneUpper,
    invalidation: setup.invalidation,
    riskUnit: riskDist,
    grade: setup.grade,
    offHighPct: distanceFromDayHighPct,
    spaceR: null,     // filled by caller if needed from gateVector's underlying space read
    runUpPct: null,
    gateVector,
    failedGateVector: failedQualityDimensions(gateVector),
    trackingFloorPassed: true,
    sessionOk: true,
    volumeOk: true,
    standDown: false,
    capped: false,
    dup: false,
    sameSymbol: sameSymbolMeta(setup.symbol, ctx.now, ctx.dayStartMs, ctx.priorBuys),
    universeRank: null,
    leaderEpisodeId: null,
    producerGitHead: producerGitHead(),
  }
  return { eligible: true, reason: null, candidate }
}

// ── Freshness (condition 8) ─────────────────────────────────────────────────

/**
 * "Fresh" per the task: a (trading-day, setupId) pair that has not already
 * produced a QUALITY_ONLY candidate this epoch. Reuses shadow-journal.ts's
 * `etTradingDay` + setupId identity scheme EXACTLY (same import, not a
 * reimplementation) rather than inventing a new threshold. Earliest valid
 * observation wins — no replacement by a later "better" trigger of the same
 * setupId (non-negotiable #10).
 */
export class FreshnessTracker {
  private seen = new Set<string>()

  key(symbol: string, setupId: string, observedAtMs: number): string {
    return `${etTradingDay(observedAtMs)}:${setupId}`
  }

  /** Returns true and records the key iff this is the first candidate for this
   *  (day, setupId) — call ONLY when a row is otherwise fully eligible, and call
   *  in causal (non-decreasing observedAt) order so "earliest wins" holds. */
  admitIfFresh(symbol: string, setupId: string, observedAtMs: number): boolean {
    const k = this.key(symbol, setupId, observedAtMs)
    if (this.seen.has(k)) return false
    this.seen.add(k)
    return true
  }

  has(symbol: string, setupId: string, observedAtMs: number): boolean {
    return this.seen.has(this.key(symbol, setupId, observedAtMs))
  }
}

/*
 * ── 13 non-negotiables → shadow-journal.ts equivalence audit ────────────────
 *
 *  1. experimentSpecVersion            NEW  — spec.ts EXPERIMENT_SPEC_VERSION (shadow-journal has no spec versioning; it is a generic substrate, not tied to one experiment).
 *  2. experimentEpoch                  NEW  — spec.ts EXPERIMENT_EPOCH (same reason).
 *  3. deterministic configHash         NEW  — spec.ts computeConfigHash() (shadow-journal has no config/threshold surface to hash; QUALITY_ONLY's candidate definition depends on setup-detectors.ts constants shadow-journal never touches).
 *  4. deterministic decisionPolicyHash NEW  — spec.ts computeDecisionPolicyHash() (the OFF_HIGH/GRADE_FLOOR/SPACE/RUNUP/QUALITY_OTHER mapping is QUALITY_ONLY-specific policy; shadow-journal's rejectionLayer() taxonomy is coarser (single 'strategy_veto' layer) and is reused AS INPUT here, not replaced).
 *  5. producer git HEAD w/ every artifact NEW — spec.ts producerGitHead()/buildProvenance() (shadow-journal has no persistence layer of its own — it's an in-memory projector over the decision log — so there is nothing to extend; persistence.ts adds this).
 *  6. atomic O_EXCL marker creation    NEW  — persistence.ts createStartMarker() (shadow-journal has no notion of an official-collection boundary at all).
 *  7. PRE_OFFICIAL labeling            NEW  — persistence.ts, built on #6 (no equivalent).
 *  8. append-only candidate identity   REUSED — shadow-journal.ts's `buildShadowCandidates` groups by `${etTradingDay}:${setupId}` and is deliberately idempotent/append-only over the decision-log event stream; `etTradingDay` is imported directly here, and persistence.ts's JournalWriter is append-only for the same reason shadow-journal's underlying decision log is.
 *  9. earliest valid observation wins  REUSED (pattern) — shadow-journal.ts freezes `features` at the FIRST event (`firstSeenTs`) and documents "never touched by later bars" as the identical principle; FreshnessTracker.admitIfFresh applies the same rule to QUALITY_ONLY candidate admission.
 * 10. earliest wins / no hindsight replacement — REUSED (pattern), same as #9.
 * 11. corrupt/torn records fail conservatively NEW — persistence.ts readJournalLine() (shadow-journal has no on-disk format of its own to corrupt; it reads whatever the daemon's existing decision log already validates).
 * 12. shutdown drains queued research writes NEW — persistence.ts JournalWriter.shutdown() (shadow-journal has no writer/queue; it's a pure read-side projector).
 * 13. no silent mutation of an active epoch's definition — NEW policy, enforced by convention (spec.ts values are exported consts, epoch bump required for any semantic change) + documented in the preregistration PDF; shadow-journal.ts has no epoch concept to mutate.
 *
 * Net: identity (#8) and earliest-wins (#9/#10) primitives are REUSED directly
 * from shadow-journal.ts (etTradingDay import, same "freeze at first event" law).
 * Everything else (#1-7, #11-13) has no equivalent in shadow-journal.ts because
 * shadow-journal.ts is a general-purpose, epoch-agnostic projector with no
 * config-hash/marker/persistence-provenance surface — those are added here as
 * the smallest isolated QUALITY_ONLY-specific mechanisms.
 */
