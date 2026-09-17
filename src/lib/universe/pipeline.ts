/**
 * H3B — shared canonical universe pipeline (pure, no I/O).
 *
 * THE single implementation of the daemon-side monitored-universe SELECTION that was
 * previously inline in `scripts/alert-daemon.ts:fetchUniverse`. Extracting it here means
 * the daemon, the coordinator and the parity harness all call ONE function — no
 * independently-maintained copies of the same policy.
 *
 * SEMANTICS ARE FROZEN to the legacy behaviour (H3B compatibility mode): the daemon takes
 * the route's ranked rows, re-sorts them by day-change descending (V8 Array.sort is stable
 * since Node 11, so ties keep the route's momentum order), and keeps the top N. Byte-for-byte
 * the same expression the daemon used before H3B. Do not change this without a policy phase.
 */

/** One ranked row as the /api/gainers route returns it (telemetry + selection view only). */
export interface RankedRow {
  symbol: string
  changePct: number
  rank?: number
  momentumScore?: number | null
  offHighPct?: number | null
  rocPct?: number | null
  relativeVolume?: number | null
  volume?: number
  float?: number | null
  premarketVolume?: number | null
}

/** Matches TOP_GAINERS_UNIVERSE in the daemon (kept in sync deliberately). */
export const DEFAULT_MONITORED_CAP = 15

/**
 * Daemon-equivalent monitored selection. VERBATIM legacy transform:
 *   rows.slice().sort((a,b)=>b.changePct-a.changePct).slice(0, cap)
 * Returns the selected rows (with their pre-existing route rank preserved) and their symbols
 * in monitored order.
 */
export function selectMonitoredUniverse(
  rows: RankedRow[],
  cap: number = DEFAULT_MONITORED_CAP,
): { monitored: RankedRow[]; symbols: string[] } {
  const monitored = rows.slice().sort((a, b) => b.changePct - a.changePct).slice(0, cap)
  return { monitored, symbols: monitored.map(r => r.symbol) }
}
