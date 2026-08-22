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

import type { Candle, SetupLog, BuySignalRecord } from '@/types'
import { getSessionType, parseEtTimestampSec, type SessionType } from './market-hours'

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
 * Normalize candles from /api/candles into the resolver's shape. The route returns
 * Yahoo/FMP candles keyed by `date` (ISO ET string), NOT the `time` (unix seconds)
 * the resolver filters on — so a raw cast matched ZERO candles and silently
 * resolved nothing (every outcome stuck 'open', every pnl blank). Accepts either
 * shape and drops rows that carry neither a usable time nor date.
 */
export function normalizeCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return []
  const out: Candle[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    // `date` is an ET wall-clock string with no zone. Parsing it with `new Date()`
    // resolved it in the HOST timezone, so on a non-ET machine every candle landed
    // hours off (Europe/Madrid: 6 hours early — a 09:35 ET bar read as 03:35, which
    // `sameEtDay` then matched to the WRONG DAY). See parseEtTimestamp.
    const time = typeof o.time === 'number'
      ? o.time
      : typeof o.date === 'string'
      ? parseEtTimestampSec(o.date)
      : NaN
    if (!Number.isFinite(time)) continue
    out.push({
      time,
      open: Number(o.open), high: Number(o.high), low: Number(o.low),
      close: Number(o.close), volume: Number(o.volume ?? 0),
    })
  }
  return out
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

// ── Scaled-out realized P/L ──────────────────────────────────────────────────

// Scale-out schedule: sell this fraction at T1, the remainder at T2. Breakeven
// stop moves under the remainder once T1 books. Tunable knobs.
const SCALE_T1_FRACTION = 0.5
// Move the runner's stop to breakeven once T1 books. PRODUCTION DEFAULT = true
// (unchanged). Research-configurable ONLY via an explicit env flag so an A/B can
// test hypothesis M1 (breakeven-after-T1 truncates runners) without touching the
// live default: BREAKEVEN_AFTER_T1=0 keeps the runner on its original invalidation
// stop until T2/EOD. The env is inert in the browser (process undefined), so the
// live client and daemon always get `true`.
const BREAKEVEN_AFTER_T1 =
  (typeof process !== 'undefined' && process.env && process.env.BREAKEVEN_AFTER_T1 === '0') ? false : true

// Slippage haircut (per side, as a fraction of price): the resolver fills at the
// exact level, but real fills are worse — you pay up on entry and give up on the
// exit. Premarket/after-hours books are thin, so the haircut is far bigger there.
// Applied to entry AND every exit leg, so a round-trip costs ~2×. Tunable; without
// this, premarket P/L reads far rosier than it will ever trade.
const SLIPPAGE_RTH = 0.0015      // 0.15%/side in regular hours
const SLIPPAGE_EXTENDED = 0.005  // 0.5%/side premarket / after-hours (thin)
export function slippageForSession(s: SessionType): number {
  return s === 'regular' ? SLIPPAGE_RTH : SLIPPAGE_EXTENDED
}

export interface PnlLeg { fraction: number; exitPrice: number; reason: 'T1' | 'T2' | 'stop' | 'breakeven' | 'close' }
export interface PnlResult { pnlPct: number; legs: PnlLeg[]; fullyClosed: boolean }

/**
 * Realized P/L for a long entry under the scale-out rule, replayed against the
 * day's candle tape:
 *   - sell SCALE_T1_FRACTION at T1, move the stop to breakeven (entry) on the rest;
 *   - sell the remainder at T2;
 *   - the stop (initial invalidation before T1, breakeven after) exits whatever is
 *     still held if hit — checked ADVERSE-FIRST within a bar (intrabar order unknown);
 *   - anything still held at the close is marked-to-close (fullyClosed = false).
 * Returns null if there are no candles on the entry's day. `entry`, `stop`,
 * `targets` are the actual fill / stop / target ladder from the BuySignalRecord.
 */
export function scaledPnl(
  entry: number,
  stop: number,
  targets: number[],
  candles: Candle[],
  signalMs: number,
  slippagePct = 0,
): PnlResult | null {
  if (entry <= 0) return null
  const signalSec = Math.floor(signalMs / 1000)
  const day = candles
    .filter(c => c.time >= signalSec && sameEtDay(c.time * 1000, signalMs))
    .sort((a, b) => a.time - b.time)
  if (day.length === 0) return null

  const t1 = targets[0] ?? null
  const t2 = targets[1] ?? null
  const legs: PnlLeg[] = []
  let held = 1
  let curStop = stop
  let t1Done = false
  let pnlFrac = 0 // sum of fraction × per-share-return

  // Fill worse than the level: pay up on entry, give up on every exit. Detection
  // still uses the raw levels (the market really touched them); only the FILL is
  // haircut. Legs keep the raw level for readability; the P/L uses the effective fill.
  const entryEff = entry * (1 + slippagePct)
  const bookAt = (fraction: number, price: number, reason: PnlLeg['reason']) => {
    const exitEff = price * (1 - slippagePct)
    pnlFrac += fraction * ((exitEff - entryEff) / entryEff)
    legs.push({ fraction, exitPrice: price, reason })
    held -= fraction
  }

  for (const c of day) {
    // Adverse first: the stop (initial, or breakeven after T1) takes priority.
    if (c.low <= curStop) {
      bookAt(held, curStop, t1Done ? 'breakeven' : 'stop')
      held = 0
      break
    }
    if (!t1Done && t1 != null && c.high >= t1) {
      bookAt(SCALE_T1_FRACTION, t1, 'T1')
      t1Done = true
      if (BREAKEVEN_AFTER_T1) curStop = entry
      // a strong bar can clear T2 in the same candle it took T1
      if (t2 != null && c.high >= t2 && held > 0) { bookAt(held, t2, 'T2'); held = 0; break }
      continue
    }
    if (t1Done && t2 != null && c.high >= t2) {
      bookAt(held, t2, 'T2')
      held = 0
      break
    }
  }

  let fullyClosed = true
  if (held > 1e-9) {
    bookAt(held, day[day.length - 1].close, 'close')
    fullyClosed = false
  }

  return { pnlPct: pnlFrac * 100, legs, fullyClosed }
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

/**
 * Compute realized (scaled-out) P/L for every buy signal whose day has closed and
 * that hasn't been priced yet. Buy signals are long-only. Fetches once per symbol
 * (caller supplies the fetch). Returns only the records that gained a pnlPct.
 */
export async function resolveBuyPnl(
  buys: BuySignalRecord[],
  now: number,
  fetchCandles: (symbol: string) => Promise<Candle[]>,
): Promise<BuySignalRecord[]> {
  const stale = buys.filter(b => b.pnlPct == null && isDayClosed(b.timestamp, now))
  if (stale.length === 0) return []

  const bySymbol = new Map<string, BuySignalRecord[]>()
  for (const b of stale) {
    const g = bySymbol.get(b.symbol)
    if (g) g.push(b)
    else bySymbol.set(b.symbol, [b])
  }

  const priced: BuySignalRecord[] = []
  for (const [symbol, group] of bySymbol) {
    let candles: Candle[] = []
    try {
      candles = await fetchCandles(symbol)
    } catch {
      continue // leave unpriced; a transient fetch failure isn't a P/L
    }
    for (const b of group) {
      const slip = slippageForSession(getSessionType(b.timestamp))
      const r = scaledPnl(b.entryHigh, b.stop, b.targets, candles, b.timestamp, slip)
      if (r) priced.push({ ...b, pnlPct: r.pnlPct, pnlFullyClosed: r.fullyClosed })
    }
  }
  return priced
}
