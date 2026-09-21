/**
 * H4B — LEADER_CONTINUATION causal outcome evaluator (PURE / research-only).
 *
 * Consumes a frozen `ShadowCandidateEvent` + the H4B-PREP 1m tape and computes descriptive
 * causal outcomes over the pre-registered 5m/15m/30m windows. It is runnable only AFTER the
 * horizon has elapsed; it NEVER runs inside candidate generation and NEVER trades.
 *
 * Load-bearing integrity contracts (H4B STEP 13–18):
 *   - NO LOOKAHEAD: bars are reconstructed with the causal tape contract (`barsAsKnownAt`)
 *     as-of an explicit evaluation time; a future revision cannot alter candidate-time facts.
 *   - TERMINAL CAUSALITY: once `low <= invalidationPrice`, the primary path TERMINATES. No later
 *     bar may improve MFE / success / time-to-R. Post-terminal upside is recorded ONLY as an
 *     explicitly-labelled COUNTERFACTUAL, never as primary credit.
 *   - SAME-BAR AMBIGUITY: if one bar breaches invalidation AND reaches a new favourable
 *     threshold, order is unknown → `AMBIGUOUS_SAME_BAR`: the favourable threshold is NOT
 *     credited, terminal invalidation is recorded at that bar, MFE is taken through the prior
 *     completed bar, and that bar's high/low are retained separately for diagnostics.
 *   - TAPE COMPLETENESS: COMPLETE → primary-eligible; DEGRADED_COMPLETE/INCOMPLETE/CONTINUED →
 *     not primary-eligible (recorded, censored). Missing/uncertifiable interval → UNSCORABLE,
 *     never scored as zero.
 *
 * No imports from executor/broker/risk/arbitration.
 */
import type { Candle } from '@/types'
import type { ShadowCandidateEvent } from './leader-continuation'
import { barsAsKnownAt, type TapeEvent, type TapeCompleteness } from '@/lib/research/tape-1m-replay'

export type WindowTerminalState =
  | 'INVALIDATION'
  | 'AMBIGUOUS_SAME_BAR'
  | 'HORIZON'
  | '30M_HORIZON'
  | 'INSUFFICIENT_TAPE'
  | 'DATA_GAP'
  | 'TAPE_INCOMPLETE'

export interface WindowOutcome {
  windowMin: number
  scorable: boolean
  terminalState: WindowTerminalState
  causalMfePct: number | null
  causalMaePct: number | null
  causalMfeR: number | null
  causalMaeR: number | null
  timeTo0_5RSec: number | null
  timeTo1RSec: number | null
  timeTo2RSec: number | null
  invalidationHit: boolean
  timeToInvalidationSec: number | null
  ambiguousSameBar: boolean
  ambiguousBarHigh: number | null
  ambiguousBarLow: number | null
  // COUNTERFACTUAL — NOT PRIMARY OUTCOME, NOT TRADE CREDIT (diagnosis only)
  counterfactualPostTerminalMfePct: number | null
  counterfactualPostTerminalMaxPct: number | null
  barsInWindow: number
}

