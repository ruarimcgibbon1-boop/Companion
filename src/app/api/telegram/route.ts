import { NextResponse } from 'next/server'
import { formatBuySignal, isTelegramConfigured, sendTelegramMessage } from '@/lib/telegram'
import type { BuySignalRecord } from '@/types'

export const runtime = 'nodejs'

// Server-side dedup: the monitor sweep runs client-side and already dedups buy
// signals, but a page refresh replays persisted state and a second tab sweeps
// independently — so remember recently-sent signal ids and drop repeats.
const sentIds = new Map<string, number>()
const SENT_TTL_MS = 6 * 60 * 60 * 1000

function alreadySent(id: string, now: number): boolean {
  for (const [k, t] of sentIds) if (now - t > SENT_TTL_MS) sentIds.delete(k)
  if (sentIds.has(id)) return true
  sentIds.set(id, now)
  return false
}

export async function POST(request: Request) {
  let body: { signal?: BuySignalRecord; test?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!isTelegramConfigured()) {
    return NextResponse.json({ sent: false, reason: 'not_configured' })
  }

  if (body.test) {
    const ok = await sendTelegramMessage('✅ Companion connected — buy signals will arrive here.')
    return NextResponse.json({ sent: ok })
  }

  const sig = body.signal
  if (!sig || typeof sig.symbol !== 'string' || typeof sig.id !== 'string') {
    return NextResponse.json({ error: 'Missing signal' }, { status: 400 })
  }
  if (alreadySent(sig.id, Date.now())) {
    return NextResponse.json({ sent: false, reason: 'duplicate' })
  }

  const ok = await sendTelegramMessage(formatBuySignal(sig))
  return NextResponse.json({ sent: ok })
}
