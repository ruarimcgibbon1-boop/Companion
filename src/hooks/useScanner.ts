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
    // Skip background polling when the tab is hidden (a forced/manual scan still runs).
    if (!force && typeof document !== 'undefined' && document.hidden) return
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
    // Force a full re-pull on a fixed cadence regardless of tab visibility, so a
    // backgrounded scanner still reflects the current gainers (the 20s poll above
    // self-pauses when hidden). `force` bypasses both the hidden-tab guard and the
    // server-side 20s cache.
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
