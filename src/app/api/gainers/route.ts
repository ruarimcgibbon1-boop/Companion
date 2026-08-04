import { NextResponse } from 'next/server'
import { getTopGainers, getMostActive, getBatchQuotes, getStockNews, getPressReleases, getFloatShares, getDailyCandles, getExtendedIntradayCandles } from '@/lib/fmp-client'
import { getYFQuote, getYFScreener, getYFTrending, getYFCandles } from '@/lib/yahoo-client'
import { cached, TTL, cache } from '@/lib/cache'
import { processNews, getBestCatalystSummary } from '@/lib/news-engine'
import type { ScannerRow, ScannerFilters, BadgeType, Badge } from '@/types'
import { getSessionType, isPremarket } from '@/lib/market-hours'
import { sessionFractionElapsed } from '@/lib/technical'
import { premarketVolumeProfile, etDateNow, etHHMMNow } from '@/lib/premarket-volume'
import { getWebullGainers, type WebullRankType } from '@/lib/webull-client'

const EXCLUDED_TERMS = [
  'etf', 'fund', 'trust', 'warrant', 'right ', 'unit ', 'preferred', 'pref',
  'acquisition corp', 'blank check',
]

function isExcluded(name: string, symbol: string, exchange?: string): boolean {
  const lower = name.toLowerCase()
  if (EXCLUDED_TERMS.some(t => lower.includes(t))) return true
  if (/[WRU]$/.test(symbol) && symbol.length > 4) return true
  const ex = (exchange ?? '').toUpperCase()
  if (ex === 'CRYPTO' || ex === 'FOREX' || ex === 'COMMODITY') return true
  return false
}

function assignBadges(row: {
  relativeVolume: number | null
  changePct: number
  catalystCategory: string
  catalystLabel: string
  float: number | null
}): Badge[] {
  const badges: Badge[] = []
  const add = (type: BadgeType) => badges.push({ type, label: type })

  if (row.relativeVolume && row.relativeVolume >= 3) add('High RVOL')
  if (row.float && row.float < 10_000_000) add('Low Float')
  if (row.catalystLabel !== 'No Recent Catalyst Found') add('Fresh News')
  if (row.catalystLabel === 'Negative or Dilutive Catalyst') add('Dilution Risk')
  if (row.changePct > 50 && row.relativeVolume && row.relativeVolume > 8) add('Halt Risk')
  if (row.changePct > 30) add('Extended')
  if (row.catalystLabel === 'No Recent Catalyst Found') add('No Catalyst')

  return badges
}

// Fraction of the regular session elapsed, floored at 0.05 so an early-session or
// premarket row is compared against a small slice of a day rather than dividing by
// ~zero. The unclamped ET-correct calculation lives in technical.ts — one source of
// truth, since RVOL means the same thing in the scanner and in the signal engine.
function scannerSessionFraction(): number {
  return Math.max(sessionFractionElapsed(), 0.05)
}

/**
 * Fill in the RVOL the primary sources can't supply.
 *
 * Every one of the day's real movers showed "—": FMP's /quote no longer returns
 * `averageVolume` at all (the field is absent from the response, verified
 * 2026-08-03), and Yahoo's day_gainers screener — the only source that does carry
 * an average — has a size floor that excludes exactly the sub-$300M names that gap
 * 100%+. So the rows with no baseline were the rows we most wanted to rank.
 *
 * Regular hours: derive the 20-day average from daily candles (the same fallback
 * the monitor already uses) off the shared `daily:` cache key.
 *
 * Premarket: the day-pace calculation does not apply, and the candle feed reports
 * premarket volume as 0, so use the real premarket measure — today's premarket
 * volume vs this name's own typical premarket volume by this time of day. Shares
 * the `pmvol:` cache key with the monitor, so the column now reads the same number
 * the premarket signal gate is judging.
 *
 * Runs on the ranked rows only (≤30) and never overwrites a value we already have.
 */
