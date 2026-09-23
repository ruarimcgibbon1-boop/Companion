/**
 * GET /api/paper/trades — read-only Journal feed for Companion-originated
 * PAPER trades.
 *
 * Server-only: mirrors /api/paper/positions (credentials never reach the
 * browser). Reads the execution ledger across the last `days` ET trading days
 * (default 7) and returns the sanitized broker-linked view the Journal renders
 * alongside its manual/local trade history. Places no orders; mutates nothing.
 *
 * Every row returned here was created by the daemon itself (setupId + signalId
 * always present) — there is no path for an externally-opened Alpaca position
 * to appear as a "Companion" journal entry from this endpoint. See
 * trades-view.ts for why that's structurally guaranteed rather than merely
 * filtered.
 */
import { NextResponse } from 'next/server'
import { loadRecentTrades } from '@/lib/execution/store'
import { buildTradeJournalView } from '@/lib/execution/trades-view'
import type { JournalTradesPayload } from '@/lib/execution/trades-view'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export interface JournalTradesError {
  ok: false
  asOf: number
  error: string
}

function unavailable(error: string, status: number): NextResponse<JournalTradesError> {
  return NextResponse.json<JournalTradesError>(
    { ok: false, asOf: Date.now(), error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const daysParam = Number(searchParams.get('days'))
    const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 30) : 7

    const trades = loadRecentTrades(days)
    const payload: JournalTradesPayload = buildTradeJournalView(trades)
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    // Ledger read failure (corrupt/unreadable file) — never surface fs details.
    return unavailable('Ledger unavailable', 503)
  }
}
