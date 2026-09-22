/**
 * QUALITY_ONLY outcome scoring.
 *
 * DATA-PLANE / REUSE NOTE: this branch has no `src/lib/leader/leader-continuation-
 * outcome.ts` (H4B concept, doesn't exist here — verified by directory search;
 * `src/lib/leader/` is absent). The only existing prospective bar-walking
 * scorer on this branch is `resolveShadowOutcome()` in
 * src/lib/research/shadow-journal.ts (the "live shadow convention").
 *
 * PROVENANCE, PRECISELY (A vs B) — per the coordinator's re-audit request:
 *
 *  (A) DIRECTLY REUSED SEMANTICS (named, not reimplemented, from
 *      resolveShadowOutcome in src/lib/research/shadow-journal.ts):
 *        - entry rule: enter on the first bar whose `high >= entryRef`
 *        - causal boundary: only bars with `time*1000 >= candidateObservedAtMs`
 *          are considered (no lookahead before the signal instant)
 *        - same-bar ambiguity: a bar that touches BOTH invalidation and a
 *          favorable threshold in the same bar resolves ADVERSE-FIRST — counts
 *          as the stop/invalidation outcome, never the favorable one
 *        - terminal invalidation: once invalidation fires, the walk stops;
 *          no bar after it can grant NEW favorable credit
 *      These are CONVENTIONS this module's control flow mirrors — the actual
 *      code below is new, not a function call into shadow-journal.ts, because
 *      resolveShadowOutcome() returns a single-horizon outcome shape and this
 *      experiment's preregistration requires multi-horizon fields
 *      resolveShadowOutcome does not compute at all.
 *
 *  (B) NEW ARITHMETIC WRITTEN FOR THIS MODULE (NOT a call into, or a port of,
 *      any existing function — written from scratch to satisfy the
 *      preregistration's required fields, faithfully following the (A)
 *      conventions above but implemented independently):
 *        - 5m/15m/30m rolling MFE_R / MAE_R windows (`withinHorizon`)
 *        - 0.5R / 1R / 2R reached flags + timeTo05R/1R/2R
 *        - oneRBeforeInvalidation / twoRBeforeInvalidation
 *        - sameBarAmbiguity flag (explicit boolean, not present in
 *          resolveShadowOutcome's return shape at all)
 *      This is disclosed explicitly rather than described as "not
 *      reimplemented" — it IS new code, even though it deliberately follows
 *      the same conventions faithfully and does not diverge from them.
 *
 * ZERO INCREMENTAL PROVIDER REQUESTS: this function takes `candles: Candle[]`
 * from the caller — it does not fetch anything. Callers are expected to pass
 * the same monitor/daemon-computed 1m bars already available to the live
 * scanner, exactly as shadow-journal.ts's resolveShadowOutcome does.
 */
import type { Candle } from '@/types'

export type TerminalReason = 'target' | 'stop' | 'open_at_end' | 'no_fill'

export interface QualityOnlyOutcome {
  entered: boolean
  entryBarTime: number | null
  mfeR5m: number | null
  mfeR15m: number | null
  mfeR30m: number | null
  maeR5m: number | null
  maeR15m: number | null
  maeR30m: number | null
  reached05R: boolean
  reached1R: boolean
  reached2R: boolean
  timeTo05R: number | null   // ms from entry
  timeTo1R: number | null
  timeTo2R: number | null
  invalidated: boolean
  timeToInvalidation: number | null
  oneRBeforeInvalidation: boolean
  twoRBeforeInvalidation: boolean
  terminalReason: TerminalReason
  sameBarAmbiguity: boolean  // a bar touched both a favorable R threshold and invalidation in the same bar
  resolvedFromBars: number
}

function withinHorizon(barTime: number, entryTime: number, minutes: number): boolean {
  return barTime <= entryTime + minutes * 60_000
}

/**
 * Walk forward from `entryRef`/`invalidation`/`candidateObservedAt`, in causal
 * order, using ONLY bars at/after candidateObservedAt (no lookahead into
 * features — outcomes legitimately look forward, per shadow-journal.ts's
 * documented FEATURES vs OUTCOMES boundary, which this reuses verbatim).
 */
