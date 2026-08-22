/**
 * Premarket relative volume.
 *
 * Before 09:30 the standard RVOL reading is meaningless: it paces the day's
 * volume against the 09:30–16:00 session, and there is no session yet. Worse,
 * the primary candle feed (Yahoo) returns premarket bars with price but
 * `volume: 0` for EVERY symbol — verified 2026-08-03 across AAPL/TSLA/NVDA and
 * the day's gappers — so nothing downstream could measure premarket
 * participation at all. That is why premarket signals fired on names that never
 * moved: the only volume evidence available was bar-over-bar expansion on a
 * feed reporting zeros.
 *
 * FMP's `historical-chart` with `extended=true` DOES carry premarket volume, so
 * this module builds the honest metric from it:
 *
 *     premarket RVOL = today's premarket volume so far
 *                      ÷ the typical premarket volume by this time of day
 *
 * Both sides come from the same feed over the same time-of-day window, so the
 * ratio is scale-consistent (FMP's intraday tape covers a subset of venues; a
 * ratio cancels that out, an absolute threshold would not) and it is not
 * distorted by the hour — comparing 05:00 to a full prior premarket session
 * would understate participation ~10×.
 *
 * Live read, 2026-08-03 premarket through 09:30: UPC (+102% on the day) 625k
 * shares vs a ~700-share baseline; AAPL 210k vs a 175k baseline (0.9×). The
 * gapper separates from the drifters by three orders of magnitude.
 */

/** One `historical-chart` row. `date` is ET wall-clock: "YYYY-MM-DD HH:MM:SS". */
export interface IntradayVolumeRow {
  date: string
  volume: number
}

export interface PremarketVolumeProfile {
  /** Today's cumulative premarket volume through `throughHHMM`. */
  todayVolume: number
  /** Typical premarket volume by this time of day (median of prior sessions), or null with no history. */
  baselineVolume: number | null
  /** How many prior sessions the baseline is built from. */
  sessions: number
  /** todayVolume ÷ baseline. Null when the reading is untrustworthy — either no
   *  prior-session history, or `measured` is false. */
  relativeVolume: number | null
  /** Whether the feed actually captured this name's premarket tape. When false,
   *  everything downstream must treat the volume as UNKNOWN, not as "low/dead" —
   *  see the coverage-floor note below. */
  measured: boolean
}

const PREMARKET_START_HHMM = 400
const PREMARKET_END_HHMM = 930
/** A name that normally trades a handful of shares premarket has no usable baseline.
 *  Flooring it keeps "today is unusual" true without the ratio exploding to noise. */
const BASELINE_FLOOR_SHARES = 1_000
/** Ratios beyond this are precision theatre (and blow up every display). */
const MAX_REPORTED_RVOL = 999
/**
 * Below this many premarket shares, the feed has NOT captured the name's tape —
 * so the reading is "unknown", not "low". FMP's intraday coverage is a subset of
 * venues and for some tickers it's essentially empty premarket: 2026-08-03 it
 * reported 55 shares for HYFM and 295 for EZRA — both of which gapped 200–500%
 * and traded heavily (a name cannot move from $0.54 to $3.44 on 55 shares). A
 * hard volume gate on those numbers blocks exactly the top-gainer rockets we most
 * want. So under this floor we return relativeVolume null + measured false, and
 * callers fall back to PRICE structure (the reliable signal) instead of vetoing.
 */
const COVERAGE_FLOOR_SHARES = 10_000

function hhmm(date: string): number | null {
  // "2026-08-03 07:35:00" → 735. Anything else (ISO with offset) → parse the same slice.
  const time = date.length >= 16 ? date.slice(11, 16) : ''
  const h = Number(time.slice(0, 2))
  const m = Number(time.slice(3, 5))
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 100 + m
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Cumulative premarket volume per session, counting only bars up to
 * `throughHHMM` so today is compared against prior days at the same point in
 * their premarket — not against their completed sessions.
 */
export function premarketVolumeByDay(
  rows: IntradayVolumeRow[],
  throughHHMM: number
): Map<string, number> {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const t = hhmm(r.date)
    if (t == null || t < PREMARKET_START_HHMM || t >= PREMARKET_END_HHMM) continue
    if (t > throughHHMM) continue
    const day = r.date.slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + (Number.isFinite(r.volume) ? r.volume : 0))
  }
  return byDay
}

export function premarketVolumeProfile(
  rows: IntradayVolumeRow[],
  opts: { todayEt: string; throughHHMM: number }
): PremarketVolumeProfile {
  const byDay = premarketVolumeByDay(rows, opts.throughHHMM)
  const todayVolume = byDay.get(opts.todayEt) ?? 0

  const prior: number[] = []
  for (const [day, vol] of byDay) if (day !== opts.todayEt) prior.push(vol)

  // The feed didn't capture the tape → the number is unknown, not low. Fall back
  // to price structure downstream rather than vetoing a rocket on missing data.
  const measured = todayVolume >= COVERAGE_FLOOR_SHARES

  const baselineVolume = median(prior)
  if (!measured || baselineVolume == null) {
    return { todayVolume, baselineVolume, sessions: prior.length, relativeVolume: null, measured }
  }
  const effective = Math.max(baselineVolume, BASELINE_FLOOR_SHARES)
  const relativeVolume = Math.min(todayVolume / effective, MAX_REPORTED_RVOL)
  return { todayVolume, baselineVolume, sessions: prior.length, relativeVolume, measured }
}

/** Current ET wall-clock as HHMM (the same shape the FMP rows carry). */
export function etHHMMNow(ts: number = Date.now()): number {
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts))
  const [h, m] = et.split(':').map(Number)
  return h * 100 + m
}

/** Current ET date as "YYYY-MM-DD" (matches the FMP row date prefix). */
export function etDateNow(ts: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts))
}
