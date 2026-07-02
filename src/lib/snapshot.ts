/**
 * Assembles a full TickerSnapshot from raw FMP data + local calculations.
 */

import type { TickerSnapshot, CompanyProfile, DataQuality, ShortAvailability } from '@/types'
import { getQuote, getIntradayCandles, getDailyCandles, getProfile, getStockNews, getPressReleases, getSharesFloat } from './fmp-client'
import { getYFCandles, getYFQuote } from './yahoo-client'
import { calculateSessionLevels, calculateTechnical, calculateSupportResistance } from './technical'
import { calculatePullbackScenarios, calculateSetupScore, getWarnings } from './setup-engine'
import { processNews, getBestCatalystSummary } from './news-engine'
import { getSessionType } from './market-hours'
import { detectBreakout } from './breakout-engine'
import { buildTradePlans } from './trade-plans'
import { cached, TTL } from './cache'
import type { Candle } from '@/types'

function toCandles(raw: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): Candle[] {
  return raw.map(c => ({
    time: Math.floor(new Date(c.date).getTime() / 1000),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }))
}

function assessShortAvailability(
  floatShares: number | null,
  freeFloatPct: number | null,
  changePct: number
): ShortAvailability {
  // Classify borrow availability from float size + free float percentage.
  // No actual borrow rate data available from FMP — this is a proxy.
  const f = floatShares ?? null
  const ff = freeFloatPct ?? null

  let availability: ShortAvailability['availability'] = 'Unknown'
  let warning: string | null = null
  let squeezeRisk = false

  if (f !== null) {
    if (f < 1_000_000) {
      availability = 'HTB'
      warning = `Extremely low float (${(f / 1e6).toFixed(2)}M shares) — very likely Hard To Borrow. Short sellers face forced buy-ins; squeeze risk is elevated.`
      squeezeRisk = true
    } else if (f < 5_000_000) {
      availability = 'HTB'
      warning = `Low float (${(f / 1e6).toFixed(1)}M shares) — likely Hard To Borrow. Borrow fees may be high; any squeeze can be violent.`
      squeezeRisk = changePct > 20
    } else if (f < 15_000_000) {
      availability = 'Tight'
      warning = `Small float (${(f / 1e6).toFixed(1)}M shares) — borrow may be tight. Watch for HTB designation during strong moves.`
      squeezeRisk = changePct > 30
    } else if (f < 50_000_000) {
      availability = 'Moderate'
      warning = ff && ff > 70
        ? `Moderate float (${(f / 1e6).toFixed(0)}M, ${ff.toFixed(0)}% free) — shares to short are available but not abundant.`
        : null
    } else {
      availability = 'Easy'
      warning = `Large float (${(f / 1e6).toFixed(0)}M shares, ${ff ? ff.toFixed(0) + '% free' : 'high free float'}) — shorts are easily available. Selling pressure can emerge without a squeeze.`
    }
  }

  return { availability, floatShares: f, freeFloatPct: ff, warning, squeezeRisk }
}

function assessDataQuality(
  quote: Awaited<ReturnType<typeof getQuote>>,
  candleCount: number,
  dailyCount: number
): DataQuality {
  if (!quote) return 'Stale'
  const age = Date.now() - (quote.timestamp ?? 0) * 1000
  if (age > 300_000 || candleCount < 5 || dailyCount < 10) return 'Limited'
  if (age > 120_000 || candleCount < 20 || dailyCount < 50) return 'Acceptable'
  return 'High'
}

