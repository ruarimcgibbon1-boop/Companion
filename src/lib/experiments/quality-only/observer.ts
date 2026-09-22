/**
 * QUALITY_ONLY_CONTINUATION observer — the smallest explicit hook this module
 * proposes for the REAL, currently-live read-only observation seam.
 *
 * ── THE REAL LIVE CALL PATH (traced, not assumed) ───────────────────────────
 * There is no live in-process call from the daemon into shadow-journal.ts or
 * mike/shadow.ts today — both are consumed OFFLINE:
 *   - shadow-journal.ts's buildShadowCandidates()/resolveShadowOutcome() are a
 *     pure projector over the JSONL decision-log file the daemon writes; nothing
 *     in the daemon process calls into shadow-journal.ts directly.
 *   - mike/shadow.ts (resolveMikeShadow) IS called in-process, but from a
 *     SEPARATE standalone scanner script, scripts/mike-scan.ts (not
 *     scripts/alert-daemon.ts) — verified via
 *     `git show research/top-mover-audit-robustness:scripts/mike-scan.ts`
 *     (this worktree's checked-out base, eead9b2, predates the Mike commits by
 *     8 commits on that branch and does not have scripts/mike-scan.ts or
 *     src/lib/mike/* on disk at all — see the PDF's "worktree base" note).
 *     mike-scan.ts's sweep() loop (line ~100-136) calls buildMonitorBatch(),
 *     evaluateMike(), then resolveMikeShadow() per symbol, and the WHOLE
 *     sweep() call is already wrapped in `try { await sweep() } catch (e) {
 *     log('sweep error:', ...) }` in main() (line ~150) — i.e. Mike's own
 *     sweep is already exception-isolated at the loop level, the same posture
 *     this observer's own wrapper reproduces for QUALITY_ONLY.
 *
 * The REAL, currently-live seam that is architecturally equivalent for THIS
 * experiment (a per-triggered-setup, verdict-aware observation point) is in
 * scripts/alert-daemon.ts's sweep() loop, immediately after `classifyBuy()`
 * computes `verdict` for each triggered setup and before/alongside the existing
 * `recordDecision(...)` audit-trail call — cited from the live branch tip
 * (research/top-mover-audit-robustness) via `git show`:
 *
 *   scripts/alert-daemon.ts (live tip, ~line 236):
 *     const { verdict, buy } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })
 *     const attrs = signalAttrs(setup, r)
 *     recordDecision({ ts: ..., etTime: ..., ...attrs, verdict, price: r.price }, now)
 *
 * `scripts/alert-daemon.ts` is one of the four files this task's absolute
 * constraints name as READ-ONLY/frozen for QUALITY_ONLY_CONTINUATION ("treat
 * every file under ... scripts/alert-daemon.ts as READ-ONLY / frozen for this
 * task" / "Purely additive: new files only. Never edit existing src/ files").
 * That constraint was never lifted by the coordinator's correction, which asks
 * to "integrate at that same seam" but does not explicitly authorize editing a
 * file the same task named frozen. Resolving that conflict conservatively: this
 * module does NOT edit scripts/alert-daemon.ts. Instead it exposes the exact
 * function that WOULD be called from that seam —
 * `observeQualityOnlyFromDecision(setup, r, verdict, ctx)` — with the identical
 * call shape (same `setup`/`r`/`verdict` already in scope at that line), proven
 * end-to-end by tests/quality-only.test.ts's integration test that constructs
 * the same real types and drives them through classifyBuy -> this observer,
 * exactly as the daemon loop would. LIVE INTEGRATION PROVEN means "the exact
 * call and its behavior are proven correct against real types at the real
 * seam's shape," not "the frozen file was edited" — see the PDF's Section 6 for
 * the full honesty statement and a proposed (unapplied) one-line diff.
 *
 * EXCEPTION ISOLATION: this function NEVER throws. Any internal failure
 * (malformed setup, missing candles, journal write error) is caught and
 * swallowed to a null return + best-effort console warning, exactly the
 * posture mike-scan.ts's own `try { await sweep() } catch` already uses for
 * Mike — so calling this from the daemon loop could never interrupt BASE's
 * alerting or Mike's independent sweep, even if this observer has a bug.
 */
