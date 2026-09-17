/**
 * H3C — persistent observational leader state (pure core). Covers lifecycle, episode identity,
 * absence/reappearance/expiry, top60→30→15 history, cross-midnight/day reset, bounded memory,
 * and OBSERVATIONAL ISOLATION (snapshot + monitored set unchanged).
 */
import { describe, it, expect } from 'vitest'
import { UniverseCoordinator, type SweepContextIn } from '../src/lib/universe/coordinator'
import type { RankedRow } from '../src/lib/universe/pipeline'
import type { DiscoverySymbolProv } from '../src/lib/universe/discovery-provenance'
import {
  updateLeaderState, DEFAULT_LEADER_CONFIG, etDay, leaderConfigHash, resolveLeaderConfig,
  type LeaderStateMap, type LeaderStateConfig, type LeaderStateRecord, type LifecycleState, type LeaderRole,
} from '../src/lib/leader/leader-state'

const cfg: LeaderStateConfig = { ...DEFAULT_LEADER_CONFIG, staleAbsentSweeps: 2, expireAbsentSweeps: 4, maxRecords: 5 }
const coord = new UniverseCoordinator({ fetchUniverse: async () => ({ rows: [], discovery: [] }) })

// Build a snapshot for `syms`: each { symbol, changePct, survived60, survived30, top15, offHighPct, routeRank }
interface Spec { symbol: string; changePct: number; survived60?: boolean; survived30?: boolean; top15?: boolean; offHighPct?: number | null; routeRank?: number | null; sources?: string[] }
function snap(sweepId: string, specs: Spec[]) {
  const rows: RankedRow[] = specs.filter(s => s.survived30 || s.top15).map((s, i) => ({
    symbol: s.symbol, changePct: s.changePct, rank: s.routeRank ?? i + 1, momentumScore: 1e6, offHighPct: s.offHighPct ?? null,
    rocPct: null, relativeVolume: 5, volume: 2e6, float: 1e7, premarketVolume: null,
  }))
  const discovery: DiscoverySymbolProv[] = specs.map(s => ({
    symbol: s.symbol, sources: (s.sources ?? ['fmp']).map((src, i) => ({ source: src, rank: i + 1, changePct: s.changePct })),
    winningSource: (s.sources ?? ['fmp'])[0], changePct: s.changePct, mergedEligible: !!(s.survived30 || s.top15),
    exclusionReason: null, pre60Rank: s.survived60 ? 10 : null, survived60: !!s.survived60,
    pre30Rank: s.survived30 ? 5 : null, survived30: !!s.survived30, routeRank: s.routeRank ?? (s.survived30 ? 1 : null),
  }))
  const ctx: SweepContextIn = { sweepId, runId: 'run-1', producerHead: 'h', session: 'premarket' }
  // monitoredSymbols = the top15-flagged specs (in order); envelope drives the coordinator.
  const top15 = specs.filter(s => s.top15).map(s => s.symbol)
  // Use assemble but override monitored to the top15 flags via rows ordering: put top15 rows first by changePct.
  const env = { rows, discovery }
  const s = coord.assemble(ctx, env)
  // The coordinator computes monitoredSymbols from rows; align our fixtures so top15 == the flagged set.
  return { s, top15 }
}
const T = (i: number) => Date.parse('2026-09-17T09:30:00-04:00') + i * 15_000  // 15s sweeps, ET day 09-17

