/**
 * H4A.1 — bounded OBSERVATIONAL leader cohort selection (pure core).
 *
 * Covers eligibility by H3C role/lifecycle, the recently-CORE grace window, EXPIRED/stale exclusion,
 * BASE + operational deduplication, deterministic prioritization, hard-cap capacity pressure, and
 * config-hash provenance. Selection uses ONLY persistent H3C facts — never an H4A local feature.
 */
import { describe, it, expect } from 'vitest'
import type { LeaderStateMap, LeaderStateRecord } from '../src/lib/leader/leader-state'
import {
  selectLeaderObservationCohort, stableObservationUnion,
  resolveLeaderObservationConfig, leaderObservationConfigHash,
  DEFAULT_LEADER_OBSERVATION_CONFIG, type LeaderObservationConfig,
} from '../src/lib/leader/leader-observation'

// Minimal valid LeaderStateRecord factory — only the fields selection reads matter; the rest carry
// defaults so the fixture stays a real record shape.
function rec(o: Partial<LeaderStateRecord> & { symbol: string }): LeaderStateRecord {
  const iso = '2026-09-18T13:30:00.000Z'
  return {
    leaderEpisodeId: o.leaderEpisodeId ?? `led-${o.symbol}-1`, tradingDay: '2026-09-18',
    firstSeenAt: iso, lastSeenAt: iso, firstSeenSweepId: 'sw1', lastSeenSweepId: 'sw1',
    firstEverSeenAt: iso, episodeCount: 1,
    sourcesEverSeen: ['fmp'], currentSources: ['fmp'], bestSourceRank: 1, currentSourceRanks: { fmp: 1 },
    bestPre60Rank: 10, bestPre30Rank: 5, bestRouteRank: o.bestRouteRank ?? 5, bestLegacyTop15Rank: null,
    firstTop60At: iso, firstTop30At: iso, firstLegacyTop15At: null,
    timesTop60: 3, timesTop30: o.timesTop30 ?? 3, timesLegacyTop15: 0,
    firstObservedChangePct: 20, currentChangePct: o.currentChangePct ?? 40,
    peakObservedChangePct: o.peakObservedChangePct ?? 60, peakObservedAt: iso,
    currentOffHighPct: -10, peakRvol: 5, currentVolume: 2e6, currentFloat: 1e7,
    presentThisSweep: o.presentThisSweep ?? true,
    consecutiveSweepsSeen: 3, consecutiveSweepsAbsent: o.consecutiveSweepsAbsent ?? 0,
    lastPresentAt: iso, lastAbsentAt: null, reappearanceCount: 0,
    lifecycleState: o.lifecycleState ?? 'LEADER_CONFIRMED', lifecycleEnteredAt: iso,
    priorLifecycleState: null, transitionReason: null, transitionSweepId: null,
    role: o.role ?? 'CORE', roleEnteredAt: iso, priorRole: o.priorRole ?? null, roleRuleVersion: 'h3c-provisional-1',
    historyComplete: true,
    ...o,
  }
}

function mapOf(...records: LeaderStateRecord[]): LeaderStateMap {
  const m: LeaderStateMap = {}
  for (const r of records) m[r.symbol] = r
  return m
}

const cfg: LeaderObservationConfig = { ...DEFAULT_LEADER_OBSERVATION_CONFIG }
const BASE15 = Array.from({ length: 15 }, (_, i) => `B${i}`)   // stand-in top15

