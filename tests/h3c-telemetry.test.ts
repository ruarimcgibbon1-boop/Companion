/**
 * H3C — leader telemetry joins + H3A completeness reader tolerance (additive v1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { emitFunnel, assessFunnelCompleteness, __resetFunnelCountersForTest, type SweepContext } from '../src/lib/telemetry/funnel'

describe('H3C leader telemetry', () => {
  let dir: string
  const ctx: SweepContext = { sweepId: 'sw-9', producerHead: 'h' }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'h3ctel-')); process.env.COMPANION_FUNNEL_DIR = dir; __resetFunnelCountersForTest() })
  afterEach(() => { delete process.env.COMPANION_FUNNEL_DIR; rmSync(dir, { recursive: true, force: true }) })

  it('leader_state_transition carries stable joins (sweepId + symbol + leaderEpisodeId)', () => {
    emitFunnel(ctx, 'leader_state_transition', { symbol: 'MEDS', leaderEpisodeId: 'led-MEDS-1', priorState: 'LEADER_CANDIDATE', newState: 'LEADER_CONFIRMED', transitionReason: 'confirmed', ruleVersion: 'h3c-provisional-1' })
    const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim())
    expect(rec.eventType).toBe('leader_state_transition')
    expect(rec.sweepId).toBe('sw-9'); expect(rec.symbol).toBe('MEDS'); expect(rec.leaderEpisodeId).toBe('led-MEDS-1')
    expect(rec.ruleVersion).toBe('h3c-provisional-1')       // provisional rule stamped
  })

  it('H3A completeness readers ignore all leader_state_* events (v1 additive)', () => {
    const events = [
      { eventType: 'sweep_started', schemaVersion: 1 },
      { eventType: 'leader_state_recovered', schemaVersion: 1, recordCount: 3 },
      { eventType: 'leader_state_transition', schemaVersion: 1, symbol: 'A' },
      { eventType: 'leader_role_changed', schemaVersion: 1, newRole: 'CORE' },
      { eventType: 'leader_state_observed', schemaVersion: 1, role: 'CORE' },
      { eventType: 'leader_state_persisted', schemaVersion: 1, ok: true },
      { eventType: 'session_observability_summary', schemaVersion: 1, cleanClose: true, droppedTotal: 0, degradedEver: false },
    ]
    expect(() => assessFunnelCompleteness(events)).not.toThrow()
    expect(assessFunnelCompleteness(events)).toBe('COMPLETE')
  })
})
