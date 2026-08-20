/**
 * FMP 1-minute tape loader for the phantom book — the one file-touching helper,
 * isolated from the pure accounting core. It only ever reads/writes the RESEARCH
 * cache (never a production log). `OFFLINE=1` forbids the network entirely: a cache
 * miss returns `missing`, never a silent fetch.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Candle } from '@/types'
import { etStrToUnixSec } from '@/lib/replay-day'

export interface RawFmpRow { date: string; open: number; high: number; low: number; close: number; volume?: number }
export type TapeSource = 'cache' | 'network' | 'missing'

/** FMP rows (ET wall-time strings) → Candle[] (unix-sec, ET-correct via replay-day's parser). */
export function normalizeFmpRows(rows: RawFmpRow[]): Candle[] {
  return rows
    .map((r) => ({ time: etStrToUnixSec(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }))
    .sort((a, b) => a.time - b.time)
}

export async function loadTape(opts: {
  symbol: string
  day: string
  offline: boolean
  cacheDir: string
  fetchRows: () => Promise<RawFmpRow[]>
}): Promise<{ bars: Candle[]; source: TapeSource }> {
  const file = join(opts.cacheDir, `m1_${opts.symbol}_${opts.day}.json`)
  if (existsSync(file)) {
    return { bars: JSON.parse(readFileSync(file, 'utf8')) as Candle[], source: 'cache' }
  }
  if (opts.offline) return { bars: [], source: 'missing' }
  const bars = normalizeFmpRows(await opts.fetchRows())
  try {
    mkdirSync(opts.cacheDir, { recursive: true })
    writeFileSync(file, JSON.stringify(bars))
  } catch {
    /* cache write is best-effort; a read-only FS must not break the run */
  }
  return { bars, source: 'network' }
}
