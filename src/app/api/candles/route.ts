import { NextResponse } from 'next/server'
import { getIntradayCandles, getDailyCandles } from '@/lib/fmp-client'
import { getYFCandles } from '@/lib/yahoo-client'
import { cached, TTL } from '@/lib/cache'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get('symbol')
  const interval = (searchParams.get('interval') ?? '5min') as '1min' | '5min' | '15min' | 'daily'

  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 })
  }

  const sym = symbol.toUpperCase()
  try {
    if (interval === 'daily') {
      const candles = await cached(`daily:${sym}`, TTL.CANDLES_DAILY, () => getDailyCandles(sym))
      return NextResponse.json({ symbol: sym, interval, candles, timestamp: Date.now() })
    }

    const ttl = interval === '1min' ? TTL.CANDLES_1M : TTL.CANDLES_5M

    // Yahoo Finance first (~30s lag, premarket included, no key needed)
    // Fall back to FMP if Yahoo fails
    const candles = await cached(
      `candles${interval}:${sym}`,
      ttl,
      async () => {
        try {
          const yf = await getYFCandles(sym, interval)
          if (yf.length > 0) return yf
        } catch { /* fall through */ }
        return getIntradayCandles(sym, interval as '1min' | '5min' | '15min')
      }
    )

    return NextResponse.json({ symbol: sym, interval, candles, timestamp: Date.now() })
  } catch (err) {
    console.error('candles route error:', err)
    return NextResponse.json({ error: 'Failed to fetch candles' }, { status: 500 })
  }
}
