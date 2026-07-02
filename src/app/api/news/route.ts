import { NextResponse } from 'next/server'
import { getStockNews, getPressReleases } from '@/lib/fmp-client'
import { processNews } from '@/lib/news-engine'
import { cached, TTL } from '@/lib/cache'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get('symbol')

  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 })
  }

  const sym = symbol.toUpperCase()
  try {
    const [news, press] = await Promise.all([
      cached(`news:${sym}`, TTL.NEWS, () => getStockNews(sym, 20)),
      cached(`press:${sym}`, TTL.NEWS, () => getPressReleases(sym, 10)),
    ])
    const processed = processNews([...news, ...press], sym)
    return NextResponse.json({ symbol: sym, news: processed, timestamp: Date.now() })
  } catch (err) {
    console.error('news route error:', err)
    return NextResponse.json({ error: 'Failed to fetch news' }, { status: 500 })
  }
}
