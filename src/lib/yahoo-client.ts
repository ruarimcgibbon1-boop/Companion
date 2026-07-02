/**
 * Yahoo Finance unofficial chart API — server-side only.
 * No API key required. Returns near-real-time data (~30s lag) including
 * premarket and afterhours candles.
 *
 * Endpoint is unofficial and unsupported; FMP is used as fallback.
 */

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart'
const YF_HEADERS = { 'User-Agent': 'Mozilla/5.0' }

export interface YFCandle {
  date: string   // ISO-like: "YYYY-MM-DD HH:MM:SS" in ET
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface YFQuote {
  symbol: string
  price: number          // latest trade price (includes premarket/afterhours)
  previousClose: number
  regularMarketPrice: number
  regularMarketVolume: number
  preMarketPrice: number | null
  postMarketPrice: number | null
}

function toETDateString(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(',', '')  // "YYYY-MM-DD HH:MM:SS"
}

type YFInterval = '1m' | '2m' | '5m' | '15m' | '1d'

const INTERVAL_MAP: Record<string, YFInterval> = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  'daily': '1d',
}

export async function getYFCandles(
  symbol: string,
  interval: '1min' | '5min' | '15min' | 'daily' = '5min'
): Promise<YFCandle[]> {
  const yfInterval = INTERVAL_MAP[interval] ?? '5m'
  const range = interval === 'daily' ? '6mo' : '2d'

  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=${yfInterval}&range=${range}&includePrePost=true`
  const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 0 } })
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`)

  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) throw new Error(`No Yahoo Finance data for ${symbol}`)

  const timestamps: number[] = result.timestamp ?? []
  const q = result.indicators?.quote?.[0] ?? {}
  const opens: number[] = q.open ?? []
  const highs: number[] = q.high ?? []
  const lows: number[] = q.low ?? []
  const closes: number[] = q.close ?? []
  const volumes: number[] = q.volume ?? []

  const candles: YFCandle[] = []
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i], v = volumes[i]
    // Skip null bars (market closed gaps)
    if (c == null || o == null) continue
    candles.push({
      date: toETDateString(timestamps[i]),
      open: o ?? c,
      high: h ?? c,
      low: l ?? c,
      close: c,
      volume: v ?? 0,
    })
  }

  return candles  // already chronological (oldest first)
}

export async function getYFQuote(symbol: string): Promise<YFQuote | null> {
  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`
  const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 0 } })
  if (!res.ok) return null

  const json = await res.json()
  const result = json?.chart?.result?.[0]
  if (!result) return null

  const meta = result.meta ?? {}
  const closes: number[] = result.indicators?.quote?.[0]?.close ?? []
  // Latest non-null close = current price
  const latestClose = [...closes].reverse().find(c => c != null) ?? meta.regularMarketPrice ?? 0

  return {
    symbol,
    price: latestClose,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? 0,
    regularMarketPrice: meta.regularMarketPrice ?? latestClose,
    regularMarketVolume: meta.regularMarketVolume ?? 0,
    preMarketPrice: meta.preMarketPrice ?? null,
    postMarketPrice: meta.postMarketPrice ?? null,
  }
}
