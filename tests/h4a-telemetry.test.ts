/**
 * H4A — local-structure telemetry joins + H3A completeness-reader tolerance (additive, funnel v1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { emitFunnel, assessFunnelCompleteness, __resetFunnelCountersForTest, type SweepContext } from '../src/lib/telemetry/funnel'

describe('H4A local-structure telemetry', () => {
  let dir: string
  const ctx: SweepContext = { sweepId: 'sw-h4a', producerHead: 'h' }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'h4atel-')); process.env.COMPANION_FUNNEL_DIR = dir; __resetFunnelCountersForTest() })
  afterEach(() => { delete process.env.COMPANION_FUNNEL_DIR; rmSync(dir, { recursive: true, force: true }) })

  it('local_structure_observed carries the H3C join + config provenance, no bar arrays', () => {
    emitFunnel(ctx, 'local_structure_observed', {
      symbol: 'MEDS', leaderEpisodeId: 'led-MEDS-1', resetState: 'STABILIZING', dataQualityStatus: 'AVAILABLE',
      timeframe: '1m', globalOffHighPct: -31.2, impulsePct: 12.4, pullbackPct: 2.1, baseRangePct: 0.8,
      localExtensionPct: 0.1, reExpansionObserved: false, localFeatureConfigVersion: 'h4a-provisional-1', localFeatureConfigHash: 'abc12345',
    })
    const rec = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim())
    expect(rec.eventType).toBe('local_structure_observed')
    expect(rec.sweepId).toBe('sw-h4a'); expect(rec.symbol).toBe('MEDS'); expect(rec.leaderEpisodeId).toBe('led-MEDS-1')
    expect(rec.timeframe).toBe('1m')                        // timeframe provenance is explicit
    expect(rec.localFeatureConfigHash).toBe('abc12345')     // effective config pinned to the observation
    expect(rec.bars).toBeUndefined(); expect(rec.candles).toBeUndefined()   // never a bar array
  })

  it('H3A completeness readers ignore all local_structure_* events (v1 additive)', () => {
    const events = [
      { eventType: 'sweep_started', schemaVersion: 1 },
      { eventType: 'local_structure_observed', schemaVersion: 1, symbol: 'A', resetState: 'DEEP' },
      { eventType: 'local_structure_changed', schemaVersion: 1, symbol: 'A', resetState: 'STABILIZING' },
      { eventType: 'leader_state_observed', schemaVersion: 1, role: 'CORE' },
      { eventType: 'session_observability_summary', schemaVersion: 1, cleanClose: true, droppedTotal: 0, degradedEver: false },
    ]
    expect(() => assessFunnelCompleteness(events)).not.toThrow()
    expect(assessFunnelCompleteness(events)).toBe('COMPLETE')
  })
})
