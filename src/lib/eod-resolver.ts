/**
 * End-of-day resolver.
 *
 * In-app outcome resolution (useMonitor.updateLog) only advances a log while the
 * app is open AND streaming that symbol — so any signal that fires late, or on a
 * day the app isn't running through the close, freezes at `outcome: 'open'`
 * forever (2026-07-23: all three logged setups stuck open). This module replays
 * a closed day's ACTUAL candle tape against each open log and resolves it with a
 * first-touch binary rule, backfilling the real MFE/MAE.
 */

import type { Candle, SetupLog } from '@/types'
import { getSessionType } from './market-hours'

// ── Day helpers ──────────────────────────────────────────────────────────────

// en-CA gives an ISO-ish YYYY-MM-DD, stable to compare two instants by ET date.
function etDayKey(ts: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts))
}

export function sameEtDay(a: number, b: number): boolean {
  return etDayKey(a) === etDayKey(b)
}

/**
 * Is the trading day of `ts` fully over as of `now`? A prior ET date is always
 * closed; today's date is closed only once we're past the 16:00 regular close
 * (afterhours / overnight / weekend). This keeps the resolver from prematurely
 * marking a still-live setup as expired while today's session is ongoing.
 */
export function isDayClosed(ts: number, now: number = Date.now()): boolean {
  if (!sameEtDay(ts, now)) return true
  const s = getSessionType(now)
  return s === 'afterhours' || s === 'overnight' || s === 'closed'
}

// ── Single-log resolution ────────────────────────────────────────────────────

/**
 * Resolve one open log against a symbol's intraday candles (time in SECONDS).
 * Walks the log's own trading day from the signal bar forward:
 *   - long: `low <= stop` → invalidated; `high >= T1` → target_hit
 *   - short: mirrored
 * First touch wins. A bar that straddles both stop and target is scored as the
 * ADVERSE outcome — intrabar order is unknown, so we never credit an optimistic
 * win. MFE/MAE come from the actual high/low over the walked window, relative to
 * priceAtIdentification (matching useMonitor's live convention).
 *
 * Returns an updated log, or null when it can't/shouldn't resolve (not open, or
 * no candles for that day).
 */
export function resolveLogAgainstCandles(log: SetupLog, candles: Candle[]): SetupLog | null {
  if (log.outcome !== 'open') return null

  const dir = log.direction === 'long' ? 1 : -1
  const stop = log.invalidation
  const t1 = log.targets[0]?.price ?? null
  const signalSec = Math.floor(log.identifiedAt / 1000)

  const day = candles
    .filter(c => c.time >= signalSec && sameEtDay(c.time * 1000, log.identifiedAt))
    .sort((a, b) => a.time - b.time)
  if (day.length === 0) return null

  const base = log.priceAtIdentification || day[0].open
  let favor = base
  let adverse = base
  let outcome: SetupLog['outcome'] = 'expired'
  let outcomeReason: string | null = 'No stop or target touched by the close (EOD tape)'
  let resolvedAt = day[day.length - 1].time * 1000

  for (const c of day) {
    favor = dir === 1 ? Math.max(favor, c.high) : Math.min(favor, c.low)
    adverse = dir === 1 ? Math.min(adverse, c.low) : Math.max(adverse, c.high)

    const hitStop = dir === 1 ? c.low <= stop : c.high >= stop
    const hitT1 = t1 != null && (dir === 1 ? c.high >= t1 : c.low <= t1)

    if (hitStop) {
      outcome = 'invalidated'
      outcomeReason = `Hit stop ${stop.toFixed(2)} (EOD tape)`
      resolvedAt = c.time * 1000
      break
    }
    if (hitT1) {
      outcome = 'target_hit'
      outcomeReason = `Reached T1 ${t1!.toFixed(2)} (EOD tape)`
      resolvedAt = c.time * 1000
      break
    }
  }

  return {
    ...log,
    maxFavorablePrice: favor,
    maxAdversePrice: adverse,
    maxFavorablePct: base > 0 ? ((favor - base) / base) * 100 * dir : 0,
    maxAdversePct: base > 0 ? ((adverse - base) / base) * 100 * dir : 0,
    outcome,
    outcomeReason,
    resolvedAt,
  }
}

// ── Batch orchestration ──────────────────────────────────────────────────────

/**
 * Resolve every open log whose trading day has closed. Candles are fetched once
 * per unique symbol (the caller supplies the fetch, so this stays testable and
 * runtime-agnostic). Returns only the logs that actually changed.
 */
export async function resolveOpenLogs(
  logs: SetupLog[],
  now: number,
  fetchCandles: (symbol: string) => Promise<Candle[]>,
): Promise<SetupLog[]> {
  const stale = logs.filter(l => l.outcome === 'open' && isDayClosed(l.identifiedAt, now))
  if (stale.length === 0) return []

  const bySymbol = new Map<string, SetupLog[]>()
  for (const l of stale) {
    const g = bySymbol.get(l.symbol)
    if (g) g.push(l)
    else bySymbol.set(l.symbol, [l])
  }

  const resolved: SetupLog[] = []
  for (const [symbol, group] of bySymbol) {
    let candles: Candle[] = []
    try {
      candles = await fetchCandles(symbol)
    } catch {
      continue // leave the group open; a transient fetch failure isn't a verdict
    }
    for (const l of group) {
      const r = resolveLogAgainstCandles(l, candles)
      if (r) resolved.push(r)
    }
  }
  return resolved
}