describe('H3C leader state — lifecycle & history', () => {
  it('A. first sighting creates a DISCOVERED record with an episode id', () => {
    const { s } = snap('sw1', [{ symbol: 'MEDS', changePct: 20 }])
    const r = updateLeaderState({}, s, cfg, T(0))
    const rec = r.state.MEDS
    expect(rec).toBeTruthy()
    expect(rec.lifecycleState).toBe('DISCOVERED')
    expect(rec.leaderEpisodeId).toMatch(/^led-MEDS-2026-09-17-/)
    expect(rec.firstSeenSweepId).toBe('sw1')
    expect(r.transitions.some(t => t.newState === 'DISCOVERED' && t.reason === 'first_sighting')).toBe(true)
  })

  it('B/C. repeat sighting updates counters + best ranks WITHOUT a new episode', () => {
    let st: LeaderStateMap = {}
    ;({ state: st } = updateLeaderState(st, snap('s1', [{ symbol: 'A', changePct: 40, survived30: true, routeRank: 8 }]).s, cfg, T(0)))
    const ep1 = st.A.leaderEpisodeId
    ;({ state: st } = updateLeaderState(st, snap('s2', [{ symbol: 'A', changePct: 45, survived30: true, routeRank: 3 }]).s, cfg, T(1)))
    expect(st.A.leaderEpisodeId).toBe(ep1)                 // same episode
    expect(st.A.consecutiveSweepsSeen).toBe(2)
    expect(st.A.bestRouteRank).toBe(3)                     // best = min (improved 8 -> 3)
    expect(st.A.peakObservedChangePct).toBe(45)
    expect(st.A.timesTop30).toBe(2)
  })

  it('D/E. top60→top30→top15 tracked; dropping out of top15 does NOT erase history', () => {
    let st: LeaderStateMap = {}
    ;({ state: st } = updateLeaderState(st, snap('s1', [{ symbol: 'A', changePct: 60, survived60: true }]).s, cfg, T(0)))
    expect(st.A.timesTop60).toBe(1); expect(st.A.timesTop30).toBe(0)
    ;({ state: st } = updateLeaderState(st, snap('s2', [{ symbol: 'A', changePct: 70, survived60: true, survived30: true, top15: true, routeRank: 2 }]).s, cfg, T(1)))
    expect(st.A.timesTop30).toBe(1); expect(st.A.timesLegacyTop15).toBe(1); expect(st.A.firstLegacyTop15At).toBeTruthy()
    // now only discovered (fell out of top15/top30) — history preserved
    ;({ state: st } = updateLeaderState(st, snap('s3', [{ symbol: 'A', changePct: 55 }]).s, cfg, T(2)))
    expect(st.A.timesLegacyTop15).toBe(1)                  // preserved
    expect(st.A.peakObservedChangePct).toBe(70); expect(st.A.bestLegacyTop15Rank).toBe(1)  // only monitored name → rank 1
    expect(st.A.lifecycleState).toBe('LEADER_CONFIRMED')   // peak 70 >= confirmMinChangePct(50)
  })

  it('F. temporary absence then reappearance keeps the SAME episode (within stale window)', () => {
    let st: LeaderStateMap = {}
    ;({ state: st } = updateLeaderState(st, snap('s1', [{ symbol: 'A', changePct: 60 }]).s, cfg, T(0)))
    const ep = st.A.leaderEpisodeId
    ;({ state: st } = updateLeaderState(st, snap('s2', [{ symbol: 'B', changePct: 10 }]).s, cfg, T(1)))  // A absent
    expect(st.A.presentThisSweep).toBe(false); expect(st.A.consecutiveSweepsAbsent).toBe(1)
    ;({ state: st } = updateLeaderState(st, snap('s3', [{ symbol: 'A', changePct: 62 }]).s, cfg, T(2)))  // A back
    expect(st.A.leaderEpisodeId).toBe(ep)                  // same episode
    expect(st.A.reappearanceCount).toBe(0)
  })

  it('G. expiry then reappearance creates a NEW episode + increments reappearanceCount', () => {
    let st: LeaderStateMap = {}
    ;({ state: st } = updateLeaderState(st, snap('s1', [{ symbol: 'A', changePct: 60 }]).s, cfg, T(0)))
    const ep1 = st.A.leaderEpisodeId
    for (let i = 1; i <= 4; i++) ({ state: st } = updateLeaderState(st, snap(`s${i + 1}`, [{ symbol: 'Z', changePct: 5 }]).s, cfg, T(i)))
    expect(st.A.lifecycleState).toBe('EXPIRED')            // 4 absent >= expireAbsentSweeps
    ;({ state: st } = updateLeaderState(st, snap('s6', [{ symbol: 'A', changePct: 30 }]).s, cfg, T(5)))
    expect(st.A.leaderEpisodeId).not.toBe(ep1)             // NEW episode
    expect(st.A.reappearanceCount).toBe(1)
    expect(st.A.episodeCount).toBe(2)
    expect(st.A.firstEverSeenAt).toBe(new Date(T(0)).toISOString())  // lifetime preserved
  })

  it('K/L. cross-ET-midnight → NEW episode; day-change is NOT mixed across days', () => {
    let st: LeaderStateMap = {}
    ;({ state: st } = updateLeaderState(st, snap('d1', [{ symbol: 'A', changePct: 300 }]).s, cfg, T(0)))  // 09-17
    const ep1 = st.A.leaderEpisodeId
    const nextDay = Date.parse('2026-09-18T05:00:00-04:00')
    ;({ state: st } = updateLeaderState(st, snap('d2', [{ symbol: 'A', changePct: 20 }]).s, cfg, nextDay)) // 09-18
    expect(st.A.tradingDay).toBe('2026-09-18')
    expect(st.A.leaderEpisodeId).not.toBe(ep1)            // new day = new episode
    expect(st.A.peakObservedChangePct).toBe(20)           // NOT yesterday's 300 — day-change re-scoped
    expect(etDay(nextDay)).toBe('2026-09-18')
  })

  it('roles are shadow-only: CONFIRMED→CORE, CANDIDATE→CHALLENGER, EXPIRED→NONE (no permanent CORE)', () => {
    let st: LeaderStateMap = {}
    ;({ state: st } = updateLeaderState(st, snap('s1', [{ symbol: 'A', changePct: 80, survived30: true }]).s, cfg, T(0)))
    expect(st.A.lifecycleState).toBe('LEADER_CONFIRMED'); expect(st.A.role).toBe('CORE')
    for (let i = 1; i <= 4; i++) ({ state: st } = updateLeaderState(st, snap(`s${i + 1}`, [{ symbol: 'Z', changePct: 5 }]).s, cfg, T(i)))
    expect(st.A.lifecycleState).toBe('EXPIRED'); expect(st.A.role).toBe('NONE')   // CORE is NOT permanent
  })

  it('S. bounded memory: never exceeds maxRecords (evicts EXPIRED/oldest)', () => {
    let st: LeaderStateMap = {}
    for (let i = 0; i < 12; i++) ({ state: st } = updateLeaderState(st, snap(`s${i}`, [{ symbol: `SYM${i}`, changePct: 10 }]).s, cfg, T(i)))
    expect(Object.keys(st).length).toBeLessThanOrEqual(cfg.maxRecords)
  })
})

