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
import { parseEtTimestampSec } from '@/lib/market-hours'
import { getQuote, getIntradayCandles, getDailyCandles, getFloatShares, getExtendedIntradayCandles } from './fmp-client'
import { getYFCandles, getYFQuote } from './yahoo-client'
import { calculateSessionLevels, calculateTechnical } from './technical'
import { buildKeyLevels } from './levels-engine'
import { detectSetups, type DetectionContext } from './setup-detectors'
import { detectCandlePatterns } from './candlestick-patterns'
import { computeLocalStructure, resolveLocalFeatureConfig } from './leader/local-structure'
import { buildRoadmap } from './roadmap-engine'
import { getSessionType, minutesSinceOpen } from './market-hours'
import { premarketVolumeProfile, etDateNow, etHHMMNow } from './premarket-volume'
import { cache, cached, TTL } from './cache'

function toCandles(raw: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): Candle[] {
  return raw.map(c => ({
    time: parseEtTimestampSec(c.date),
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

/**
 * H4A.1 — OBSERVATIONAL-ONLY mode. When `observationalOnly` is set the symbol is a member of the
 * bounded leader-observation cohort (NOT the BASE monitored set). It rides the SAME canonical
 * data/compute path (same cache keys, same pure geometry) so there is no second market-data truth,
 * but it SKIPS the enrichment that only feeds BASE detection/execution and that H4B does not need:
 *   - float shares (getFloatShares)        — 1 fewer FMP call per cold symbol
 *   - premarket volume (getExtendedIntraday) — 1 fewer FMP call per cold premarket symbol
 *   - detectSetups                          — a HARD structural guarantee that an observational
 *                                             symbol never enters BASE detection at all
 * candles1m + daily + quote/yfquote are still fetched (they are what honest 1m local geometry needs).
 * The default (BASE) path is byte-identical to pre-H4A.1.
 */
export async function buildMonitorResult(
  symbol: string,
  opts: { observationalOnly?: boolean } = {},
): Promise<MonitorResult | null> {
  const sym = symbol.toUpperCase()
  const observationalOnly = opts.observationalOnly === true
  const missing: string[] = []

  try {
    const [quote, yfQuote, rawIntraday, rawDaily] = await Promise.all([
      // H4A.1: observational-only symbols skip the FMP quote entirely. With yfQuote present it feeds only
      // the rvol baseline (which falls back to the 20-day daily average) and a redundant crypto-guard, so
      // it is not needed for honest 1m local geometry — and dropping it removes 1 FMP call per obs fetch.
      observationalOnly ? Promise.resolve(null) : cached(`quote:${sym}`, TTL.QUOTE, () => getQuote(sym)),
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

    // Premarket participation. RVOL as computed above is null before 09:30 (no
    // regular session to pace against) and the primary candle feed reports
    // premarket volume as 0, so premarket had NO volume evidence at all — the
    // gap that let signals fire on names that never moved. Substitute the real
    // premarket measure: today's premarket volume vs this name's own typical
    // premarket volume by this time of day, off the one feed that carries it.
    const session = getSessionType()
    const premarket = session === 'premarket' && !observationalOnly
      ? await cached(`pmvol:${sym}`, TTL.PREMARKET_VOL, async () => {
          const rows = await getExtendedIntradayCandles(sym)
          // No rows at all = the fetch failed, NOT a quiet premarket: the window
          // spans 10 days of regular hours too, so a live symbol always has some.
          // Returning a measured zero here would silently block every premarket
          // signal and look identical to "nothing set up today".
          if (rows.length === 0) return null
          return premarketVolumeProfile(rows, { todayEt: etDateNow(), throughHHMM: etHHMMNow() })
        })
      : null
    if (premarket?.relativeVolume != null) technical.relativeVolume = premarket.relativeVolume

    if (sessionLevels.vwap == null) missing.push('VWAP')
    if (technical.ema9 == null) missing.push('9 EMA')
    if (technical.ema20 == null) missing.push('21 EMA')
    if (technical.relativeVolume == null) missing.push('relative volume')

    const levels = buildKeyLevels({ intraday, daily, sessionLevels, technical, currentPrice: price })

    const { score: catalystScore, has: hasCatalyst } = cachedCatalystScore(sym)
    // Float feeds the in-play gate (BASE only). Shared 6h cache key with the scanner. Observational
    // cohort symbols do NOT need it and never reach the gate — skip the provider call for them.
    const float = observationalOnly
      ? null
      : await cached(`floatShares:${sym}`, TTL.FLOAT, () => getFloatShares(sym))
    if (!hasCatalyst) missing.push('catalyst / news')

    // BASE detection. HARD ISOLATION: an observational cohort symbol is never passed to detectSetups,
    // so it can produce no BASE setup, enter no arbitration set, and reach no executor.
    let setups: ReturnType<typeof detectSetups> = []
    if (!observationalOnly) {
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
        session,
        minutesSinceOpen: minutesSinceOpen(),
        float,
      }
      setups = detectSetups(detCtx)
    }
    const roadmap = buildRoadmap(sym, price, levels)

    // Candlestick pattern scan (surfaced for the top-gainer universe). Location =
    // pulled back near VWAP / 9EMA; trend = intraday uptrend. Filters make a hammer
    // at support on volume read differently from one floating mid-range.
    const ema9Dist = technical.ema9 != null && technical.ema9 > 0 ? Math.abs((price - technical.ema9) / technical.ema9) * 100 : 99
    const atSupport = Math.abs(technical.distanceFromVwapPct ?? 99) < 1.5 || ema9Dist < 1
    const uptrend = technical.trend5m === 'up' || technical.higherHighsLows === true
    const patterns = detectCandlePatterns(intraday, { atSupport, uptrend })

    // Data integrity — freshest underlying data point.
    const freshestMs = Math.max(candleTs, quoteTs, yfQuote ? Date.now() - 30_000 : 0)
    const ageMs = Date.now() - freshestMs
    const activeSession = session === 'premarket' || session === 'regular' || session === 'afterhours'
    const delayed = activeSession && ageMs > 120_000

    const prevClose = yfQuote?.previousClose ?? quote?.previousClose ?? price
    const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : (quote?.changePercentage ?? 0)

    // H4A — OBSERVATIONAL local-reset geometry over the SAME 1m bars already fetched above (zero new
    // provider requests). Strategy-neutral; never read by any gate/decision/execution. Best-effort:
    // a throw here must never break the monitor result.
    let localStructure = null
    try {
      const sessionHigh = session === 'premarket'
        ? (sessionLevels.premarketHigh ?? null)
        : (sessionLevels.regularHigh ?? sessionLevels.premarketHigh ?? null)
      localStructure = computeLocalStructure({
        symbol: sym, candles: intraday, asOfMs: Date.now(), session,
        globals: {
          price, sessionHigh, dayChangePct: changePct,
          vwap: technical.vwap, ema9: technical.ema9, ema21: technical.ema20,
          atr: technical.atr, atrPct: technical.atr != null && price > 0 ? (technical.atr / price) * 100 : null,
          relativeVolume: technical.relativeVolume, spreadPct: null,
        },
      }, resolveLocalFeatureConfig())
    } catch (e) {
      console.error(`localStructure(${sym}) failed (observational only):`, (e as Error).message)
    }

    return {
      symbol: sym,
      price,
      changePct,
      volume: currentVolume,
      relativeVolume: technical.relativeVolume,
      // Only report the premarket volume when the feed actually captured the tape.
      // A tiny "measured" number (HYFM 55 shares) is missing coverage, not thin
      // liquidity — reporting it lets the buy-log floor and scanner filter drop the
      // exact rockets we want. Null = unknown, and unknown never vetoes.
      premarketVolume: premarket?.measured ? premarket.todayVolume : null,
      spreadPct: null,
      catalyst: hasCatalyst ? (cache.get<NewsItem[]>(`news:${sym}`)?.[0]?.quality ?? 'Catalyst') : 'No catalyst data',
      // Observational telemetry only (additive; not read by any gate/decision). Already
      // fetched above for the in-play gate's DetectionContext; previously dropped here.
      float,
      levels,
      setups,
      patterns,
      localStructure,
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
        // Prefer the measured premarket volume — the candle feed reports 0 premarket.
        premarketVolume: premarket?.todayVolume ?? sessionLevels.premarketVolume,
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

/**
 * Concurrency-limited batch over ONE shared data plane.
 *
 * `observationalOnly` names the subset of `symbols` that are leader-observation cohort members
 * (H4A.1) — they take the lighter observational path (no float/pmvol enrichment, no detectSetups).
 * All symbols share the same cache/single-flight, so a symbol requested once is fetched once; the
 * cohort never overlaps BASE (it is deduplicated upstream) but the cache would collapse it anyway.
 * With no options this is byte-identical to the pre-H4A.1 BASE batch.
 */
export async function buildMonitorBatch(
  symbols: string[],
  opts: { concurrency?: number; observationalOnly?: Iterable<string> } = {},
): Promise<MonitorResult[]> {
  const concurrency = opts.concurrency ?? 6
  const obsOnly = new Set([...(opts.observationalOnly ?? [])].map(s => s.toUpperCase()))
  const unique = [...new Set(symbols.map(s => s.toUpperCase()))].slice(0, 40)
  const out: MonitorResult[] = []
  let idx = 0
  async function worker() {
    while (idx < unique.length) {
      const i = idx++
      const r = await buildMonitorResult(unique[i], { observationalOnly: obsOnly.has(unique[i]) })
      if (r) out.push(r)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker))
  return out
}
