/**
 * FMP usage persistence + rolling baseline.
 *
 * Covers: same-day persistence, restart continuation, ET-day rollover, atomic write,
 * corrupt-file recovery, rolling-window inclusion/exclusion, endpoint aggregation,
 * no-secret-leakage in persisted files, display-only rolling limit, and the invariant
 * that a telemetry/persistence failure can never throw into fmpGet().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordFmpCall, getFmpUsage, resetFmpUsage, persistFmpUsage,
  getRollingUsage, formatRollingLine, rollingLimitBytes, maybeEmitFmpUsage,
  etDay, fmpUsageDir, type FmpUsageDayFile, type FmpFamilyStat,
} from '../src/lib/fmp-telemetry'
import { getQuote } from '../src/lib/fmp-client'

// Fixed instant → deterministic ET day regardless of the wall clock (15:00 EDT).
const BASE = Date.parse('2026-09-13T15:00:00-04:00')
const DAY = etDay(BASE)                 // "2026-09-13"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fmp-usage-'))
  process.env.COMPANION_FMP_USAGE_DIR = dir
  delete process.env.FMP_ROLLING_LIMIT_GB
  delete process.env.FMP_SOFT_DAILY_GB
  resetFmpUsage(BASE)                   // currentDay = DAY, deterministically
})
afterEach(() => {
  delete process.env.COMPANION_FMP_USAGE_DIR
  vi.unstubAllGlobals()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function stat(over: Partial<FmpFamilyStat> = {}): FmpFamilyStat {
  return { requests: 0, successful: 0, failed: 0, bytes: 0, latencyTotalMs: 0, latencyMaxMs: 0, ...over }
}
function writeDayFile(day: string, families: Record<string, FmpFamilyStat>): void {
  const totals = stat()
  for (const s of Object.values(families)) {
    totals.requests += s.requests; totals.bytes += s.bytes
    totals.successful += s.successful; totals.failed += s.failed
    totals.latencyTotalMs += s.latencyTotalMs
    totals.latencyMaxMs = Math.max(totals.latencyMaxMs, s.latencyMaxMs)
  }
  const file: FmpUsageDayFile = { day, updatedAt: BASE, totals, families }
  writeFileSync(join(dir, `${day}.json`), JSON.stringify(file))
}

describe('same-day persistence', () => {
  it('writes an aggregate file with totals, families and no secrets', () => {
    recordFmpCall({ path: '/quote', ok: true, bytes: 100, latencyMs: 10 }, BASE)
    recordFmpCall({ path: '/historical-chart/5min', ok: true, bytes: 900, latencyMs: 40 }, BASE)
    expect(persistFmpUsage(DAY, BASE)).toBe(true)

    const raw = readFileSync(join(dir, `${DAY}.json`), 'utf8')
    const parsed = JSON.parse(raw) as FmpUsageDayFile
    expect(parsed.day).toBe(DAY)
    expect(parsed.totals).toMatchObject({ requests: 2, bytes: 1000 })
    expect(parsed.families['/quote'].bytes).toBe(100)
    expect(parsed.families['/historical-chart/5min'].bytes).toBe(900)
    // No secret / URL / apikey in the persisted file — only paths + numbers.
    expect(raw).not.toContain('apikey')
    expect(raw).not.toContain('financialmodelingprep')
  })

  it('does not overwrite an existing day file with an empty snapshot', () => {
    writeDayFile(DAY, { '/quote': stat({ requests: 5, bytes: 500 }) })
    resetFmpUsage(BASE)                 // memory empty
    expect(persistFmpUsage(DAY, BASE)).toBe(false)   // nothing to persist → no write
    const parsed = JSON.parse(readFileSync(join(dir, `${DAY}.json`), 'utf8')) as FmpUsageDayFile
    expect(parsed.totals.bytes).toBe(500)            // prior data intact
  })
})

describe('restart continuation', () => {
  it('process B loads the same day and continues rather than resetting', () => {
    // Process A
    recordFmpCall({ path: '/quote', ok: true, bytes: 100, latencyMs: 10 }, BASE)
    recordFmpCall({ path: '/quote', ok: false, bytes: 20, latencyMs: 5 }, BASE)
    expect(persistFmpUsage(DAY, BASE)).toBe(true)

    // Simulate a fresh process: clear in-memory + arm load-on-first-use
    resetFmpUsage(BASE)
    expect(getFmpUsage(BASE).totals.requests).toBe(2)   // load-on-read seeds from disk

    // Process B keeps accumulating on top of the loaded baseline
    recordFmpCall({ path: '/quote', ok: true, bytes: 30, latencyMs: 7 }, BASE)
    const u = getFmpUsage(BASE)
    expect(u.totals.requests).toBe(3)
    expect(u.families['/quote'].bytes).toBe(150)
  })
})

describe('ET-day rollover', () => {
  it('flushes the closing day to disk and starts the new day fresh', () => {
    recordFmpCall({ path: '/quote', ok: true, bytes: 100, latencyMs: 10 }, BASE)
    const NEXT = BASE + 26 * 3600_000            // safely into the next ET day
    const day2 = etDay(NEXT)
    expect(day2).not.toBe(DAY)

    // Reading on the new day rolls: old day persisted, counters reset.
    const rolled = getFmpUsage(NEXT)
    expect(rolled.day).toBe(day2)
    expect(rolled.totals.requests).toBe(0)

    const closed = JSON.parse(readFileSync(join(dir, `${DAY}.json`), 'utf8')) as FmpUsageDayFile
    expect(closed.totals.requests).toBe(1)
    expect(closed.totals.bytes).toBe(100)

    // New day accumulates independently.
    recordFmpCall({ path: '/quote', ok: true, bytes: 55, latencyMs: 3 }, NEXT)
    expect(getFmpUsage(NEXT).totals.bytes).toBe(55)
  })
})

describe('atomic write path', () => {
  it('leaves the final file and no leftover temp files', () => {
    recordFmpCall({ path: '/quote', ok: true, bytes: 100, latencyMs: 10 }, BASE)
    persistFmpUsage(DAY, BASE)
    const entries = readdirSync(dir)
    expect(entries).toContain(`${DAY}.json`)
    expect(entries.some(f => f.includes('.tmp.'))).toBe(false)
  })
})

describe('corrupt-file recovery', () => {
  it('warns and starts fresh, never throwing', () => {
    writeFileSync(join(dir, `${DAY}.json`), '{ this is not valid json ')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetFmpUsage(BASE)

    expect(() => recordFmpCall({ path: '/quote', ok: true, bytes: 42, latencyMs: 1 }, BASE)).not.toThrow()
    const u = getFmpUsage(BASE)
    expect(u.totals.requests).toBe(1)          // corrupt prior data ignored, fresh start
    expect(u.families['/quote'].bytes).toBe(42)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('rolling window', () => {
  it('includes the trailing N days and excludes older, aggregating per family', () => {
    writeDayFile(DAY, { '/quote': stat({ requests: 10, bytes: 1_000 }) })
    writeDayFile(etDay(BASE - 5 * 86_400_000), { '/quote': stat({ requests: 5, bytes: 500 }), '/news/stock': stat({ requests: 2, bytes: 200 }) })
    writeDayFile(etDay(BASE - 29 * 86_400_000), { '/quote': stat({ requests: 1, bytes: 300 }) })   // edge: included
    writeDayFile(etDay(BASE - 30 * 86_400_000), { '/quote': stat({ requests: 9, bytes: 9_000 }) }) // excluded
    writeDayFile(etDay(BASE - 40 * 86_400_000), { '/quote': stat({ requests: 9, bytes: 9_000 }) }) // excluded

    const r = getRollingUsage(30, BASE)
    expect(r.totalBytes).toBe(1_000 + 500 + 200 + 300)        // excludes day-30 and day-40
    expect(r.totalRequests).toBe(10 + 5 + 2 + 1)
    expect(r.datesPresent).toContain(DAY)
    expect(r.datesPresent).toContain(etDay(BASE - 29 * 86_400_000))
    expect(r.datesPresent).not.toContain(etDay(BASE - 30 * 86_400_000))
    // Endpoint aggregation across days, largest bytes first.
    const quote = r.families.find(f => f.family === '/quote')!
    expect(quote.bytes).toBe(1_000 + 500 + 300)
    expect(r.families[0].family).toBe('/quote')
    // Today surfaced separately.
    expect(r.today?.totals.bytes).toBe(1_000)
  })

  it('is empty (no throw) when the usage dir does not exist', () => {
    rmSync(dir, { recursive: true, force: true })
    const r = getRollingUsage(30, BASE)
    expect(r.totalBytes).toBe(0)
    expect(r.datesPresent).toEqual([])
  })
})

describe('display-only rolling limit', () => {
  it('renders used/limit/pct but changes no recorded data or behaviour', () => {
    process.env.FMP_ROLLING_LIMIT_GB = '50'
    writeDayFile(DAY, { '/quote': stat({ requests: 1, bytes: 25_000_000_000 }) })   // 25 GB
    const r = getRollingUsage(30, BASE)
    expect(rollingLimitBytes()).toBe(50_000_000_000)
    expect(r.limitGb).toBe(50)
    expect(r.usedPct).toBeCloseTo(50, 5)
    expect(formatRollingLine(r)).toBe('[FMP] rolling 30d 25.0 / 50.0 GB (50.0%)')

    // The limit is display-only: recording still works (not throttled/blocked). The
    // new byte lands on top of the loaded on-disk baseline (25 GB + 10).
    expect(() => recordFmpCall({ path: '/quote', ok: true, bytes: 10, latencyMs: 1 }, BASE)).not.toThrow()
    expect(getFmpUsage(BASE).families['/quote'].bytes).toBe(25_000_000_010)
  })

  it('omits the limit clause when unset', () => {
    writeDayFile(DAY, { '/quote': stat({ requests: 1, bytes: 2_000_000_000 }) })
    const r = getRollingUsage(30, BASE)
    expect(r.limitGb).toBeNull()
    expect(formatRollingLine(r)).toBe('[FMP] rolling 30d 2.0 GB')
  })
})

describe('failure isolation — telemetry can never throw into fmpGet()', () => {
  it('persist returns false (no throw) when the usage dir cannot be created', () => {
    // Point the dir at an existing FILE so mkdirSync fails.
    const badFile = join(dir, 'not-a-dir')
    writeFileSync(badFile, 'x')
    process.env.COMPANION_FMP_USAGE_DIR = badFile
    resetFmpUsage(BASE)
    recordFmpCall({ path: '/quote', ok: true, bytes: 5, latencyMs: 1 }, BASE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(persistFmpUsage(DAY, BASE)).toBe(false)
    expect(() => maybeEmitFmpUsage(() => {}, BASE)).not.toThrow()
    warn.mockRestore()
  })

  it('getQuote still resolves when the usage dir is unwritable', async () => {
    const badFile = join(dir, 'blocker')
    writeFileSync(badFile, 'x')
    process.env.COMPANION_FMP_USAGE_DIR = badFile
    process.env.FMP_API_KEY = 'k_secret_value'
    resetFmpUsage(BASE)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = JSON.stringify([{ symbol: 'AAA', price: 1, previousClose: 1 }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, async text() { return body } } as unknown as Response))

    await expect(getQuote('AAA')).resolves.toMatchObject({ symbol: 'AAA' })
  })
})

describe('fmpUsageDir override', () => {
  it('honours COMPANION_FMP_USAGE_DIR', () => {
    expect(fmpUsageDir()).toBe(dir)
  })
})
