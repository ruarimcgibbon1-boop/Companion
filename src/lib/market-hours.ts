/**
 * Market session detection — America/New_York authoritative, Europe/London display.
 * All timestamps in milliseconds unless stated.
 */

export type SessionType =
  | 'premarket'        // 04:00–09:30 ET today
  | 'regular'          // 09:30–16:00 ET today
  | 'afterhours'       // 16:00–20:00 ET today
  | 'overnight'        // 20:00–04:00 ET (between sessions)
  | 'closed'           // weekend or holiday

export interface SessionConfig {
  premarketStartHHMM: number   // e.g. 400
  premarketEndHHMM: number     // e.g. 930
  regularStartHHMM: number     // e.g. 930
  regularEndHHMM: number       // e.g. 1600
  afterHoursEndHHMM: number    // e.g. 2000
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  premarketStartHHMM: 400,
  premarketEndHHMM: 930,
  regularStartHHMM: 930,
  regularEndHHMM: 1600,
  afterHoursEndHHMM: 2000,
}

// ── Helpers ────────────────────────────────────────────────────────────────
//
// PERFORMANCE: `etHHMM` and `isWeekendET` map a UTC instant to an ET wall-clock
// field. Both are pure functions of `ts`. Constructing an Intl.DateTimeFormat and
// calling `.format()` is expensive (~microseconds each), and the replay classifies
// the SAME candle timestamps on every bar it re-scans — so this ran millions of
// times and dominated replay runtime. We (1) reuse ONE formatter each instead of
// constructing per call, and (2) memoise the result per `ts`. This is a pure
// caching change: identical inputs give identical outputs, so no session boundary,
// no detector, and no gate verdict moves — only the cost does. The cache is bounded
// and cleared wholesale when full, so a long-lived live session can't leak.

const ET_HHMM_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
})
const ET_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long',
})

const MAX_TS_CACHE = 200_000
const hhmmCache = new Map<number, number>()
const weekendCache = new Map<number, boolean>()

function etHHMM(ts: number): number {
  const hit = hhmmCache.get(ts)
  if (hit !== undefined) return hit
  const et = ET_HHMM_FMT.format(ts)
  const [h, m] = et.split(':').map(Number)
  const v = h * 100 + m
  if (hhmmCache.size >= MAX_TS_CACHE) hhmmCache.clear()
  hhmmCache.set(ts, v)
  return v
}

