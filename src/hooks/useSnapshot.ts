'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { TickerSnapshot } from '@/types'

const SNAPSHOT_INTERVAL = 20_000 // 20 sec

export function useSnapshot() {
  const {
    selectedSymbol,
    setSnapshot,
    setSnapshotLoading,
    setSnapshotError,
  } = useTradingStore()

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const currentSymbol = useRef<string | null>(null)

  const fetchSnapshot = useCallback(async (sym: string) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setSnapshotLoading(true)
    setSnapshotError(null)

    try {
      const res = await fetch(`/api/snapshot?symbol=${sym}`, {
        signal: abortRef.current.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: TickerSnapshot = await res.json()
      setSnapshot(data)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setSnapshotError((err as Error).message)
    } finally {
      setSnapshotLoading(false)
    }
  }, [setSnapshot, setSnapshotLoading, setSnapshotError])

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    abortRef.current?.abort()

    if (!selectedSymbol) {
      setSnapshot(null)
      return
    }

    currentSymbol.current = selectedSymbol
    fetchSnapshot(selectedSymbol)
    timerRef.current = setInterval(() => {
      if (currentSymbol.current) fetchSnapshot(currentSymbol.current)
    }, SNAPSHOT_INTERVAL)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      abortRef.current?.abort()
    }
  }, [selectedSymbol, fetchSnapshot, setSnapshot])
}
