// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

import { useBrokerTrades } from '@/hooks/useBrokerTrades'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const emptyPayload = { ok: true, asOf: Date.now(), trades: [], counts: { total: 0, closed: 0, open: 0, verified: 0, manualReview: 0 } }

describe('useBrokerTrades overlap guard', () => {
  it('collapses two rapid refresh() calls into a single in-flight request', async () => {
    let resolveFetch: (() => void) | null = null
    const calls: string[] = []
    const impl = vi.fn((url: string) => {
      calls.push(url)
      return new Promise<Response>(resolve => {
        resolveFetch = () => resolve(new Response(JSON.stringify(emptyPayload), { status: 200 }))
      })
    })
    vi.stubGlobal('fetch', impl)

    const { result } = renderHook(() => useBrokerTrades())

    // The mount-time fetch is in flight (never resolved yet). Call refresh()
    // again while it's still pending — this must be skipped, not queued as a
    // second concurrent request.
    await act(async () => {
      result.current.refresh()
    })

    expect(calls).toHaveLength(1)

    // Let the first (and only) request resolve, then confirm a THIRD call
    // after it completes is allowed through normally (the guard only blocks
    // overlap, not all future refreshes).
    await act(async () => {
      resolveFetch?.()
    })
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      result.current.refresh()
    })
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('never issues an order/execution-side request', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      return new Response(JSON.stringify(emptyPayload), { status: 200 })
    }))

    const { result } = renderHook(() => useBrokerTrades())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(calls.every(c => c.startsWith('GET'))).toBe(true)
    expect(calls.some(c => /order|submit|buy|sell/i.test(c))).toBe(false)
  })
})
