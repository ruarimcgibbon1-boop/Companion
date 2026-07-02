import { NextResponse } from 'next/server'
import { buildMonitorBatch } from '@/lib/monitor'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request) {
  let body: { symbols?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const symbols = Array.isArray(body.symbols) ? body.symbols.filter(s => typeof s === 'string' && s.length > 0) : []
  if (symbols.length === 0) {
    return NextResponse.json({ results: [], timestamp: Date.now() })
  }

  try {
    const results = await buildMonitorBatch(symbols)
    return NextResponse.json({ results, timestamp: Date.now() })
  } catch (err) {
    console.error('monitor route error:', err)
    return NextResponse.json({ error: 'Failed to analyse symbols' }, { status: 500 })
  }
}
