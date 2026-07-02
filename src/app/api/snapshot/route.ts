import { NextResponse } from 'next/server'
import { buildSnapshot } from '@/lib/snapshot'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get('symbol')

  if (!symbol) {
    return NextResponse.json({ error: 'symbol is required' }, { status: 400 })
  }

  const snap = await buildSnapshot(symbol.toUpperCase())
  if (!snap) {
    return NextResponse.json(
      { error: `No equity data for ${symbol}. This may be a crypto, ETF, or symbol not covered by the data provider.` },
      { status: 404 }
    )
  }

  return NextResponse.json(snap)
}
