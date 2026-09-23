/**
 * Pattern-log outcome resolver.
 *
 * The pattern log has always recorded that a candlestick pattern fired and never
 * what happened next, so it could not answer the only question worth asking of
 * it: which patterns actually pay? Price and timestamp were already captured, so
 * the outcome is recoverable from the tape — this module does that.
 *
 * Rules, chosen to keep the answer honest rather than flattering:
 *   - SYMMETRIC ±2% barriers. Equal up/down distance means the win rate IS the
 *     edge: >50% says the pattern predicts direction. An asymmetric ladder would
 *     bake in a payoff assumption and let a 30%-win pattern look profitable on
 *     paper for reasons that have nothing to do with the pattern.
 *   - ADVERSE FIRST within a bar, matching eod-resolver.ts. A bar spanning both
 *     barriers scores as the loss, because intrabar order is unknown and we never
 *     credit an outcome we can't prove.
 *   - A one-hour horizon. Candlestick reversals are short-horizon claims; if
 *     nothing has happened in an hour the pattern didn't call anything.
 *
 * Pure and clock-free apart from the caller-supplied `now`.
 */
import type { Candle, PatternLogRecord, PatternOutcome } from '@/types'

/** Barrier distance in % — same both ways, see the header. */
export const PATTERN_BARRIER_PCT = 2
/** Bars of 5-min tape to walk after the pattern (12 × 5min = 1 hour). */
export const PATTERN_HORIZON_BARS = 12

export interface PatternResolution {
  outcome: PatternOutcome
  mfePct: number
  maePct: number
  resolvedAt: number
}

/**
 * Walk the tape after a logged pattern and classify it.
 *
 * Returns null when the pattern cannot be judged yet — no tape after it, or the
 * horizon hasn't elapsed. Callers must leave those `open` rather than guessing;
 * an unresolvable pattern is missing data, not a loss.
 */
export function resolvePattern(
  record: PatternLogRecord,
  candles: Candle[],
  now: number = Date.now(),
): PatternResolution | null {
  const entry = record.price
  if (!(entry > 0)) return null

  const startSec = Math.floor(record.timestamp / 1000)
  const forward = candles
    .filter(c => c.time >= startSec)
    .sort((a, b) => a.time - b.time)
    .slice(0, PATTERN_HORIZON_BARS)
  if (forward.length === 0) return null

  const upBarrier = entry * (1 + PATTERN_BARRIER_PCT / 100)
  const downBarrier = entry * (1 - PATTERN_BARRIER_PCT / 100)

  let best = entry
  let worst = entry
  let outcome: PatternOutcome = 'expired'
  let resolvedAt = forward[forward.length - 1].time * 1000

  for (const c of forward) {
    best = Math.max(best, c.high)
    worst = Math.min(worst, c.low)
    // Adverse first — a bar that spans both barriers is a loss.
    if (c.low <= downBarrier) { outcome = 'loss'; resolvedAt = c.time * 1000; break }
    if (c.high >= upBarrier) { outcome = 'win'; resolvedAt = c.time * 1000; break }
  }

  // Nothing resolved AND the horizon hasn't fully elapsed yet → still open. Don't
  // book an 'expired' on a pattern that simply hasn't had its hour.
  if (outcome === 'expired' && forward.length < PATTERN_HORIZON_BARS) {
    const horizonEndsAt = (forward[0].time + PATTERN_HORIZON_BARS * 300) * 1000
    if (now < horizonEndsAt) return null
  }

  return {
    outcome,
    mfePct: ((best - entry) / entry) * 100,
    maePct: ((worst - entry) / entry) * 100,
    resolvedAt,
  }
}

/**
 * Resolve every unresolved record, fetching each symbol's tape at most once.
 * Records that can't be judged are left untouched.
 */
export async function resolvePatternLog(
  records: PatternLogRecord[],
  fetchCandles: (symbol: string) => Promise<Candle[]>,
  now: number = Date.now(),
): Promise<PatternLogRecord[]> {
  const pending = records.filter(r => r.outcome == null || r.outcome === 'open')
  if (pending.length === 0) return []

  const symbols = [...new Set(pending.map(r => r.symbol))]
  const tape = new Map<string, Candle[]>()
  for (const symbol of symbols) {
    try { tape.set(symbol, await fetchCandles(symbol)) } catch { /* leave unresolved */ }
  }

  const updated: PatternLogRecord[] = []
  for (const record of pending) {
    const candles = tape.get(record.symbol)
    if (!candles || candles.length === 0) continue
    const res = resolvePattern(record, candles, now)
    if (!res) continue
    updated.push({
      ...record,
      outcome: res.outcome,
      mfePct: res.mfePct,
      maePct: res.maePct,
      resolvedAt: res.resolvedAt,
    })
  }
  return updated
}

/** Win rate over resolved records. Expired rows are excluded — they made no call. */
export function patternWinRate(records: PatternLogRecord[]): { wins: number; losses: number; pct: number | null } {
  const wins = records.filter(r => r.outcome === 'win').length
  const losses = records.filter(r => r.outcome === 'loss').length
  const decided = wins + losses
  return { wins, losses, pct: decided ? (wins / decided) * 100 : null }
}
