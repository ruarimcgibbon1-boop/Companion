/**
 * H3C — leader-state persistence & restart safety. Atomic write, validated load, quarantine on
 * corrupt/schema-mismatch, producer-head/config change, "no history is not fabricated", and
 * CRASH-AWARE recovery (a crashed PERIODIC checkpoint must never masquerade as complete).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadLeaderState, saveLeaderState, leaderStateFile, LEADER_STATE_SCHEMA_VERSION } from '../src/lib/leader/leader-store'
import { leaderConfigHash, DEFAULT_LEADER_CONFIG } from '../src/lib/leader/leader-state'
import type { LeaderStateMap, LeaderStateRecord } from '../src/lib/leader/leader-state'

const HASH = leaderConfigHash(DEFAULT_LEADER_CONFIG)

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
    expect(saveLeaderState({ records: st, producerHead: 'head1', tradingDay: '2026-09-17', saveReason: 'SHUTDOWN', configHash: HASH })).toBe(true)
    const lr = loadLeaderState({ producerHead: 'head1', configHash: HASH })
    expect(lr.loadedFromDisk).toBe(true); expect(lr.degraded).toBe(false)
    expect(Object.keys(lr.records).sort()).toEqual(['DLXY', 'MEDS'])
    expect(lr.records.MEDS.leaderEpisodeId).toBe('led-MEDS-1')
    expect(lr.records.MEDS.role).toBe('CORE')
  })

  it('R. write is ATOMIC — no lingering .tmp, and the file is valid JSON', () => {
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'PERIODIC' })
    const files = readdirSync(dir)
    expect(files.some(f => f.includes('.tmp'))).toBe(false)               // temp cleaned up by rename
    expect(files).toContain('.companion-leader-state.json')
    const parsed = JSON.parse(readFileSync(leaderStateFile(dir), 'utf8'))
    expect(parsed.schemaVersion).toBe(LEADER_STATE_SCHEMA_VERSION)
    expect(parsed.saveReason).toBe('PERIODIC')                           // provenance persisted
  })

  it('I. corrupt JSON → quarantined + DEGRADED_CORRUPT fresh start (does not fabricate history)', () => {
    writeFileSync(leaderStateFile(dir), '{ this is not: valid json ]')
    const lr = loadLeaderState({ producerHead: 'h' })
    expect(lr.degraded).toBe(true); expect(lr.reason).toBe('corrupt_parse'); expect(lr.recoveryStatus).toBe('DEGRADED_CORRUPT')
    expect(Object.keys(lr.records)).toHaveLength(0)                        // fresh
    expect(lr.historyComplete).toBe(false)
    expect(readdirSync(dir).some(f => f.includes('.corrupt-'))).toBe(true) // quarantined
    expect(existsSync(leaderStateFile(dir))).toBe(false)                   // bad file moved aside
  })

  it('J. schema mismatch → DEGRADED_CORRUPT (not silently trusted)', () => {
    writeFileSync(leaderStateFile(dir), JSON.stringify({ schemaVersion: 999, savedAt: 'x', tradingDay: 'x', records: {} }))
    const lr = loadLeaderState({ producerHead: 'h' })
    expect(lr.degraded).toBe(true); expect(lr.reason).toBe('schema_mismatch'); expect(lr.recoveryStatus).toBe('DEGRADED_CORRUPT')
  })

  it('6. missing file → FRESH_UNKNOWN (fresh, NOT degraded; earlier-in-day history is unknown, never claimed complete)', () => {
    const lr = loadLeaderState({ producerHead: 'h' })
    expect(lr.loadedFromDisk).toBe(false); expect(lr.degraded).toBe(false); expect(lr.reason).toBe('no_prior_file')
    expect(lr.recoveryStatus).toBe('FRESH_UNKNOWN'); expect(lr.historyComplete).toBe(false)   // does NOT overclaim completeness
  })

  it('7a. producer-head change → history kept but derived provenance FLAGGED incomplete (conservative)', () => {
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'headOLD', tradingDay: '2026-09-17', saveReason: 'SHUTDOWN', configHash: HASH })
    const lr = loadLeaderState({ producerHead: 'headNEW', configHash: HASH })
    expect(lr.loadedFromDisk).toBe(true); expect(lr.producerHeadChanged).toBe(true); expect(lr.reason).toBe('producer_head_changed')
    expect(lr.recoveryStatus).toBe('RECOVERED_DEGRADED'); expect(lr.historyComplete).toBe(false)
    expect(Object.keys(lr.records)).toContain('A')                        // raw facts preserved
    expect(lr.records.A.historyComplete).toBe(false)                      // derived provenance stale
  })

  it('7b. config-hash change → RECOVERED_DEGRADED (old derived lifecycle/role not trusted under new rule)', () => {
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'SHUTDOWN', configHash: HASH })
    const lr = loadLeaderState({ producerHead: 'h', configHash: 'deadbeef' })
    expect(lr.configChanged).toBe(true); expect(lr.reason).toBe('config_changed')
    expect(lr.recoveryStatus).toBe('RECOVERED_DEGRADED'); expect(lr.historyComplete).toBe(false)
    expect(Object.keys(lr.records)).toContain('A')                        // facts kept
  })

  it('§2 checkpoint persists config provenance (version + hash) for the audit', () => {
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'SHUTDOWN', configVersion: 'h3c-provisional-1', configHash: HASH, runId: 'run-1', lastSweepId: 'sw-1' })
    const parsed = JSON.parse(readFileSync(leaderStateFile(dir), 'utf8'))
    expect(parsed.leaderConfigVersion).toBe('h3c-provisional-1')
    expect(parsed.leaderConfigHash).toBe(HASH)
    expect(parsed.runId).toBe('run-1'); expect(parsed.lastSweepId).toBe('sw-1')
  })

  it('a save failure returns false and never throws (execution unaffected)', () => {
    process.env.COMPANION_LEADER_DIR = join(dir, 'does', 'not', 'exist')   // rename target dir missing
    const args = { records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'PERIODIC' as const }
    expect(() => saveLeaderState(args)).not.toThrow()
    expect(saveLeaderState(args)).toBe(false)
  })
})

// ── Red-team §1: crashed PERIODIC checkpoint must not masquerade as complete ──────────────────────
describe('H3C checkpoint freshness / crash recovery (§1)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'leaderck-')); process.env.COMPANION_LEADER_DIR = dir; vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { delete process.env.COMPANION_LEADER_DIR; rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  it('A. graceful SHUTDOWN checkpoint → restart RECOVERED_COMPLETE (history trustworthy)', () => {
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'SHUTDOWN', configHash: HASH, lastSweepId: 'sw-120' })
    const lr = loadLeaderState({ producerHead: 'h', configHash: HASH })
    expect(lr.recoveryStatus).toBe('RECOVERED_COMPLETE'); expect(lr.historyComplete).toBe(true)
    expect(lr.records.A.historyComplete).toBe(true)
    expect(lr.savedReason).toBe('SHUTDOWN')
  })

  it('A2. a completed ONCE run is also a clean-terminal checkpoint → RECOVERED_COMPLETE', () => {
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'ONCE', configHash: HASH })
    const lr = loadLeaderState({ producerHead: 'h', configHash: HASH })
    expect(lr.recoveryStatus).toBe('RECOVERED_COMPLETE'); expect(lr.historyComplete).toBe(true)
  })

  it('B. PERIODIC checkpoint + simulated crash (no later SHUTDOWN) → restart DEGRADED/incomplete', () => {
    // The daemon writes PERIODIC every ~20 sweeps; a crash leaves the last PERIODIC on disk with NO
    // trailing SHUTDOWN. That is exactly this file — it must not be trusted complete.
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'PERIODIC', configHash: HASH, lastSweepId: 'sw-100' })
    const lr = loadLeaderState({ producerHead: 'h', configHash: HASH })
    expect(lr.recoveryStatus).toBe('RECOVERED_DEGRADED')
    expect(lr.historyComplete).toBe(false)
    expect(lr.reason).toBe('periodic_checkpoint_from_unclean_prior_run')
    expect(Object.keys(lr.records)).toContain('A')                        // facts kept, no fabrication
    expect(lr.records.A.historyComplete).toBe(false)
  })

  it('C. a PERIODIC checkpoint from sweep 100 cannot claim the 19 later unseen sweeps (still DEGRADED)', () => {
    // Same crashed-periodic file regardless of how many sweeps ran after it — completeness is never assumed.
    saveLeaderState({ records: { A: rec('A', 'e') }, producerHead: 'h', tradingDay: '2026-09-17', saveReason: 'PERIODIC', configHash: HASH, lastSweepId: 'sw-100', checkpointSeq: 5 })
    const lr = loadLeaderState({ producerHead: 'h', configHash: HASH })
    expect(lr.historyComplete).toBe(false)
    expect(lr.lastSweepId).toBe('sw-100')                                  // the audit can see how far the checkpoint reached
  })

  it('D. a corrupt checkpoint remains DEGRADED regardless of save reason', () => {
    writeFileSync(leaderStateFile(dir), 'not json at all')
    const lr = loadLeaderState({ producerHead: 'h', configHash: HASH })
    expect(lr.degraded).toBe(true); expect(lr.recoveryStatus).toBe('DEGRADED_CORRUPT'); expect(lr.historyComplete).toBe(false)
  })

  it('a legacy v1 file with NO saveReason is treated conservatively as DEGRADED (not silently complete)', () => {
    writeFileSync(leaderStateFile(dir), JSON.stringify({ schemaVersion: 1, producerHead: 'h', savedAt: 'x', tradingDay: '2026-09-17', records: { A: rec('A', 'e') } }))
    const lr = loadLeaderState({ producerHead: 'h', configHash: HASH })
    expect(lr.recoveryStatus).toBe('RECOVERED_DEGRADED'); expect(lr.historyComplete).toBe(false); expect(lr.reason).toBe('unknown_save_reason')
  })
})
