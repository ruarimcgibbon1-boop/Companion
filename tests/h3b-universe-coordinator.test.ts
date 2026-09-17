/**
 * H3B — UniverseCoordinator parity + snapshot contract.
 *
 * The CORE H3B guarantee: for identical ranked rows, the NEW UniverseCoordinator
 * (compatibility mode) produces the EXACT SAME monitored universe — same symbols AND
 * same order — as the legacy daemon inline selection. Any difference is a blocker.
 */
import { describe, it, expect } from 'vitest'
import { UniverseCoordinator, SWEEP_SNAPSHOT_SCHEMA_VERSION, type SweepContextIn } from '../src/lib/universe/coordinator'
import { selectMonitoredUniverse, DEFAULT_MONITORED_CAP, type RankedRow } from '../src/lib/universe/pipeline'

// The EXACT legacy daemon selection (was inline in alert-daemon.fetchUniverse before H3B).
const legacyMonitored = (rows: RankedRow[], cap = DEFAULT_MONITORED_CAP): string[] =>
  rows.slice().sort((a, b) => b.changePct - a.changePct).slice(0, cap).map(r => r.symbol)

const row = (symbol: string, changePct: number, extra: Partial<RankedRow> = {}): RankedRow =>
  ({ symbol, changePct, rank: 0, momentumScore: null, offHighPct: null, rocPct: null,
     relativeVolume: null, volume: 0, float: null, premarketVolume: null, ...extra })

const mkRows = (n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => row(`S${i}`, f(i), { rank: i + 1 }))

const ctx: SweepContextIn = { sweepId: 'sw-1', runId: 'run-1', producerHead: 'head1', session: 'premarket' }
const env = (rows: RankedRow[]) => ({ rows, discovery: [] })
const coord = (rows: RankedRow[], cap = DEFAULT_MONITORED_CAP) =>
  new UniverseCoordinator({ fetchUniverse: async () => env(rows), monitoredCap: cap })

// ── A–J parity fixtures (daemon-selection level) ─────────────────────────────
const fixtures: Array<[string, RankedRow[]]> = [
  ['A normal breadth (20 distinct)', mkRows(20, i => 100 - i)],
  ['B >60 symbols', mkRows(65, i => 500 - i)],
  ['C >30 symbols', mkRows(35, i => 200 - i * 2)],
  ['D ties (equal changePct → stable order)', [
    row('T1', 50, { rank: 1 }), row('T2', 50, { rank: 2 }), row('T3', 50, { rank: 3 }),
    row('T4', 80, { rank: 4 }), row('T5', 50, { rank: 5 }), ...mkRows(14, i => 10 + i)]],
  ['E missing optional enrichment (null momentum/rvol/float)', mkRows(18, i => 90 - i)],
  ['H stale/missing provider (a few rows only)', mkRows(3, i => 30 - i)],
  ['I high-breadth monster day (40 high movers)', mkRows(40, i => 900 - i * 3)],
  ['J empty provider response', []],
  ['exact-15 (no truncation)', mkRows(15, i => 15 - i)],
  ['under-15', mkRows(9, i => 9 - i)],
  ['negative + zero changePct mix', mkRows(20, i => 50 - i * 6)],
]

describe('H3B coordinator parity (compatibility mode == legacy inline selection)', () => {
  for (const [name, rows] of fixtures) {
    it(`${name}: monitored symbols + ORDER identical to legacy`, () => {
      const legacy = legacyMonitored(rows)
      const snap = coord(rows).assemble(ctx, env(rows))
      expect(snap.monitoredSymbols).toEqual(legacy)                 // exact order parity
      expect([...snap.monitoredSymbols]).toHaveLength(Math.min(rows.length, DEFAULT_MONITORED_CAP))
    })
  }

  it('B/C/I truncate to exactly the cap; the cap is TOP_GAINERS_UNIVERSE=15', () => {
    expect(DEFAULT_MONITORED_CAP).toBe(15)
    expect(coord(mkRows(65, i => 500 - i)).assemble(ctx, env(mkRows(65, i => 500 - i))).monitoredSymbols).toHaveLength(15)
  })

  it('ties are broken by route order (stable sort) — matches legacy exactly', () => {
    const rows = [row('A', 50, { rank: 1 }), row('B', 50, { rank: 2 }), row('C', 60, { rank: 3 }), row('D', 50, { rank: 4 })]
    const snap = coord(rows, 3).assemble(ctx, env(rows))
    expect(snap.monitoredSymbols).toEqual(legacyMonitored(rows, 3))
    expect(snap.monitoredSymbols).toEqual(['C', 'A', 'B'])          // C(60) first; A,B tie at 50 keep input order
  })
})

