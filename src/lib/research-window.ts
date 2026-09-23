/**
 * Research / held-out validation split (fidelity Priority 4).
 *
 * Development and optimisation happen on the RESEARCH window (July 2026). August
 * 2026 is a HELD-OUT validation window: it must stay untouched until a candidate
 * change has already been chosen on July, and every use of it must be recorded so
 * it can never quietly become training data.
 *
 * Pure + runtime-agnostic (no fs, no clock) so it is trivially testable and usable
 * from both the browser and the CLI. The ledger WRITE lives in the caller (the
 * backtest), which owns the filesystem.
 */

/** YYYY-MM prefix of the research (development) window. */
export const RESEARCH_MONTH = '2026-07'
/** YYYY-MM prefix of the held-out validation window. */
export const HELDOUT_MONTH = '2026-08'

/** The 20 NYSE trading days of the research window, in order. */
const RESEARCH_WINDOW_DAYS = [
  '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10',
  '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17',
  '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24',
  '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31',
]

export function researchWindowDays(): string[] {
  return [...RESEARCH_WINDOW_DAYS]
}

/** True for any date in the held-out validation month. */
export function isHeldOut(day: string): boolean {
  return day.slice(0, 7) === HELDOUT_MONTH
}

/** True for a date in the research (development) month. */
export function isResearch(day: string): boolean {
  return day.slice(0, 7) === RESEARCH_MONTH
}

/** Split a set of days into research vs held-out vs anything outside both. */
export function classifyDays(days: string[]): { research: string[]; heldout: string[]; other: string[] } {
  const research: string[] = [], heldout: string[] = [], other: string[] = []
  for (const d of days) {
    if (isHeldOut(d)) heldout.push(d)
    else if (isResearch(d)) research.push(d)
    else other.push(d)
  }
  return { research, heldout, other }
}

/** Inclusive weekday span between two ISO dates (no holiday calendar — a superset). */
export function weekdaysBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = []
  const end = new Date(toIso + 'T00:00:00Z')
  for (let t = new Date(fromIso + 'T00:00:00Z'); t <= end; t.setUTCDate(t.getUTCDate() + 1)) {
    const dow = t.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(t.toISOString().slice(0, 10))
  }
  return out
}