async function backfillRelativeVolume(rows: ScannerRow[], inPremarket: boolean): Promise<void> {
  await Promise.allSettled(rows.map(async r => {
    if (inPremarket) {
      const profile = await cached(`pmvol:${r.symbol}`, TTL.PREMARKET_VOL, async () => {
        const candles = await getExtendedIntradayCandles(r.symbol)
        if (candles.length === 0) return null
        return premarketVolumeProfile(candles, { todayEt: etDateNow(), throughHHMM: etHHMMNow() })
      })
      if (!profile) return
      if (profile.relativeVolume != null) r.relativeVolume = profile.relativeVolume
      // Only trust the number when the feed actually captured the tape. A tiny
      // "measured" reading (HYFM's 55 premarket shares) is missing coverage, not
      // thin liquidity — writing it here would let the premarket volume floor drop
      // the very rockets we want to surface. When unmeasured, leave premarketVolume
      // null (unknown) so the row survives and is ranked on price/change instead.
      if (profile.measured && profile.todayVolume > 0) {
        r.premarketVolume = profile.todayVolume
        if (r.volume === 0) r.volume = profile.todayVolume
      }
      return
    }
    if (r.relativeVolume != null || r.volume <= 0) return
    const daily = await cached(`daily:${r.symbol}`, TTL.CANDLES_DAILY, () => getDailyCandles(r.symbol))
    if (daily.length < 5) return
    const recent = daily.slice(-20)
    const avgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length
    if (avgVol > 0) r.relativeVolume = r.volume / (avgVol * scannerSessionFraction())
  }))
}