export interface CandidateOutcome {
  shadowCandidateId: string
  symbol: string
  referencePrice: number
  invalidationPrice: number
  riskUnitPrice: number
  candidateObservedAt: string
  tapeCompleteness: TapeCompleteness
  primaryEligible: boolean         // tape COMPLETE (else recorded but censored from primary efficacy)
  windows: WindowOutcome[]
  barsAvailableAfterAnchor: number
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const BAR_SEC = 60
const GAP_TOL_SEC = 2 * BAR_SEC   // a >2-minute jump between adjacent 1m bars = a data gap

/** True when the tape verdict permits PRIMARY efficacy scoring. */
export function tapePrimaryEligible(c: TapeCompleteness): boolean {
  return c === 'COMPLETE'
}

/**
 * Compute the causal outcome for one candidate. `tapeEvents` are the parsed tape events for this
 * symbol (from parseTape). `asOfMs` is the evaluation time (default: after the last observed bar),
 * used for the causal `barsAsKnownAt` reconstruction — future revisions past this point are invisible.
 */
export function evaluateCandidateOutcome(
  candidate: ShadowCandidateEvent,
  tapeEvents: TapeEvent[],
  opts: { tapeCompleteness: TapeCompleteness; asOfMs?: number; windowsMin?: number[] },
): CandidateOutcome {
  const symbol = candidate.symbol
  const reference = candidate.referencePrice
  const invalid = candidate.invalidationPrice
  const R = candidate.riskUnitPrice
  const anchorMs = Date.parse(candidate.candidateObservedAt)
  const windows = opts.windowsMin ?? [5, 15, 30]
  const primaryEligible = tapePrimaryEligible(opts.tapeCompleteness)

  // Evaluation time: default just past the last observation so the whole horizon is visible.
  let maxObs = anchorMs
  for (const e of tapeEvents) {
    const raw = (e as Record<string, unknown>).observedAtMs
    const t = typeof raw === 'number' ? raw : 0
    if (t > maxObs) maxObs = t
  }
  const asOfMs = opts.asOfMs ?? maxObs + 1

  // Causal reconstruction: bars as Companion knew them by asOfMs. NO LOOKAHEAD past asOfMs.
  const allBars = barsAsKnownAt(tapeEvents, symbol, asOfMs)
  // Post-anchor path (strictly after the candidate observation), chronological.
  const postBars = allBars.filter(b => b.time * SECOND > anchorMs).sort((a, b) => a.time - b.time)

  const windowsOut = windows.map(w => scanWindow(postBars, anchorMs, w, reference, invalid, R, primaryEligible, opts.tapeCompleteness))

  return {
    shadowCandidateId: candidate.shadowCandidateId,
    symbol,
    referencePrice: reference,
    invalidationPrice: invalid,
    riskUnitPrice: R,
    candidateObservedAt: candidate.candidateObservedAt,
    tapeCompleteness: opts.tapeCompleteness,
    primaryEligible,
    windows: windowsOut,
    barsAvailableAfterAnchor: postBars.length,
  }
}

function scanWindow(
  postBars: Candle[], anchorMs: number, windowMin: number,
  reference: number, invalid: number, R: number,
  primaryEligible: boolean, completeness: TapeCompleteness,
): WindowOutcome {
  const windowEndMs = anchorMs + windowMin * MINUTE
  const bars = postBars.filter(b => b.time * SECOND <= windowEndMs)
  const lastAvailMs = postBars.length ? postBars[postBars.length - 1].time * SECOND : anchorMs

  const base: WindowOutcome = {
    windowMin, scorable: false, terminalState: 'INSUFFICIENT_TAPE',
    causalMfePct: null, causalMaePct: null, causalMfeR: null, causalMaeR: null,
    timeTo0_5RSec: null, timeTo1RSec: null, timeTo2RSec: null,
    invalidationHit: false, timeToInvalidationSec: null,
    ambiguousSameBar: false, ambiguousBarHigh: null, ambiguousBarLow: null,
    counterfactualPostTerminalMfePct: null, counterfactualPostTerminalMaxPct: null,
    barsInWindow: bars.length,
  }
  if (!Number.isFinite(reference) || !(R > 0)) { base.terminalState = 'DATA_GAP'; return base }
  if (completeness === 'INCOMPLETE' || completeness === 'CONTINUED') { base.terminalState = 'TAPE_INCOMPLETE'; return base }

  const thr = (k: number) => reference + k * R
  let mfeHigh = -Infinity   // max high over bars STRICTLY BEFORE any terminal invalidation bar
  let maeLow = Infinity     // min low over bars up to and including the terminal bar
  let t05: number | null = null, t1: number | null = null, t2: number | null = null
  let terminalIdx = -1
  let terminalState: WindowTerminalState | null = null
  let ambiguous = false, ambHigh: number | null = null, ambLow: number | null = null
  let gapBefore = false

  let prevTime: number | null = null
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    if (prevTime !== null && b.time - prevTime > GAP_TOL_SEC) { gapBefore = true; terminalIdx = i - 1; terminalState = 'DATA_GAP'; break }
    prevTime = b.time
    const invalHit = b.low <= invalid
    if (invalHit) {
      const newFav = (b.high >= thr(0.5) && t05 === null) || (b.high >= thr(1) && t1 === null) || (b.high >= thr(2) && t2 === null)
      if (newFav) { ambiguous = true; ambHigh = b.high; ambLow = b.low }
      maeLow = Math.min(maeLow, b.low)   // the invalidation bar's low IS part of the adverse path
      terminalIdx = i
      terminalState = ambiguous ? 'AMBIGUOUS_SAME_BAR' : 'INVALIDATION'
      break
    }
    // No invalidation this bar → credit favourable thresholds (pre-terminal) + extend MFE/MAE.
    const tSec = Math.round((b.time * SECOND - anchorMs) / SECOND)
    if (t05 === null && b.high >= thr(0.5)) t05 = tSec
    if (t1 === null && b.high >= thr(1)) t1 = tSec
    if (t2 === null && b.high >= thr(2)) t2 = tSec
    mfeHigh = Math.max(mfeHigh, b.high)
    maeLow = Math.min(maeLow, b.low)
  }

