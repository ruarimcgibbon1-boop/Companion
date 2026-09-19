/**
 * H4B-PREP — canonical 1m research tape writer.
 *
 * Proves: dedup vs revision (STEP 3/14), closed/in-progress classification (STEP 4),
 * source provenance (STEP 10), honest populations (STEP 13), append-only isolation and
 * failure behaviour (STEP 6/15), and auditable completeness (STEP 7/8).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Candle } from '../src/types'
import {
  recordBarObservations, recordCandleSource, emitTapeSummary, flushSync,
  classifyBarStatus, barFingerprint, tapeDroppedTotal,
  __resetTapeForTest,
} from '../src/lib/research/tape-1m'
import { cache } from '../src/lib/cache'
import { assessTapeCompleteness, splitTapeSessions, barsAsKnownAt } from '../src/lib/research/tape-1m-replay'

const ET = (s: string) => Date.parse(s)
// minute-aligned unix-sec bar times
const M = (n: number) => 1_726_660_800 + n * 60

function candle(timeSec: number, o = 1, h = 2, l = 0.9, c = 1.5, v = 100): Candle {
  return { time: timeSec, open: o, high: h, low: l, close: c, volume: v }
}

describe('H4B tape writer', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tape-'))
    process.env.COMPANION_1M_TAPE_DIR = dir
    delete process.env.COMPANION_1M_TAPE
    __resetTapeForTest()
    cache.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    __resetTapeForTest()
    delete process.env.COMPANION_1M_TAPE_DIR
    delete process.env.COMPANION_1M_TAPE
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const readAll = (): Record<string, unknown>[] => {
    const f = readdirSync(dir).find(n => n.startsWith('.companion-1m-tape-'))
    return f ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  }
  const bars = (recs: Record<string, unknown>[]) => recs.filter(r => r.eventType === 'bar_observation')

  // ── STEP 14: dedup vs revision ────────────────────────────────────────────
  it('identical bar observed many times → written once, repeats suppressed', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    for (let i = 0; i < 20; i++) {
      recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now: now + i * 1000 })
    }
    flushSync(now)
    expect(emitTapeSummary(now)).toBe(true)
    const recs = readAll()
    expect(bars(recs)).toHaveLength(1)
    const sum = recs.find(r => r.eventType === 'tape_writer_summary')!
    expect(sum.identicalDuplicatesSuppressed).toBe(19)
    expect(sum.revisionsWritten).toBe(0)
  })

  it('same symbol+timestamp with changed OHLCV → revision preserved (append-only)', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0), 1, 2, 0.9, 1.5, 100)], requestKind: 'BASE', now })
    // provider revises the SAME minute
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0), 1, 3, 0.9, 2.7, 900)], requestKind: 'BASE', now: now + 120_000 })
    flushSync(now)
    const recs = readAll()
    const b = bars(recs)
    expect(b).toHaveLength(2)                       // BOTH preserved
    expect(b.map(r => r.revisionSequence)).toEqual([0, 1])
    expect(b[0].barFingerprint).not.toBe(b[1].barFingerprint)
    // append-only: the earlier value is still on disk, unchanged
    expect(b[0].high).toBe(2)
    expect(b[1].high).toBe(3)
  })

  it('same timestamp, different symbol → separate observations', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    recordBarObservations({ symbol: 'BBB', candles: [candle(M(0))], requestKind: 'BASE', now })
    flushSync(now)
    const b = bars(readAll())
    expect(b).toHaveLength(2)
    expect(new Set(b.map(r => r.symbol))).toEqual(new Set(['AAA', 'BBB']))
  })

  it('server restart re-observes the same bar WITHOUT destructive overwrite', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    emitTapeSummary(now)
    // restart: in-memory dedup resets; the same day file is appended to
    __resetTapeForTest()
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now: now + 1000 })
    emitTapeSummary(now + 1000)
    const recs = readAll()
    expect(bars(recs)).toHaveLength(2)             // both runs' observations retained
    const sessions = splitTapeSessions(recs as never)
    expect(sessions).toHaveLength(2)
    expect(sessions.map(assessTapeCompleteness as never)).toEqual(['COMPLETE', 'COMPLETE'])
  })

  // ── STEP 4: closed vs in-progress ──────────────────────────────────────────
  it('classifyBarStatus: older-than-newest = CLOSED; newest before close+margin = IN_PROGRESS', () => {
    const t = M(5)
    const maxT = M(5)
    // ref within the bar's own minute → still forming
    expect(classifyBarStatus(t, maxT, (t + 10) * 1000)).toBe('IN_PROGRESS')
    // ref well past the minute end + margin → closed
    expect(classifyBarStatus(t, maxT, (t + 60 + 30) * 1000)).toBe('CLOSED')
    // an earlier bar than the newest is always closed
    expect(classifyBarStatus(M(4), maxT, (t + 5) * 1000)).toBe('CLOSED')
    // ref before the bar even starts → undecidable
    expect(classifyBarStatus(t, maxT, (t - 5) * 1000)).toBe('UNKNOWN')
  })

  it('barStatus uses receivedAt, honouring publication delay (not wall clock)', () => {
    // PUBLICATION-DELAY SCENARIO: at 10:07:10 the provider's newest published bar is still the
    // 10:06 minute (it hasn't emitted 10:07 yet). By WALL CLOCK (10:07:35) the 10:06 minute ended
    // >15s ago → would look CLOSED. But the honest reference is receivedAt (10:07:10), which is
    // inside the close+margin window, so the newest bar is (correctly) still IN_PROGRESS — it may
    // yet be revised. This is exactly why we never call a bar CLOSED by wall clock alone.
    const fetchedAt = ET('2026-09-18T10:07:10-04:00')
    const now = ET('2026-09-18T10:07:35-04:00')   // 25s after fetch (within provenance TTL)
    recordCandleSource('AAA', 'yahoo', fetchedAt)
    const barMin = Math.floor(ET('2026-09-18T10:06:00-04:00') / 1000)
    const prevMin = barMin - 60
    recordBarObservations({ symbol: 'AAA', candles: [candle(prevMin), candle(barMin)], requestKind: 'BASE', now })
    flushSync(now)
    const b = bars(readAll())
    const newest = b.find(r => r.barTimeSec === barMin)!
    const older = b.find(r => r.barTimeSec === prevMin)!
    expect(newest.statusBasis).toBe('receivedAt')
    expect(newest.barStatus).toBe('IN_PROGRESS')  // decided by receivedAt, NOT the 10:07:35 wall clock
    expect(older.barStatus).toBe('CLOSED')
  })

  // ── STEP 10: source provenance ─────────────────────────────────────────────
  it('records the winning provider + receivedAt when the sidecar is present; UNKNOWN otherwise', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordCandleSource('AAA', 'fmp', now)
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    recordBarObservations({ symbol: 'ZZZ', candles: [candle(M(0))], requestKind: 'BASE', now }) // no sidecar
    flushSync(now)
    const b = bars(readAll())
    const a = b.find(r => r.symbol === 'AAA')!
    const z = b.find(r => r.symbol === 'ZZZ')!
    expect(a.source).toBe('fmp')
    expect(a.receivedAt).toBe(new Date(now).toISOString())
    expect(z.source).toBe('UNKNOWN')            // never fabricate a provider
    expect(z.receivedAt).toBeNull()
  })

  // ── STEP 13: honest populations ────────────────────────────────────────────
  it('records requestKind honestly for BASE and LEADER_OBSERVATION', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    recordBarObservations({ symbol: 'LDR', candles: [candle(M(0))], requestKind: 'LEADER_OBSERVATION', now })
    flushSync(now)
    const b = bars(readAll())
    expect(b.find(r => r.symbol === 'AAA')!.requestKind).toBe('BASE')
    expect(b.find(r => r.symbol === 'LDR')!.requestKind).toBe('LEADER_OBSERVATION')
  })

  // ── STEP 15: failure / data-quality red-team ───────────────────────────────
  it('malformed price is recorded (never dropped) and flagged; OHLC nulled', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    const bad: Candle = { time: M(0), open: NaN, high: -1, low: 0, close: Number.POSITIVE_INFINITY, volume: NaN }
    recordBarObservations({ symbol: 'AAA', candles: [bad], requestKind: 'BASE', now })
    flushSync(now)
    const b = bars(readAll())
    expect(b).toHaveLength(1)
    expect(b[0].dataQuality).toBe('NON_FINITE_PRICE')
    expect(b[0].open).toBeNull()
    expect(b[0].volume).toBeNull()
  })

  it('missing volume is flagged and stored as null', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    const c: Candle = { time: M(0), open: 1, high: 2, low: 0.9, close: 1.5, volume: NaN }
    recordBarObservations({ symbol: 'AAA', candles: [c], requestKind: 'BASE', now })
    flushSync(now)
    const b = bars(readAll())
    expect(b[0].dataQuality).toBe('MISSING_VOLUME')
    expect(b[0].volume).toBeNull()
  })

  it('recordBarObservations NEVER throws, even against an unwritable sink', () => {
    process.env.COMPANION_1M_TAPE_DIR = join(dir, 'does', 'not', 'exist')
    expect(() => {
      recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now: Date.now() })
      flushSync()
      emitTapeSummary()
    }).not.toThrow()
  })

  it('queue overflow DROPS explicitly, marks degraded, and never blocks (STEP 6)', () => {
    process.env.COMPANION_1M_TAPE_MAX_QUEUE = '3'  // read dynamically → tiny bound
    __resetTapeForTest()
    const now = ET('2026-09-18T10:00:30-04:00')
    // 10 DISTINCT bar minutes in one call → 3 buffered, 7 must be dropped (never blocks/throws).
    const many: Candle[] = Array.from({ length: 40 }, (_, i) => candle(M(i)))
    expect(() => recordBarObservations({ symbol: 'AAA', candles: many, requestKind: 'BASE', now })).not.toThrow()
    flushSync(now)
    emitTapeSummary(now)
    // Overflow drops SOME bars explicitly, marks the writer degraded, and stays auditable.
    expect(tapeDroppedTotal()).toBeGreaterThan(0)
    const recs = readAll()
    expect(recs.some(r => r.eventType === 'tape_writer_degraded')).toBe(true)
    const sum = recs.find(r => r.eventType === 'tape_writer_summary')!
    expect(sum.degradedEver).toBe(true)
    expect((sum.queueOverflows as number)).toBeGreaterThan(0)
    // the session is DEGRADED_COMPLETE — never silently COMPLETE despite the loss
    expect(assessTapeCompleteness(recs as never)).toBe('DEGRADED_COMPLETE')
    delete process.env.COMPANION_1M_TAPE_MAX_QUEUE
  })

  it('master off-switch makes the tape a pure no-op', () => {
    process.env.COMPANION_1M_TAPE = '0'
    __resetTapeForTest()
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now: Date.now() })
    flushSync()
    expect(readAll()).toHaveLength(0)
  })

  // ── STEP 7/8: completeness + summary ───────────────────────────────────────
  it('clean run → tape_writer_started + summary → COMPLETE', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0)), candle(M(1))], requestKind: 'BASE', now })
    expect(emitTapeSummary(now)).toBe(true)
    const recs = readAll()
    expect(recs[0].eventType).toBe('tape_writer_started')
    const sum = recs.find(r => r.eventType === 'tape_writer_summary')!
    expect(sum.cleanClose).toBe(true)
    expect(sum.eventsWritten).toBe(3)   // tape_writer_started + 2 bar_observation lines
    expect(bars(recs)).toHaveLength(2)
    expect(sum.degradedEver).toBe(false)
    expect(assessTapeCompleteness(recs as never)).toBe('COMPLETE')
  })

  it('abrupt exit (no summary) → INCOMPLETE, never masquerades complete', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    flushSync(now)
    // process killed here — no emitTapeSummary
    const recs = readAll()
    expect(recs.some(r => r.eventType === 'tape_writer_summary')).toBe(false)
    expect(assessTapeCompleteness(recs as never)).toBe('INCOMPLETE')
  })

  it('a recovered write loss self-documents as tape_gap → DEGRADED_COMPLETE', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    // make writes fail
    process.env.COMPANION_1M_TAPE_DIR = join(dir, 'gone')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    flushSync(now)                          // fails → dropped, degraded
    process.env.COMPANION_1M_TAPE_DIR = dir // recover
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(1))], requestKind: 'BASE', now: now + 1000 })
    flushSync(now + 1000)                   // succeeds → writes tape_gap
    expect(emitTapeSummary(now + 2000)).toBe(true)
    const recs = readAll()
    expect(recs.some(r => r.eventType === 'tape_gap')).toBe(true)
    const sum = recs.find(r => r.eventType === 'tape_writer_summary')!
    expect(sum.degradedEver).toBe(true)
    expect((sum.eventsDropped as number)).toBeGreaterThanOrEqual(1)
    expect(assessTapeCompleteness(recs as never)).toBe('DEGRADED_COMPLETE')
  })

  // ── STEP 8: cross-ET-midnight rotation ─────────────────────────────────────
  it('cross-midnight run → prior day CONTINUED, next day COMPLETE (not a crash)', () => {
    const D  = ET('2026-09-18T23:59:30-04:00')  // ET day 2026-09-18
    const D1 = ET('2026-09-19T00:00:30-04:00')  // ET day 2026-09-19
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now: D })
    flushSync(D)
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(1))], requestKind: 'BASE', now: D1 })
    flushSync(D1)                               // rotation markers written into both files
    emitTapeSummary(D1)
    const readDay = (day: string) =>
      readFileSync(join(dir, `.companion-1m-tape-${day}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const dayD = readDay('2026-09-18')
    const dayD1 = readDay('2026-09-19')
    const rot = dayD.find((e: Record<string, unknown>) => e.eventType === 'tape_rotated')!
    expect(rot.direction).toBe('continued_in_next_file')
    expect(assessTapeCompleteness(dayD as never)).toBe('CONTINUED')
    expect(assessTapeCompleteness(dayD1 as never)).toBe('COMPLETE')
    expect(rot.runId).toBe(dayD1.find((e: Record<string, unknown>) => e.eventType === 'tape_rotated')!.runId)
  })

  // ── end-to-end: the tape round-trips to a causal reconstruction ────────────
  it('round-trip: written bars reconstruct via barsAsKnownAt', () => {
    const now = ET('2026-09-18T10:05:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0), 1, 2, 0.9, 1.5, 100), candle(M(1), 1.5, 2.5, 1.4, 2.2, 200)], requestKind: 'BASE', now })
    emitTapeSummary(now)
    const recs = readAll()
    const reconstructed = barsAsKnownAt(recs as never, 'AAA', now + 10_000)
    expect(reconstructed.map(b => b.time)).toEqual([M(0), M(1)])
    expect(reconstructed[1]).toMatchObject({ close: 2.2, volume: 200 })
  })

  it('barFingerprint is stable for identical OHLCV and differs on any change', () => {
    expect(barFingerprint(1, 2, 0.9, 1.5, 100)).toBe(barFingerprint(1, 2, 0.9, 1.5, 100))
    expect(barFingerprint(1, 2, 0.9, 1.5, 100)).not.toBe(barFingerprint(1, 2, 0.9, 1.6, 100))
    expect(barFingerprint(1, 2, 0.9, 1.5, 100)).not.toBe(barFingerprint(1, 2, 0.9, 1.5, 101))
  })
})
