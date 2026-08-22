'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { ScannerRow } from '@/types'

const SCAN_INTERVAL = 20_000       // 20s — fast foreground refresh (pauses when the tab is hidden)
const BACKGROUND_REFRESH = 300_000 // 5min — guaranteed full re-pull of the gainers universe, even
                                   // when the tab is backgrounded, so the list is never more than
                                   // ~5 min stale when you glance back to it.

export function useScanner() {
  const {
    filters,
    setScannerRows,
    setScannerLoading,
    setScannerError,
    setLastScanTime,
  } = useTradingStore()

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bgTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const scan = useCallback(async (force = false) => {
    // Keeps polling even when the tab is hidden, so the monitor it feeds never
    // runs against a stale/empty universe in a backgrounded session (that combo
    // printed 0 signals on 2026-07-24/27). Browsers throttle background timers to
    // ~once/minute, so this stays cheap; `force` still bypasses the server cache.
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setScannerLoading(true)
    setScannerError(null)

    try {
      const params = new URLSearchParams({
        minChangePct: String(filters.minChangePct),
        minVolume: String(filters.minVolume),
        maxPrice: String(filters.maxPrice),
        minPrice: String(filters.minPrice),
        maxResults: String(filters.maxResults),
      })
      if (filters.minRelativeVolume > 0) params.set('minRvol', String(filters.minRelativeVolume))
      if (filters.minMarketCap) params.set('minMktCap', String(filters.minMarketCap))
      if (filters.maxFloat) params.set('maxFloat', String(filters.maxFloat))
      if (force) params.set('refresh', '1')

      const res = await fetch(`/api/gainers?${params}`, {
        signal: abortRef.current.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { rows: ScannerRow[]; timestamp: number }
      setScannerRows(data.rows ?? [])
      setLastScanTime(data.timestamp)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setScannerError((err as Error).message)
    } finally {
      setScannerLoading(false)
    }
  }, [filters, setScannerRows, setScannerLoading, setScannerError, setLastScanTime])

  useEffect(() => {
    scan()
    timerRef.current = setInterval(() => scan(), SCAN_INTERVAL)
    // The 20s poll keeps running when hidden (throttled to ~1/min by the browser);
    // this slower forced re-pull additionally bypasses the server-side 20s cache
    // so a long-backgrounded scanner still gets a guaranteed fresh universe.
    bgTimerRef.current = setInterval(() => scan(true), BACKGROUND_REFRESH)
    // On refocus, refresh immediately so there's no stale flash.
    const onVisible = () => { if (!document.hidden) scan() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (bgTimerRef.current) clearInterval(bgTimerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
      abortRef.current?.abort()
    }
  }, [scan])

  return { scan }
}
