/**
 * H4B-PREP — FINAL PRE-PUSH WRITER-INTEGRITY RED-TEAM.
 *
 * 1. periodic filesystem writes must not block the event loop (async serialized writer);
 * 2. malformed/torn records must participate in completeness certification;
 * 3. single-writer semantics across processes (O_EXCL lease);
 * 4. dev/HMR lifecycle: one writer per process (globalThis singleton);
 * 5. dedup equality is collision-safe (canonical OHLCV, not a 32-bit hash).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { appendFile as fspAppendFile } from 'fs/promises'
import { tmpdir, hostname } from 'os'
import { join } from 'path'
import type { Candle } from '../src/types'
import {
  recordBarObservations, emitTapeSummary, flushSync,
  barFingerprint, writerLockFile, tapeFlushInFlight, tapeDisabledByLock, tapeAsyncWriteFailures,
  __resetTapeForTest, __kickDrainForTest, __drainTapeForTest, __setAppendImplForTest,
} from '../src/lib/research/tape-1m'
import {
  parseTape, assessTapeFile, assessTapeCompleteness, barsAsKnownAt, type TapeEvent,
} from '../src/lib/research/tape-1m-replay'

const ET = (s: string) => Date.parse(s)
const M = (n: number) => 1_726_660_800 + n * 60
const candle = (t: number, o = 1, h = 2, l = 0.9, c = 1.5, v = 100): Candle => ({ time: t, open: o, high: h, low: l, close: c, volume: v })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tapehard-'))
  process.env.COMPANION_1M_TAPE_DIR = dir
  delete process.env.COMPANION_1M_TAPE
  __resetTapeForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  __resetTapeForTest()
  delete process.env.COMPANION_1M_TAPE_DIR
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const readAll = (): Record<string, unknown>[] => {
  const f = readdirSync(dir).find(n => n.startsWith('.companion-1m-tape-') && n.endsWith('.jsonl'))
  return f ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
}
const bars = (recs: Record<string, unknown>[]) => recs.filter(r => r.eventType === 'bar_observation')

// ── 1. WRITER RESOURCE ISOLATION (async, non-blocking) ──────────────────────────
describe('1. periodic flush is async and never blocks the event loop', () => {
  it('the request path performs NO synchronous disk write (bars buffered until drained)', async () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    expect(readAll()).toHaveLength(0)          // nothing on disk yet — enqueue only
    await __drainTapeForTest()
    expect(bars(readAll()).length).toBe(1)     // async drain wrote it
  })

  it('a stalled disk append does NOT block the event loop or the enqueue path', async () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    // Inject a slow/stalled async append (resolves only when we release the gate).
    __setAppendImplForTest(async (file, text) => { await gate; await fspAppendFile(file, text) })
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    __kickDrainForTest()                        // drain starts, then parks on the stalled append
    expect(tapeFlushInFlight()).toBe(true)

    // While the append is stalled, the event loop stays responsive...
    const t0 = process.hrtime.bigint()
    await new Promise<void>(r => setImmediate(r))
    const loopMs = Number(process.hrtime.bigint() - t0) / 1e6
    expect(loopMs).toBeLessThan(100)

    // ...and a concurrent BASE-request enqueue returns immediately (no disk on the hot path).
    const e0 = process.hrtime.bigint()
    recordBarObservations({ symbol: 'BBB', candles: [candle(M(1))], requestKind: 'BASE', now })
    const enqMs = Number(process.hrtime.bigint() - e0) / 1e6
    expect(enqMs).toBeLessThan(50)

    release()
    await __drainTapeForTest()
    expect(bars(readAll()).length).toBeGreaterThanOrEqual(1)
  })

  it('async write failure is tracked and never throws into the caller', async () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    __setAppendImplForTest(async () => { throw new Error('EIO simulated') })
    expect(() => recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })).not.toThrow()
    await __drainTapeForTest()
    expect(tapeAsyncWriteFailures()).toBeGreaterThan(0)
  })
})

// ── 2. TORN / MALFORMED LINE COMPLETENESS ───────────────────────────────────────
describe('2. malformed/torn lines participate in certification', () => {
  const line = (o: object) => JSON.stringify(o)
  const started = line({ eventType: 'tape_writer_started', runId: 'r' })
  const bar = (n: number) => line({ eventType: 'bar_observation', symbol: 'AAA', barTimeSec: M(n), observedAtMs: n, open: 1, high: 2, low: 1, close: 1.5, volume: 1 })
  const summary = (extra: object = {}) => line({ eventType: 'tape_writer_summary', cleanClose: true, eventsDropped: 0, writeFailures: 0, queueOverflows: 0, asyncWriteFailures: 0, degradedEver: false, ...extra })
  const TORN = '{"eventType":"bar_observation","symbol":"AA'  // partial final append

  it('parseTape reports integrity metadata (count + trailing)', () => {
    const { events, malformed, malformedTrailing } = parseTape([started, bar(0), TORN].join('\n'))
    expect(events).toHaveLength(2)
    expect(malformed).toBe(1)
    expect(malformedTrailing).toBe(true)
  })

  it('A. malformed trailing AFTER a clean summary → INCOMPLETE', () => {
    const text = [started, bar(0), summary(), TORN].join('\n')
    expect(assessTapeFile(text).completeness).toBe('INCOMPLETE')
  })

  it('B. malformed line BETWEEN two valid events (run later closes) → DEGRADED_COMPLETE', () => {
    const text = [started, TORN, bar(0), summary()].join('\n')
    expect(assessTapeFile(text).completeness).toBe('DEGRADED_COMPLETE')
  })

  it('C. malformed line inside an otherwise closed run → DEGRADED_COMPLETE', () => {
    const text = [started, bar(0), TORN, bar(1), summary()].join('\n')
    expect(assessTapeFile(text).completeness).toBe('DEGRADED_COMPLETE')
  })

  it('D. clean file, zero malformed → COMPLETE', () => {
    const text = [started, bar(0), summary()].join('\n')
    expect(assessTapeFile(text).completeness).toBe('COMPLETE')
  })

  it('E. partial final line from a crash (no summary) → INCOMPLETE', () => {
    const text = [started, bar(0), TORN].join('\n')
    expect(assessTapeFile(text).completeness).toBe('INCOMPLETE')
  })

  it('CRITICAL: clean Run A + summary, then torn Run B with no valid record → INCOMPLETE (not COMPLETE)', () => {
    // Run A closed cleanly; Run B began afterward, its first append torn, process died.
    const text = [started, bar(0), summary(), TORN].join('\n')
    // event-only assessment (blind to the torn bytes) would wrongly say COMPLETE:
    expect(assessTapeCompleteness(parseTape(text).events)).toBe('COMPLETE')
    // integrity-aware, file-level assessment is conservative and correct:
    expect(assessTapeFile(text).completeness).toBe('INCOMPLETE')
  })
})

// ── 3. SINGLE-WRITER LEASE (cross-process) ──────────────────────────────────────
describe('3. single-writer O_EXCL lease', () => {
  it('a second live writer disables its own tape and never writes the canonical file', () => {
    // Pre-plant a lease owned by a LIVE pid on this host (our own pid is alive).
    writeFileSync(writerLockFile(), JSON.stringify({ runId: 'other', pid: process.pid, host: hostname(), startedAt: 'x' }))
    const now = ET('2026-09-18T10:00:30-04:00')
    expect(() => recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })).not.toThrow()
    flushSync(now)
    expect(tapeDisabledByLock()).toBe(true)
    // No canonical tape file was created by the disabled writer.
    expect(readdirSync(dir).some(n => n.startsWith('.companion-1m-tape-') && n.endsWith('.jsonl'))).toBe(false)
  })

  it('a STALE lease (dead pid, same host) is taken over and the tape writes normally', () => {
    writeFileSync(writerLockFile(), JSON.stringify({ runId: 'dead', pid: 2147483647, host: hostname(), startedAt: 'x' }))
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    flushSync(now)
    expect(tapeDisabledByLock()).toBe(false)
    expect(bars(readAll()).length).toBe(1)
  })

  it('emitTapeSummary releases the lease so a subsequent run can acquire it', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    emitTapeSummary(now)
    expect(readdirSync(dir).some(n => n === '.companion-1m-tape.lock')).toBe(false)  // lease released
    // a fresh run (restart) acquires cleanly
    __resetTapeForTest()
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(1))], requestKind: 'BASE', now: now + 1000 })
    flushSync(now + 1000)
    expect(tapeDisabledByLock()).toBe(false)
  })
})

// ── 4. DEV / HMR LIFECYCLE (process singleton) ──────────────────────────────────
describe('4. writer state is a process singleton (HMR-safe)', () => {
  it('all writer state lives on one globalThis Symbol', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    const g = globalThis as unknown as Record<PropertyKey, unknown>
    const state = g[Symbol.for('companion.research.tape1m/v1')] as { runId: string | null }
    expect(state).toBeTruthy()
    expect(typeof state.runId).toBe('string')
  })

  it('repeated sweeps in one process keep ONE run and do not accumulate signal handlers', () => {
    const before = process.listenerCount('SIGINT')
    const now = ET('2026-09-18T10:00:30-04:00')
    const g = globalThis as unknown as Record<PropertyKey, unknown>
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    const runId1 = (g[Symbol.for('companion.research.tape1m/v1')] as { runId: string }).runId
    for (let i = 1; i < 25; i++) recordBarObservations({ symbol: 'AAA', candles: [candle(M(i))], requestKind: 'BASE', now: now + i * 1000 })
    const runId2 = (g[Symbol.for('companion.research.tape1m/v1')] as { runId: string }).runId
    expect(runId2).toBe(runId1)                                  // one run, not many
    expect(process.listenerCount('SIGINT')).toBe(before + 1)     // exactly one hook, not 25
  })
})

// ── 5. DEDUP FINGERPRINT SAFETY (collision-safe equality) ───────────────────────
describe('5. dedup equality is collision-safe (canonical OHLCV, not a 32-bit hash)', () => {
  it('a real FNV-1a fingerprint collision does NOT suppress a genuinely different bar', () => {
    // Two DIFFERENT volumes that genuinely COLLIDE under barFingerprint for the same o|h|l|c
    // (found by brute force; hard-coded so the test is instant and deterministic).
    const v1 = 578057, v2 = 1486500
    expect(barFingerprint(1, 2, 0.9, 1.5, v1)).toBe(barFingerprint(1, 2, 0.9, 1.5, v2))  // same 32-bit hash
    expect(v1).not.toBe(v2)                                               // different data

    // Both must be recorded (the second is a REVISION, never suppressed by the shared hash).
    const now = ET('2026-09-18T10:00:30-04:00')
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0), 1, 2, 0.9, 1.5, v1)], requestKind: 'BASE', now })
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0), 1, 2, 0.9, 1.5, v2)], requestKind: 'BASE', now: now + 60_000 })
    flushSync(now)
    const b = bars(readAll())
    expect(b).toHaveLength(2)
    expect(b.map(r => r.volume)).toEqual([v1, v2])
    expect(b.map(r => r.revisionSequence)).toEqual([0, 1])
    // and the causal reconstruction as-of the later time shows the revised (v2) value
    expect(barsAsKnownAt(readAll() as unknown as TapeEvent[], 'AAA', now + 120_000)[0].volume).toBe(v2)
  })

  it('a genuinely identical bar IS suppressed (equality still works)', () => {
    const now = ET('2026-09-18T10:00:30-04:00')
    for (let i = 0; i < 5; i++) recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now: now + i * 1000 })
    flushSync(now)
    expect(bars(readAll())).toHaveLength(1)
  })
})