import type { DetectedSetup, MonitorResult, BuySignalRecord, SetupLog, SetupStateRecord, Candle } from '@/types'
import { evaluateEligibility, type QualityOnlyCandidate, type EligibilityResult } from './candidate'
import { scoreQualityOnlyOutcome, type QualityOnlyOutcome } from './outcome'
import { FreshnessTracker } from './candidate'

export interface ObserverContext {
  now: number
  minLevelStrength: number
  priorBuys: BuySignalRecord[]
  priorLogs: SetupLog[]
  priorStates: SetupStateRecord[]
  everLoggedForSetupId: (setupId: string) => boolean
  dayStartMs: number
  candles: Candle[]         // bars up to signal time, for gate reconstruction (no lookahead)
  outcomeCandles?: Candle[] // bars at/after signal time, for outcome resolution only (may look forward)
  freshness: FreshnessTracker
}

export interface ObservationResult {
  candidate: QualityOnlyCandidate | null
  outcome: QualityOnlyOutcome | null
  eligibility: EligibilityResult
}

/**
 * The proposed hook. Call shape mirrors the real daemon seam exactly: the same
 * `setup`/`r` already computed by BASE, plus the `verdict` classifyBuy already
 * returned (this observer does not recompute it, does not call classifyBuy a
 * second time, and does not change what BASE does with `verdict`).
 *
 * Returns null (never throws) on any internal error, so a bug here can never
 * propagate into the caller's loop.
 */
export function observeQualityOnlyFromDecision(
  setup: DetectedSetup,
  r: MonitorResult,
  verdict: string,
  ctx: ObserverContext,
): ObservationResult | null {
  try {
    if (verdict !== 'veto') {
      // Not a veto row at all — nothing for this observer to do. (Still a
      // "successful no-op," not an error.)
      return { candidate: null, outcome: null, eligibility: { eligible: false, reason: 'not_veto_verdict', candidate: null } }
    }

    const eligibility = evaluateEligibility(setup, {
      now: ctx.now,
      minLevelStrength: ctx.minLevelStrength,
      r,
      priorBuys: ctx.priorBuys,
      priorLogs: ctx.priorLogs,
      priorStates: ctx.priorStates,
      everLoggedForSetupId: ctx.everLoggedForSetupId,
      dayStartMs: ctx.dayStartMs,
      candles: ctx.candles,
    })

    if (!eligibility.eligible || !eligibility.candidate) {
      return { candidate: null, outcome: null, eligibility }
    }

    // Freshness (condition 8) — earliest valid observation wins.
    const fresh = ctx.freshness.admitIfFresh(setup.symbol, setup.id, ctx.now)
    if (!fresh) {
      return {
        candidate: null, outcome: null,
        eligibility: { eligible: false, reason: 'not_fresh', candidate: null },
      }
    }

    const candidate = eligibility.candidate

    // Outcome resolution consumes ONLY already-available bars passed by the
    // caller — no new provider request. If the caller has none yet (e.g. this
    // sweep IS the signal bar), outcome is deferred (null) rather than guessed.
    let outcome: QualityOnlyOutcome | null = null
    if (ctx.outcomeCandles && ctx.outcomeCandles.length > 0) {
      outcome = scoreQualityOnlyOutcome(ctx.outcomeCandles, candidate.entryRef, candidate.invalidation, candidate.candidateObservedAt)
    }

    return { candidate, outcome, eligibility }
  } catch (e) {
    // Never let an observer failure propagate into the caller's sweep loop —
    // same posture as mike-scan.ts's `try { await sweep() } catch` isolation.
    try { console.warn('[quality-only observer] swallowed error:', (e as Error)?.message ?? e) } catch { /* even logging must never throw upward */ }
    return null
  }
}
