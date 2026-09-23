'use client'

/**
 * Journal's broker-linked trade history feed.
 *
 * Unlike useBrokerPositions (live, polled fast during market hours), this is
 * historical/completed-trade data — fetched on demand (mount + manual
 * refresh) rather than polled. A failed refresh retains the last known list
 * rather than clearing it, matching the "never conflate error with empty"
 * rule from the positions feed.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrokerTradeView, JournalTradesPayload } from '@/lib/execution/trades-view'
import type { JournalTradesError } from '@/app/api/paper/trades/route'

export interface BrokerTradesState {
  trades: BrokerTradeView[]
  counts: JournalTradesPayload['counts'] | null
  loading: boolean
  error: string | null
  lastSuccessAt: number | null
  refresh: () => void
}

export function useBrokerTrades(days = 7): BrokerTradesState {
  const [trades, setTrades] = useState<BrokerTradeView[]>([])
  const [counts, setCounts] = useState<JournalTradesPayload['counts'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)

  const fetchTrades = useCallback(async () => {
    // Same overlap guard as useBrokerPositions/useBrokerAccount: a second
    // refresh() (StrictMode double-invoke, a fast double click) skips rather
    // than firing a concurrent duplicate request.
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    try {
      const res = await fetch(`/api/paper/trades?days=${days}`, { cache: 'no-store' })
      const data = (await res.json()) as JournalTradesPayload | JournalTradesError
      if (!mounted.current) return

      if (res.ok && data.ok) {
        setTrades(data.trades)
        setCounts(data.counts)
        setLastSuccessAt(data.asOf)
        setError(null)
      } else {
        setError(!data.ok ? data.error : `HTTP ${res.status}`)
      }
    } catch {
      if (mounted.current) setError('Network error reaching ledger feed')
    } finally {
      inFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }, [days])

  useEffect(() => {
    mounted.current = true
    const tick = () => { fetchTrades() }
    tick()
    return () => { mounted.current = false }
  }, [fetchTrades])

  return { trades, counts, loading, error, lastSuccessAt, refresh: fetchTrades }
}