describe('H4A.1 cohort — eligibility', () => {
  it('B. a CORE leader outside top15 is eligible', () => {
    const st = mapOf(rec({ symbol: 'Z', role: 'CORE', lifecycleState: 'LEADER_CONFIRMED' }))
    const sel = selectLeaderObservationCohort(st, BASE15, cfg)
    expect(sel.selected.map(m => m.symbol)).toContain('Z')
    expect(sel.selected.find(m => m.symbol === 'Z')!.reason).toBe('CORE_PRESENT')
  })

  it('B2. a CORE leader that has FALLEN off the sweep (absent) is still eligible — the H1/H1.1 target', () => {
    const st = mapOf(rec({ symbol: 'Z', role: 'CORE', presentThisSweep: false, consecutiveSweepsAbsent: 3, lifecycleState: 'RESETTING' }))
    const sel = selectLeaderObservationCohort(st, BASE15, cfg)
    expect(sel.selected.find(m => m.symbol === 'Z')!.reason).toBe('CORE_FALLEN')
  })

  it('C. a CHALLENGER outside top15 is eligible when includeChallengers=true', () => {
    const st = mapOf(rec({ symbol: 'C1', role: 'CHALLENGER', lifecycleState: 'LEADER_CANDIDATE' }))
    expect(selectLeaderObservationCohort(st, BASE15, cfg).selected.map(m => m.symbol)).toContain('C1')
    const off = selectLeaderObservationCohort(st, BASE15, { ...cfg, includeChallengers: false })
    expect(off.selected.map(m => m.symbol)).not.toContain('C1')
  })

  it('D. a recently-CORE record fallen to STALE (role NONE) is eligible within the grace window', () => {
    const graced = rec({ symbol: 'G', role: 'NONE', lifecycleState: 'STALE', priorRole: 'CORE', presentThisSweep: false, consecutiveSweepsAbsent: 5 })
    expect(selectLeaderObservationCohort(mapOf(graced), BASE15, cfg).selected.find(m => m.symbol === 'G')!.reason).toBe('RECENTLY_CORE_GRACE')
    // past the grace window → excluded
    const past = rec({ symbol: 'G', role: 'NONE', lifecycleState: 'STALE', priorRole: 'CORE', presentThisSweep: false, consecutiveSweepsAbsent: cfg.recentlyCoreGraceSweeps + 1 })
    expect(selectLeaderObservationCohort(mapOf(past), BASE15, cfg).selected.map(m => m.symbol)).not.toContain('G')
  })

  it('D2. a role-NONE record that never earned CORE-tier strength is NOT graced', () => {
    const weak = rec({ symbol: 'W', role: 'NONE', lifecycleState: 'STALE', priorRole: 'CHALLENGER', peakObservedChangePct: 20, timesTop30: 1, consecutiveSweepsAbsent: 2 })
    expect(selectLeaderObservationCohort(mapOf(weak), BASE15, cfg).selected.map(m => m.symbol)).not.toContain('W')
  })

  it('E. EXPIRED is excluded regardless of prior strength', () => {
    const st = mapOf(rec({ symbol: 'X', role: 'NONE', lifecycleState: 'EXPIRED', priorRole: 'CORE', peakObservedChangePct: 90 }))
    expect(selectLeaderObservationCohort(st, BASE15, cfg).selected.map(m => m.symbol)).not.toContain('X')
    expect(selectLeaderObservationCohort(st, BASE15, cfg).eligibleCount).toBe(0)
  })

  it('H. a symbol in BOTH top15 and CORE is deduplicated OUT of the cohort (covered by BASE)', () => {
    const st = mapOf(rec({ symbol: 'B3', role: 'CORE' }))   // B3 is in BASE15
    const sel = selectLeaderObservationCohort(st, BASE15, cfg)
    expect(sel.selected.map(m => m.symbol)).not.toContain('B3')
    expect(sel.eligibleCount).toBe(0)
    // and the union contains B3 exactly once
    const union = stableObservationUnion(BASE15, sel.selected.map(m => m.symbol))
    expect(union.filter(s => s === 'B3')).toHaveLength(1)
  })

  it('operational exclusion: an open-broker-position symbol is not re-added to the cohort', () => {
    const st = mapOf(rec({ symbol: 'POS', role: 'CORE' }))
    const sel = selectLeaderObservationCohort(st, BASE15, cfg, { excludeSymbols: ['POS'] })
    expect(sel.selected.map(m => m.symbol)).not.toContain('POS')
  })
})