export function scoreQualityOnlyOutcome(
  candles: Candle[],
  entryRef: number,
  invalidation: number,
  candidateObservedAtMs: number,
): QualityOnlyOutcome {
  const riskDist = entryRef - invalidation
  const post = candles
    .filter(c => c.time * 1000 >= candidateObservedAtMs)
    .sort((a, b) => a.time - b.time)

  const none: QualityOnlyOutcome = {
    entered: false, entryBarTime: null,
    mfeR5m: null, mfeR15m: null, mfeR30m: null, maeR5m: null, maeR15m: null, maeR30m: null,
    reached05R: false, reached1R: false, reached2R: false,
    timeTo05R: null, timeTo1R: null, timeTo2R: null,
    invalidated: false, timeToInvalidation: null,
    oneRBeforeInvalidation: false, twoRBeforeInvalidation: false,
    terminalReason: 'no_fill', sameBarAmbiguity: false, resolvedFromBars: post.length,
  }
  if (post.length === 0 || !(riskDist > 0)) return none

  let entered = false, entryTimeMs = 0
  let mfe5 = -Infinity, mfe15 = -Infinity, mfe30 = -Infinity
  let mae5 = Infinity, mae15 = Infinity, mae30 = Infinity
  let reached05 = false, reached1 = false, reached2 = false
  let t05: number | null = null, t1: number | null = null, t2: number | null = null
  let invalidated = false, tInval: number | null = null

  for (let i = 0; i < post.length; i++) {
    const bar = post[i]
    const barTimeMs = bar.time * 1000
    if (!entered) {
      if (bar.high >= entryRef) { entered = true; entryTimeMs = barTimeMs }
      else continue
    }
    const rHigh = (bar.high - entryRef) / riskDist
    const rLow = (bar.low - entryRef) / riskDist

    if (withinHorizon(barTimeMs, entryTimeMs, 5)) { mfe5 = Math.max(mfe5, rHigh); mae5 = Math.min(mae5, rLow) }
    if (withinHorizon(barTimeMs, entryTimeMs, 15)) { mfe15 = Math.max(mfe15, rHigh); mae15 = Math.min(mae15, rLow) }
    if (withinHorizon(barTimeMs, entryTimeMs, 30)) { mfe30 = Math.max(mfe30, rHigh); mae30 = Math.min(mae30, rLow) }

    const hitInvalidationThisBar = bar.low <= invalidation
    const hit05ThisBar = !reached05 && rHigh >= 0.5
    const hit1ThisBar = !reached1 && rHigh >= 1
    const hit2ThisBar = !reached2 && rHigh >= 2

    if (!invalidated) {
      if (hit05ThisBar) { reached05 = true; t05 = barTimeMs - entryTimeMs }
      if (hit1ThisBar) { reached1 = true; t1 = barTimeMs - entryTimeMs }
      if (hit2ThisBar) { reached2 = true; t2 = barTimeMs - entryTimeMs }
    }

    if (hitInvalidationThisBar && !invalidated) {
      invalidated = true
      tInval = barTimeMs - entryTimeMs
      // Same-bar ambiguity: this bar also reached a favorable R threshold. No
      // favorable credit past terminal invalidation (non-negotiable), so we
      // stop granting NEW favorable thresholds after this point, and flag it.
      const sameBar = hit05ThisBar || hit1ThisBar || hit2ThisBar
      return {
        entered: true, entryBarTime: entryTimeMs,
        mfeR5m: round(mfe5), mfeR15m: round(mfe15), mfeR30m: round(mfe30),
        maeR5m: round(mae5), maeR15m: round(mae15), maeR30m: round(mae30),
        reached05R: reached05, reached1R: reached1, reached2R: reached2,
        timeTo05R: t05, timeTo1R: t1, timeTo2R: t2,
        invalidated: true, timeToInvalidation: tInval,
        oneRBeforeInvalidation: reached1 && (t1 == null || t1 <= (tInval ?? Infinity)),
        twoRBeforeInvalidation: reached2 && (t2 == null || t2 <= (tInval ?? Infinity)),
        terminalReason: 'stop', sameBarAmbiguity: sameBar, resolvedFromBars: post.length,
      }
    }
  }

  if (!entered) return none

  return {
    entered: true, entryBarTime: entryTimeMs,
    mfeR5m: round(mfe5), mfeR15m: round(mfe15), mfeR30m: round(mfe30),
    maeR5m: round(mae5), maeR15m: round(mae15), maeR30m: round(mae30),
    reached05R: reached05, reached1R: reached1, reached2R: reached2,
    timeTo05R: t05, timeTo1R: t1, timeTo2R: t2,
    invalidated: false, timeToInvalidation: null,
    oneRBeforeInvalidation: reached1, twoRBeforeInvalidation: reached2,
    terminalReason: reached1 || reached2 || reached05 ? 'target' : 'open_at_end',
    sameBarAmbiguity: false, resolvedFromBars: post.length,
  }
}

function round(v: number): number | null {
  if (!Number.isFinite(v)) return null
  return Math.round(v * 1000) / 1000
}
