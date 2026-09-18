import { NextResponse } from 'next/server'
import { buildMonitorBatch } from '@/lib/monitor'

export const runtime = 'nodejs'
export const maxDuration = 60

// H4A.1: hard server-side lifetime bound for an OBSERVATIONAL-only request. Guarantees the observational
// provider work is torn down well before the next 15s BASE sweep, EVEN IF the client's disconnect is not
// propagated to request.signal — so stale observational work can never contend with the next BASE
// acquisition. Kept below SWEEP_MS (15s) and ≥ the daemon's own 8s observation timeout.
const OBS_SERVER_DEADLINE_MS = (() => {
  const v = Number(process.env.COMPANION_LEADER_OBS_SERVER_DEADLINE_MS)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 10_000
})()

export async function POST(request: Request) {
  let body: { symbols?: string[]; observationalOnly?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const symbols = Array.isArray(body.symbols) ? body.symbols.filter(s => typeof s === 'string' && s.length > 0) : []
  // H4A.1: the subset that are leader-observation cohort members (data coverage only — the lighter
  // observational path, never BASE detection/execution). Optional + additive; absent = all BASE.
  const observationalOnly = Array.isArray(body.observationalOnly)
    ? body.observationalOnly.filter(s => typeof s === 'string' && s.length > 0)
    : []
  if (symbols.length === 0) {
    return NextResponse.json({ results: [], timestamp: Date.now() })
  }

  // H4A.1 server-side lifetime bound. ONLY when the whole request is observational (as the daemon's
  // cohort fetch always is) do we cancel: on the client's disconnect (request.signal, if propagated) OR
  // a hard server deadline (guaranteed). This tears down observational provider work so it cannot outlive
  // its lease or contend with the next BASE sweep. A BASE request (observationalOnly empty) gets NO
  // signal — its provider semantics are byte-unchanged.
  const fullyObservational = observationalOnly.length > 0 && observationalOnly.length === symbols.length
  const signal = fullyObservational
    ? AbortSignal.any([request.signal, AbortSignal.timeout(OBS_SERVER_DEADLINE_MS)])
    : undefined

  try {
    const results = await buildMonitorBatch(symbols, { observationalOnly, signal })
    return NextResponse.json({ results, timestamp: Date.now() })
  } catch (err) {
    console.error('monitor route error:', err)
    return NextResponse.json({ error: 'Failed to analyse symbols' }, { status: 500 })
  }
}