describe('H4A.1 cohort — prioritization & capacity (STEP 3 / STEP 14)', () => {
  it('G. deterministic priority: CORE before CHALLENGER before grace; present before fallen; stronger rank first', () => {
    const st = mapOf(
      rec({ symbol: 'CHAL', role: 'CHALLENGER', lifecycleState: 'LEADER_CANDIDATE' }),
      rec({ symbol: 'COREFALL', role: 'CORE', presentThisSweep: false, consecutiveSweepsAbsent: 2 }),
      rec({ symbol: 'COREB', role: 'CORE', presentThisSweep: true, bestRouteRank: 9 }),
      rec({ symbol: 'COREA', role: 'CORE', presentThisSweep: true, bestRouteRank: 2 }),
      rec({ symbol: 'GRACE', role: 'NONE', lifecycleState: 'STALE', priorRole: 'CORE', presentThisSweep: false, consecutiveSweepsAbsent: 4 }),
    )
    const order = selectLeaderObservationCohort(st, BASE15, cfg).selected.map(m => m.symbol)
    // present CORE by rank, then fallen CORE, then CHALLENGER, then grace
    expect(order).toEqual(['COREA', 'COREB', 'COREFALL', 'CHAL', 'GRACE'])
  })

  it('deterministic tiebreak by symbol when every priority key is equal', () => {
    const st = mapOf(
      rec({ symbol: 'DELTA', role: 'CORE' }), rec({ symbol: 'ALPHA', role: 'CORE' }), rec({ symbol: 'CHARLIE', role: 'CORE' }),
    )
    expect(selectLeaderObservationCohort(st, BASE15, cfg).selected.map(m => m.symbol)).toEqual(['ALPHA', 'CHARLIE', 'DELTA'])
  })

  it('F/STEP14. cap below eligible count: exactly `cap` selected, the rest recorded as excluded-by-cap', () => {
    const records = Array.from({ length: 12 }, (_, i) => rec({ symbol: `L${String(i).padStart(2, '0')}`, role: 'CORE', bestRouteRank: i + 1 }))
    const sel = selectLeaderObservationCohort(mapOf(...records), BASE15, { ...cfg, maxSymbols: 5 })
    expect(sel.eligibleCount).toBe(12)
    expect(sel.selectedCount).toBe(5)
    expect(sel.excludedByCapCount).toBe(7)
    expect(sel.selected).toHaveLength(5)
    expect(sel.excludedByCap).toHaveLength(7)
    // selected are the 5 strongest by route rank (deterministic)
    expect(sel.selected.map(m => m.symbol)).toEqual(['L00', 'L01', 'L02', 'L03', 'L04'])
  })

  it('STEP14. eligible == cap and eligible < cap both behave (no unbounded expansion)', () => {
    const five = Array.from({ length: 5 }, (_, i) => rec({ symbol: `E${i}`, role: 'CORE', bestRouteRank: i + 1 }))
    const eq = selectLeaderObservationCohort(mapOf(...five), BASE15, { ...cfg, maxSymbols: 5 })
    expect(eq.selectedCount).toBe(5); expect(eq.excludedByCapCount).toBe(0)
    const under = selectLeaderObservationCohort(mapOf(...five), BASE15, { ...cfg, maxSymbols: 8 })
    expect(under.selectedCount).toBe(5); expect(under.excludedByCapCount).toBe(0)
  })

  it('STEP14. all-CORE beyond cap: some CORE are excluded observationally (cap is never secretly raised)', () => {
    const records = Array.from({ length: 10 }, (_, i) => rec({ symbol: `A${String(i).padStart(2, '0')}`, role: 'CORE', bestRouteRank: i + 1 }))
    const sel = selectLeaderObservationCohort(mapOf(...records), BASE15, { ...cfg, maxSymbols: 3 })
    expect(sel.selectedCount).toBe(3)
    expect(sel.excludedByCap.every(m => m.role === 'CORE')).toBe(true)
    expect(sel.excludedByCapCount).toBe(7)
  })

  it('maxSymbols=0 selects nothing but still reports eligibility', () => {
    const sel = selectLeaderObservationCohort(mapOf(rec({ symbol: 'Z', role: 'CORE' })), BASE15, { ...cfg, maxSymbols: 0 })
    expect(sel.selectedCount).toBe(0); expect(sel.eligibleCount).toBe(1); expect(sel.excludedByCapCount).toBe(1)
  })
})

describe('H4A.1 cohort — config provenance (STEP 12)', () => {
  it('O. same config → same hash; any behavior-affecting change → different hash', () => {
    const h = leaderObservationConfigHash(cfg)
    expect(leaderObservationConfigHash({ ...cfg })).toBe(h)
    expect(leaderObservationConfigHash({ ...cfg, maxSymbols: cfg.maxSymbols + 1 })).not.toBe(h)
    expect(leaderObservationConfigHash({ ...cfg, includeChallengers: !cfg.includeChallengers })).not.toBe(h)
    expect(leaderObservationConfigHash({ ...cfg, recentlyCoreGraceSweeps: 999 })).not.toBe(h)
    expect(leaderObservationConfigHash({ ...cfg, recentlyCoreMinPeakChangePct: 1 })).not.toBe(h)
  })

  it('env overrides are observational-only and change the resolved config + hash', () => {
    const base = resolveLeaderObservationConfig({})
    const overridden = resolveLeaderObservationConfig({ COMPANION_LEADER_OBS_MAX: '3', COMPANION_LEADER_OBS_INCLUDE_CHALLENGERS: 'false' })
    expect(overridden.maxSymbols).toBe(3)
    expect(overridden.includeChallengers).toBe(false)
    expect(leaderObservationConfigHash(overridden)).not.toBe(leaderObservationConfigHash(base))
  })

  it('selection stamps the effective config version + hash', () => {
    const sel = selectLeaderObservationCohort(mapOf(rec({ symbol: 'Z', role: 'CORE' })), BASE15, cfg)
    expect(sel.configVersion).toBe(cfg.version)
    expect(sel.configHash).toBe(leaderObservationConfigHash(cfg))
  })
})

describe('H4A.1 cohort — stable union (STEP 7 dedup)', () => {
  it('base symbols come first and are never displaced; a shared symbol appears once', () => {
    const union = stableObservationUnion(['A', 'B', 'C'], ['C', 'Z', 'B', 'Y'])
    expect(union).toEqual(['A', 'B', 'C', 'Z', 'Y'])
  })
})
