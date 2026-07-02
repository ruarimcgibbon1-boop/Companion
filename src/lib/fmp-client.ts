/**
 * FMP Client — server-side only. Never import in browser components.
 *
 * Verified stable API endpoints (July 2026):
 *   GET /stable/biggest-gainers
 *   GET /stable/quote?symbol=
 *   GET /stable/profile?symbol=
 *   GET /stable/historical-chart/{interval}?symbol=
 *   GET /stable/news/stock?symbols=&limit=
 *   GET /stable/news/press-releases?symbols=&limit=
 */

import { z } from 'zod'

const BASE = 'https://financialmodelingprep.com/stable'

function getApiKey(): string {
  const key = process.env.FMP_API_KEY
  if (!key) {
    throw new Error(
      'FMP_API_KEY is not set. Copy .env.local.example to .env.local and add your key.'
    )
  }
  return key
}

async function fmpGet<T>(
  path: string,
  params: Record<string, string | number | boolean> = {},
  schema: z.ZodType<T>
): Promise<T> {
  const key = getApiKey()
  const url = new URL(`${BASE}${path}`)
  url.searchParams.set('apikey', key)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v))
  }

  const res = await fetch(url.toString(), {
    next: { revalidate: 0 },
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`FMP ${path} → HTTP ${res.status}`)

  const json = await res.json()
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    console.warn(`FMP schema mismatch ${path}:`, parsed.error.issues.slice(0, 2))
    return json as T
  }
  return parsed.data
}

// ── Schemas ────────────────────────────────────────────────────────────────

// /stable/biggest-gainers → [{symbol,price,name,change,changesPercentage,exchange}]
export const FmpGainerSchema = z.object({
  symbol: z.string(),
  name: z.string().optional().default(''),
  price: z.number().optional().default(0),
  change: z.number().optional().default(0),
  changesPercentage: z.union([z.number(), z.string()]).transform(Number).optional().default(0),
  exchange: z.string().optional().default(''),
})
export type FmpGainer = z.infer<typeof FmpGainerSchema>

// /stable/quote?symbol= → [{symbol,name,price,changePercentage,change,volume,dayLow,dayHigh,
//                           marketCap,priceAvg50,priceAvg200,averageVolume,exchange,open,
//                           previousClose,timestamp}]
export const FmpQuoteSchema = z.object({
  symbol: z.string(),
  name: z.string().optional().default(''),
  price: z.number().optional().nullable().default(null),
  change: z.number().optional().default(0),
  changePercentage: z.union([z.number(), z.string()]).transform(Number).optional().default(0),
  volume: z.number().optional().default(0),
  averageVolume: z.number().optional().default(0),
  dayHigh: z.number().optional().nullable().default(null),
  dayLow: z.number().optional().nullable().default(null),
  open: z.number().optional().nullable().default(null),
  previousClose: z.number().optional().nullable().default(null),
  marketCap: z.number().optional().nullable().default(null),
  priceAvg50: z.number().optional().nullable().default(null),
  priceAvg200: z.number().optional().nullable().default(null),
  exchange: z.string().optional().default(''),
  timestamp: z.number().optional().default(0),
})
export type FmpQuote = z.infer<typeof FmpQuoteSchema>

// /stable/historical-chart/{interval}?symbol= → [{date,open,high,low,close,volume}]
export const FmpCandleSchema = z.object({
  date: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
})
export type FmpCandle = z.infer<typeof FmpCandleSchema>

// /stable/profile?symbol= → [{symbol,companyName,exchange,exchangeFullName,industry,sector,
//                             averageVolume,marketCap,isEtf,isFund,isActivelyTrading,description}]
export const FmpProfileSchema = z.object({
  symbol: z.string(),
  companyName: z.string().optional().default(''),
  exchange: z.string().optional().default(''),
  exchangeFullName: z.string().optional().default(''),
  industry: z.string().optional().default(''),
  sector: z.string().optional().default(''),
  averageVolume: z.number().optional().nullable().default(null),
  marketCap: z.number().optional().nullable().default(null),
  isEtf: z.boolean().optional().default(false),
  isFund: z.boolean().optional().default(false),
  isActivelyTrading: z.boolean().optional().default(true),
  description: z.string().optional().default(''),
})
export type FmpProfile = z.infer<typeof FmpProfileSchema>

// /stable/news/stock → [{symbol,publishedDate,publisher,title,image,site,text,url}]
export const FmpNewsSchema = z.object({
  symbol: z.string().optional().default(''),
  title: z.string().optional().default(''),
  text: z.string().optional().default(''),
  url: z.string().optional().default(''),
  site: z.string().optional().default(''),
  publisher: z.string().optional().default(''),
  publishedDate: z.string().optional().default(''),
  image: z.string().optional().default(''),
})
export type FmpNews = z.infer<typeof FmpNewsSchema>

