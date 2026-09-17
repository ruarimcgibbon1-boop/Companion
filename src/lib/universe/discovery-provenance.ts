/**
 * H3B — pure assembly of the per-symbol discovery/merge/rank provenance.
 *
 * This is the CANONICAL pre-trigger universe truth: it is both recorded in the funnel
 * (telemetry) AND returned in the daemon-only universe envelope so the coordinator can put
 * it in the live SweepSnapshot (H3C leader-state observation reads the snapshot, never the
 * JSONL). Every input map is populated AT the route's decision points (all-sources at merge,
 * exact reason at each filter, ranks at each truncation) — this function only shapes them.
 */

/** One source's observation of a symbol — available WITHOUT any new provider request. */
export interface SourceObservation {
  source: string           // webull | yahoo | yahoo_trending | fmp
  rank: number             // 1-based position within that source's list (the provider's own order)
  changePct: number | null // that source's raw change value, when it carries one
}
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
  sources: SourceObservation[]     // ALL sources that observed the symbol, with per-source rank + raw change
  winningSource: string | null     // the first-wins merge winner
  changePct: number
  mergedEligible: boolean           // survived to the final ranked pool
  exclusionReason: string | null    // null = survived; else the EXACT stage/reason it left the funnel
  pre60Rank: number | null
  survived60: boolean
  pre30Rank: number | null
  survived30: boolean
  routeRank: number | null
}

export function assembleDiscoveryProvenance(
  universe: ProvUniverseEntry[],
  ranked: ProvRankedRow[],
  allSources: Map<string, SourceObservation[]>,
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
