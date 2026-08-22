/**
 * FMP 1-minute tape loader for the phantom book — the one file-touching helper,
 * isolated from the pure accounting core. It only ever reads/writes the RESEARCH
 * cache (never a production log). `OFFLINE=1` forbids the network entirely: a cache
 * miss returns `missing`, never a silent fetch.
 *
 * FAIL-CLOSED (the poisoning fix): a transient FMP failure returns `[]`. This loader
 * must NEVER let that masquerade as a real tape:
 *   - a network fetch that yields zero bars is a FAILURE — it is never cached, and it
 *     surfaces as `fetch_failed`;
 *   - a pre-existing cache file that parses to zero bars is POISONED — offline it
 *     surfaces as `empty_cache` (EMPTY_TAPE_CACHE), online it is discarded and refetched;
 *   - every result carries `targetDayBars`, the count of bars for the requested ET day,
 *     so the caller can require ≥1 real bar for a symbol that feeds a headline book.
 * A small bounded retry lives HERE (phantom research only); the generic FMP client is
 * untouched so no other subsystem changes behaviour.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type { Candle } from '@/types'
import { etStrToUnixSec } from '@/lib/replay-day'
import { etTradingDay } from '@/lib/research/shadow-journal'

export interface RawFmpRow { date: string; open: number; high: number; low: number; close: number; volume?: number }
/** cache/network = real bars loaded; missing = offline miss; empty_cache/fetch_failed = fail-closed conditions. */
export type TapeSource = 'cache' | 'network' | 'missing' | 'empty_cache' | 'fetch_failed'
export interface TapeResult { bars: Candle[]; source: TapeSource; targetDayBars: number }

/** SHA-256 of exact source content, so a report records the immutable snapshot it ran on. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** FMP rows (ET wall-time strings) → Candle[] (unix-sec, ET-correct via replay-day's parser). */
export function normalizeFmpRows(rows: RawFmpRow[]): Candle[] {
  return rows
    .map((r) => ({ time: etStrToUnixSec(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }))
    .sort((a, b) => a.time - b.time)
}

/** Bars whose ET trading day equals `day`. A non-empty multi-day tape with zero of these is still a failure. */
export function countTargetDayBars(bars: Candle[], day: string): number {
  let n = 0
  for (const b of bars) if (etTradingDay(b.time * 1000) === day) n++
  return n
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Bounded retry, LOCAL to phantom research. A throw OR an empty array is retryable.
 * Returns [] only after all attempts are exhausted; the caller never caches [].
 */
async function fetchWithRetry(fetchRows: () => Promise<RawFmpRow[]>, retries: number, delayMs: number): Promise<Candle[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const rows = await fetchRows()
      if (rows.length > 0) return normalizeFmpRows(rows)
    } catch {
      /* retryable */
    }
    if (attempt < retries && delayMs > 0) await sleep(delayMs)
  }
  return []
}

export async function loadTape(opts: {
  symbol: string
  day: string
  offline: boolean
  cacheDir: string
  fetchRows: () => Promise<RawFmpRow[]>
  retries?: number
  retryDelayMs?: number
}): Promise<TapeResult> {
  const file = join(opts.cacheDir, `m1_${opts.symbol}_${opts.day}.json`)

  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8')) as Candle[]
    if (cached.length > 0) {
      return { bars: cached, source: 'cache', targetDayBars: countTargetDayBars(cached, opts.day) }
    }
    // Zero-bar cache = poisoned by a prior failed fetch. Never trust it.
    if (opts.offline) return { bars: [], source: 'empty_cache', targetDayBars: 0 }
    // Online: discard it and refetch below (overwrite only if the refetch is non-empty).
  }

  if (opts.offline) return { bars: [], source: 'missing', targetDayBars: 0 }

  const bars = await fetchWithRetry(opts.fetchRows, opts.retries ?? 2, opts.retryDelayMs ?? 250)
  if (bars.length === 0) {
    // NEVER cache a failed/empty fetch — that is exactly the poisoning we are preventing.
    return { bars: [], source: 'fetch_failed', targetDayBars: 0 }
  }
  try {
    mkdirSync(opts.cacheDir, { recursive: true })
    writeFileSync(file, JSON.stringify(bars))
  } catch {
    /* cache write is best-effort; a read-only FS must not break the run */
  }
  return { bars, source: 'network', targetDayBars: countTargetDayBars(bars, opts.day) }
}
