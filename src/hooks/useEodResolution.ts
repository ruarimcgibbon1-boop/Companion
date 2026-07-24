/**
 * Drives the end-of-day resolver from the client: fetches each stale-open log's
 * day tape via /api/candles and writes the resolved outcomes back to the store.
 *
 * Mount with { auto: true } once at the app root (TopBar) so open outcomes from
 * closed sessions reconcile on load; mount with { auto: false } anywhere that
 * needs a manual "Resolve open" button (the Buy Log).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Candle } from '@/types'
import { useTradingStore } from '@/store/trading-store'
import { resolveOpenLogs } from '@/lib/eod-resolver'

async function fetchDayCandles(symbol: string): Promise<Candle[]> {
  const res = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=5min`)
  if (!res.ok) throw new Error(`candles ${symbol}: ${res.status}`)
  const data = await res.json()
  return (data.candles ?? []) as Candle[]
}

type Status = 'idle' | 'running' | 'done' | 'error'

export function useEodResolution({ auto = false }: { auto?: boolean } = {}) {
  const openCount = useTradingStore(s => s.setupLogs.filter(l => l.outcome === 'open').length)
  const upsertSetupLog = useTradingStore(s => s.upsertSetupLog)
  const [status, setStatus] = useState<Status>('idle')
  const [lastResolved, setLastResolved] = useState(0)
  const inFlight = useRef(false)

  const resolveNow = useCallback(async (): Promise<number> => {
    if (inFlight.current) return 0
    inFlight.current = true
    setStatus('running')
    try {
      // Read the freshest logs at call time, not a stale closure.
      const logs = useTradingStore.getState().setupLogs
      const resolved = await resolveOpenLogs(logs, Date.now(), fetchDayCandles)
      for (const l of resolved) upsertSetupLog(l)
      setLastResolved(resolved.length)
      setStatus('done')
      return resolved.length
    } catch {
      setStatus('error')
      return 0
    } finally {
      inFlight.current = false
    }
  }, [upsertSetupLog])

  const autoRan = useRef(false)
  useEffect(() => {
    if (!auto || autoRan.current) return
    autoRan.current = true
    void resolveNow()
  }, [auto, resolveNow])

  return { resolveNow, status, lastResolved, openCount }
}
