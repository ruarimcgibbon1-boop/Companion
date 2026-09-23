import { NextResponse } from 'next/server'
import { formatBuySignal, isTelegramConfigured, sendTelegramMessage } from '@/lib/telegram'
import type { BuySignalRecord } from '@/types'

export const runtime = 'nodejs'

// Server-side dedup: the monitor sweep runs client-side and already dedups buy
// signals, but a page refresh replays persisted state and a second tab sweeps
// independently — so remember recently-sent signals here and drop repeats. This
// is the single choke point across every tab/reload, so it MUST key on a STABLE
// id. It used to key on the buy record's `id` (`<setupId>:triggered:<seconds>`),
// whose timestamp changes every sweep — so the SAME setup re-texted on each sweep
// (2026-08-06: 3 alerts for one ONFO trade). Key on the setup id instead, so one
// setup = one alert per window; a genuinely different continuation has its own
// setup id (different zone) and still comes through.
const sentIds = new Map<string, number>()
const SENT_TTL_MS = 6 * 60 * 60 * 1000

function alreadySent(key: string, now: number): boolean {
  for (const [k, t] of sentIds) if (now - t > SENT_TTL_MS) sentIds.delete(k)
  if (sentIds.has(key)) return true
  sentIds.set(key, now)
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
  // Dedup on the stable setup id (falls back to the record id if absent) so the
  // same setup can't re-text across sweeps/tabs — the ONFO triple-alert fix.
  if (alreadySent(sig.setupId || sig.id, Date.now())) {
    return NextResponse.json({ sent: false, reason: 'duplicate' })
  }

  const ok = await sendTelegramMessage(formatBuySignal(sig))
  return NextResponse.json({ sent: ok })
}