// ── API functions ──────────────────────────────────────────────────────────

export async function getTopGainers(): Promise<FmpGainer[]> {
  try {
    return await fmpGet('/biggest-gainers', {}, z.array(FmpGainerSchema))
  } catch {
    return []
  }
}

export async function getMostActive(): Promise<FmpGainer[]> {
  try {
    return await fmpGet('/most-active', {}, z.array(FmpGainerSchema))
  } catch {
    return []
  }
}

export async function getQuote(symbol: string): Promise<FmpQuote | null> {
  try {
    const data = await fmpGet('/quote', { symbol }, z.array(FmpQuoteSchema))
    return data[0] ?? null
  } catch {
    return null
  }
}

// Batch fetch up to 50 symbols in one request using comma-separated symbol param
export async function getBatchQuotes(symbols: string[]): Promise<FmpQuote[]> {
  if (!symbols.length) return []
  // FMP stable /quote only works for single symbols on this plan tier.
  // Fetch up to CONCURRENCY in parallel, in waves.
  const CONCURRENCY = 10
  const results: FmpQuote[] = []
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const chunk = symbols.slice(i, i + CONCURRENCY)
    const settled = await Promise.allSettled(
      chunk.map(sym => fmpGet('/quote', { symbol: sym }, z.array(FmpQuoteSchema)))
    )
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(...r.value)
    }
  }
  return results
}

export async function getQuotes(symbols: string[]): Promise<FmpQuote[]> {
  return getBatchQuotes(symbols)
}

export async function getIntradayCandles(
  symbol: string,
  interval: '1min' | '5min' | '15min' = '5min'
): Promise<FmpCandle[]> {
  // Request from yesterday 4pm ET to cover full premarket + regular session today.
  // Use ET date arithmetic: premarket starts 04:00 ET, so fetching from 2 days ago is safe.
  const now = new Date()
  const fromDate = new Date(now)
  fromDate.setDate(fromDate.getDate() - 2)
  const from = fromDate.toISOString().slice(0, 10)

  // Try with extended=true first, fall back to without (some subscription tiers differ)
  const attempts: Array<Record<string, string | number | boolean>> = [
    { symbol, from, extended: true },
    { symbol, from },
    { symbol },
  ]

  for (const params of attempts) {
    try {
      const data = await fmpGet(
        `/historical-chart/${interval}`,
        params,
        z.array(FmpCandleSchema)
      )
      if (data.length > 0) {
        return data.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      }
    } catch { /* try next */ }
  }
  return []
}

export async function getDailyCandles(symbol: string): Promise<FmpCandle[]> {
  // Daily EOD history — try known endpoint paths
  const attempts: Array<[string, Record<string, string | number | boolean>]> = [
    ['/historical-price-eod/full', { symbol, limit: 252 }],
    ['/historical-price-full', { symbol, limit: 252 }],
  ]
  for (const [path, params] of attempts) {
    try {
      const raw = await fmpGet(path, params, z.union([
        z.array(FmpCandleSchema),
        z.object({ historical: z.array(FmpCandleSchema) }),
      ]))
      const candles = Array.isArray(raw) ? raw : raw.historical
      if (candles.length > 0) {
        return candles.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      }
    } catch { /* try next */ }
  }
  return []
}

export async function getProfile(symbol: string): Promise<FmpProfile | null> {
  try {
    const data = await fmpGet('/profile', { symbol }, z.array(FmpProfileSchema))
    return data[0] ?? null
  } catch {
    return null
  }
}

export async function getStockNews(symbol: string, limit = 20): Promise<FmpNews[]> {
  try {
    return await fmpGet('/news/stock', { symbols: symbol, limit }, z.array(FmpNewsSchema))
  } catch {
    return []
  }
}

export async function getPressReleases(symbol: string, limit = 10): Promise<FmpNews[]> {
  try {
    return await fmpGet('/news/press-releases', { symbols: symbol, limit }, z.array(FmpNewsSchema))
  } catch {
    return []
  }
}

const FmpSharesFloatSchema = z.object({
  symbol: z.string(),
  date: z.string().optional(),
  freeFloat: z.number().optional().nullable(),       // % of shares freely tradeable
  floatShares: z.number().optional().nullable(),     // absolute float share count
  outstandingShares: z.number().optional().nullable(),
})
export type FmpSharesFloat = z.infer<typeof FmpSharesFloatSchema>

export async function getSharesFloat(symbol: string): Promise<FmpSharesFloat | null> {
  try {
    const data = await fmpGet('/shares-float', { symbol }, z.array(FmpSharesFloatSchema))
    return data[0] ?? null
  } catch {
    return null
  }
}
