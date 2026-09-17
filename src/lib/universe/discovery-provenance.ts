/**
 * H3B — pure assembly of the per-symbol discovery/merge/rank provenance that the
 * /api/gainers route records (telemetry only). Extracted so the logic is unit-testable
 * without the route's provider I/O. Every input map is populated AT the route's decision
 * points (all-sources at merge, exact reason at each filter, ranks at each truncation) —
 * this function only shapes them, it never infers a reason.
 */
export interface ProvUniverseEntry {
  symbol: string
  webull?: boolean
  yfChangePct?: number
  changesPercentage?: number | string
}
export interface ProvRankedRow { symbol: string; rank?: number }
export interface RankProvEntry { pre60Rank?: number; survived60?: boolean; pre30Rank?: number; survived30?: boolean; routeRank?: number }

export interface DiscoverySymbolProv {
  symbol: string
  sources: string[]
  winningSource: string | null
  changePct: number
  mergedEligible: boolean
  exclusionReason: string | null   // null = survived to the ranked pool
  pre60Rank: number | null
  survived60: boolean
  pre30Rank: number | null
  survived30: boolean
  routeRank: number | null
}

export function assembleDiscoveryProvenance(
  universe: ProvUniverseEntry[],
  ranked: ProvRankedRow[],
  allSources: Map<string, string[]>,
  dropReason: Map<string, string>,
  rankProv: Map<string, RankProvEntry>,
): DiscoverySymbolProv[] {
  const rankedSymbols = new Set(ranked.map(r => r.symbol))
  const rankMap = new Map(ranked.map(r => [r.symbol, r.rank ?? null]))
  const discovered: DiscoverySymbolProv[] = universe.map(g => {
    const p = rankProv.get(g.symbol)
    return {
      symbol: g.symbol,
      sources: allSources.get(g.symbol) ?? [],
      winningSource: g.webull ? 'webull' : (g.yfChangePct !== undefined ? 'yahoo' : 'fmp'),
      changePct: typeof g.changesPercentage === 'number' ? g.changesPercentage : Number(g.changesPercentage ?? 0),
      mergedEligible: rankedSymbols.has(g.symbol),
      exclusionReason: dropReason.get(g.symbol) ?? null,
      pre60Rank: p?.pre60Rank ?? null, survived60: p?.survived60 ?? false,
      pre30Rank: p?.pre30Rank ?? null, survived30: p?.survived30 ?? false,
      routeRank: rankMap.get(g.symbol) ?? null,
    }
  })
  // Symbols excluded at the MERGE stage never entered `universe`; surface them too so the
  // "did we ever discover X?" question is fully answerable from one event.
  const inUniverse = new Set(universe.map(g => g.symbol))
  const excludedAtMerge: DiscoverySymbolProv[] = [...dropReason.entries()]
    .filter(([sym]) => !inUniverse.has(sym))
    .map(([symbol, exclusionReason]) => ({
      symbol, sources: allSources.get(symbol) ?? [], winningSource: null, changePct: 0,
      mergedEligible: false, exclusionReason,
      pre60Rank: null, survived60: false, pre30Rank: null, survived30: false, routeRank: null,
    }))
  return [...discovered, ...excludedAtMerge]
}
