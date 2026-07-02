'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { ScannerRow } from '@/types'

const SCAN_INTERVAL = 30_000 // 30s — matches candle refresh cadence

export function useScanner() {
  const {
    filters,
    setScannerRows,
    setScannerLoading,
    setScannerError,
    setLastScanTime,
  } = useTradingStore()

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const scan = useCallback(async (force = false) => {
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
    timerRef.current = setInterval(scan, SCAN_INTERVAL)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      abortRef.current?.abort()
    }
  }, [scan])

  return { scan }
}
