/**
 * GET /api/paper/account — read-only Alpaca PAPER account summary for the
 * Positions tab's top bar (equity / buying power / connection state).
 *
 * Server-only, same credential-safety shape as /api/paper/positions: broker
 * construction failure or a broker error is reported as UNAVAILABLE, never as
 * a zeroed-out account. Places no orders; mutates nothing.
 */
import { NextResponse } from 'next/server'
import { AlpacaBroker, AlpacaBrokerError } from '@/lib/execution/alpaca'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export interface PaperAccountPayload {
  ok: true
  asOf: number
  equity: number
  cash: number
  buyingPower: number
  daytradeCount: number
  blocked: boolean
}

export interface PaperAccountError {
  ok: false
  asOf: number
  error: string
}

function unavailable(error: string, status: number): NextResponse<PaperAccountError> {
  return NextResponse.json<PaperAccountError>(
    { ok: false, asOf: Date.now(), error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function GET() {
  let broker: AlpacaBroker
  try {
    broker = new AlpacaBroker()
  } catch {
    return unavailable('Alpaca credentials not configured', 503)
  }

  try {
    const account = await broker.getAccount()
    const payload: PaperAccountPayload = { ok: true, asOf: Date.now(), ...account }
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const status = e instanceof AlpacaBrokerError ? e.status : 502
    return unavailable(`Alpaca account request failed (${status})`, 503)
  }
}
