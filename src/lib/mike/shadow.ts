/**
 * MIKE'S STRATEGY — shadow outcome resolver (evidence collection only).
 *
 * After Mike TRADES or VETOES a candidate we keep tracking it on the tape to learn
 * whether it subsequently hit +10% / +15% / stop-equivalent downside, its MFE/MAE,
 * and whether it produced a large runner. This resolves a HYPOTHETICAL outcome from
 * post-signal bars — it NEVER creates an order. Outcomes may look forward; the
 * decision that produced the candidate never did.
 *
 * Mirrors the discipline of src/lib/research/shadow-journal.ts but uses Mike's own
 * +10/+15 ladder and stays entirely inside the mike module.
 */
import type { Candle } from '@/types'
import type { MikeCandidate, MikeShadowOutcome } from './types'

/**
 * Resolve from `reference` forward over bars at/after `sinceMs`.
 * `stop` is the stop-equivalent downside (may be null → downside not scored).
 * Conservative on same-bar ambiguity: a bar that touches both stop and a target is
 * scored as the STOP.
 */
export function resolveMikeShadow(
  reference: number,
  stop: number | null,
  candles: Candle[],
  sinceMs: number,
): MikeShadowOutcome {
  const none: MikeShadowOutcome = {
    reference, stop, hit10: false, hit15: false, hitStop: false,
    mfePct: null, maePct: null, maxRunPct: null, reachedRunner: false,
    runnerExcursionAfter15Pct: null, timeTo10Bars: null, timeTo15Bars: null, timeToAdverseBars: null,
    barsToResolve: null, resolvedFromBars: 0, resolved: false,
  }
  if (!(reference > 0)) return none
  const post = candles.filter(c => c.time * 1000 >= sinceMs).sort((a, b) => a.time - b.time)
  if (post.length === 0) return none

  const t10 = reference * 1.10
  const t15 = reference * 1.15
  let mfe = -Infinity, mae = Infinity
  let first10: number | null = null, first15: number | null = null, firstStop: number | null = null

  // Full scan (no early break) so we capture time-to-each and the post-+15 runner.
  for (let i = 0; i < post.length; i++) {
    const bar = post[i]
    mfe = Math.max(mfe, ((bar.high - reference) / reference) * 100)
    mae = Math.min(mae, ((bar.low - reference) / reference) * 100)
    if (firstStop == null && stop != null && bar.low <= stop) firstStop = i
    if (first10 == null && bar.high >= t10) first10 = i
    if (first15 == null && bar.high >= t15) first15 = i
  }

  // Runner excursion: highest high AFTER the +15 bar (how far the last 25% could run).
  let runnerAfter15: number | null = null
  if (first15 != null) {
    let hi = -Infinity
    for (let i = first15 + 1; i < post.length; i++) hi = Math.max(hi, post[i].high)
    runnerAfter15 = hi === -Infinity ? 0 : round(((hi - reference) / reference) * 100)
  }

  const barsToResolve = [first15, firstStop].filter((x): x is number => x != null).sort((a, b) => a - b)[0] ?? null

  return {
    reference, stop,
    hit10: first10 != null, hit15: first15 != null, hitStop: firstStop != null,
    mfePct: round(mfe), maePct: round(mae), maxRunPct: round(mfe),
    reachedRunner: first15 != null,
    runnerExcursionAfter15Pct: runnerAfter15,
    timeTo10Bars: first10, timeTo15Bars: first15, timeToAdverseBars: firstStop,
    barsToResolve, resolvedFromBars: post.length, resolved: true,
  }
}

/** The price the ladder is measured from: intended entry when traded, else the frozen breakout level. */
export function mikeShadowReference(c: MikeCandidate): number | null {
  if (c.outcome === 'TRADED' && c.tradePlan) return c.tradePlan.entry
  return c.breakoutLevel?.price ?? null
}

/**
 * Stop-equivalent downside for shadow tracking: the trade plan's stop when Mike
 * traded, else a −maxStopPct band under the reference for a vetoed candidate (so
 * "hit stop-equivalent downside" is measurable). `maxStopPct` defaults to 0.10.
 */
export function mikeShadowStop(c: MikeCandidate, maxStopPct = 0.10): number | null {
  if (c.outcome === 'TRADED' && c.tradePlan) return c.tradePlan.stop.price
  const ref = c.breakoutLevel?.price ?? null
  return ref != null ? ref * (1 - maxStopPct) : null
}

const round = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
