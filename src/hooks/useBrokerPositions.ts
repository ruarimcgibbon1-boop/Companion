'use client'

/**
 * Live broker-position feed for the Positions bar.
 *
 * Polls the server-only /api/paper/positions endpoint (Alpaca stays behind the
 * server; no credentials touch the browser) on a cadence that tracks the trading
 * session — fast while the market is active, slow when it's closed. Two rules
 * shape the behaviour, both from Phase 5/11:
 *
 *   1. Requests never overlap. Each tick is skipped if one is still in flight, so
 *      a slow response can't stack a backlog of fetches.
 *   2. A failed refresh NEVER clears positions. The last good broker snapshot is
 *      retained and flagged `stale`; an empty list is only ever shown when the
 *      broker itself reported flat (ok:true, positions:[]).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getSessionType } from '@/lib/market-hours'
import type {
  BrokerPositionView,
  PaperPositionsPayload,
  PaperPositionsResponse,
} from '@/lib/execution/positions-view'

/** Poll cadence by session. Active RTH is the fast path; closed markets barely move. */
export function pollIntervalMs(now: number = Date.now()): number {
  switch (getSessionType(now)) {
    case 'regular':
      return 2_500
    case 'premarket':
    case 'afterhours':
      return 5_000
    default:
      return 30_000
  }
}

/**
 * Stale threshold, scaled to the live cadence: a feed is stale only once a
 * refresh is overdue by several poll cycles, never merely because the cadence is
 * slow. At the 30s closed-session cadence this is 90s, so a healthy poll that
 * lands every 30s never flips stale; a 15s floor keeps the fast RTH/extended
 * paths (7.5s / 15s raw) from tripping between normal ticks.
 */
export function staleThresholdMs(now: number = Date.now()): number {
  return Math.max(15_000, pollIntervalMs(now) * 3)
}

export interface BrokerPositionsState {
  positions: BrokerPositionView[]
  counts: PaperPositionsPayload['counts'] | null
  loading: boolean
  /** ms epoch of the last SUCCESSFUL refresh; null until the first one lands. */
  lastSuccessAt: number | null
  /** True once the last good snapshot is older than staleThresholdMs(), or a fetch failed. */
  stale: boolean
  /** Broker unreachable / endpoint error. Positions are retained when this is set. */
  error: string | null
  /** True only when the broker itself confirmed flat (not on error). */
  brokerFlat: boolean
  refresh: () => void
}

export function useBrokerPositions(): BrokerPositionsState {
  const [positions, setPositions] = useState<BrokerPositionView[]>([])
  const [counts, setCounts] = useState<PaperPositionsPayload['counts'] | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [brokerFlat, setBrokerFlat] = useState(false)
  // Ticks every second so `stale` flips on its own even if polling stalls.
  const [clock, setClock] = useState(() => Date.now())

  const inFlight = useRef(false)
  const mounted = useRef(true)

  const poll = useCallback(async () => {
    if (inFlight.current) return   // rule 1: never overlap
    inFlight.current = true
    try {
      const res = await fetch('/api/paper/positions', { cache: 'no-store' })
      const data = (await res.json()) as PaperPositionsResponse
      if (!mounted.current) return

      if (res.ok && data.ok) {
        setPositions(data.positions)
        setCounts(data.counts)
        setBrokerFlat(data.positions.length === 0)
        setLastSuccessAt(data.asOf)
        setError(null)
      } else {
        // rule 2: retain last known positions, mark the feed errored.
        setError(!data.ok ? data.error : `HTTP ${res.status}`)
      }
    } catch {
      if (mounted.current) setError('Network error reaching broker feed')
    } finally {
      inFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])

  // Poll loop — re-armed each tick so the interval can follow the session cadence.
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      poll().finally(() => {
        timer = setTimeout(tick, pollIntervalMs())
      })
    }
    tick()
    return () => {
      mounted.current = false
      clearTimeout(timer)
    }
  }, [poll])

  // 1 Hz wall clock so `stale` becomes true without waiting for the next poll.
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])

  const stale =
    error != null ||
    (lastSuccessAt != null && clock - lastSuccessAt > staleThresholdMs(clock))

  return {
    positions,
    counts,
    loading,
    lastSuccessAt,
    stale,
    error,
    brokerFlat: brokerFlat && error == null,
    refresh: poll,
  }
}
