/**
 * Momentum ranking for the scanner universe.
 *
 * THE BUG THIS FIXES (2026-08-12). The universe was ranked by change-from-previous
 * close, and that number PEAKS AFTER THE MOVE IS OVER. A stock reaches the top of
 * the gainers list precisely because it already ran, so the list handed us names at
 * their most extended, most faded moment — and every quality gate we own then
 * correctly refused them.
 *
 * Measured live at 08:25 ET that day, on the twelve biggest gainers on the board:
 *   OFAL  +153% on the day, -30.4% off its session high
 *   PLAG  +126%             -24.7%
 *   RMCF  +105%             -35.4%
 *   BAOS   +51%             -58.4%
 * NINE OF TWELVE were already >5% below their session high. 46 long setups were
 * detected across them and ZERO triggered: 22 blocked by the quarantine, 16 by the
 * anti-fade gate for sitting 22-35% under the high. The gates were right. The
 * ranking was feeding them names that were already over.
 *
 * So: rank on how a name is moving NOW, and never rank a name above one our own
 * gates can actually trade. Day change becomes a filter, not the sort key.
 *
 * Pure and clock-free apart from the caller-supplied `now` — the route does the I/O.
 */
import type { Candle } from '@/types'

/** Window for "moving now", in minutes. Three 5-min bars. */
export const MOMENTUM_WINDOW_MIN = 15

/**
 * Mirrors MAX_BELOW_HIGH_PCT in setup-detectors.ts. Kept in sync deliberately:
 * the whole point is that discovery must not rank a name above the fade line that
 * the detectors will refuse it for. If that constant moves, move this one.
 */
export const RANK_MAX_BELOW_HIGH_PCT = 5

export interface MomentumRead {
  /** % price change over the trailing window. Null when the tape is too short. */
  rocPct: number | null
  /** Distance below the session high, negative. Null when unknown. */
  offHighPct: number | null
  /** Would the anti-fade gate let a chase-family setup fire here? */
  nearHigh: boolean
  /**
   * Sort key, descending. Names the gates can trade always outrank names they
   * can't, and within each group the fastest-moving comes first. A name we cannot
   * measure is treated as tradeable (fail open — never bury a row for missing
   * data; that is the silent-`[]` trap that killed premarket signals on 07-20).
   */
  score: number
}

/** Base offset so any near-high name outranks any faded one, whatever the RoC. */
const NEAR_HIGH_TIER = 1_000_000

export function readMomentum(
  candles: Candle[],
  price: number,
  now: number = Date.now(),
  windowMin: number = MOMENTUM_WINDOW_MIN,
): MomentumRead {
  const unknown: MomentumRead = { rocPct: null, offHighPct: null, nearHigh: true, score: NEAR_HIGH_TIER }
  if (!(price > 0) || candles.length === 0) return unknown

  const sorted = candles.slice().sort((a, b) => a.time - b.time)
  const cutoffSec = Math.floor(now / 1000) - windowMin * 60
  const window = sorted.filter(c => c.time >= cutoffSec)

  // Reference = the close just before the window opened, else the window's own
  // first open. Without a prior bar a fresh gap would read as zero momentum.
  const priorIndex = sorted.findIndex(c => c.time >= cutoffSec) - 1
  const reference = priorIndex >= 0 ? sorted[priorIndex].close : window[0]?.open ?? null
  const rocPct = reference != null && reference > 0 ? ((price - reference) / reference) * 100 : null

  const sessionHigh = sorted.reduce((h, c) => Math.max(h, c.high), 0)
  const offHighPct = sessionHigh > 0 ? ((price - sessionHigh) / sessionHigh) * 100 : null

  // Unknown fade status fails OPEN, same as everywhere else in this codebase.
  const nearHigh = offHighPct == null || offHighPct >= -RANK_MAX_BELOW_HIGH_PCT
  const score = (nearHigh ? NEAR_HIGH_TIER : 0) + (rocPct ?? 0)

  return { rocPct, offHighPct, nearHigh, score }
}

/**
 * Compare two rows by momentum score, falling back to day change when neither has
 * a usable reading — so the ranking degrades to the old behaviour rather than to
 * an arbitrary order if the candle feed is down.
 */
export function compareByMomentum(
  a: { momentumScore?: number | null; changePct: number },
  b: { momentumScore?: number | null; changePct: number },
): number {
  const as = a.momentumScore, bs = b.momentumScore
  if (as != null && bs != null && as !== bs) return bs - as
  if (as != null && bs == null) return -1
  if (as == null && bs != null) return 1
  return b.changePct - a.changePct
}