function isWeekendET(ts: number): boolean {
  const hit = weekendCache.get(ts)
  if (hit !== undefined) return hit
  const dayName = ET_WEEKDAY_FMT.format(ts)
  const v = dayName === 'Saturday' || dayName === 'Sunday'
  if (weekendCache.size >= MAX_TS_CACHE) weekendCache.clear()
  weekendCache.set(ts, v)
  return v
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getSessionType(
  ts: number = Date.now(),
  config: SessionConfig = DEFAULT_SESSION_CONFIG
): SessionType {
  if (isWeekendET(ts)) return 'closed'
  const hhmm = etHHMM(ts)
  const { premarketStartHHMM, premarketEndHHMM, regularEndHHMM, afterHoursEndHHMM } = config
  if (hhmm >= premarketStartHHMM && hhmm < premarketEndHHMM) return 'premarket'
  if (hhmm >= premarketEndHHMM && hhmm < regularEndHHMM) return 'regular'
  if (hhmm >= regularEndHHMM && hhmm < afterHoursEndHHMM) return 'afterhours'
  return 'overnight'
}

export function isPremarket(ts: number, config = DEFAULT_SESSION_CONFIG): boolean {
  return getSessionType(ts, config) === 'premarket'
}

/** Minutes since ET midnight. The building block for any "how far into the day" maths —
 *  doing that arithmetic on the host clock silently measures the LOCAL trading day. */
export function etMinutesOfDay(ts: number = Date.now()): number {
  const h = etHHMM(ts)
  return Math.floor(h / 100) * 60 + (h % 100)
}

/** Minutes elapsed since the 09:30 ET open, or null outside regular hours. */
export function minutesSinceOpen(ts: number = Date.now(), config = DEFAULT_SESSION_CONFIG): number | null {
  if (getSessionType(ts, config) !== 'regular') return null
  const hhmm = etHHMM(ts)
  const cur = Math.floor(hhmm / 100) * 60 + (hhmm % 100)
  const open = Math.floor(config.regularStartHHMM / 100) * 60 + (config.regularStartHHMM % 100)
  return cur - open
}

export function isRegularHours(ts: number, config = DEFAULT_SESSION_CONFIG): boolean {
  return getSessionType(ts, config) === 'regular'
}

export function isAfterHours(ts: number, config = DEFAULT_SESSION_CONFIG): boolean {
  return getSessionType(ts, config) === 'afterhours'
}

export function isExtendedHours(ts: number, config = DEFAULT_SESSION_CONFIG): boolean {
  const s = getSessionType(ts, config)
  return s === 'premarket' || s === 'afterhours'
}

export function isMarketOpen(ts: number = Date.now()): boolean {
  return isRegularHours(ts)
}

/** Whether this candle belongs to TODAY's premarket window specifically */
export function isTodayPremarket(ts: number, config = DEFAULT_SESSION_CONFIG): boolean {
  if (isWeekendET(ts)) return false
  const hhmm = etHHMM(ts)
  return hhmm >= config.premarketStartHHMM && hhmm < config.premarketEndHHMM && isToday(ts)
}

/** Whether this candle belongs to TODAY's after-hours window */
export function isTodayAfterHours(ts: number, config = DEFAULT_SESSION_CONFIG): boolean {
  if (isWeekendET(ts)) return false
  const hhmm = etHHMM(ts)
  return hhmm >= config.regularEndHHMM && hhmm < config.afterHoursEndHHMM && isToday(ts)
}

/** Previous session = yesterday's after-hours (20:00–04:00 boundary) */
export function isPreviousAfterHours(ts: number, config = DEFAULT_SESSION_CONFIG): boolean {
  if (isWeekendET(ts)) return false
  const hhmm = etHHMM(ts)
  return hhmm >= config.regularEndHHMM && hhmm < config.afterHoursEndHHMM && isYesterday(ts)
}

function isToday(ts: number): boolean {
  const now = new Date()
  const d = new Date(ts)
  const fmt = (x: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(x)
  return fmt(now) === fmt(d)
}

function isYesterday(ts: number): boolean {
  const yesterday = new Date(Date.now() - 86_400_000)
  const d = new Date(ts)
  const fmt = (x: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(x)
  return fmt(yesterday) === fmt(d)
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function formatET(ts: number, showSeconds = true): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    ...(showSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(new Date(ts))
}

export function formatLondon(ts: number, showSeconds = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    ...(showSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(new Date(ts))
}

/** Convenience alias used by TopBar */
export function formatEasternTime(ts: number): string {
  return formatET(ts, true)
}

export function dataAge(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  return `${Math.floor(min / 60)}h ago`
}

export function isStale(ts: number, thresholdMs = 120_000): boolean {
  return Date.now() - ts > thresholdMs
}

export function sessionLabel(s: SessionType): string {
  switch (s) {
    case 'premarket': return 'Premarket'
    case 'regular': return 'Regular Session'
    case 'afterhours': return 'After-Hours'
    case 'overnight': return 'Overnight'
    case 'closed': return 'Market Closed'
  }
}

export function sessionColor(s: SessionType): string {
  switch (s) {
    case 'premarket': return 'text-yellow-400'
    case 'regular': return 'text-green-400'
    case 'afterhours': return 'text-blue-400'
    case 'overnight': return 'text-gray-500'
    case 'closed': return 'text-gray-600'
  }
}

// ── FMP / Yahoo timestamp parsing ───────────────────────────────────────────

/**
 * Parse an ET wall-clock timestamp string into a real instant.
 *
 * CRITICAL BUG THIS FIXES (2026-08-12). FMP returns intraday timestamps as naive
 * ET strings — "2026-08-12 09:35:00" — with no timezone. Every call site did
 * `new Date(str)`, which parses them in the HOST's local timezone. On a machine
 * set to America/New_York that happens to be right, so it looked fine; on this
 * one (Europe/Madrid, UTC+2) every candle landed SIX HOURS early:
 *
 *   FMP bar 04:00 ET  ->  app read 22:00  ->  session "overnight"
 *   FMP bar 09:35 ET  ->  app read 03:35  ->  session "overnight"   (5 min after the open!)
 *   FMP bar 12:00 ET  ->  app read 06:00  ->  session "premarket"
 *
 * So VWAP resets, session highs/lows, the opening-range window, opening_drive's
 * 09:30-09:45 gate and the EOD resolver's day matching were all being computed
 * against the wrong bars. `scripts/backtest.ts` parsed ET correctly all along,
 * which is exactly why the replay showed an edge the live app never realised —
 * they were not running on the same timeline.
 *
 * DST-correct: derives the real ET offset for the instant in question rather than
 * hardcoding -04:00, so it doesn't silently break every November.
 *
 * Returns NaN for unparseable input — callers must drop those rows, never coerce.
 */
export function parseEtTimestamp(value: string): number {
  if (!value) return NaN
  // Already carries a zone (ISO with Z or +/-hh:mm)? Trust it.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value.trim())) return Date.parse(value)

  const normalized = value.trim().length <= 10
    ? `${value.trim()}T00:00:00`
    : value.trim().replace(' ', 'T')
  // Read the wall time as if it were UTC, then shift by ET's offset at that instant.
  const asIfUtc = Date.parse(`${normalized}Z`)
  if (!Number.isFinite(asIfUtc)) return NaN
  // Two passes so a timestamp within an hour of a DST boundary still resolves.
  let instant = asIfUtc - etOffsetMs(asIfUtc)
  instant = asIfUtc - etOffsetMs(instant)
  return instant
}

/** ET's offset from UTC at a given instant, in ms (negative — ET is behind UTC). */
function etOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  // hour can format as 24 at midnight in some ICU versions; normalise it.
  const wallAsUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'),
  )
  return wallAsUtc - utcMs
}

/** Seconds convenience wrapper — the Candle shape stores unix SECONDS. */
export function parseEtTimestampSec(value: string): number {
  const ms = parseEtTimestamp(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN
}
