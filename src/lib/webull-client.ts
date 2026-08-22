/**
 * Webull market-data client — PUBLIC market data only, no account access.
 *
 * Why: FMP's biggest-gainers lags to the prior session in premarket and doesn't
 * carry fresh low-float rockets at all (QNME/ELPW returned no FMP quote on
 * 2026-08-04), and Yahoo's screeners are regular-session + size-floored. So the
 * day's actual premarket movers — the whole point of this app — never entered the
 * universe. Webull's ranking endpoint is what its own web app calls for the
 * premarket gainers board, and it returns exactly those names (QNME +228%,
 * RAIN +97%, ELPW +59%) with NO login.
 *
 * Scope + safety:
 *   - Only the public ranking + chart endpoints are used. No login, no
 *     credentials, no account/position/order data — the `did` header is a random
 *     device identifier, not authentication.
 *   - This is an UNDOCUMENTED endpoint (the web app's own backend), so treat it as
 *     best-effort: every call is wrapped and fails soft to [] / null, and the
 *     scanner/monitor must keep working when Webull is unreachable.
 *   - Intraday minute candles are gated without an account token (they return a
 *     single bar unauthenticated), so `getWebullDailyCandles` covers daily only.
 *     Intraday for names FMP/Yahoo lack needs the user's Webull session token or a
 *     paid feed — see the discovery note in the gainers route.
 */

// A stable device id keeps Webull from treating each call as a new device (which
// invites rate-limiting). Any 32-char hex works; override via env if it ever gets
// throttled. NOT a secret and NOT tied to the user's account.
const WEBULL_DID = process.env.WEBULL_DID ?? 'b0a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5'
const QUOTES_BASE = 'https://quotes-gw.webullfintech.com/api'
const REGION_US = 6

function wbHeaders(): Record<string, string> {
  return {
    did: WEBULL_DID,
    'access_token': '',
    app: 'global',
    os: 'web',
    platform: 'web',
    hl: 'en',
    tz: 'America/New_York',
    ver: '1.0',
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
  }
}

async function wbGet(path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${QUOTES_BASE}${path}`, { headers: wbHeaders(), next: { revalidate: 0 } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export type WebullRankType = 'preMarket' | 'afterMarket' | '1d'

export interface WebullGainer {
  symbol: string
  changePct: number          // percent, e.g. 228.0
  price: number | null       // last/ranked price
  tickerId: number
  exchange: string
}

interface WbTicker {
  symbol?: string
  disSymbol?: string
  tickerId?: number
  changeRatio?: number       // fraction: 0.974 = +97.4%
  close?: number
  price?: number
  pPrice?: number            // premarket price on some payloads
  disExchangeCode?: string
  template?: string
}

/**
 * The day's ranked gainers for the given session. `preMarket` is the one that
 * fills the discovery gap; `afterMarket` and `1d` cover the other sessions so the
 * scanner has a live gainers source in every phase.
 */
export async function getWebullGainers(rank: WebullRankType, pageSize = 30): Promise<WebullGainer[]> {
  const json = await wbGet(
    `/wlas/ranking/topGainers?regionId=${REGION_US}&rankType=${rank}&pageIndex=1&pageSize=${pageSize}&supportBroker=8`
  )
  const data = (json as { data?: Array<{ ticker?: WbTicker } & WbTicker> })?.data
  if (!Array.isArray(data)) return []
  const out: WebullGainer[] = []
  for (const row of data) {
    const t: WbTicker = (row.ticker ?? row) as WbTicker
    const symbol = (t.symbol ?? t.disSymbol ?? '').toUpperCase()
    if (!symbol || t.tickerId == null) continue
    // Equities only — skip warrants/units/rights the ranking sometimes includes.
    if (t.template && t.template !== 'stock') continue
    // Webull returns prices as strings on some payloads — coerce to a real number.
    const rawPrice = t.pPrice ?? t.price ?? t.close
    const price = rawPrice != null && Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null
    out.push({
      symbol,
      changePct: t.changeRatio != null ? t.changeRatio * 100 : 0,
      price,
      tickerId: t.tickerId,
      exchange: t.disExchangeCode ?? '',
    })
  }
  return out
}

/** Resolve a bare symbol to Webull's tickerId (needed for chart lookups). */
export async function getWebullTickerId(symbol: string): Promise<number | null> {
  const json = await wbGet(
    `/search/pc/tickers?keyword=${encodeURIComponent(symbol)}&pageIndex=1&pageSize=10&regionId=${REGION_US}`
  )
  const data = (json as { data?: WbTicker[] })?.data
  if (!Array.isArray(data)) return null
  // Prefer an exact-symbol common stock.
  const exact = data.find(t => (t.symbol ?? t.disSymbol ?? '').toUpperCase() === symbol.toUpperCase() && (t.template ?? 'stock') === 'stock')
  return exact?.tickerId ?? data[0]?.tickerId ?? null
}

export interface WebullCandle {
  time: number   // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Daily candles for a Webull tickerId. Used as a last-resort source for names no
 * other feed carries (so levels/gap have something to work with). Intraday minute
 * data is NOT available unauthenticated, so this is daily-only by design.
 *
 * Row format: "epochSec,open,close,high,low,prevClose,volume,vwap".
 */
export async function getWebullDailyCandles(tickerId: number, count = 120): Promise<WebullCandle[]> {
  const json = await wbGet(`/quote/charts/query?tickerIds=${tickerId}&type=d1&count=${count}`)
  const rows = (json as Array<{ data?: string[] }>)?.[0]?.data
  if (!Array.isArray(rows)) return []
  const out: WebullCandle[] = []
  for (const line of rows) {
    const p = line.split(',')
    if (p.length < 7) continue
    const [t, o, c, h, l, , v] = p.map(Number)
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue
    out.push({ time: t, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 })
  }
  return out.sort((a, b) => a.time - b.time)
}
