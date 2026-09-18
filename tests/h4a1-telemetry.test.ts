/**
 * H4A.1 — observational leader telemetry (cohort + per-symbol data coverage) is additive to funnel v1:
 * carries the H3C episode + config joins, never a bar array, and is ignored by the completeness reader.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { emitFunnel, assessFunnelCompleteness, __resetFunnelCountersForTest, type SweepContext } from '../src/lib/telemetry/funnel'

describe('H4A.1 leader-observation telemetry', () => {
  let dir: string
  const ctx: SweepContext = { sweepId: 'sw-h4a1', producerHead: 'h' }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'h4a1tel-')); process.env.COMPANION_FUNNEL_DIR = dir; __resetFunnelCountersForTest() })
  afterEach(() => { delete process.env.COMPANION_FUNNEL_DIR; rmSync(dir, { recursive: true, force: true }) })

  function readAll(): Record<string, unknown>[] {
    return readdirSync(dir).flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
  }

  it('leader_observation_cohort records selection, cap, excluded-by-cap and config provenance', () => {
    emitFunnel(ctx, 'leader_observation_cohort', {
      runId: 'run-1', baseSize: 15, cap: 8, eligibleCount: 3, selectedCount: 3, excludedByCapCount: 0,
      selected: [{ symbol: 'Z', leaderEpisodeId: 'led-Z-1', role: 'CORE', lifecycleState: 'LEADER_CONFIRMED', reason: 'CORE_FALLEN', presentThisSweep: false }],
      excludedByCap: [], configVersion: 'h4a1-provisional-1', configHash: 'deadbeef',
    })
    const r = readAll()[0]
    expect(r.eventType).toBe('leader_observation_cohort')
    expect(r.cap).toBe(8); expect(r.selectedCount).toBe(3)
    expect(r.configHash).toBe('deadbeef')
    expect((r.selected as unknown[])[0]).toMatchObject({ symbol: 'Z', leaderEpisodeId: 'led-Z-1', reason: 'CORE_FALLEN' })
    expect(r.bars).toBeUndefined(); expect(r.candles).toBeUndefined()
  })

  it('leader_observation_data carries episode + timeframe + availability, and never a bar array', () => {
    emitFunnel(ctx, 'leader_observation_data', {
      symbol: 'Z', leaderEpisodeId: 'led-Z-1', role: 'CORE', lifecycleState: 'RESETTING', cohortReason: 'CORE_FALLEN',
      presentThisSweep: false, monitorResultAvailable: true, localStructureAvailable: true, timeframe: '1m',
      dataQualityStatus: 'AVAILABLE', qualityFlags: [], globalOffHighPct: -18.3, dataAsOf: 1_726_000_000_000, barsFreshnessMs: 4200,
      localFeatureConfigVersion: 'h4a-provisional-1', localFeatureConfigHash: 'abc12345',
      leaderObservationConfigVersion: 'h4a1-provisional-1', leaderObservationConfigHash: 'deadbeef',
    })
    const r = readAll()[0]
    expect(r.eventType).toBe('leader_observation_data')
    expect(r.symbol).toBe('Z'); expect(r.leaderEpisodeId).toBe('led-Z-1')
    expect(r.timeframe).toBe('1m'); expect(r.localStructureAvailable).toBe(true)
    expect(r.leaderObservationConfigHash).toBe('deadbeef')
    expect(r.bars).toBeUndefined(); expect(r.candles).toBeUndefined()
  })

  it('an unavailable observation is recorded honestly (no fabricated features)', () => {
    emitFunnel(ctx, 'leader_observation_data', {
      symbol: 'Q', leaderEpisodeId: 'led-Q-1', role: 'CHALLENGER', cohortReason: 'CHALLENGER_FALLEN',
      monitorResultAvailable: false, localStructureAvailable: false, timeframe: null, dataQualityStatus: 'MONITOR_UNAVAILABLE', qualityFlags: [],
    })
    const r = readAll()[0]
    expect(r.monitorResultAvailable).toBe(false)
    expect(r.dataQualityStatus).toBe('MONITOR_UNAVAILABLE')
    expect(r.timeframe).toBeNull()
  })

  it('H3A/H4A completeness readers ignore all leader_observation_* events (v1 additive)', () => {
    const events = [
      { eventType: 'sweep_started', schemaVersion: 1 },
      { eventType: 'leader_observation_cohort', schemaVersion: 1, selectedCount: 2 },
      { eventType: 'leader_observation_data', schemaVersion: 1, symbol: 'Z', timeframe: '1m' },
      { eventType: 'local_structure_observed', schemaVersion: 1, symbol: 'A' },
      { eventType: 'session_observability_summary', schemaVersion: 1, cleanClose: true, droppedTotal: 0, degradedEver: false },
    ]
    expect(() => assessFunnelCompleteness(events)).not.toThrow()
    expect(assessFunnelCompleteness(events)).toBe('COMPLETE')
  })
})