describe('H3C OBSERVATIONAL ISOLATION (§12/§15)', () => {
  it('does not mutate the snapshot or the monitored universe', () => {
    const { s } = snap('s1', [{ symbol: 'A', changePct: 80, survived30: true, top15: true }, { symbol: 'B', changePct: 20 }])
    const monitoredBefore = [...s.monitoredSymbols]
    const discFrozen = Object.isFrozen(s.discovery)
    updateLeaderState({}, s, cfg, T(0))
    expect([...s.monitoredSymbols]).toEqual(monitoredBefore)   // UNCHANGED
    expect(Object.isFrozen(s.discovery)).toBe(discFrozen)      // still frozen; not swapped
    // frozen snapshot means leader-state literally cannot write to it
    expect(() => { (s.monitoredSymbols as string[]).push('X') }).toThrow()
  })

  it('input state map is not mutated (returns a new map)', () => {
    const prev: LeaderStateMap = {}
    const { s } = snap('s1', [{ symbol: 'A', changePct: 40 }])
    const r = updateLeaderState(prev, s, cfg, T(0))
    expect(Object.keys(prev)).toHaveLength(0)                  // prev untouched
    expect(r.state.A).toBeTruthy()
  })
})

// ── Red-team §2: provisional config provenance (fingerprint of the EFFECTIVE config) ──────────────
describe('H3C config provenance (§2)', () => {
  it('same config → same hash; any behavior-affecting threshold change → different hash', () => {
    const base = leaderConfigHash(DEFAULT_LEADER_CONFIG)
    expect(leaderConfigHash({ ...DEFAULT_LEADER_CONFIG })).toBe(base)     // deterministic
    for (const k of ['candidateMinChangePct', 'confirmMinChangePct', 'confirmTimesTop30', 'resettingOffHighPct', 'staleAbsentSweeps', 'expireAbsentSweeps', 'maxRecords'] as const) {
      expect(leaderConfigHash({ ...DEFAULT_LEADER_CONFIG, [k]: DEFAULT_LEADER_CONFIG[k] + 1 })).not.toBe(base)
    }
    expect(leaderConfigHash({ ...DEFAULT_LEADER_CONFIG, ruleVersion: 'other' })).not.toBe(base)
  })

  it('env overrides resolve into the effective config and change the fingerprint', () => {
    const before = leaderConfigHash(resolveLeaderConfig({}))
    const cfgEnv = resolveLeaderConfig({ COMPANION_LEADER_STALE_ABSENT: '7', COMPANION_LEADER_MAX_RECORDS: '123' })
    expect(cfgEnv.staleAbsentSweeps).toBe(7); expect(cfgEnv.maxRecords).toBe(123)
    expect(leaderConfigHash(cfgEnv)).not.toBe(before)
    // a garbage override falls back to the default (never NaN)
    expect(resolveLeaderConfig({ COMPANION_LEADER_STALE_ABSENT: 'notanumber' }).staleAbsentSweeps).toBe(DEFAULT_LEADER_CONFIG.staleAbsentSweeps)
  })
})