// Real premarket price for a symbol. Yahoo's meta.preMarketPrice is unreliable
// (undefined for thin micro-caps), so we take the freshest premarket candle close
// — the same candle path the monitor uses — and the previous close from the quote.
// Candles are cached under the shared `candles1m:` key, so this doesn't double-hit.
interface PMData { price: number; volume: number; prevClose: number }
async function getPremarketQuote(sym: string): Promise<PMData | null> {
  try {
    const [candles, q] = await Promise.all([
      cached(`candles1m:${sym}`, TTL.CANDLES_1M, async () => {
        try {
          const yf = await getYFCandles(sym, '1min')
          if (yf.length > 0) return yf
        } catch { /* fall through */ }
        const { getIntradayCandles } = await import('@/lib/fmp-client')
        return getIntradayCandles(sym, '1min')
      }),
      cached(`yfquote:${sym}`, TTL.QUOTE, () => getYFQuote(sym)),
    ])
    const prevClose = q?.previousClose ?? null
    if (!candles.length || !prevClose) return null

    // Today's premarket bars (ET date prefix works for both ISO-offset and plain formats)
    const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
    const todays = candles.filter(c => c.date.startsWith(todayEt))
    const series = todays.length ? todays : candles
    const latest = series[series.length - 1]
    const price = latest?.close
    if (!price) return null
    const volume = todays.reduce((s, c) => s + c.volume, 0)
    return { price, volume, prevClose }
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const forceRefresh = searchParams.get('refresh') === '1'

  const filters: ScannerFilters = {
    minPrice: Number(searchParams.get('minPrice') ?? 1),
    maxPrice: Number(searchParams.get('maxPrice') ?? 300),
    minChangePct: Number(searchParams.get('minChangePct') ?? 5),
    maxChangePct: Number(searchParams.get('maxChangePct') ?? 1000),
    minVolume: Number(searchParams.get('minVolume') ?? 500000),
    minRelativeVolume: Number(searchParams.get('minRvol') ?? 0),
    minMarketCap: searchParams.get('minMktCap') ? Number(searchParams.get('minMktCap')) : null,
    maxMarketCap: searchParams.get('maxMktCap') ? Number(searchParams.get('maxMktCap')) : null,
    maxFloat: searchParams.get('maxFloat') ? Number(searchParams.get('maxFloat')) : null,
    exchanges: ['NASDAQ', 'NYSE', 'AMEX'],
    commonStocksOnly: searchParams.get('commonOnly') !== 'false',
    includeLowFloat: searchParams.get('includeLowFloat') !== 'false',
    sessionMode: 'regular',
    maxResults: Number(searchParams.get('maxResults') ?? 30),
    minNewsRecencyHours: null,
  }

  const sessionType = getSessionType()
  const inPremarket = isPremarket(Date.now())

  try {
    if (forceRefresh) {
      cache.delete('gainers')
      cache.delete('mostActive')
      cache.delete('yfGainers')
      cache.delete('yfSmallCap')
      cache.delete('yfActives')
      cache.delete('yfTrending')
      cache.delete('batchQuotes:gainers')
      cache.delete('webullGainers:preMarket')
      cache.delete('webullGainers:afterMarket')
      cache.delete('webullGainers:1d')
    }

    // Universe strategy:
    // - Regular hours: Yahoo Finance day_gainers + most_actives (real-time, no auth)
    //   supplemented by FMP biggest-gainers for any symbols YF misses.
    // - Premarket: FMP biggest-gainers + most-active merged, then YF quote per symbol for gap%.
    // Webull is the ONLY source that surfaces fresh premarket rockets — FMP's
    // biggest-gainers lags to the prior session and doesn't carry sub-$1 low-floats
    // at all (QNME/ELPW had no FMP quote 2026-08-04), Yahoo's screeners are RTH +
    // size-floored. Webull's own premarket board returned exactly the day's movers.
    // Public ranking endpoint, no login; fails soft to [] so the scanner survives if
    // Webull is unreachable. Rank tracks the session.
    const webullRank: WebullRankType = inPremarket ? 'preMarket' : sessionType === 'afterhours' ? 'afterMarket' : '1d'

    const [yfGainers, yfSmallCap, yfActives, yfTrendingSyms, fmpGainers, fmpMostActive, webullGainers] = await Promise.all([
      !inPremarket ? cached('yfGainers', TTL.GAINERS, () => getYFScreener('day_gainers', 50)).catch(() => []) : Promise.resolve([]),
      !inPremarket ? cached('yfSmallCap', TTL.GAINERS, () => getYFScreener('small_cap_gainers', 25)).catch(() => []) : Promise.resolve([]),
      !inPremarket ? cached('yfActives', TTL.GAINERS, () => getYFScreener('most_actives', 50)).catch(() => []) : Promise.resolve([]),
      cached('yfTrending', TTL.GAINERS, () => getYFTrending(40)).catch(() => [] as string[]),
      cached('gainers', TTL.GAINERS, getTopGainers),
      cached('mostActive', TTL.GAINERS, getMostActive),
      cached(`webullGainers:${webullRank}`, TTL.GAINERS, () => getWebullGainers(webullRank)).catch(() => []),
    ])

    // Fetch YF quotes for trending symbols not already covered by screeners
    // (trending gives symbols only; we need price/change% from quote)
    // wb* fields carry Webull's own price/change so a name no other feed covers
    // (the sub-$1 rockets) still has real numbers to display and rank on.
    type UniverseEntry = { symbol: string; name?: string; price?: number; changesPercentage?: number | string; exchange?: string; yfChangePct?: number; yfVolume?: number; yfAvgVolume?: number | null; yfMarketCap?: number | null; wbPrice?: number | null; wbChangePct?: number; webull?: boolean }

    const screenerSymbols = new Set([...yfGainers, ...yfSmallCap, ...yfActives].map(r => r.symbol))
    const trendingOnly = (yfTrendingSyms as string[]).filter(s => !screenerSymbols.has(s))

    const trendingQuotes = await Promise.allSettled(
      trendingOnly.map(async sym => {
        const q = await cached(`yfquote:${sym}`, TTL.QUOTE, () => getYFQuote(sym))
        if (!q || !q.previousClose || q.price <= 0) return null
        const changePct = ((q.price - q.previousClose) / q.previousClose) * 100
        return {
          symbol: sym,
          name: '',
          price: q.price,
          changesPercentage: changePct,
          exchange: '',
          yfChangePct: changePct,
          yfVolume: q.regularMarketVolume,
          yfMarketCap: null,
        } as UniverseEntry
      })
    )
    const trendingRows: UniverseEntry[] = trendingQuotes
      .filter(r => r.status === 'fulfilled' && r.value != null)
      .map(r => (r as PromiseFulfilledResult<UniverseEntry>).value)

    // Merge all sources, deduplicate by symbol
    const seen = new Set<string>()

    const yfRows: UniverseEntry[] = [...yfGainers, ...yfSmallCap, ...yfActives].map(r => ({
      symbol: r.symbol,
      name: r.name,
      price: r.price,
      changesPercentage: r.changePct,
      exchange: r.exchange,
      yfChangePct: r.changePct,
      yfVolume: r.volume,
      yfAvgVolume: r.avgVolume,
      yfMarketCap: r.marketCap,
    }))
    const fmpRows: UniverseEntry[] = [...fmpGainers, ...fmpMostActive]

    const webullRows: UniverseEntry[] = webullGainers.map(w => ({
      symbol: w.symbol,
      name: '',
      price: w.price ?? undefined,
      changesPercentage: w.changePct,
      exchange: w.exchange,
      wbPrice: w.price,
      wbChangePct: w.changePct,
      webull: true,
    }))

    // Webull first so its fresh premarket movers seed the universe; FMP/Yahoo rows
    // for the same symbol are deduped out but their richer data is re-joined by the
    // per-symbol quote/candle fetches below.
    const universe = [...webullRows, ...yfRows, ...trendingRows, ...fmpRows].filter(g => {
      if (!g.symbol || seen.has(g.symbol)) return false
      seen.add(g.symbol)
      if (filters.commonStocksOnly && isExcluded(g.name ?? '', g.symbol, g.exchange)) return false
      return true
    })

    const symbols = universe.map(g => g.symbol)

    // Always fetch quotes for name/exchange/avgVolume
    const quotes = await cached(
      'batchQuotes:gainers',
      TTL.BATCH_QUOTE,
      () => getBatchQuotes(symbols)
    )
    const quoteMap = new Map(quotes.map(q => [q.symbol, q]))

    // During premarket: use YF quote for each symbol to get real premarket price.
    // This is a single small request per symbol (~50ms) vs fetching full 1min candles.
    const pmDataMap = new Map<string, PMData>()
    if (inPremarket) {
      const pmResults = await Promise.allSettled(
        symbols.map(async sym => {
          const data = await getPremarketQuote(sym)
          return { sym, data }
        })
      )
      for (const r of pmResults) {
        if (r.status === 'fulfilled' && r.value.data) {
          pmDataMap.set(r.value.sym, r.value.data)
        }
      }
    }

    // Catalyst is fetched AFTER ranking (below) — only for the rows we actually
    // display — so every visible mover gets a news lookup, not just the first 8.

    // Float — a core "in play" dimension (low float = violent moves). Fetched from
    // FMP shares-float, cached 6h since it changes only on filings. Some micro-caps
    // return glitchy tiny values (e.g. INLF reported 4,263 shares); treat anything
    // under 10k as bad data (null) rather than a fake ultra-low-float flag.
    const floatMap = new Map<string, number | null>()
    await Promise.allSettled(
      symbols.map(async sym => {
        floatMap.set(sym, await cached(`floatShares:${sym}`, TTL.FLOAT, () => getFloatShares(sym)))
      })
    )

    // Premarket volume is inherently lower — relax the floor to 5% of normal.
    const effectiveMinVolume = inPremarket ? filters.minVolume * 0.05 : filters.minVolume
    // Premarket: allow sub-$1 gappers (the day's low-float rockets — QNME $0.31,
    // ELPW $0.10 — live below the $1 default floor). Highest-risk/thinnest names, by
    // explicit choice. RTH keeps the normal floor.
    const effectiveMinPrice = inPremarket ? Math.min(filters.minPrice, 0.05) : filters.minPrice

    const rows: ScannerRow[] = universe
      .map((g: UniverseEntry, i: number) => {
        const q = quoteMap.get(g.symbol)
        const pm = inPremarket ? pmDataMap.get(g.symbol) : undefined

        // Reject non-equity symbols — but only use FMP exchange when we don't have a YF
        // source confirming it's equity (FMP misclassifies some tickers e.g. USDE as CRYPTO)
        const gExchange = (g.exchange ?? '').toUpperCase()
        const qExchange = (q?.exchange ?? '').toUpperCase()
        // If row came from YF screener/trending (has yfChangePct, non-empty exchange or no fmp mismatch), trust YF
        const isFmpCryptoMisclassification = g.yfChangePct !== undefined && ['CRYPTO','FOREX','COMMODITY'].includes(qExchange) && !['CRYPTO','FOREX','COMMODITY'].includes(gExchange)
        if (!isFmpCryptoMisclassification) {
          const quoteExchange = qExchange || gExchange
          if (['CRYPTO', 'FOREX', 'COMMODITY'].includes(quoteExchange)) return null
        }

        let price: number
        let changePct: number
        let prevClose: number

        if (inPremarket && pm) {
          // Real premarket gap: YF premarket price vs previous regular-session close
          price = pm.price
          prevClose = pm.prevClose
          changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0
        } else if (g.yfChangePct !== undefined && g.price) {
          // YF screener row — already has real-time price and change%
          price = g.price
          changePct = g.yfChangePct
          prevClose = q?.previousClose ?? 0
        } else if (g.webull && !q?.price && !(pm?.price)) {
          // Webull-discovered name that no other feed covers (the sub-$1 rockets):
          // use Webull's own price/change so it still displays and ranks instead of
          // being dropped for a missing FMP/Yahoo quote.
          price = g.wbPrice ?? 0
          changePct = g.wbChangePct ?? 0
          prevClose = price > 0 && changePct > -100 ? price / (1 + changePct / 100) : 0
        } else {
          // FMP-only row: use quote data
          price = q?.price ?? g.price ?? 0
          prevClose = q?.previousClose ?? 0
          changePct = prevClose > 0
            ? ((price - prevClose) / prevClose) * 100
            : (q?.changePercentage ?? Number(g.changesPercentage ?? 0))
        }

        // Webull is the premarket discovery authority for thin names. When the
        // FMP/Yahoo enrichment disagrees and would drop a name Webull flags as a real
        // gainer, trust Webull's own price/change. ELPW (2026-08-04): Yahoo's
        // premarket path read $0.18 vs a stale $0.175 prevClose = +2.7% and the
        // gainer filter dropped it, while FMP AND Webull agreed it was $0.10 / +67%.
        // Only overrides UP to a real gainer — a higher fresh gap (RAIN via Yahoo,
        // +111% > Webull's +97%) is left alone.
        if (g.webull && g.wbChangePct != null && g.wbPrice && g.wbChangePct >= filters.minChangePct && g.wbChangePct > changePct) {
          price = g.wbPrice
          changePct = g.wbChangePct
          prevClose = changePct > -100 ? price / (1 + changePct / 100) : prevClose
        }

        // NOTE: `||` not `??` on purpose. The premarket candle sum comes back as 0
        // (the Yahoo feed returns premarket bars with price but no volume), and `??`
        // would treat that 0 as a real value — pinning every scanner row to vol 0 and
        // rvol null, which silently broke the MinVol and High-RVOL filters. A zero
        // here is always a data gap, so fall through to the quote's volume.
        const volume = pm?.volume || g.yfVolume || q?.volume || 0
        // Prefer YF screener's 3-month average daily volume; fall back to FMP quote's.
        const avgVol = (g.yfAvgVolume && g.yfAvgVolume > 0) ? g.yfAvgVolume : (q?.averageVolume ?? 0)
        // Session-adjusted relative volume: today's volume vs the normal pace by this time.
        const rvol = avgVol > 0 ? volume / (avgVol * scannerSessionFraction()) : null


        if (price < effectiveMinPrice || price > filters.maxPrice) return null
        // During premarket only show upside gappers (positive change)
        const absPct = Math.abs(changePct)
        if (absPct < filters.minChangePct || absPct > filters.maxChangePct) return null
        if (inPremarket && changePct <= 0) return null  // skip stocks gapping down in premarket scanner
        // Volume floor: RTH only. In premarket the `volume` here is often a stale
        // regular-session fallback (RAIN's 20k FMP volume tripped the floor and
        // dropped a +110% gapper) — premarket volume is measured later in the
        // backfill and screened there on the real number.
        if (!inPremarket && volume > 0 && volume < effectiveMinVolume) return null
        if (filters.minRelativeVolume > 0 && rvol !== null && rvol < filters.minRelativeVolume) return null

        const float = floatMap.get(g.symbol) ?? null
        // Only exclude on maxFloat when we actually know the float — never drop a
        // name for missing data.
        if (filters.maxFloat != null && float != null && float > filters.maxFloat) return null

        // Catalyst + badges are attached after ranking (see below), so leave
        // placeholders here.
        const premarketChange = pm ? pm.price - prevClose : null
        const premarketChangePct = pm && prevClose > 0 ? ((pm.price - prevClose) / prevClose) * 100 : null

        return {
          rank: i + 1,
          symbol: g.symbol,
          name: g.name ?? q?.name ?? '',
          price,
          changePct: inPremarket ? (premarketChangePct ?? changePct) : changePct,
          volume,
          relativeVolume: rvol,
          float,
          marketCap: g.yfMarketCap ?? q?.marketCap ?? null,
          exchange: g.exchange ?? '',
          catalystLabel: 'No Recent Catalyst Found' as const,
          catalystCategory: 'No Catalyst' as const,
          setupScore: 50,
          status: 'Developing' as const,
          badges: [] as Badge[],
          lastUpdate: Date.now(),
          premarketChangePct,
          premarketChange,
          premarketVolume: pm?.volume ?? null,
          bid: null,
          ask: null,
          spread: null,
          latestTradeTime: q?.timestamp ? q.timestamp * 1000 : null,
        } as ScannerRow
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, filters.maxResults)
      .map((r, i) => ({ ...r, rank: i + 1 }))

    // RVOL backfill for the ranked rows only — before badges, which read it.
    await backfillRelativeVolume(rows, inPremarket)
    // Re-apply the volume floors now that the previously-unknown rows have numbers.
    // The pass during mapping can only drop a row whose RVOL was already known, so
    // without this a High-RVOL filter still let every baseline-less name through —
    // and in premarket every row arrived with volume 0 (feed gap), so nothing could
    // be screened on volume at all. Rows still lacking a measurement are kept: never
    // drop a name for missing data.
    const ranked = rows
      .filter(r => filters.minRelativeVolume <= 0 || r.relativeVolume == null || r.relativeVolume >= filters.minRelativeVolume)
      .filter(r => !inPremarket || r.premarketVolume == null || r.premarketVolume >= effectiveMinVolume)
      .map((r, i) => ({ ...r, rank: i + 1 }))

    // Catalyst enrichment for the ranked rows only. Merge press-releases with the
    // news feed (PR first — the original, freshest wire) so a gapper's actual
    // headline drives the label, and derive the real category + quality via
    // getBestCatalystSummary. Cached 3 min per symbol.
    await Promise.allSettled(
      ranked.map(async r => {
        const [pr, news] = await Promise.all([
          cached(`pr:${r.symbol}`, TTL.NEWS, () => getPressReleases(r.symbol, 8)),
          cached(`news:${r.symbol}`, TTL.NEWS, () => getStockNews(r.symbol, 8)),
        ])
        const processed = processNews([...pr, ...news], r.symbol)
        const c = getBestCatalystSummary(processed)
        r.catalystLabel = c.quality
        r.catalystCategory = c.category
        r.badges = assignBadges({
          relativeVolume: r.relativeVolume,
          changePct: Math.abs(r.changePct),
          catalystCategory: c.category,
          catalystLabel: c.quality,
          float: r.float,
        })
      })
    )

    return NextResponse.json({ rows: ranked, sessionType, timestamp: Date.now() })
  } catch (err) {
    console.error('gainers route error:', err)
    return NextResponse.json({ error: 'Failed to fetch gainers' }, { status: 500 })
  }
}
