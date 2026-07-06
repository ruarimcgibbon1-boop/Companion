import { NextResponse } from 'next/server'
import { getTopGainers, getMostActive, getBatchQuotes, getStockNews } from '@/lib/fmp-client'
import { getYFQuote, getYFScreener, getYFTrending, getYFCandles } from '@/lib/yahoo-client'
import { cached, TTL, cache } from '@/lib/cache'
import { processNews } from '@/lib/news-engine'
import type { ScannerRow, ScannerFilters, BadgeType, Badge } from '@/types'
import { getSessionType, isPremarket } from '@/lib/market-hours'

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

// Fraction of the 9:30–16:00 ET regular session elapsed (clamped 0.05–1) so
// relative volume is time-of-day adjusted rather than compared to a full day.
function sessionFractionElapsed(): number {
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
  const [h, m] = et.split(':').map(Number)
  const mins = h * 60 + m
  const open = 9 * 60 + 30, close = 16 * 60
  if (mins >= close) return 1
  if (mins <= open) return 0.05   // premarket — compare against a small slice of the day
  return Math.max(0.05, (mins - open) / (close - open))
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
    }

    // Universe strategy:
    // - Regular hours: Yahoo Finance day_gainers + most_actives (real-time, no auth)
    //   supplemented by FMP biggest-gainers for any symbols YF misses.
    // - Premarket: FMP biggest-gainers + most-active merged, then YF quote per symbol for gap%.
    const [yfGainers, yfSmallCap, yfActives, yfTrendingSyms, fmpGainers, fmpMostActive] = await Promise.all([
      !inPremarket ? cached('yfGainers', TTL.GAINERS, () => getYFScreener('day_gainers', 50)).catch(() => []) : Promise.resolve([]),
      !inPremarket ? cached('yfSmallCap', TTL.GAINERS, () => getYFScreener('small_cap_gainers', 25)).catch(() => []) : Promise.resolve([]),
      !inPremarket ? cached('yfActives', TTL.GAINERS, () => getYFScreener('most_actives', 50)).catch(() => []) : Promise.resolve([]),
      cached('yfTrending', TTL.GAINERS, () => getYFTrending(40)).catch(() => [] as string[]),
      cached('gainers', TTL.GAINERS, getTopGainers),
      cached('mostActive', TTL.GAINERS, getMostActive),
    ])

    // Fetch YF quotes for trending symbols not already covered by screeners
    // (trending gives symbols only; we need price/change% from quote)
    type UniverseEntry = { symbol: string; name?: string; price?: number; changesPercentage?: number | string; exchange?: string; yfChangePct?: number; yfVolume?: number; yfAvgVolume?: number | null; yfMarketCap?: number | null }

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

    const universe = [...yfRows, ...trendingRows, ...fmpRows].filter(g => {
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

    // News for top 8 only
    const newsMap = new Map<string, string>()
    await Promise.allSettled(
      symbols.slice(0, 8).map(async sym => {
        const news = await cached(`news:${sym}`, TTL.NEWS, () => getStockNews(sym, 5))
        const processed = processNews(news, sym)
        if (processed.length > 0) newsMap.set(sym, processed[0].quality)
      })
    )

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
        } else {
          // FMP-only row: use quote data
          price = q?.price ?? g.price ?? 0
          prevClose = q?.previousClose ?? 0
          changePct = prevClose > 0
            ? ((price - prevClose) / prevClose) * 100
            : (q?.changePercentage ?? Number(g.changesPercentage ?? 0))
        }

        const volume = pm?.volume ?? g.yfVolume ?? q?.volume ?? 0
        // Prefer YF screener's 3-month average daily volume; fall back to FMP quote's.
        const avgVol = (g.yfAvgVolume && g.yfAvgVolume > 0) ? g.yfAvgVolume : (q?.averageVolume ?? 0)
        // Session-adjusted relative volume: today's volume vs the normal pace by this time.
        const rvol = avgVol > 0 ? volume / (avgVol * sessionFractionElapsed()) : null

        // Premarket volume is inherently lower — relax filter to 5% of normal
        const effectiveMinVolume = inPremarket ? filters.minVolume * 0.05 : filters.minVolume

        if (price < filters.minPrice || price > filters.maxPrice) return null
        // During premarket only show upside gappers (positive change)
        const absPct = Math.abs(changePct)
        if (absPct < filters.minChangePct || absPct > filters.maxChangePct) return null
        if (inPremarket && changePct <= 0) return null  // skip stocks gapping down in premarket scanner
        if (volume > 0 && volume < effectiveMinVolume) return null
        if (filters.minRelativeVolume > 0 && rvol !== null && rvol < filters.minRelativeVolume) return null

        const catalystLabel = (newsMap.get(g.symbol) ?? 'No Recent Catalyst Found') as ScannerRow['catalystLabel']
        const badges = assignBadges({ relativeVolume: rvol, changePct: absPct, catalystCategory: '', catalystLabel, float: null })

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
          float: null as number | null,
          marketCap: g.yfMarketCap ?? q?.marketCap ?? null,
          exchange: g.exchange ?? '',
          catalystLabel,
          catalystCategory: 'No Catalyst' as const,
          setupScore: 50,
          status: 'Developing' as const,
          badges,
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

    return NextResponse.json({ rows, sessionType, timestamp: Date.now() })
  } catch (err) {
    console.error('gainers route error:', err)
    return NextResponse.json({ error: 'Failed to fetch gainers' }, { status: 500 })
  }
}