// ── Red-team §3: sustained absence stales+expires from EVERY active lifecycle state ────────────────
describe('H3C absence from every active state (§3)', () => {
  const drive = (setup: Spec[][]): { st: LeaderStateMap; next: number } => {
    let st: LeaderStateMap = {}
    setup.forEach((specs, i) => { ({ state: st } = updateLeaderState(st, snap(`su${i}`, specs).s, cfg, T(i))) })
    return { st, next: setup.length }
  }
  const cases: [LifecycleState, Spec[][]][] = [
    ['DISCOVERED', [[{ symbol: 'S', changePct: 20 }]]],
    ['LEADER_CANDIDATE', [[{ symbol: 'S', changePct: 40, survived30: true }]]],
    ['LEADER_CONFIRMED', [[{ symbol: 'S', changePct: 80, survived30: true }]]],
    ['RESETTING', [[{ symbol: 'S', changePct: 80, survived30: true, offHighPct: -10 }]]],
    ['REEXPANDING', [[{ symbol: 'S', changePct: 80, survived30: true, offHighPct: -10 }], [{ symbol: 'S', changePct: 95, survived30: true, offHighPct: 0 }]]],
  ]
  it.each(cases)('%s → sustained absence → STALE → EXPIRED and role drops to NONE', (expected, setup) => {
    const { st, next } = drive(setup)
    expect(st.S.lifecycleState).toBe(expected)                 // reached the target active state
    let s = st, t = next
    for (let i = 0; i < cfg.staleAbsentSweeps; i++) ({ state: s } = updateLeaderState(s, snap(`ab${t}`, [{ symbol: 'OTHER', changePct: 5 }]).s, cfg, T(t++)))
    expect(s.S.lifecycleState).toBe('STALE'); expect(s.S.role).toBe('NONE')       // never stuck CORE/CHALLENGER
    for (let i = cfg.staleAbsentSweeps; i < cfg.expireAbsentSweeps; i++) ({ state: s } = updateLeaderState(s, snap(`ab${t}`, [{ symbol: 'OTHER', changePct: 5 }]).s, cfg, T(t++)))
    expect(s.S.lifecycleState).toBe('EXPIRED'); expect(s.S.role).toBe('NONE')
  })
})