describe('H3B SweepSnapshot contract', () => {
  it('propagates sweepId / runId / producerHead / session and stamps schema + policy', () => {
    const snap = coord(mkRows(5, i => 5 - i)).assemble(ctx, env(mkRows(5, i => 5 - i)))
    expect(snap.sweepId).toBe('sw-1'); expect(snap.runId).toBe('run-1')
    expect(snap.producerHead).toBe('head1'); expect(snap.session).toBe('premarket')
    expect(snap.schemaVersion).toBe(SWEEP_SNAPSHOT_SCHEMA_VERSION)
    expect(snap.policy).toBe('LEGACY_COMPAT')
    expect(snap.universeSizeBefore).toBe(5); expect(snap.universeSizeAfter).toBe(5)
  })

  it('is immutable-by-convention (frozen; mutation throws in strict mode)', () => {
    const snap = coord(mkRows(4, i => 4 - i)).assemble(ctx, env(mkRows(4, i => 4 - i)))
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.monitoredUniverse)).toBe(true)
    expect(Object.isFrozen(snap.monitoredSymbols)).toBe(true)
    expect(() => { (snap.monitoredSymbols as string[]).push('X') }).toThrow()
    expect(() => { (snap as { policy: string }).policy = 'X' }).toThrow()
  })

  it('buildSweep calls the injected fetcher EXACTLY ONCE (zero extra provider work)', async () => {
    let calls = 0
    const rows = mkRows(6, i => 6 - i)
    const c = new UniverseCoordinator({ fetchUniverse: async () => { calls++; return env(rows) } })
    const snap = await c.buildSweep(ctx)
    expect(calls).toBe(1)
    expect(snap.monitoredSymbols).toEqual(legacyMonitored(rows))
  })

  it('empty provider response → empty monitored universe (no throw)', async () => {
    const c = new UniverseCoordinator({ fetchUniverse: async () => ({ rows: [], discovery: [] }) })
    const snap = await c.buildSweep(ctx)
    expect(snap.monitoredSymbols).toEqual([])
    expect(snap.universeSizeBefore).toBe(0)
  })
})

// The canonical snapshot must carry the COMPLETE pre-trigger truth so H3C can observe a symbol
// BEFORE the top-30 truncation, without re-reading the JSONL.
describe('H3B snapshot completeness for H3C', () => {
  const disc = (symbol: string, o: Partial<import('../src/lib/universe/discovery-provenance').DiscoverySymbolProv> = {}) =>
    ({ symbol, sources: [{ source: 'fmp', rank: 1, changePct: 50 }], winningSource: 'fmp', changePct: 50,
       mergedEligible: false, exclusionReason: null, pre60Rank: null, survived60: false, pre30Rank: null,
       survived30: false, routeRank: null, ...o })
  const envFull = {
    rows: [row('A', 90, { rank: 1 })],
    discovery: [
      disc('A', { mergedEligible: true, survived60: true, survived30: true, pre60Rank: 1, pre30Rank: 1, routeRank: 1 }),
      disc('MID', { survived60: true, survived30: false, pre60Rank: 45, pre30Rank: 31 }),   // in top60, NOT top30
      disc('LOW', { survived60: false, pre60Rank: 62 }),                                     // outside the 60-pool
      disc('ETFX', { exclusionReason: 'excluded_non_common_stock' }),                        // excluded at merge
    ],
  }
  const c = new UniverseCoordinator({ fetchUniverse: async () => envFull })

  it('snapshot.discovery carries every stage: pre60/60/pre30/30 + exclusions', async () => {
    const snap = await c.buildSweep(ctx)
    expect(snap.discovery).toHaveLength(4)
    const mid = snap.discovery.find(d => d.symbol === 'MID')!
    expect(mid.survived60).toBe(true); expect(mid.survived30).toBe(false)  // observable BEFORE top-30 truncation
    expect(snap.discovery.find(d => d.symbol === 'ETFX')!.exclusionReason).toBe('excluded_non_common_stock')
    // H3C query: symbols that reached the 60-pool but were truncated before top-30
    const preTop30 = snap.discovery.filter(d => d.survived60 && !d.survived30).map(d => d.symbol)
    expect(preTop30).toContain('MID')
  })

  it('is DEEP-frozen: nested rows, discovery entries and source arrays cannot be mutated', async () => {
    const snap = await c.buildSweep(ctx)
    expect(Object.isFrozen(snap.discovery)).toBe(true)
    expect(Object.isFrozen(snap.discovery[0])).toBe(true)
    expect(Object.isFrozen(snap.discovery[0].sources)).toBe(true)
    expect(Object.isFrozen(snap.discovery[0].sources[0])).toBe(true)
    expect(Object.isFrozen(snap.rawDiscovery[0])).toBe(true)
    expect(Object.isFrozen(snap.monitoredUniverse[0])).toBe(true)
    // one consumer cannot mutate what another sees
    expect(() => { (snap.rawDiscovery[0] as { changePct: number }).changePct = 0 }).toThrow()
    expect(() => { (snap.discovery[0] as { mergedEligible: boolean }).mergedEligible = false }).toThrow()
    expect(() => { (snap.discovery[0].sources[0] as { rank: number }).rank = 99 }).toThrow()
    expect(() => { (snap.discovery[0].sources as unknown[]).push({}) }).toThrow()
  })
})

describe('H3B selectMonitoredUniverse (shared pure fn)', () => {
  it('is the single implementation and equals the legacy expression', () => {
    const rows = mkRows(50, i => (i * 37) % 100)   // scrambled changePct
    expect(selectMonitoredUniverse(rows).symbols).toEqual(legacyMonitored(rows))
    expect(selectMonitoredUniverse(rows, 7).symbols).toEqual(legacyMonitored(rows, 7))
  })
})
