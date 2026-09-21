/**
 * H4B — LEADER_CONTINUATION causal outcome evaluator (PURE / research-only).
 *
 * Consumes a frozen `ShadowCandidateEvent` + the H4B-PREP 1m tape and computes descriptive
 * PROSPECTIVE outcomes over the pre-registered 5m/15m/30m windows. Runnable only AFTER the horizon
 * has elapsed; never inside candidate generation; never trades.
 *
 * TWO CLOCKS, TWO PRICES (H4B red-team §3/§4/§6 — load-bearing):
 *   - STRUCTURAL level (fixed at candidate emission): structuralBreakoutPrice = base.high,
 *     structuralInvalidationPrice = base.low, structuralRiskUnit = base.high − base.low.
 *   - PROSPECTIVE outcome (measured post-observation): the primary outcome starts at
 *     `primaryOutcomeStart` = the FIRST closed 1m bar at/after `candidateObservedAt`; its close is
 *     `outcomeReferencePrice`. Every prospective metric is measured over bars STRICTLY AFTER that
 *     start bar, from `outcomeReferencePrice`, normalized by the structural risk unit. Therefore:
 *       • a price move BEFORE candidate observation earns ZERO prospective credit;
 *       • an invalidation BEFORE observation cannot terminate the prospective path;
 *       • +kR reached before observation cannot be credited.
 *   Prospective metrics are named `prospective*` and are NEVER mixed with the structural level.
 *
 * TERMINAL CAUSALITY: once low ≤ structuralInvalidationPrice (post-start), the primary path
 *   terminates; later bars are COUNTERFACTUAL only. SAME-BAR AMBIGUITY: a bar breaching invalidation
 *   that also reaches a new favourable threshold → AMBIGUOUS_SAME_BAR (no credit; MFE through prior
 *   bar). NO LOOKAHEAD: bars via `barsAsKnownAt(asOfMs)`; a later revision cannot alter an earlier
 *   as-of replay. TAPE COMPLETENESS: only COMPLETE is primary-eligible.
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
  | 'NO_OUTCOME_START_BAR'
  | 'DATA_GAP'
  | 'TAPE_INCOMPLETE'

export interface WindowOutcome {
  windowMin: number
  scorable: boolean
  terminalState: WindowTerminalState
  // PROSPECTIVE (post-observation) metrics — measured from outcomeReferencePrice, normalized by the structural R.
  prospectiveMfePct: number | null
  prospectiveMaePct: number | null
  prospectiveMfeR: number | null
  prospectiveMaeR: number | null
  prospectiveTimeTo0_5RSec: number | null
  prospectiveTimeTo1RSec: number | null
  prospectiveTimeTo2RSec: number | null
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
  canonicalCandidateKey: string
  symbol: string
  candidateObservedAt: string
  // structural level (from candidate emission)
  structuralBreakoutPrice: number
  structuralInvalidationPrice: number
  structuralRiskUnit: number
  // prospective outcome anchors (from the tape, post-observation)
  primaryOutcomeStartSec: number | null
  outcomeReferencePrice: number | null
  // how far ABOVE the structural breakout the candidate already traded at observation (diagnostic; NOT credit)
  structuralExtensionAtObsPct: number | null
  tapeCompleteness: TapeCompleteness
  primaryEligible: boolean            // tape COMPLETE AND a closed outcome-start bar exists
  windows: WindowOutcome[]
  barsAvailableAfterAnchor: number
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const BAR_SEC = 60
const GAP_TOL_SEC = 2 * BAR_SEC

export function tapePrimaryEligible(c: TapeCompleteness): boolean {
  return c === 'COMPLETE'
}

export function evaluateCandidateOutcome(
  candidate: ShadowCandidateEvent,
  tapeEvents: TapeEvent[],
  opts: { tapeCompleteness: TapeCompleteness; asOfMs?: number; windowsMin?: number[] },
): CandidateOutcome {
  const symbol = candidate.symbol
  const structuralBreakoutPrice = candidate.referencePrice     // base.high
  const structuralInvalidationPrice = candidate.invalidationPrice // base.low
  const R = candidate.riskUnitPrice                            // base.high - base.low
  const anchorMs = Date.parse(candidate.candidateObservedAt)
  const windows = opts.windowsMin ?? [5, 15, 30]
  const tapeOk = tapePrimaryEligible(opts.tapeCompleteness)

  // outcomeEvaluationAsOf: default just past the last observation so the whole horizon is visible.
  let maxObs = anchorMs
  for (const e of tapeEvents) {
    const raw = (e as Record<string, unknown>).observedAtMs
    const t = typeof raw === 'number' ? raw : 0
    if (t > maxObs) maxObs = t
  }
  const asOfMs = opts.asOfMs ?? maxObs + 1

  // Causal reconstruction (NO LOOKAHEAD past asOfMs).
  const allBars = barsAsKnownAt(tapeEvents, symbol, asOfMs)
  const sorted = allBars.slice().sort((a, b) => a.time - b.time)

  // FROZEN primary outcome origin: the FIRST bar at/after candidateObservedAt is the outcome-start bar;
  // its close is the causally-knowable outcome reference. Prospective path = bars STRICTLY AFTER it.
  const startBar = sorted.find(b => b.time * SECOND >= anchorMs) ?? null
  const outcomeReferencePrice = startBar ? startBar.close : null
  const primaryOutcomeStartSec = startBar ? startBar.time : null
  const postStart = startBar ? sorted.filter(b => b.time > startBar.time) : []
  const structuralExtensionAtObsPct = outcomeReferencePrice != null && structuralBreakoutPrice > 0
    ? ((outcomeReferencePrice - structuralBreakoutPrice) / structuralBreakoutPrice) * 100 : null

  const primaryEligible = tapeOk && startBar !== null
  const windowsOut = windows.map(w =>
    scanWindow(postStart, startBar, w, outcomeReferencePrice, structuralInvalidationPrice, R, primaryEligible, opts.tapeCompleteness))

  return {
    shadowCandidateId: candidate.shadowCandidateId,
    canonicalCandidateKey: candidate.canonicalCandidateKey,
    symbol,
    candidateObservedAt: candidate.candidateObservedAt,
    structuralBreakoutPrice, structuralInvalidationPrice, structuralRiskUnit: R,
    primaryOutcomeStartSec, outcomeReferencePrice, structuralExtensionAtObsPct,
    tapeCompleteness: opts.tapeCompleteness,
    primaryEligible,
    windows: windowsOut,
    barsAvailableAfterAnchor: postStart.length,
  }
}

function emptyWindow(windowMin: number, terminal: WindowTerminalState, barsInWindow: number): WindowOutcome {
  return {
    windowMin, scorable: false, terminalState: terminal,
    prospectiveMfePct: null, prospectiveMaePct: null, prospectiveMfeR: null, prospectiveMaeR: null,
    prospectiveTimeTo0_5RSec: null, prospectiveTimeTo1RSec: null, prospectiveTimeTo2RSec: null,
    invalidationHit: false, timeToInvalidationSec: null,
    ambiguousSameBar: false, ambiguousBarHigh: null, ambiguousBarLow: null,
    counterfactualPostTerminalMfePct: null, counterfactualPostTerminalMaxPct: null,
    barsInWindow,
  }
}

function scanWindow(
  postStart: Candle[], startBar: Candle | null, windowMin: number,
  reference: number | null, invalid: number, R: number,
  primaryEligible: boolean, completeness: TapeCompleteness,
): WindowOutcome {
  if (startBar === null || reference === null) return emptyWindow(windowMin, 'NO_OUTCOME_START_BAR', 0)
  if (!Number.isFinite(reference) || !(R > 0)) return emptyWindow(windowMin, 'DATA_GAP', 0)
  if (completeness === 'INCOMPLETE' || completeness === 'CONTINUED') return emptyWindow(windowMin, 'TAPE_INCOMPLETE', 0)

  const startSec = startBar.time
  const startMs = startSec * SECOND
  const windowEndMs = startMs + windowMin * MINUTE
  const bars = postStart.filter(b => b.time * SECOND <= windowEndMs)
  const lastAvailMs = postStart.length ? postStart[postStart.length - 1].time * SECOND : startMs

  const out = emptyWindow(windowMin, 'INSUFFICIENT_TAPE', bars.length)
  const thr = (k: number) => reference + k * R
  let mfeHigh = -Infinity, maeLow = Infinity
  let t05: number | null = null, t1: number | null = null, t2: number | null = null
  let terminalIdx = -1
  let terminalState: WindowTerminalState | null = null
  let ambiguous = false, ambHigh: number | null = null, ambLow: number | null = null
  let gapBefore = false
  let prevTime: number | null = startSec

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    if (prevTime !== null && b.time - prevTime > GAP_TOL_SEC) { gapBefore = true; terminalIdx = i - 1; terminalState = 'DATA_GAP'; break }
    prevTime = b.time
    const tSec = Math.round((b.time * SECOND - startMs) / SECOND)
    if (b.low <= invalid) {
      const newFav = (b.high >= thr(0.5) && t05 === null) || (b.high >= thr(1) && t1 === null) || (b.high >= thr(2) && t2 === null)
      if (newFav) { ambiguous = true; ambHigh = b.high; ambLow = b.low }
      maeLow = Math.min(maeLow, b.low)
      terminalIdx = i
      terminalState = ambiguous ? 'AMBIGUOUS_SAME_BAR' : 'INVALIDATION'
      break
    }
    if (t05 === null && b.high >= thr(0.5)) t05 = tSec
    if (t1 === null && b.high >= thr(1)) t1 = tSec
    if (t2 === null && b.high >= thr(2)) t2 = tSec
    mfeHigh = Math.max(mfeHigh, b.high)
    maeLow = Math.min(maeLow, b.low)
  }

  if (terminalState === null) {
    if (lastAvailMs < windowEndMs) { out.terminalState = 'INSUFFICIENT_TAPE'; out.scorable = false; fill(out, mfeHigh, maeLow, reference, R, t05, t1, t2, false, null, false, null, null, null, null); return out }
    terminalState = windowMin >= 30 ? '30M_HORIZON' : 'HORIZON'
  }

  const invalidationHit = terminalState === 'INVALIDATION' || terminalState === 'AMBIGUOUS_SAME_BAR'
  const terminalBar = terminalIdx >= 0 ? bars[terminalIdx] : null
  const timeToInvalidationSec = invalidationHit && terminalBar ? Math.round((terminalBar.time * SECOND - startMs) / SECOND) : null

  let cfMfePct: number | null = null, cfMaxPct: number | null = null
  if (invalidationHit && terminalIdx >= 0) {
    let cfHigh = -Infinity
    for (let j = terminalIdx + 1; j < bars.length; j++) cfHigh = Math.max(cfHigh, bars[j].high)
    if (cfHigh > -Infinity) { cfMfePct = ((cfHigh - reference) / reference) * 100; cfMaxPct = cfHigh }
  }

  out.terminalState = terminalState
  out.scorable = primaryEligible && terminalState !== 'DATA_GAP' && !gapBefore
  fill(out, mfeHigh, maeLow, reference, R, t05, t1, t2, invalidationHit, timeToInvalidationSec, ambiguous, ambHigh, ambLow, cfMfePct, cfMaxPct)
  return out
}

function fill(
  o: WindowOutcome, mfeHigh: number, maeLow: number, reference: number, R: number,
  t05: number | null, t1: number | null, t2: number | null,
  invalidationHit: boolean, timeToInvalidationSec: number | null,
  ambiguous: boolean, ambHigh: number | null, ambLow: number | null,
  cfMfePct: number | null, cfMaxPct: number | null,
): void {
  const mfeValid = mfeHigh > -Infinity, maeValid = maeLow < Infinity
  o.prospectiveMfePct = mfeValid ? ((mfeHigh - reference) / reference) * 100 : null
  o.prospectiveMaePct = maeValid ? ((maeLow - reference) / reference) * 100 : null
  o.prospectiveMfeR = mfeValid ? (mfeHigh - reference) / R : null
  o.prospectiveMaeR = maeValid ? (maeLow - reference) / R : null
  o.prospectiveTimeTo0_5RSec = t05
  o.prospectiveTimeTo1RSec = t1
  o.prospectiveTimeTo2RSec = t2
  o.invalidationHit = invalidationHit
  o.timeToInvalidationSec = timeToInvalidationSec
  o.ambiguousSameBar = ambiguous
  o.ambiguousBarHigh = ambHigh
  o.ambiguousBarLow = ambLow
  o.counterfactualPostTerminalMfePct = cfMfePct
  o.counterfactualPostTerminalMaxPct = cfMaxPct
}
