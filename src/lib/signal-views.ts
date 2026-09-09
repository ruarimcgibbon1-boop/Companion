/**
 * Presentation-only read-models for the Signals tab.
 *
 * Source-of-truth split (this file introduces NO trading semantics — no signal
 * generation, scoring, thresholds, session/expiry rules, or persistence):
 *
 *   Active / Triggered  ← the LIVE `monitoredSetups` (DetectedSetup[]), which the
 *                         monitor rebuilds every sweep. These represent what is
 *                         actually current, unlike the alert log.
 *   Event history       ← the `monitorAlerts` rolling log (chronological audit),
 *                         sliced per ticker for the expandable history section.
 *
 * The engine can list several current setups for one symbol. Per the "one ticker
 * = one card" rule we surface a single PRIMARY setup collapsed, and expose the
 * rest on expand. Nothing here mutates its inputs.
 */

import type { DetectedSetup, MonitorAlert, SetupState } from '@/types'

/**
 * Display filter vocabulary, mapped onto the real `SetupState` values that
 * already exist on every setup/alert — nothing invented. `all` is a pass-through.
 */
export type SignalStateFilter = 'all' | 'approaching' | 'confirming' | 'triggered' | 'invalidated'

const FILTER_STATES: Record<Exclude<SignalStateFilter, 'all'>, SetupState> = {
  approaching: 'approaching',
  confirming: 'confirming',
  triggered: 'triggered',
  invalidated: 'failed',
}

/** Filter chips in display order, with user-facing labels. */
export const SIGNAL_STATE_FILTERS: { key: SignalStateFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'approaching', label: 'Approaching' },
  { key: 'confirming', label: 'Confirming' },
  { key: 'triggered', label: 'Triggered' },
  { key: 'invalidated', label: 'Invalidated' },
]

/**
 * Lifecycle progression rank — a DISPLAY ordering that mirrors the state
 * machine's own `ORDER` (setup-state-machine.ts) and the existing `stateRank`
 * in the Opportunities drawer. Higher = further progressed / more actionable.
 * Used only to pick which of a ticker's current setups to show first. It is a
 * presentation choice and implies NO strategy superiority between setups.
 */
export const SETUP_STATE_RANK: Record<SetupState, number> = {
  identified: 0, approaching: 1, at_level: 2, confirming: 3, triggered: 4,
  failed: -1, expired: -2,
}

/** A ticker's current setups, collapsed to one primary with the rest kept. */
export interface TickerSetupGroup {
  symbol: string
  /** The setup shown in the collapsed card (furthest-progressed, score tie-break). */
  primary: DetectedSetup
  /** Every current setup for this ticker, ordered the same way (includes `primary`). */
  setups: DetectedSetup[]
}

/**
 * Order two setups for display: furthest-progressed state first, then higher
 * score. Deterministic; presentation-only.
 */
function bySetupPriority(a: DetectedSetup, b: DetectedSetup): number {
  const r = SETUP_STATE_RANK[b.state] - SETUP_STATE_RANK[a.state]
  if (r !== 0) return r
  return b.score - a.score
}

/**
 * Group the live setups by ticker, one row per symbol. Within a symbol the
 * setups are ordered by display priority and the first is the primary. Rows are
 * ordered by their primary (most-actionable ticker first). Pure — never mutates
 * the input array or the setups within it.
 */
export function groupSetupsByTicker(setups: DetectedSetup[]): TickerSetupGroup[] {
  const bySymbol = new Map<string, DetectedSetup[]>()
  for (const s of setups) {
    const list = bySymbol.get(s.symbol)
    if (list) list.push(s)
    else bySymbol.set(s.symbol, [s])
  }

  const rows: TickerSetupGroup[] = []
  for (const [symbol, list] of bySymbol) {
    const ordered = [...list].sort(bySetupPriority)
    rows.push({ symbol, primary: ordered[0], setups: ordered })
  }

  rows.sort((a, b) => bySetupPriority(a.primary, b.primary))
  return rows
}

/** Does a setup's lifecycle state match a display filter? `all` matches everything. */
export function matchesSetupFilter(setup: DetectedSetup, filter: SignalStateFilter): boolean {
  if (filter === 'all') return true
  return setup.state === FILTER_STATES[filter]
}

/**
 * Filter grouped rows by their PRIMARY setup's state, so the visible (collapsed)
 * card always matches the active chip. Returns a new array; never mutates.
 */
export function filterSetupTickers(rows: TickerSetupGroup[], filter: SignalStateFilter): TickerSetupGroup[] {
  if (filter === 'all') return rows
  return rows.filter(r => matchesSetupFilter(r.primary, filter))
}

/**
 * Rows whose current setup state is triggered — for the Triggered view. Because
 * the primary is the furthest-progressed setup, any ticker with a triggered
 * setup surfaces here with that setup primary.
 */
export function triggeredSetupTickers(rows: TickerSetupGroup[]): TickerSetupGroup[] {
  return rows.filter(r => r.primary.state === 'triggered')
}

/** Per-ticker state tallies (one vote per ticker, by its primary setup). */
export interface SetupSummary {
  tickers: number
  byState: Partial<Record<SetupState, number>>
  approaching: number
  confirming: number
  triggered: number
  invalidated: number
}

/** Summarise current states across grouped tickers, for the summary strip. */
export function summarizeSetupTickers(rows: TickerSetupGroup[]): SetupSummary {
  const byState: Partial<Record<SetupState, number>> = {}
  for (const r of rows) {
    const s = r.primary.state
    byState[s] = (byState[s] ?? 0) + 1
  }
  return {
    tickers: rows.length,
    byState,
    approaching: byState.approaching ?? 0,
    confirming: byState.confirming ?? 0,
    triggered: byState.triggered ?? 0,
    invalidated: byState.failed ?? 0,
  }
}

/**
 * Decision-useful summary text from a summary, e.g.
 * "3 tickers active · 2 confirming · 1 approaching". Lists only non-zero states.
 */
export function setupSummaryText(summary: SetupSummary): string {
  const head = `${summary.tickers} ${summary.tickers === 1 ? 'ticker' : 'tickers'} active`
  const parts: string[] = []
  if (summary.triggered) parts.push(`${summary.triggered} triggered`)
  if (summary.confirming) parts.push(`${summary.confirming} confirming`)
  if (summary.approaching) parts.push(`${summary.approaching} approaching`)
  if (summary.invalidated) parts.push(`${summary.invalidated} invalidated`)
  return parts.length ? `${head} · ${parts.join(' · ')}` : head
}

/**
 * The event log slice for one ticker, newest-first — for the expandable event
 * history inside an Active card. Reads `monitorAlerts`; never mutates it.
 */
export function eventsForTicker(alerts: MonitorAlert[], symbol: string): MonitorAlert[] {
  return alerts.filter(a => a.symbol === symbol).sort((a, b) => b.timestamp - a.timestamp)
}

/** Count of unread events for one ticker (purely for a visual dot). Reads only. */
export function unreadForTicker(alerts: MonitorAlert[], symbol: string): number {
  return alerts.reduce((n, a) => n + (a.symbol === symbol && !a.read ? 1 : 0), 0)
}
