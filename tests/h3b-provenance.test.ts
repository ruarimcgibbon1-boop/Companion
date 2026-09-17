/**
 * H3B — pre-trigger provenance (the H3A blind spots), tested on the pure assembler.
 * Proves: all discovery sources, winning source, EXACT exclusion/filter reason, 60→30
 * pre-truncation ranks, and merge-stage exclusions are all reconstructable per symbol.
 */
import { describe, it, expect } from 'vitest'
import { assembleDiscoveryProvenance } from '../src/lib/universe/discovery-provenance'

describe('H3B discovery provenance assembler', () => {
  // A symbol seen in webull+yahoo+fmp, survived to the ranked pool at route rank 2.
  const universe = [
    { symbol: 'MEDS', webull: true, yfChangePct: 300, changesPercentage: 300 },
    { symbol: 'DLXY', yfChangePct: 120, changesPercentage: 120 },   // survived, dropped at post-filter (not in ranked)
    { symbol: 'FOO', changesPercentage: 40 },                        // fmp-only, dropped by a map filter
  ]
  const ranked = [{ symbol: 'MEDS', rank: 2 }, { symbol: 'BAR', rank: 1 }]
  const so = (source: string, rank: number, changePct: number | null = null) => ({ source, rank, changePct })
  const allSources = new Map([
    ['MEDS', [so('webull', 1, 300), so('yahoo', 3, 298), so('fmp', 5, 301)]],
    ['DLXY', [so('yahoo', 2, 120)]], ['FOO', [so('fmp', 9, 40)]],
    ['ETFX', [so('fmp', 4, 15), so('yahoo', 7, 14)]],
  ])
  const dropReason = new Map<string, string>([
    ['FOO', 'below_min_volume'],
    ['DLXY', 'post_rank_below_min_rvol'],    // survived to top-30 but dropped by the final rvol re-filter
    ['ETFX', 'excluded_non_common_stock'],   // excluded at MERGE — never entered `universe`
  ])
  const rankProv = new Map([
    ['MEDS', { pre60Rank: 1, survived60: true, pre30Rank: 2, survived30: true, routeRank: 2 }],
    ['DLXY', { pre60Rank: 5, survived60: true, pre30Rank: 4, survived30: true }],
    ['FOO', { pre60Rank: 40, survived60: true }],
  ])
  const prov = assembleDiscoveryProvenance(universe, ranked, allSources, dropReason, rankProv)
  const by = (s: string) => prov.find(p => p.symbol === s)!

  it('captures ALL discovery sources (with per-source rank + raw change) + the winning source', () => {
    expect(by('MEDS').sources.map(s => s.source)).toEqual(['webull', 'yahoo', 'fmp'])
    expect(by('MEDS').sources.find(s => s.source === 'yahoo')).toEqual({ source: 'yahoo', rank: 3, changePct: 298 })
    expect(by('MEDS').winningSource).toBe('webull')
    expect(by('DLXY').winningSource).toBe('yahoo')
    expect(by('FOO').winningSource).toBe('fmp')
  })

  it('records the EXACT per-symbol exclusion/filter reason (null when it survived)', () => {
    expect(by('MEDS').exclusionReason).toBeNull()          // survived to ranked
    expect(by('FOO').exclusionReason).toBe('below_min_volume')
    expect(by('MEDS').mergedEligible).toBe(true)
    expect(by('FOO').mergedEligible).toBe(false)
    expect(by('DLXY').mergedEligible).toBe(false)          // survived to top-30 but dropped by the final rvol re-filter
    expect(by('DLXY').exclusionReason).toBe('post_rank_below_min_rvol')
  })

  it('captures 60→30 pre-truncation ranks', () => {
    expect(by('MEDS').pre60Rank).toBe(1); expect(by('MEDS').survived60).toBe(true)
    expect(by('MEDS').pre30Rank).toBe(2); expect(by('MEDS').survived30).toBe(true)
    expect(by('MEDS').routeRank).toBe(2)
    expect(by('FOO').survived30).toBe(false)              // dropped before the 30-rank
  })

  it('surfaces symbols excluded at the MERGE stage (never entered universe)', () => {
    const etfx = by('ETFX')
    expect(etfx).toBeTruthy()
    expect(etfx.exclusionReason).toBe('excluded_non_common_stock')
    expect(etfx.sources.map(s => s.source)).toEqual(['fmp', 'yahoo'])
    expect(etfx.mergedEligible).toBe(false)
    expect(etfx.routeRank).toBeNull()
  })

  it('every discovered symbol is answerable: appeared? sources? survived? reason? ranks?', () => {
    expect(new Set(prov.map(p => p.symbol))).toEqual(new Set(['MEDS', 'DLXY', 'FOO', 'ETFX']))
    for (const p of prov) {
      expect(Array.isArray(p.sources)).toBe(true)
      expect(p.mergedEligible === true || p.exclusionReason !== null || p.survived30 === false).toBe(true)
    }
  })
})
