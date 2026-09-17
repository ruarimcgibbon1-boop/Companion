/**
 * H3C — leader-state persistence & restart safety. Atomic write, validated load, quarantine on
 * corrupt/schema-mismatch, producer-head change, and "no history is not fabricated".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadLeaderState, saveLeaderState, leaderStateFile, LEADER_STATE_SCHEMA_VERSION } from '../src/lib/leader/leader-store'
import type { LeaderStateMap, LeaderStateRecord } from '../src/lib/leader/leader-state'

const rec = (symbol: string, episode: string): LeaderStateRecord => ({
  symbol, leaderEpisodeId: episode, tradingDay: '2026-09-17', firstSeenAt: 'x', lastSeenAt: 'x',
  firstSeenSweepId: 's', lastSeenSweepId: 's', firstEverSeenAt: 'x', episodeCount: 1,
  sourcesEverSeen: ['fmp'], currentSources: ['fmp'], bestSourceRank: 1, currentSourceRanks: { fmp: 1 },
  bestPre60Rank: 1, bestPre30Rank: 1, bestRouteRank: 1, bestLegacyTop15Rank: 1,
  firstTop60At: null, firstTop30At: null, firstLegacyTop15At: null, timesTop60: 0, timesTop30: 0, timesLegacyTop15: 0,
  firstObservedChangePct: 50, currentChangePct: 50, peakObservedChangePct: 90, peakObservedAt: 'x',
  currentOffHighPct: null, peakRvol: null, currentVolume: null, currentFloat: null,
  presentThisSweep: true, consecutiveSweepsSeen: 1, consecutiveSweepsAbsent: 0, lastPresentAt: 'x', lastAbsentAt: null,
  reappearanceCount: 0, lifecycleState: 'LEADER_CONFIRMED', lifecycleEnteredAt: 'x', priorLifecycleState: null,
  transitionReason: null, transitionSweepId: null, role: 'CORE', roleEnteredAt: 'x', priorRole: null,
  roleRuleVersion: 'h3c-provisional-1', historyComplete: true,
})

describe('H3C leader-state persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'leader-')); process.env.COMPANION_LEADER_DIR = dir; vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { delete process.env.COMPANION_LEADER_DIR; rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  it('H. save then load round-trips records + episode ids (restart preserves state)', () => {
    const st: LeaderStateMap = { MEDS: rec('MEDS', 'led-MEDS-1'), DLXY: rec('DLXY', 'led-DLXY-1') }
    expect(saveLeaderState(st, 'head1', '2026-09-17')).toBe(true)
    const lr = loadLeaderState('head1')
    expect(lr.loadedFromDisk).toBe(true); expect(lr.degraded).toBe(false)
    expect(Object.keys(lr.records).sort()).toEqual(['DLXY', 'MEDS'])
    expect(lr.records.MEDS.leaderEpisodeId).toBe('led-MEDS-1')
    expect(lr.records.MEDS.role).toBe('CORE')
  })

  it('R. write is ATOMIC — no lingering .tmp, and the file is valid JSON', () => {
    saveLeaderState({ A: rec('A', 'e') }, 'h', '2026-09-17')
    const files = readdirSync(dir)
    expect(files.some(f => f.includes('.tmp'))).toBe(false)               // temp cleaned up by rename
    expect(files).toContain('.companion-leader-state.json')
    const parsed = JSON.parse(readFileSync(leaderStateFile(dir), 'utf8'))
    expect(parsed.schemaVersion).toBe(LEADER_STATE_SCHEMA_VERSION)
  })

  it('I. corrupt JSON → quarantined + DEGRADED fresh start (does not fabricate history)', () => {
    writeFileSync(leaderStateFile(dir), '{ this is not: valid json ]')
    const lr = loadLeaderState('h')
    expect(lr.degraded).toBe(true); expect(lr.reason).toBe('corrupt_parse')
    expect(Object.keys(lr.records)).toHaveLength(0)                        // fresh
    expect(readdirSync(dir).some(f => f.includes('.corrupt-'))).toBe(true) // quarantined
    expect(existsSync(leaderStateFile(dir))).toBe(false)                   // bad file moved aside
  })

  it('J. schema mismatch → DEGRADED (not silently trusted)', () => {
    writeFileSync(leaderStateFile(dir), JSON.stringify({ schemaVersion: 999, savedAt: 'x', tradingDay: 'x', records: {} }))
    const lr = loadLeaderState('h')
    expect(lr.degraded).toBe(true); expect(lr.reason).toBe('schema_mismatch')
  })

  it('missing file → fresh, NOT degraded (a first run legitimately has no history)', () => {
    const lr = loadLeaderState('h')
    expect(lr.loadedFromDisk).toBe(false); expect(lr.degraded).toBe(false); expect(lr.reason).toBe('no_prior_file')
  })

  it('producer-head change → history kept but FLAGGED (conservative)', () => {
    saveLeaderState({ A: rec('A', 'e') }, 'headOLD', '2026-09-17')
    const lr = loadLeaderState('headNEW')
    expect(lr.loadedFromDisk).toBe(true); expect(lr.producerHeadChanged).toBe(true); expect(lr.reason).toBe('producer_head_changed')
    expect(Object.keys(lr.records)).toContain('A')
  })

  it('a save failure returns false and never throws (execution unaffected)', () => {
    process.env.COMPANION_LEADER_DIR = join(dir, 'does', 'not', 'exist')   // rename target dir missing
    expect(() => saveLeaderState({ A: rec('A', 'e') }, 'h', '2026-09-17')).not.toThrow()
    expect(saveLeaderState({ A: rec('A', 'e') }, 'h', '2026-09-17')).toBe(false)
  })
})