  // Resolve terminal / coverage.
  if (terminalState === null) {
    if (lastAvailMs < windowEndMs) { base.terminalState = 'INSUFFICIENT_TAPE'; base.scorable = false; return finalize(base, mfeHigh, maeLow, reference, R, t05, t1, t2, false, null, false, null, null, null, null) }
    terminalState = windowMin >= 30 ? '30M_HORIZON' : 'HORIZON'
  }

  const invalidationHit = terminalState === 'INVALIDATION' || terminalState === 'AMBIGUOUS_SAME_BAR'
  const terminalBar = terminalIdx >= 0 ? bars[terminalIdx] : null
  const timeToInvalidationSec = invalidationHit && terminalBar ? Math.round((terminalBar.time * SECOND - anchorMs) / SECOND) : null

  // Counterfactual (post-terminal upside) — diagnosis only, never primary credit.
  let cfMfePct: number | null = null, cfMaxPct: number | null = null
  if (invalidationHit && terminalIdx >= 0) {
    let cfHigh = -Infinity
    for (let j = terminalIdx + 1; j < bars.length; j++) cfHigh = Math.max(cfHigh, bars[j].high)
    if (cfHigh > -Infinity) { cfMfePct = ((cfHigh - reference) / reference) * 100; cfMaxPct = cfHigh }
  }

  const scorable = primaryEligible && terminalState !== 'DATA_GAP' && !gapBefore
  const out = finalize(base, mfeHigh, maeLow, reference, R, t05, t1, t2, invalidationHit, timeToInvalidationSec, ambiguous, ambHigh, ambLow, cfMfePct, cfMaxPct)
  out.terminalState = terminalState
  out.scorable = scorable
  return out
}

function finalize(
  base: WindowOutcome, mfeHigh: number, maeLow: number, reference: number, R: number,
  t05: number | null, t1: number | null, t2: number | null,
  invalidationHit: boolean, timeToInvalidationSec: number | null,
  ambiguous: boolean, ambHigh: number | null, ambLow: number | null,
  cfMfePct: number | null, cfMaxPct: number | null,
): WindowOutcome {
  const mfeValid = mfeHigh > -Infinity
  const maeValid = maeLow < Infinity
  base.causalMfePct = mfeValid ? ((mfeHigh - reference) / reference) * 100 : null
  base.causalMaePct = maeValid ? ((maeLow - reference) / reference) * 100 : null
  base.causalMfeR = mfeValid ? (mfeHigh - reference) / R : null
  base.causalMaeR = maeValid ? (maeLow - reference) / R : null
  base.timeTo0_5RSec = t05
  base.timeTo1RSec = t1
  base.timeTo2RSec = t2
  base.invalidationHit = invalidationHit
  base.timeToInvalidationSec = timeToInvalidationSec
  base.ambiguousSameBar = ambiguous
  base.ambiguousBarHigh = ambHigh
  base.ambiguousBarLow = ambLow
  base.counterfactualPostTerminalMfePct = cfMfePct
  base.counterfactualPostTerminalMaxPct = cfMaxPct
  return base
}
