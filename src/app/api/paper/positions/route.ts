/**
 * GET /api/paper/positions — read-only broker position feed for the UI.
 *
 * Server-only: the Alpaca client lives here so credentials never reach the
 * browser. We query the broker for authoritative positions, read the Companion
 * execution ledger from disk (the daemon's per-day trades file), and return the
 * sanitized join built by buildPositionView. This endpoint places no orders and
 * mutates nothing — it is purely a window onto broker truth.
 *
 * Two failure shapes the client must tell apart (see Phase 11):
 *   • ok:true  with positions:[]  → broker verified FLAT
 *   • ok:false                    → broker UNAVAILABLE (creds/network) — the
 *                                    client keeps its last known state, never
 *                                    treats this as "account is flat".
 */
import { NextResponse } from 'next/server'
import { AlpacaBroker, AlpacaBrokerError } from '@/lib/execution/alpaca'
import { loadTrades } from '@/lib/execution/store'
import { buildPositionView } from '@/lib/execution/positions-view'
import type { PaperPositionsError } from '@/lib/execution/positions-view'

// Broker data changes every second and the ledger is read from disk — never cache.
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function unavailable(error: string, status: number): NextResponse<PaperPositionsError> {
  return NextResponse.json<PaperPositionsError>(
    { ok: false, source: 'alpaca-paper', asOf: Date.now(), error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET() {
  // Construction throws when ALPACA_* is missing — surface that as "unavailable",
  // not an empty (flat) account. Deliberately generic: never echo config values.
  let broker: AlpacaBroker
  try {
    broker = new AlpacaBroker()
  } catch {
    return unavailable('Alpaca credentials not configured', 503)
  }

  try {
    // Ledger read is best-effort: if the trades file can't be read we still
    // report broker truth, just with everything attributed EXTERNAL.
    const [brokerPositions, trades] = await Promise.all([
      broker.getPositions(),
      Promise.resolve().then(() => {
        try { return loadTrades() } catch { return [] }
      }),
    ])

    const payload = buildPositionView(brokerPositions, trades)
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    // Broker reachable-but-erroring, or network failure. Keep the reason short and
    // credential-free — never forward a raw broker response body to the client.
    const status = e instanceof AlpacaBrokerError ? e.status : 502
    return unavailable(`Alpaca positions request failed (${status})`, 503)
  }
}
