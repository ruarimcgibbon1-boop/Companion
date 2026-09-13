/**
 * FMP telemetry — byte/request accounting at the fmpGet() chokepoint.
 *
 * Proves: correct byte counting, endpoint-family aggregation, success/failure
 * counting, that JSON/schema/error BEHAVIOUR is unchanged by the instrumentation, and
 * — the security invariant — that the apikey never reaches any recorded or emitted
 * string. Telemetry keys derive from the `path` argument only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fmpFamily, recordFmpCall, getFmpUsage, resetFmpUsage,
  formatFmpUsageLines, bytesShare, formatBytes, etDay,
} from '../src/lib/fmp-telemetry'
import { getQuote, getTopGainers } from '../src/lib/fmp-client'

const SECRET = 'SECRET_TEST_KEY_do_not_leak_9f8a'

function resp(body: string, ok = true, status = 200) {
  return { ok, status, async text() { return body } } as unknown as Response
}

// Isolate persistence to a fresh empty temp dir so lazy load-on-first-use is a no-op
// and these byte assertions never pick up real persisted usage on any machine.
let usageDir: string
beforeEach(() => {
  process.env.FMP_API_KEY = SECRET
  delete process.env.FMP_SOFT_DAILY_GB
  delete process.env.FMP_ROLLING_LIMIT_GB
  usageDir = mkdtempSync(join(tmpdir(), 'fmp-usage-step1-'))
  process.env.COMPANION_FMP_USAGE_DIR = usageDir
  resetFmpUsage()
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.COMPANION_FMP_USAGE_DIR
  try { rmSync(usageDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ── Pure telemetry helpers ──────────────────────────────────────────────────
describe('fmp-telemetry pure helpers', () => {
  it('derives the family from the path only, keeping the interval segment', () => {
    expect(fmpFamily('/quote')).toBe('/quote')
    expect(fmpFamily('/historical-chart/5min')).toBe('/historical-chart/5min')
    expect(fmpFamily('/historical-chart/1min')).toBe('/historical-chart/1min')
    // A stray query string (should never happen) is dropped so no key can survive.
    expect(fmpFamily('/quote?apikey=abc&symbol=X')).toBe('/quote')
  })

  it('aggregates requests, successes, failures, bytes and latency per family', () => {
    recordFmpCall({ path: '/quote', ok: true, bytes: 100, latencyMs: 10 })
    recordFmpCall({ path: '/quote', ok: false, bytes: 20, latencyMs: 40 })
    recordFmpCall({ path: '/biggest-gainers', ok: true, bytes: 500, latencyMs: 5 })

    const u = getFmpUsage()
    expect(u.families['/quote']).toMatchObject({
      requests: 2, successful: 1, failed: 1, bytes: 120, latencyTotalMs: 50, latencyMaxMs: 40,
    })
    expect(u.families['/biggest-gainers'].bytes).toBe(500)
    expect(u.totals).toMatchObject({ requests: 3, successful: 2, failed: 1, bytes: 620, latencyMaxMs: 40 })
    expect(u.day).toBe(etDay())
  })

  it('bytesShare is largest-first and sums to ~1', () => {
    recordFmpCall({ path: '/historical-chart/5min', ok: true, bytes: 800, latencyMs: 1 })
    recordFmpCall({ path: '/quote', ok: true, bytes: 200, latencyMs: 1 })
    const shares = bytesShare(getFmpUsage())
    expect(shares[0].family).toBe('/historical-chart/5min')
    expect(shares[0].share).toBeCloseTo(0.8, 5)
    expect(shares.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 5)
  })

  it('formats usage lines in the [FMP] today … · … req shape', () => {
    recordFmpCall({ path: '/historical-chart/5min', ok: true, bytes: 610_000_000, latencyMs: 1 })
    recordFmpCall({ path: '/quote', ok: true, bytes: 220_000_000, latencyMs: 1 })
    const lines = formatFmpUsageLines(getFmpUsage())
    expect(lines[0]).toMatch(/^\[FMP\] today [\d.]+ (GB|MB|KB|B) · [\d,]+ req$/)
    expect(lines.some(l => /^\[FMP\] historical-chart\/5min \d+% bytes$/.test(l))).toBe(true)
    expect(lines.some(l => /^\[FMP\] quote \d+% bytes$/.test(l))).toBe(true)
  })

  it('formatBytes scales B/KB/MB/GB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2_048)).toBe('2.0 KB')
    expect(formatBytes(3_000_000)).toBe('3.00 MB')
    expect(formatBytes(1_500_000_000)).toBe('1.50 GB')
  })
})

// ── fmpGet wiring: behaviour preserved + bytes counted ────────────────────────
describe('fmpGet instrumentation', () => {
  it('counts actual response-body bytes under the right family, JSON result unchanged', async () => {
    const body = JSON.stringify([{ symbol: 'AAA', price: 3.21, previousClose: 3, changePercentage: 7, volume: 1_000_000, averageVolume: 500_000, timestamp: 1 }])
    const fetchMock = vi.fn().mockResolvedValue(resp(body))
    vi.stubGlobal('fetch', fetchMock)

    const q = await getQuote('AAA')
    // JSON/schema behaviour unchanged: parsed quote returned intact.
    expect(q?.symbol).toBe('AAA')
    expect(q?.price).toBe(3.21)

    const u = getFmpUsage()
    expect(u.families['/quote'].requests).toBe(1)
    expect(u.families['/quote'].successful).toBe(1)
    expect(u.families['/quote'].bytes).toBe(Buffer.byteLength(body, 'utf8'))
  })

  it('reads the body exactly once (no double consume)', async () => {
    const text = vi.fn().mockResolvedValue(JSON.stringify([]))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    await getTopGainers()
    expect(text).toHaveBeenCalledTimes(1)
  })

  it('records a non-2xx as failed and preserves the swallow-to-empty behaviour', async () => {
    const body = 'gateway timeout'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(body, false, 504)))

    // getTopGainers swallows the throw and returns [] exactly as before.
    const rows = await getTopGainers()
    expect(rows).toEqual([])

    const u = getFmpUsage()
    expect(u.families['/biggest-gainers'].requests).toBe(1)
    expect(u.families['/biggest-gainers'].failed).toBe(1)
    expect(u.families['/biggest-gainers'].successful).toBe(0)
    // Even an error body consumes bandwidth — counted.
    expect(u.families['/biggest-gainers'].bytes).toBe(Buffer.byteLength(body, 'utf8'))
  })

  it('records invalid JSON on a 200 as failed and returns null (behaviour unchanged)', async () => {
    const body = 'not json {['
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(body, true, 200)))

    const q = await getQuote('AAA')
    expect(q).toBeNull()

    const u = getFmpUsage()
    expect(u.families['/quote'].failed).toBe(1)
    expect(u.families['/quote'].bytes).toBe(Buffer.byteLength(body, 'utf8'))
  })
})

// ── SECURITY: no apikey ever recorded or emitted ─────────────────────────────
describe('fmp-telemetry secret-leak proof', () => {
  it('sends the key on the wire but never stores or emits it', async () => {
    const body = JSON.stringify([{ symbol: 'AAA', price: 1, previousClose: 1 }])
    const fetchMock = vi.fn().mockResolvedValue(resp(body))
    vi.stubGlobal('fetch', fetchMock)

    await getQuote('AAA')

    // The key IS still sent to FMP (behaviour unchanged) …
    const calledUrl = String(fetchMock.mock.calls[0][0])
    expect(calledUrl).toContain(`apikey=${SECRET}`)

    // … but appears NOWHERE in telemetry state or any emitted line.
    const snapshot = getFmpUsage()
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('apikey')
    expect(Object.keys(snapshot.families)).toEqual(['/quote'])

    for (const line of formatFmpUsageLines(snapshot)) {
      expect(line).not.toContain(SECRET)
      expect(line).not.toContain('apikey')
    }
  })
})
