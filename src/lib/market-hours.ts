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

function etHHMM(ts: number): number {
  const d = new Date(ts)
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  const [h, m] = et.split(':').map(Number)
  return h * 100 + m
}

function isWeekendET(ts: number): boolean {
  const d = new Date(ts)
  const dayName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
  }).format(d)
  return dayName === 'Saturday' || dayName === 'Sunday'
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
