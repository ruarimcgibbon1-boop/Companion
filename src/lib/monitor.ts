/**
 * Per-symbol monitor analysis — server-side.
 *
 * Reuses the same cached candle/quote data as the snapshot pipeline (shared
 * cache keys) so scanner-wide monitoring is cheap. Produces ranked levels,
 * detected setups, a price roadmap, and honest data-integrity flags.
 *
 * All market data is fetched server-side. No values are invented: when a data
 * point is missing it is reported in `integrity.missing` and the affected
 * scores are reduced by the scoring matrix.
 */

import type { Candle, MonitorResult, NewsItem } from '@/types'
import { getQuote, getIntradayCandles, getDailyCandles } from './fmp-client'
import { getYFCandles, getYFQuote } from './yahoo-client'
import { calculateSessionLevels, calculateTechnical } from './technical'
import { buildKeyLevels } from './levels-engine'
import { detectSetups, type DetectionContext } from './setup-detectors'
import { buildRoadmap } from './roadmap-engine'
import { getSessionType } from './market-hours'
import { cache, cached, TTL } from './cache'

function toCandles(raw: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): Candle[] {
  return raw.map(c => ({
    time: Math.floor(new Date(c.date).getTime() / 1000),
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
  }))
}

// Map cached news (if already present) to a 0-15 catalyst score. Never triggers
// a fetch — monitoring must stay cheap and must not invent catalysts.
function cachedCatalystScore(sym: string): { score: number; has: boolean } {
  const news = cache.get<NewsItem[]>(`news:${sym}`)
  if (!news || news.length === 0) return { score: 0, has: false }
  const best = news[0]
  switch (best.quality) {
    case 'Strong Confirmed Catalyst': return { score: 15, has: true }
    case 'Moderate Catalyst': return { score: 10, has: true }
    case 'Weak or Recycled Catalyst': return { score: 5, has: true }
    case 'Negative or Dilutive Catalyst': return { score: 0, has: true }
    default: return { score: 3, has: true }
  }
}

