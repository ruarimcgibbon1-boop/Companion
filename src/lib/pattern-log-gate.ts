/**
 * Pattern-log admission gate — what is worth writing into the dataset.
 *
 * Extracted from useMonitor for the same reason buy-log.ts was: the rules that
 * decide what gets recorded belong somewhere testable, not inline in a hook where
 * they can only be verified by exporting a CSV a day later and reading it.
 *
 * Every rule here comes from the 2026-08-12 export — 191 rows, of which only 115
 * were distinct and rather fewer were useful.
 */
import type { CandlePattern } from '@/types'
import { etMinutesOfDay } from './market-hours'

/** No pattern logged at/after 15:55 ET — nothing after that is tradeable today. */
export const PATTERN_LOG_CUTOFF_ET_MIN = 15 * 60 + 55

/**
 * Don't log a bullish reversal on a name already down this much. The same
 * falling-knife logic the buy log applies, which the pattern detector never had:
 * that export carried a three_white_soldiers on YXT at −60.3% and four ONFO
 * hammers between −23% and −27%.
 */
export const PATTERN_MAX_FADE_PCT = 5

/**
 * Dedup key. Rounds to 0.1% so ordinary tick noise doesn't defeat it.
 *
 * The old key was a 10-minute TIME bucket, which re-logged a persisting pattern
 * every bucket for as long as it lasted — and against a stale quote that is
 * unbounded. INLF's hammer logged 21 times at exactly 6.27 across three hours,
 * PAVS's morning_star 20 times at 4.91, CELZ 17 times at 0.6688. Keying on price
 * means a pattern that hasn't moved logs once.
 */
export function patternPriceKey(price: number): string {
  return price > 0 ? (Math.round(price * 1000) / 1000).toFixed(3) : '0'
}

export function patternLogId(symbol: string, pattern: CandlePattern, price: number): string {
  return `${symbol}:${pattern}:${patternPriceKey(price)}`
}

export type PatternRejection = 'duplicate' | 'after_cutoff' | 'faded'

export interface PatternLogContext {
  now: number
  /** Day change % at log time — negative means the name is down. */
  changePct: number
  /** Ids already in the log, so a repeat at the same price is dropped. */
  loggedIds: ReadonlySet<string>
}

/**
 * Should this pattern occurrence be written to the log? Returns the reason when
 * not, so a caller can count rejections rather than silently dropping them.
 */
export function shouldLogPattern(
  id: string,
  ctx: PatternLogContext,
): { log: true } | { log: false; reason: PatternRejection } {
  if (ctx.loggedIds.has(id)) return { log: false, reason: 'duplicate' }
  if (etMinutesOfDay(ctx.now) >= PATTERN_LOG_CUTOFF_ET_MIN) return { log: false, reason: 'after_cutoff' }
  if (ctx.changePct < -PATTERN_MAX_FADE_PCT) return { log: false, reason: 'faded' }
  return { log: true }
}
