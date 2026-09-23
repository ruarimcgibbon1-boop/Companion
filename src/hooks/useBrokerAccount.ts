'use client'

/**
 * Alpaca PAPER account summary for the Positions tab top bar. Polled gently
 * (account equity/buying power barely moves tick-to-tick); a failed refresh
 * retains the last known snapshot and is flagged via `error`, never silently
 * treated as a zeroed account.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaperAccountPayload, PaperAccountError } from '@/app/api/paper/account/route'

const POLL_MS = 30_000

export interface BrokerAccountState {
  account: Omit<PaperAccountPayload, 'ok' | 'asOf'> | null
  loading: boolean
  error: string | null
  lastSuccessAt: number | null
  refresh: () => void
}

export function useBrokerAccount(): BrokerAccountState {
  const [account, setAccount] = useState<BrokerAccountState['account']>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)

  const poll = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetch('/api/paper/account', { cache: 'no-store' })
      const data = (await res.json()) as PaperAccountPayload | PaperAccountError
      if (!mounted.current) return

      if (res.ok && data.ok) {
        const { equity, cash, buyingPower, daytradeCount, blocked } = data
        setAccount({ equity, cash, buyingPower, daytradeCount, blocked })
        setLastSuccessAt(data.asOf)
        setError(null)
      } else {
        setError(!data.ok ? data.error : `HTTP ${res.status}`)
      }
    } catch {
      if (mounted.current) setError('Network error reaching broker account feed')
    } finally {
      inFlight.current = false
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      poll().finally(() => {
        timer = setTimeout(tick, POLL_MS)
      })
    }
    tick()
    return () => { mounted.current = false; clearTimeout(timer) }
  }, [poll])

  return { account, loading, error, lastSuccessAt, refresh: poll }
}