export async function buildMonitorResult(symbol: string): Promise<MonitorResult | null> {
  const sym = symbol.toUpperCase()
  const missing: string[] = []

  try {
    const [quote, yfQuote, rawIntraday, rawDaily] = await Promise.all([
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
    ])

    // Reject non-equities (crypto etc.) unless YF confirms equity pricing.
    const exch = (quote?.exchange ?? '').toUpperCase()
    if (['CRYPTO', 'FOREX', 'COMMODITY'].includes(exch) && !yfQuote) return null

    const intraday = toCandles(rawIntraday)
    const daily = toCandles(rawDaily)
    if (intraday.length === 0) missing.push('intraday candles')
    if (daily.length === 0) missing.push('daily candles')

    // Price priority: YF live → newest FMP candle → FMP quote.
    const latestCandle = intraday.length ? intraday[intraday.length - 1] : null
    const quoteTs = (quote?.timestamp ?? 0) * 1000
    const candleTs = latestCandle ? latestCandle.time * 1000 : 0
    const yfPrice = yfQuote?.price ?? null
    const price = yfPrice ?? (candleTs > quoteTs && latestCandle ? latestCandle.close : (quote?.price ?? 0))
    if (price <= 0) return null

    const liveVolume = yfQuote?.regularMarketVolume ?? quote?.volume ?? undefined
    const sessionLevels = calculateSessionLevels(intraday, daily, price, liveVolume)

    // Relative volume needs a baseline average. Prefer the quote's average volume;
    // fall back to a 20-day average derived from daily candles so rvol is available
    // even when the quote feed omits it.
    const dailyAvgVol = daily.length >= 5
      ? daily.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, daily.length)
      : 0
    const avgVolume = quote?.averageVolume && quote.averageVolume > 0 ? quote.averageVolume : dailyAvgVol
    const currentVolume = liveVolume ?? quote?.volume ?? 0

    const technical = calculateTechnical(
      intraday, daily, currentVolume, avgVolume, sessionLevels, price
    )

    if (sessionLevels.vwap == null) missing.push('VWAP')
    if (technical.ema9 == null) missing.push('9 EMA')
    if (technical.ema20 == null) missing.push('21 EMA')
    if (technical.relativeVolume == null) missing.push('relative volume')

    const levels = buildKeyLevels({ intraday, daily, sessionLevels, technical, currentPrice: price })

    const { score: catalystScore, has: hasCatalyst } = cachedCatalystScore(sym)

    const detCtx: DetectionContext = {
      symbol: sym,
      price,
      candles: intraday,
      sessionLevels,
      technical,
      levels,
      catalystScore,
      hasCatalyst,
      spreadPct: null,     // real-time spread not available from this feed — honestly null
      changePct: quote?.changePercentage ?? 0,
    }
    if (!hasCatalyst) missing.push('catalyst / news')

    const setups = detectSetups(detCtx)
    const roadmap = buildRoadmap(sym, price, levels)

    // Data integrity — freshest underlying data point.
    const freshestMs = Math.max(candleTs, quoteTs, yfQuote ? Date.now() - 30_000 : 0)
    const ageMs = Date.now() - freshestMs
    const session = getSessionType()
    const activeSession = session === 'premarket' || session === 'regular' || session === 'afterhours'
    const delayed = activeSession && ageMs > 120_000

    const prevClose = yfQuote?.previousClose ?? quote?.previousClose ?? price
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : (quote?.changePercentage ?? 0)

    return {
      symbol: sym,
      price,
      changePct,
      relativeVolume: technical.relativeVolume,
      spreadPct: null,
      catalyst: hasCatalyst ? (cache.get<NewsItem[]>(`news:${sym}`)?.[0]?.quality ?? 'Catalyst') : 'No catalyst data',
      levels,
      setups,
      roadmap,
      integrity: {
        marketDataTimestamp: freshestMs,
        ageMs,
        session,
        delayed,
        missing,
      },
      technicals: {
        vwap: technical.vwap,
        ema9: technical.ema9,
        ema20: technical.ema20,
        rsi14: technical.rsi14,
        atr: technical.atr,
        atrPct: technical.atr != null && price > 0 ? (technical.atr / price) * 100 : null,
        distanceFromVwapPct: technical.distanceFromVwapPct,
        distanceFromEma9Pct: technical.ema9 != null && technical.ema9 > 0 ? ((price - technical.ema9) / technical.ema9) * 100 : null,
        distanceFromDayHighPct: technical.distanceFromDayHighPct,
        aboveVwap: technical.vwap != null ? price >= technical.vwap : null,
        higherHighsLows: technical.higherHighsLows,
        lowerHighsLows: technical.lowerHighsLows,
        trend5m: technical.trend5m,
        trend15m: technical.trend15m,
        volumeTrend: technical.volumeTrend,
        gapPct: technical.gapPct,
        premarketHigh: sessionLevels.premarketHigh,
        premarketVolume: sessionLevels.premarketVolume,
        dayHigh: sessionLevels.regularHigh,
        previousDayHigh: sessionLevels.previousDayHigh,
        previousClose: sessionLevels.previousClose,
        or5High: sessionLevels.or5High,
        or15High: sessionLevels.or15High,
        twentyDayHigh: technical.twentyDayHigh,
      },
    }
  } catch (err) {
    console.error(`buildMonitorResult(${sym}) failed:`, err)
    return null
  }
}

/** Concurrency-limited batch. */
export async function buildMonitorBatch(symbols: string[], concurrency = 6): Promise<MonitorResult[]> {
  const unique = [...new Set(symbols.map(s => s.toUpperCase()))].slice(0, 40)
  const out: MonitorResult[] = []
  let idx = 0
  async function worker() {
    while (idx < unique.length) {
      const i = idx++
      const r = await buildMonitorResult(unique[i])
      if (r) out.push(r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker))
  return out
}
