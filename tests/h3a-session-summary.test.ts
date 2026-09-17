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
  emitFunnel, emitSessionSummary, newSweepId, assessFunnelCompleteness,
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
})
