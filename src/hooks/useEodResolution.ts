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
import { resolveOpenLogs, resolveBuyPnl, normalizeCandles } from '@/lib/eod-resolver'
import { resolvePatternLog } from '@/lib/pattern-resolver'

async function fetchDayCandles(symbol: string): Promise<Candle[]> {
  const res = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=5min`)
  if (!res.ok) throw new Error(`candles ${symbol}: ${res.status}`)
  const data = await res.json()
  // /api/candles returns candles keyed by `date` (ISO), not `time` (unix sec);
  // normalizeCandles converts them so the resolver actually matches the day.
  return normalizeCandles(data.candles)
}

// Fetch each symbol at most once per resolve pass — the log resolver and the P/L
// resolver both want the same day tape.
function makeCachedFetch(): (symbol: string) => Promise<Candle[]> {
  const cache = new Map<string, Promise<Candle[]>>()
  return (symbol: string) => {
    let p = cache.get(symbol)
    if (!p) { p = fetchDayCandles(symbol); cache.set(symbol, p) }
    return p
  }
}

type Status = 'idle' | 'running' | 'done' | 'error'

export function useEodResolution({ auto = false }: { auto?: boolean } = {}) {
  const openCount = useTradingStore(s => s.setupLogs.filter(l => l.outcome === 'open').length)
  const unpricedCount = useTradingStore(s => s.buySignals.filter(b => b.pnlPct == null).length)
  const upsertSetupLog = useTradingStore(s => s.upsertSetupLog)
  const updateBuySignal = useTradingStore(s => s.updateBuySignal)
  const updatePatternLogs = useTradingStore(s => s.updatePatternLogs)
  const [status, setStatus] = useState<Status>('idle')
  const [lastResolved, setLastResolved] = useState(0)
  const inFlight = useRef(false)

  const resolveNow = useCallback(async (): Promise<number> => {
    if (inFlight.current) return 0
    inFlight.current = true
    setStatus('running')
    try {
      // Read the freshest state at call time, not a stale closure.
      const { setupLogs, buySignals, patternLog } = useTradingStore.getState()
      const now = Date.now()
      const fetchCandles = makeCachedFetch()

      const resolvedLogs = await resolveOpenLogs(setupLogs, now, fetchCandles)
      for (const l of resolvedLogs) upsertSetupLog(l)

      const pricedBuys = await resolveBuyPnl(buySignals, now, fetchCandles)
      for (const b of pricedBuys) updateBuySignal(b.id, { pnlPct: b.pnlPct, pnlFullyClosed: b.pnlFullyClosed })

      // Patterns resolve on the same pass and the same cached tape. Until this
      // existed the pattern log recorded occurrences and never outcomes, so it
      // could not answer which patterns pay — the only thing it's for.
      const resolvedPatterns = await resolvePatternLog(patternLog, fetchCandles, now)
      updatePatternLogs(resolvedPatterns)

      const total = resolvedLogs.length + pricedBuys.length + resolvedPatterns.length
      setLastResolved(total)
      setStatus('done')
      return total
    } catch {
      setStatus('error')
      return 0
    } finally {
      inFlight.current = false
    }
  }, [upsertSetupLog, updateBuySignal, updatePatternLogs])

  const autoRan = useRef(false)
  useEffect(() => {
    if (!auto || autoRan.current) return
    autoRan.current = true
    void resolveNow()
  }, [auto, resolveNow])

  return { resolveNow, status, lastResolved, openCount, unpricedCount, pendingCount: openCount + unpricedCount }
}
