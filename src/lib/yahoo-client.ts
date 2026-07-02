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

// Offset (minutes) of America/New_York from UTC at a given instant (handles EDT/EST).
function etOffsetMinutes(date: Date): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }))
  const et = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  return Math.round((et.getTime() - utc.getTime()) / 60000)
}

// Emit an UNAMBIGUOUS ISO-8601 string with the correct ET offset, e.g.
// "2026-07-02T10:41:00-04:00". This parses to the same instant on any server
// timezone — critical because the dev server may not run in ET. The date part
// still begins "YYYY-MM-DD" so existing `startsWith(todayEt)` checks keep working.
function toETDateString(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  let hour = get('hour')
  if (hour === '24') hour = '00'
  const off = etOffsetMinutes(d)
  const sign = off <= 0 ? '-' : '+'
  const abs = Math.abs(off)
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${offStr}`
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

/**
 * Yahoo Finance trending tickers for the US market.
 * Returns bare symbols — no price data, needs a follow-up quote fetch.
 * No auth required. Covers micro/penny caps that screeners miss.
 */
export async function getYFTrending(count = 40): Promise<string[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/trending/US?count=${count}`
  const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 0 } })
  if (!res.ok) throw new Error(`YF trending HTTP ${res.status}`)
  const json = await res.json()
  const quotes: { symbol: string }[] = json?.finance?.result?.[0]?.quotes ?? []
  return quotes
    .map(q => q.symbol)
    .filter(s => s && !s.includes('-') && !s.includes('=') && s.length <= 6)  // drop crypto/fx pairs
}

export interface YFScreenerRow {
  symbol: string
  name: string
  price: number
  changePct: number     // regular market change %
  volume: number
  marketCap: number | null
  exchange: string
}

/**
 * Fetch Yahoo Finance predefined screener results (no auth required).
 * scrId options: 'day_gainers' | 'most_actives' | 'day_losers'
 */
export async function getYFScreener(
  scrId: 'day_gainers' | 'most_actives' | 'small_cap_gainers',
  count = 50
): Promise<YFScreenerRow[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}&formatted=false`
  const res = await fetch(url, { headers: YF_HEADERS, next: { revalidate: 0 } })
  if (!res.ok) throw new Error(`YF screener HTTP ${res.status}`)
  const json = await res.json()
  const quotes: Record<string, unknown>[] = json?.finance?.result?.[0]?.quotes ?? []
  return quotes
    .filter(q => q.symbol && q.regularMarketPrice)
    .map(q => ({
      symbol: q.symbol as string,
      name: (q.shortName ?? q.longName ?? '') as string,
      price: q.regularMarketPrice as number,
      changePct: (q.regularMarketChangePercent as number) ?? 0,
      volume: (q.regularMarketVolume as number) ?? 0,
      marketCap: (q.marketCap as number) ?? null,
      exchange: (q.exchange ?? q.fullExchangeName ?? '') as string,
    }))
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
