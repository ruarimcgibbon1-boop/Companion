import { NextResponse } from 'next/server'
import { getTopGainers, getBatchQuotes, getStockNews } from '@/lib/fmp-client'
import { getYFCandles } from '@/lib/yahoo-client'
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

// Fetch 1min extended candles and return { latestPrice, premarketVolume } for a symbol.
// Uses the same cache key as the chart so we don't double-hit FMP.
async function getPremarketData(sym: string): Promise<{ price: number; volume: number } | null> {
  try {
    const candles = await cached(`candles1m:${sym}`, TTL.CANDLES_1M, async () => {
      try {
        const yf = await getYFCandles(sym, '1min')
        if (yf.length > 0) return yf
      } catch { /* fall through */ }
      const { getIntradayCandles } = await import('@/lib/fmp-client')
      return getIntradayCandles(sym, '1min')
    })
    if (!candles.length) return null
    // Latest candle is current premarket price
    const latest = candles[candles.length - 1]
    // Sum volume of all candles from today's date (ET date string prefix)
    const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
    const pmVolume = candles
      .filter(c => c.date.startsWith(todayEt))
      .reduce((s, c) => s + c.volume, 0)
    return { price: latest.close, volume: pmVolume }
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
      cache.delete('batchQuotes:gainers')
    }

    const gainers = await cached('gainers', TTL.GAINERS, getTopGainers)

    const preFiltered = gainers.filter(g => {
      if (!g.symbol) return false
      if (filters.commonStocksOnly && isExcluded(g.name ?? '', g.symbol, g.exchange)) return false
      return true
    })

    const symbols = preFiltered.map(g => g.symbol)

    // Always fetch quotes for name/exchange/previousClose/avgVolume
    const quotes = await cached(
      'batchQuotes:gainers',
      TTL.BATCH_QUOTE,
      () => getBatchQuotes(symbols)
    )
    const quoteMap = new Map(quotes.map(q => [q.symbol, q]))

    // During premarket: fetch 1min extended candles to get the real current price and PM volume.
    // Limit to top 25 symbols to keep latency reasonable — candles are cached 30s.
    let pmDataMap = new Map<string, { price: number; volume: number }>()
    if (inPremarket) {
      const pmResults = await Promise.allSettled(
        symbols.slice(0, 25).map(async sym => {
          const data = await getPremarketData(sym)
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

    const rows: ScannerRow[] = preFiltered
      .map((g: { symbol: string; name?: string; price?: number; changesPercentage?: number | string; exchange?: string }, i: number) => {
        const q = quoteMap.get(g.symbol)
        const pm = inPremarket ? pmDataMap.get(g.symbol) : undefined

        // Reject non-equity symbols
        const quoteExchange = (q?.exchange ?? g.exchange ?? '').toUpperCase()
        if (['CRYPTO', 'FOREX', 'COMMODITY'].includes(quoteExchange)) return null

        // In premarket: use candle price if available; fall back to quote price
        const price = pm?.price ?? q?.price ?? g.price ?? 0
        const prevClose = q?.previousClose ?? 0

        // Compute change% from candle price vs previousClose for accuracy
        const changePct = prevClose > 0
          ? Math.abs(((price - prevClose) / prevClose) * 100)
          : Math.abs(q?.changePercentage ?? Number(g.changesPercentage ?? 0))

        const volume = pm?.volume ?? q?.volume ?? 0
        const avgVol = q?.averageVolume ?? 0
        const rvol = avgVol > 0 ? volume / avgVol : null

        // Premarket volume is inherently lower — relax filter to 5% of normal
        const effectiveMinVolume = inPremarket ? filters.minVolume * 0.05 : filters.minVolume

        if (price < filters.minPrice || price > filters.maxPrice) return null
        if (changePct < filters.minChangePct || changePct > filters.maxChangePct) return null
        if (volume > 0 && volume < effectiveMinVolume) return null
        if (filters.minRelativeVolume > 0 && rvol !== null && rvol < filters.minRelativeVolume) return null

        const catalystLabel = (newsMap.get(g.symbol) ?? 'No Recent Catalyst Found') as ScannerRow['catalystLabel']
        const badges = assignBadges({ relativeVolume: rvol, changePct, catalystCategory: '', catalystLabel, float: null })

        const premarketChange = pm ? pm.price - prevClose : null
        const premarketChangePct = pm && prevClose > 0 ? ((pm.price - prevClose) / prevClose) * 100 : null

        return {
          rank: i + 1,
          symbol: g.symbol,
          name: g.name ?? '',
          price,
          changePct,
          volume,
          relativeVolume: rvol,
          float: null as number | null,
          marketCap: q?.marketCap ?? null,
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