export async function buildSnapshot(symbol: string): Promise<TickerSnapshot | null> {
  try {
    const sym = symbol.toUpperCase()

    // Parallel data fetch
    const [quote, yfQuote, rawIntraday, rawDaily, profile, newsRaw, pressRaw, sharesFloat] = await Promise.all([
      cached(`quote:${sym}`, TTL.QUOTE, () => getQuote(sym)),
      cached(`yfquote:${sym}`, TTL.QUOTE, () => getYFQuote(sym)),
      cached(`candles1m:${sym}`, TTL.CANDLES_1M, async () => {
        try {
          const yf = await getYFCandles(sym, '1min')
          if (yf.length > 0) return yf
        } catch { /* fall through */ }
        return getIntradayCandles(sym, '1min')
      }),
      cached(`daily:${sym}`, TTL.CANDLES_DAILY, () => getDailyCandles(sym)),
      cached(`profile:${sym}`, TTL.PROFILE, () => getProfile(sym)),
      cached(`news:${sym}`, TTL.NEWS, () => getStockNews(sym, 20)),
      cached(`press:${sym}`, TTL.NEWS, () => getPressReleases(sym, 10)),
      cached(`float:${sym}`, TTL.CANDLES_DAILY, () => getSharesFloat(sym)),
    ])

    if (!quote) return null

    // Reject crypto and non-equity symbols — they have no intraday candles and mislead the plans
    const exchange = (quote.exchange ?? '').toUpperCase()
    if (exchange === 'CRYPTO' || exchange === 'FOREX' || exchange === 'COMMODITY') return null

    const intraday = toCandles(rawIntraday)
    const daily = toCandles(rawDaily)
    const allNews = [...newsRaw, ...pressRaw]
    const processedNews = processNews(allNews, sym)
    const { quality: catalystQuality, category: catalystCategory, summary: catalystSummary } = getBestCatalystSummary(processedNews)

    // Price priority:
    // 1. Yahoo Finance latest candle close (~30s lag, includes premarket)
    // 2. Latest FMP intraday candle close (may be 60min delayed)
    // 3. FMP quote price (stale regular-session close during premarket)
    const latestCandle = intraday.length ? intraday[intraday.length - 1] : null
    const quoteTs = (quote?.timestamp ?? 0) * 1000
    const candleTs = latestCandle ? latestCandle.time * 1000 : 0
    const yfPrice = yfQuote?.price ?? null
    const livePrice = yfPrice ?? (candleTs > quoteTs && latestCandle ? latestCandle.close : (quote?.price ?? 0))
    const liveVolume = yfQuote?.regularMarketVolume ?? quote?.volume ?? undefined

    const sessionLevels = calculateSessionLevels(intraday, daily, livePrice, liveVolume)
    const technical = calculateTechnical(
      intraday,
      daily,
      quote.volume ?? 0,
      quote.averageVolume ?? 0,
      sessionLevels,
      livePrice
    )

    const currentPrice = livePrice
    const zones = calculateSupportResistance(intraday, sessionLevels, currentPrice, technical)
    const pullbacks = calculatePullbackScenarios(currentPrice, technical, sessionLevels, zones)
    const setupScore = calculateSetupScore(technical, pullbacks, zones, catalystQuality)
    const warnings = getWarnings(technical, currentPrice, pullbacks)
    const breakoutStatus = detectBreakout(intraday, sessionLevels, technical, zones, currentPrice)
    const tradePlans = buildTradePlans({ price: currentPrice, technical, levels: sessionLevels, zones, catalystQuality, breakout: breakoutStatus })

    const companyProfile: CompanyProfile | null = profile
      ? {
          symbol: sym,
          companyName: profile.companyName,
          exchange: profile.exchange,
          industry: profile.industry,
          sector: profile.sector,
          float: null,              // not available in stable /profile
          sharesOutstanding: null,
          marketCap: profile.marketCap,
          isEtf: profile.isEtf,
          isFund: profile.isFund,
          isActivelyTrading: profile.isActivelyTrading,
          description: profile.description,
        }
      : null

    const dataQuality = assessDataQuality(quote, intraday.length, daily.length)
    const sessionType = getSessionType()

    // Use shares-float data; fall back to profile if available
    const floatShares = sharesFloat?.floatShares ?? null
    const freeFloatPct = sharesFloat?.freeFloat ?? null
    const changePct = Math.abs(quote.changePercentage ?? 0)
    const shortAvailability = assessShortAvailability(floatShares, freeFloatPct, changePct)

    return {
      symbol: sym,
      quote: {
        symbol: sym,
        name: quote.name ?? '',
        price: currentPrice,
        change: currentPrice - (yfQuote?.previousClose ?? quote?.previousClose ?? currentPrice),
        changesPercentage: (yfQuote?.previousClose ?? quote?.previousClose)
          ? ((currentPrice - (yfQuote?.previousClose ?? quote?.previousClose ?? currentPrice)) / (yfQuote?.previousClose ?? quote?.previousClose ?? 1)) * 100
          : (quote?.changePercentage ?? 0),
        open: quote.open ?? 0,
        dayHigh: Math.max(quote.dayHigh ?? 0, currentPrice),
        dayLow: quote.dayLow && quote.dayLow > 0 ? Math.min(quote.dayLow, currentPrice) : currentPrice,
        previousClose: quote.previousClose ?? 0,
        volume: quote.volume ?? 0,
        avgVolume: quote.averageVolume ?? 0,
        marketCap: quote.marketCap ?? 0,
        exchange: quote.exchange ?? '',
        timestamp: (quote.timestamp ?? 0) * 1000,
      },
      profile: companyProfile,
      sessionLevels,
      technical,
      zones,
      pullbacks,
      news: processedNews,
      catalystSummary,
      catalystQuality,
      catalystCategory,
      setupScore,
      dataQuality,
      sessionType,
      warnings,
      breakoutStatus,
      tradePlans,
      shortAvailability,
      timestamp: Date.now(),
    }
  } catch (err) {
    console.error(`buildSnapshot(${symbol}) failed:`, err)
    return null
  }
}