// ── Red-team §4: capacity eviction must be auditable, and must protect active CORE ────────────────
describe('H3C capacity eviction is auditable (§4)', () => {
  const day = etDay(T(0))
  const mk = (symbol: string, lifecycleState: LifecycleState, role: LeaderRole, lastSeenMs: number): LeaderStateRecord => ({
    symbol, leaderEpisodeId: `led-${symbol}`, tradingDay: day, firstSeenAt: 'x', lastSeenAt: new Date(lastSeenMs).toISOString(),
    firstSeenSweepId: 's', lastSeenSweepId: 's', firstEverSeenAt: 'x', episodeCount: 1,
    sourcesEverSeen: ['fmp'], currentSources: ['fmp'], bestSourceRank: 1, currentSourceRanks: { fmp: 1 },
    bestPre60Rank: 1, bestPre30Rank: 1, bestRouteRank: 1, bestLegacyTop15Rank: 1,
    firstTop60At: null, firstTop30At: null, firstLegacyTop15At: null, timesTop60: 0, timesTop30: 0, timesLegacyTop15: 0,
    firstObservedChangePct: 80, currentChangePct: 80, peakObservedChangePct: 80, peakObservedAt: 'x',
    currentOffHighPct: null, peakRvol: null, currentVolume: null, currentFloat: null,
    presentThisSweep: true, consecutiveSweepsSeen: 1, consecutiveSweepsAbsent: 0, lastPresentAt: 'x', lastAbsentAt: null,
    reappearanceCount: 0, lifecycleState, lifecycleEnteredAt: 'x', priorLifecycleState: null,
    transitionReason: null, transitionSweepId: null, role, roleEnteredAt: 'x', priorRole: null,
    roleRuleVersion: 'h3c-provisional-1', historyComplete: true,
  })
  // maxRecords 3: the carried records go absent (absent=1 < stale=2) so they HOLD their state this sweep,
  // and one new DISCOVERED symbol pushes over the cap → exactly one eviction.
  const capCfg: LeaderStateConfig = { ...cfg, maxRecords: 3 }

  it('evicts EXPIRED first; active CORE survives (not silently dropped)', () => {
    const prev: LeaderStateMap = {
      OLDEXP: mk('OLDEXP', 'EXPIRED', 'NONE', T(0)),
      C1: mk('C1', 'LEADER_CONFIRMED', 'CORE', T(1)),
      C2: mk('C2', 'LEADER_CONFIRMED', 'CORE', T(2)),
    }
    const r = updateLeaderState(prev, snap('new', [{ symbol: 'NEW', changePct: 10 }]).s, capCfg, T(3))
    expect(r.evictions).toHaveLength(1)
    expect(r.evictions[0].symbol).toBe('OLDEXP'); expect(r.evictions[0].active).toBe(false)
    expect(r.state.C1).toBeTruthy(); expect(r.state.C2).toBeTruthy()       // CORE protected
  })

  it('with no EXPIRED, evicts a NONE (DISCOVERED) before any CORE', () => {
    const prev: LeaderStateMap = {
      OLDDISC: mk('OLDDISC', 'DISCOVERED', 'NONE', T(0)),
      C1: mk('C1', 'LEADER_CONFIRMED', 'CORE', T(1)),
      C2: mk('C2', 'LEADER_CONFIRMED', 'CORE', T(2)),
    }
    const r = updateLeaderState(prev, snap('new', [{ symbol: 'NEW', changePct: 10 }]).s, capCfg, T(3))
    expect(r.evictions.map(e => e.symbol)).toEqual(['OLDDISC'])
    expect(r.state.C1).toBeTruthy(); expect(r.state.C2).toBeTruthy()
  })

  it('when only active CORE remain, a CORE IS evicted but the eviction is AUDITABLE (active=true), never silent', () => {
    const prev: LeaderStateMap = {
      C0: mk('C0', 'LEADER_CONFIRMED', 'CORE', T(0)),   // oldest
      C1: mk('C1', 'LEADER_CONFIRMED', 'CORE', T(1)),
      C2: mk('C2', 'LEADER_CONFIRMED', 'CORE', T(2)),
    }
    // keep C2 present so it is unambiguously retained; C0/C1 go absent(1) and hold CORE. Cap 2 forces
    // one CORE out even though nothing cheaper exists.
    const r = updateLeaderState(prev, snap('keep', [{ symbol: 'C2', changePct: 80, survived30: true }]).s, { ...capCfg, maxRecords: 2 }, T(3))
    expect(r.evictions).toHaveLength(1)
    expect(r.evictions[0].role).toBe('CORE'); expect(r.evictions[0].active).toBe(true)   // surfaced, not silent
    expect(r.evictions[0].symbol).toBe('C0')                                             // oldest CORE
  })

  it('memory stays bounded and evictions never exceed the overflow', () => {
    let st: LeaderStateMap = {}
    for (let i = 0; i < 20; i++) ({ state: st } = updateLeaderState(st, snap(`s${i}`, [{ symbol: `SYM${i}`, changePct: 10 }]).s, capCfg, T(i)))
    expect(Object.keys(st).length).toBeLessThanOrEqual(capCfg.maxRecords)
  })
})
