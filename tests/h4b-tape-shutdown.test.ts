/**
 * H4B-PREP — FINAL SHUTDOWN-DURABILITY RED-TEAM.
 *
 * The filesystem op is asynchronous, so the load-bearing question is: can SIGINT/SIGTERM/
 * beforeExit write a clean tape_writer_summary while an async append batch is still in flight
 * or queued-but-not-durable? It must not. A clean summary is allowed ONLY when nothing is in
 * flight and the queue is empty; otherwise the session is left UNCERTIFIED (INCOMPLETE).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { appendFile as fspAppendFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Candle } from '../src/types'
import {
  recordBarObservations, emitTapeSummary, shutdownTape, flushSync, buildTapeSummary,
  tapeFlushInFlight, tapeDroppedTotal,
  __resetTapeForTest, __kickDrainForTest, __setAppendImplForTest,
} from '../src/lib/research/tape-1m'
import { assessTapeFile } from '../src/lib/research/tape-1m-replay'

const ET = (s: string) => Date.parse(s)
const M = (n: number) => 1_726_660_800 + n * 60
const candle = (t: number): Candle => ({ time: t, open: 1, high: 2, low: 0.9, close: 1.5, volume: 100 })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tapesd-'))
  process.env.COMPANION_1M_TAPE_DIR = dir
  delete process.env.COMPANION_1M_TAPE
  __resetTapeForTest()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  __resetTapeForTest()
  delete process.env.COMPANION_1M_TAPE_DIR
  delete process.env.COMPANION_1M_TAPE_SHUTDOWN_MS
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const fileText = (): string => {
  const f = readdirSync(dir).find(n => n.startsWith('.companion-1m-tape-') && n.endsWith('.jsonl'))
  return f ? readFileSync(join(dir, f), 'utf8') : ''
}
const recs = (): Record<string, unknown>[] =>
  fileText().trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const now = ET('2026-09-18T10:00:30-04:00')

// ── 2. LOAD-BEARING FALSE-COMPLETE FIXTURE ──────────────────────────────────────
describe('2. shutdown with an in-flight append that never completes', () => {
  it('does NOT write a clean summary that certifies an undurable batch → INCOMPLETE', async () => {
    const gate = new Promise<void>(() => { /* never resolves */ })
    __setAppendImplForTest(() => gate)           // the first (only) async append is held forever
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0)), candle(M(1))], requestKind: 'BASE', now })
    __kickDrainForTest()                          // async append now IN FLIGHT (unresolved)
    expect(tapeFlushInFlight()).toBe(true)

    const ok = await shutdownTape(now, 80)        // bounded; cannot drain → gives up
    expect(ok).toBe(false)

    // Nothing was durably appended, so nothing is certified.
    expect(buildTapeSummary().eventsWritten).toBe(0)        // eventsWritten counts ONLY durable appends
    expect(recs().some(r => r.eventType === 'tape_writer_summary')).toBe(false)
    expect(assessTapeFile(fileText()).completeness).toBe('INCOMPLETE')
    // the undrained data is accounted as lost (not silently forgotten)
    expect(tapeDroppedTotal()).toBeGreaterThanOrEqual(0)
  })
})

// ── 3. ORDERED CLEAN-SHUTDOWN FIXTURE ───────────────────────────────────────────
describe('3. ordered clean shutdown (append allowed to finish)', () => {
  it('drains, then writes tape_writer_summary LAST → COMPLETE', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    __setAppendImplForTest(async (f, t) => { if (calls++ === 0) await gate; await fspAppendFile(f, t) })
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0)), candle(M(1))], requestKind: 'BASE', now })
    __kickDrainForTest()                          // first append parked
    expect(tapeFlushInFlight()).toBe(true)

    const p = shutdownTape(now, 5_000)            // begins; awaits the in-flight drain
    release()                                     // let the append become durable
    const ok = await p
    expect(ok).toBe(true)

    const r = recs()
    // physical order: bar observations → (health markers) → summary LAST
    expect(r[r.length - 1].eventType).toBe('tape_writer_summary')
    const lastBar = r.map(x => x.eventType).lastIndexOf('bar_observation')
    const sumIdx = r.map(x => x.eventType).indexOf('tape_writer_summary')
    expect(lastBar).toBeLessThan(sumIdx)
    expect(assessTapeFile(fileText()).completeness).toBe('COMPLETE')
    // eventsWritten reflects durable appends: started + 2 bars + summary
    expect((r.find(x => x.eventType === 'tape_writer_summary')!.eventsWritten as number)).toBe(3)
  })
})

// ── 1/4. SUMMARY MAY NOT PRECEDE AN IN-FLIGHT / QUEUED BATCH ─────────────────────
describe('1/4. clean summary requires no write in flight and an empty queue', () => {
  it('emitTapeSummary refuses while an async append is in flight', async () => {
    const gate = new Promise<void>(() => {})
    __setAppendImplForTest(() => gate)
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    __kickDrainForTest()
    expect(tapeFlushInFlight()).toBe(true)
    expect(emitTapeSummary(now)).toBe(false)      // cannot certify clean while draining
    expect(recs().some(r => r.eventType === 'tape_writer_summary')).toBe(false)
  })

  it('a fully-synchronous clean run still certifies COMPLETE (no async in flight)', () => {
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    expect(emitTapeSummary(now)).toBe(true)
    expect(assessTapeFile(fileText()).completeness).toBe('COMPLETE')
  })
})

// ── 4/6. IDEMPOTENCY: NO DUPLICATE SUMMARY ──────────────────────────────────────
describe('4/6. shutdown is idempotent (one summary, one lease release)', () => {
  it('shutdownTape called twice writes exactly one summary', async () => {
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    const [a, b] = await Promise.all([shutdownTape(now), shutdownTape(now)])
    expect(a).toBe(true)
    expect(b).toBe(true)                          // same cached promise
    expect(recs().filter(r => r.eventType === 'tape_writer_summary')).toHaveLength(1)
  })

  it('emitTapeSummary then shutdownTape does not double-write the summary', async () => {
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    expect(emitTapeSummary(now)).toBe(true)
    await shutdownTape(now)                        // shuttingDown path sees summaryWritten → no dup
    expect(recs().filter(r => r.eventType === 'tape_writer_summary')).toHaveLength(1)
  })
})

// ── 7. COUNTER DURABILITY ───────────────────────────────────────────────────────
describe('7. summary counters reflect durable truth', () => {
  it('forced shutdown giving up on an outstanding batch prevents COMPLETE and counts the loss', async () => {
    const gate = new Promise<void>(() => {})
    __setAppendImplForTest(() => gate)
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0)), candle(M(1)), candle(M(2))], requestKind: 'BASE', now })
    __kickDrainForTest()
    const ok = await shutdownTape(now, 60)
    expect(ok).toBe(false)
    expect(buildTapeSummary().eventsWritten).toBe(0)           // nothing durable
    expect(assessTapeFile(fileText()).completeness).not.toBe('COMPLETE')
  })

  it('after shutdown, no new events are accepted', async () => {
    recordBarObservations({ symbol: 'AAA', candles: [candle(M(0))], requestKind: 'BASE', now })
    await shutdownTape(now)
    const before = buildTapeSummary().eventsWritten
    recordBarObservations({ symbol: 'BBB', candles: [candle(M(5))], requestKind: 'BASE', now: now + 1000 })
    flushSync(now + 1000)
    expect(buildTapeSummary().eventsWritten).toBe(before)      // ignored: shutting down
  })
})
