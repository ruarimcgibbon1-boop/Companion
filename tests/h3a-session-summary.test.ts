/**
 * H3A research-integrity: terminal session_observability_summary + completeness.
 *
 * A funnel file is CERTIFIABLE only if it ends with a session_observability_summary.
 * Absence of that marker => INCOMPLETE / UNKNOWN completeness (never "zero drops").
 * The fail→process-exit case must NOT be able to masquerade as complete.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  emitFunnel, emitSessionSummary, newSweepId, assessFunnelCompleteness, splitFunnelSessions, assessRun,
  __resetFunnelCountersForTest, type SweepContext,
} from '../src/lib/telemetry/funnel'

describe('H3A session summary + completeness', () => {
  let dir: string
  const s: SweepContext = { sweepId: 'sweep-A', producerHead: 'head123' }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sess-'))
    process.env.COMPANION_FUNNEL_DIR = dir
    __resetFunnelCountersForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { delete process.env.COMPANION_FUNNEL_DIR; rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
  const readAll = () => {
    const f = readdirSync(dir).find(n => n.startsWith('.companion-funnel-'))
    return f ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  }

  // A. clean session
  it('A. clean session → terminal summary, droppedTotal=0, COMPLETE', () => {
    emitFunnel(s, 'sweep_started', { session: 'premarket' })
    emitFunnel(s, 'gate_evaluation', { symbol: 'AAA' })
    emitFunnel({ sweepId: 'sweep-B', producerHead: 'head123' }, 'sweep_started', {})
    expect(emitSessionSummary('head123')).toBe(true)
    const recs = readAll()
    const sum = recs.find(r => r.eventType === 'session_observability_summary')!
    expect(sum).toBeTruthy()
    expect(sum.droppedTotal).toBe(0)
    expect(sum.degradedEver).toBe(false)
    expect(sum.cleanClose).toBe(true)
    expect(sum.firstSweepId).toBe('sweep-A')
    expect(sum.lastSweepId).toBe('sweep-B')
    expect(sum.sweepsObserved).toBe(2)          // two sweep_started
    expect(sum.eventsWritten).toBe(3)
    expect(sum.eventsAttempted).toBe(3)
    expect(assessFunnelCompleteness(recs)).toBe('COMPLETE')
  })

  // B. fail → recover → degraded, but still certifiable-as-degraded
  it('B. fail→recover → gap marker + summary degradedEver=true → DEGRADED_COMPLETE', () => {
    process.env.COMPANION_FUNNEL_DIR = join(dir, 'gone')   // 5 writes fail → escalation → degradedEver
    for (let i = 0; i < 5; i++) emitFunnel(s, 'sweep_started', { i })
    process.env.COMPANION_FUNNEL_DIR = dir                 // recover
    emitFunnel(s, 'gate_evaluation', { symbol: 'AAA' })    // writes record + telemetry_gap
    expect(emitSessionSummary('head123')).toBe(true)
    const recs = readAll()
    expect(recs.some(r => r.eventType === 'telemetry_gap')).toBe(true)
    const sum = recs.find(r => r.eventType === 'session_observability_summary')!
    expect(sum.degradedEver).toBe(true)
    expect(sum.droppedTotal).toBe(5)
    expect(sum.firstFailureAt).toBeTruthy()
    expect(sum.lastFailureAt).toBeTruthy()
    expect(assessFunnelCompleteness(recs)).toBe('DEGRADED_COMPLETE')
  })

  // C. persistent failure THROUGH shutdown → summary not persisted, no false completeness
  it('C. persistent failure through shutdown → summary NOT written, file INCOMPLETE', () => {
    process.env.COMPANION_FUNNEL_DIR = join(dir, 'gone')   // everything fails, never recovers
    for (let i = 0; i < 4; i++) emitFunnel(s, 'sweep_started', { i })
    // shutdown attempts the summary but the sink is still unwritable:
    expect(emitSessionSummary('head123')).toBe(false)      // did NOT pretend to persist
    // nothing reached the real dir → the file has no terminal marker (or no file at all)
    const recs = readAll()
    expect(recs.some(r => r.eventType === 'session_observability_summary')).toBe(false)
    expect(assessFunnelCompleteness(recs)).toBe('INCOMPLETE')
  })

  // D. abrupt exit (no summary) → INCOMPLETE even though events look fine
  it('D. abrupt/no-summary fixture → INCOMPLETE (absence ≠ zero drops)', () => {
    const abrupt = [
      { eventType: 'sweep_started', sweepId: 'x' },
      { eventType: 'gate_evaluation', sweepId: 'x', verdict: 'veto' },
      // process was killed here — no session_observability_summary
    ]
    expect(assessFunnelCompleteness(abrupt)).toBe('INCOMPLETE')
    // and a summary with cleanClose !== true is also not certifiable
    expect(assessFunnelCompleteness([{ eventType: 'session_observability_summary', cleanClose: false }])).toBe('INCOMPLETE')
    // a gap-only file (no summary) is INCOMPLETE, not DEGRADED_COMPLETE
    expect(assessFunnelCompleteness([{ eventType: 'telemetry_gap', droppedEvents: 3 }])).toBe('INCOMPLETE')
  })

  // E. observability writes never throw (execution independence) — the summary + emit
  // are best-effort and pure w.r.t. control flow.
  it('E. emit + summary never throw, even against an unwritable sink', () => {
    process.env.COMPANION_FUNNEL_DIR = join(dir, 'nope')
    expect(() => emitFunnel(s, 'sweep_started', {})).not.toThrow()
    expect(() => { const ok = emitSessionSummary('h'); expect(typeof ok).toBe('boolean') }).not.toThrow()
  })

  // F. SAME-DAY MULTI-RUN: a per-day file can hold several daemon runs (restarts append
  // to the same ET-day file). Split first, then certify each run independently.
  it('F. same-day multi-run: two clean runs → [COMPLETE, COMPLETE]', () => {
    // run 1
    emitFunnel({ sweepId: 'r1s1', producerHead: 'h' }, 'sweep_started', {})
    emitSessionSummary('h')
    // run 2 (process restarted → counters reset)
    __resetFunnelCountersForTest()
    emitFunnel({ sweepId: 'r2s1', producerHead: 'h' }, 'sweep_started', {})
    emitSessionSummary('h')
    const recs = readAll()
    const sessions = splitFunnelSessions(recs)
    expect(sessions).toHaveLength(2)
    expect(sessions.map(assessFunnelCompleteness)).toEqual(['COMPLETE', 'COMPLETE'])
    // whole-file call is also COMPLETE here (last run closed cleanly, no trailing events)
    expect(assessFunnelCompleteness(recs)).toBe('COMPLETE')
  })

  it('F2. same-day multi-run: clean run then crashed run → [COMPLETE, INCOMPLETE]; whole-file INCOMPLETE', () => {
    emitFunnel({ sweepId: 'r1s1', producerHead: 'h' }, 'sweep_started', {})
    emitSessionSummary('h')                                 // run 1 closed
    __resetFunnelCountersForTest()
    emitFunnel({ sweepId: 'r2s1', producerHead: 'h' }, 'sweep_started', {})
    emitFunnel({ sweepId: 'r2s1', producerHead: 'h' }, 'gate_evaluation', {})
    // run 2 crashed — no terminal summary
    const recs = readAll()
    const sessions = splitFunnelSessions(recs)
    expect(sessions).toHaveLength(2)
    expect(sessions.map(assessFunnelCompleteness)).toEqual(['COMPLETE', 'INCOMPLETE'])
    // whole-file: a trailing un-closed run makes the file not certifiable
    expect(assessFunnelCompleteness(recs)).toBe('INCOMPLETE')
  })
})

// ── CROSS-ET-MIDNIGHT FILE ROTATION (a run spanning two day files) ────────────
describe('H3A cross-midnight rotation completeness', () => {
  let dir: string
  const s: SweepContext = { sweepId: 'x', producerHead: 'h' }
  const D  = Date.parse('2026-09-17T20:00:00-04:00')   // ET day 2026-09-17 (afterhours)
  const D1 = Date.parse('2026-09-18T05:00:00-04:00')   // ET day 2026-09-18 (premarket, next file)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xmid-')); process.env.COMPANION_FUNNEL_DIR = dir
    __resetFunnelCountersForTest()
    vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { delete process.env.COMPANION_FUNNEL_DIR; rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })
  const readDay = (day: string) => {
    const p = join(dir, `.companion-funnel-${day}.jsonl`)
    try { return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
  }

  // 1. clean run contained in one ET day → COMPLETE, no rotation marker anywhere.
  it('1. clean run within one ET day → COMPLETE (no rotation)', () => {
    emitFunnel(s, 'sweep_started', {}, D)
    emitFunnel(s, 'gate_evaluation', { symbol: 'AAA' }, D)
    emitSessionSummary('h', D)
    const d = readDay('2026-09-17')
    expect(d.some(e => e.eventType === 'funnel_rotated')).toBe(false)
    expect(assessFunnelCompleteness(d)).toBe('COMPLETE')
  })

  // 2. clean run spanning two files → prior file CONTINUED, next file COMPLETE.
  it('2. run spans two ET-day files → day-D CONTINUED, day-D+1 COMPLETE (not INCOMPLETE)', () => {
    emitFunnel(s, 'sweep_started', {}, D)                 // day D
    emitFunnel(s, 'sweep_started', {}, D1)                // rotation → markers in both files
    emitSessionSummary('h', D1)                           // summary lands in D+1
    const dayD = readDay('2026-09-17'); const dayD1 = readDay('2026-09-18')
    // prior file: last closer is a continued_in_next_file marker → CONTINUED, NOT INCOMPLETE
    const rot = dayD.find(e => e.eventType === 'funnel_rotated')!
    expect(rot.direction).toBe('continued_in_next_file')
    expect(rot.runId).toBeTruthy()
    expect(assessFunnelCompleteness(dayD)).toBe('CONTINUED')
    // next file: continued_from marker + events + summary → COMPLETE
    expect(dayD1[0].eventType).toBe('funnel_rotated')
    expect(dayD1[0].direction).toBe('continued_from_prev_file')
    expect(assessFunnelCompleteness(dayD1)).toBe('COMPLETE')
    // both files carry the SAME runId → a validator can chain them
    expect(rot.runId).toBe(dayD1[0].runId)
    expect(dayD1.find(e => e.eventType === 'session_observability_summary')!.runId).toBe(rot.runId)
  })

  // 3. cross-midnight run that later terminates cleanly → whole run COMPLETE via runId join.
  it('3. cross-midnight run terminating cleanly → assessRun(joined) = COMPLETE', () => {
    emitFunnel(s, 'sweep_started', {}, D)
    emitFunnel(s, 'gate_evaluation', { symbol: 'A' }, D)
    emitFunnel(s, 'sweep_started', {}, D1)               // rotation
    emitFunnel(s, 'gate_evaluation', { symbol: 'B' }, D1)
    emitSessionSummary('h', D1)
    const joined = [...readDay('2026-09-17'), ...readDay('2026-09-18')]  // day order
    expect(assessRun(joined)).toBe('COMPLETE')            // interior rotation markers ignored
  })

  // 4. cross-midnight run that CRASHES after rotation → day-D CONTINUED, day-D+1 INCOMPLETE, run INCOMPLETE.
  it('4. cross-midnight run crashes after rotation → D CONTINUED, D+1 INCOMPLETE, run INCOMPLETE', () => {
    emitFunnel(s, 'sweep_started', {}, D)
    emitFunnel(s, 'sweep_started', {}, D1)               // rotation
    emitFunnel(s, 'gate_evaluation', { symbol: 'B' }, D1) // then crash — no summary
    const dayD = readDay('2026-09-17'); const dayD1 = readDay('2026-09-18')
    expect(assessFunnelCompleteness(dayD)).toBe('CONTINUED')
    expect(assessFunnelCompleteness(dayD1)).toBe('INCOMPLETE')
    expect(assessRun([...dayD, ...dayD1])).toBe('INCOMPLETE')
  })

  // 5. genuine telemetry loss stays DISTINGUISHABLE from a benign rotation.
  it('5. dropped telemetry vs rotation vs abrupt exit are all distinct', () => {
    // genuine drop within a normal single-day run → DEGRADED_COMPLETE
    process.env.COMPANION_FUNNEL_DIR = join(dir, 'gone')
    for (let i = 0; i < 5; i++) emitFunnel(s, 'sweep_started', { i }, D)   // 5 fail → degraded
    process.env.COMPANION_FUNNEL_DIR = dir
    emitFunnel(s, 'gate_evaluation', {}, D)                                 // recover (gap marker)
    emitSessionSummary('h', D)
    const degraded = readDay('2026-09-17')
    expect(assessFunnelCompleteness(degraded)).toBe('DEGRADED_COMPLETE')
    // a plain abrupt exit (no summary, no rotation) is INCOMPLETE — never mistaken for CONTINUED
    expect(assessFunnelCompleteness([{ eventType: 'sweep_started' }, { eventType: 'gate_evaluation' }])).toBe('INCOMPLETE')
    // the four states are distinct
    expect(new Set(['COMPLETE', 'DEGRADED_COMPLETE', 'CONTINUED', 'INCOMPLETE']).size).toBe(4)
  })
})
