// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { PositionTracker } from '@/components/positions/PositionTracker'
import { useTradingStore } from '@/store/trading-store'
import type { BrokerPositionView } from '@/lib/execution/positions-view'
import type { BrokerPositionsState } from '@/hooks/useBrokerPositions'

// PositionTracker no longer instantiates useBrokerPositions() itself — it
// receives the broker feed as a prop from its parent (TopBar), which owns the
// single poll loop. These tests construct that state directly rather than
// mocking /api/paper/positions, which also proves the drawer performs no
// independent positions fetch of its own (see the dedicated assertion below).

function brokerRow(overrides: Partial<BrokerPositionView> = {}): BrokerPositionView {
  return {
    symbol: 'STFS', direction: 'long', qty: 1449, qtyAvailable: 1449,
    avgEntryPrice: 5.33, currentPrice: 5.8, unrealizedPnl: 681.03, unrealizedPnlPct: 8.8,
    source: 'companion', tradeId: 'pt:sig-1', signalId: 'sig-1', setupType: 'premarket_breakout',
    initialStop: 5.0, currentStop: 5.0, hasProtectiveStop: false, t1: 5.72, t2: 5.8,
    targetState: 'none', reconciliationStatus: 'verified', lastUpdatedAt: Date.now(),
    ...overrides,
  }
}

function brokerState(overrides: Partial<BrokerPositionsState> = {}): BrokerPositionsState {
  return {
    positions: [],
    counts: null,
    loading: false,
    lastSuccessAt: Date.now(),
    stale: false,
    error: null,
    brokerFlat: true,
    refresh: vi.fn(),
    ...overrides,
  }
}

const accountOk = {
  ok: true, asOf: Date.now(), equity: 100_000, cash: 90_000, buyingPower: 180_000,
  daytradeCount: 0, blocked: false,
}

/** Only /api/paper/account is expected to be fetched by PositionTracker now (for the summary bar). */
function mockAccountFetch(accountResponse: unknown = accountOk) {
  const calls: { url: string; method: string }[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    if (String(url).startsWith('/api/paper/account')) {
      return new Response(JSON.stringify(accountResponse), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, error: 'unexpected fetch in test' }), { status: 500 })
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

beforeEach(() => {
  // Reset the manual/local tracker store between tests — it's a module-level
  // singleton, so a leftover position from one test would leak into the next.
  useTradingStore.setState({ positions: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PositionTracker (Positions tab)', () => {
  it('shows "no open positions" when Alpaca is connected and flat', async () => {
    mockAccountFetch()
    render(<PositionTracker broker={brokerState({ brokerFlat: true })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/no open PAPER positions/i)).toBeInTheDocument())
  })

  it('shows the broker-unavailable state distinctly from flat', async () => {
    mockAccountFetch()
    render(<PositionTracker broker={brokerState({ error: 'Alpaca credentials not configured', brokerFlat: false, lastSuccessAt: null })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0))
  })

  it('renders a single COMPANION-linked position with its reconciliation status', async () => {
    mockAccountFetch()
    const row = brokerRow()
    render(<PositionTracker broker={brokerState({ positions: [row], brokerFlat: false, counts: { open: 1, companion: 1, external: 0, unattributed: 0, unrealizedPnl: 681.03 } })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('STFS')).toBeInTheDocument())
    expect(screen.getByText('COMPANION')).toBeInTheDocument()
    expect(screen.getByText('VERIFIED')).toBeInTheDocument()
  })

  it('renders an EXTERNAL/unlinked broker position without fabricating strategy metadata', async () => {
    mockAccountFetch()
    const row = brokerRow({
      symbol: 'MSFT', source: 'external', tradeId: null, signalId: null, setupType: null,
      initialStop: null, currentStop: null, t1: null, t2: null, targetState: null, reconciliationStatus: null,
    })
    render(<PositionTracker broker={brokerState({ positions: [row], brokerFlat: false, counts: { open: 1, companion: 0, external: 1, unattributed: 0, unrealizedPnl: 681.03 } })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('MSFT')).toBeInTheDocument())
    expect(screen.getByText('EXTERNAL')).toBeInTheDocument()
    // No VERIFIED/DISCREPANCY/etc reconciliation badge — nothing to reconcile against.
    expect(screen.queryByText('VERIFIED')).not.toBeInTheDocument()
  })

  it('flags a reconciliation mismatch (discrepancy) distinctly', async () => {
    mockAccountFetch()
    const row = brokerRow({ reconciliationStatus: 'discrepancy' })
    render(<PositionTracker broker={brokerState({ positions: [row], brokerFlat: false, counts: { open: 1, companion: 1, external: 0, unattributed: 0, unrealizedPnl: 681.03 } })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('DISCREPANCY')).toBeInTheDocument())
  })

  it('renders multiple positions', async () => {
    mockAccountFetch()
    const rows = [brokerRow({ symbol: 'STFS' }), brokerRow({ symbol: 'AUUD', tradeId: 'pt:sig-2', signalId: 'sig-2' })]
    render(<PositionTracker broker={brokerState({ positions: rows, brokerFlat: false, counts: { open: 2, companion: 2, external: 0, unattributed: 0, unrealizedPnl: 1362.06 } })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('STFS')).toBeInTheDocument())
    expect(screen.getByText('AUUD')).toBeInTheDocument()
  })

  it('never calls a broker mutation endpoint, and never fetches /api/paper/positions itself — read-only, prop-driven', async () => {
    const calls = mockAccountFetch()
    const row = brokerRow()
    render(<PositionTracker broker={brokerState({ positions: [row], brokerFlat: false, counts: { open: 1, companion: 1, external: 0, unattributed: 0, unrealizedPnl: 681.03 } })} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('STFS')).toBeInTheDocument())
    // Give any stray effect a tick to fire before asserting on the call log.
    await new Promise(r => setTimeout(r, 0))
    expect(calls.every(c => c.method === 'GET')).toBe(true)
    expect(calls.some(c => c.url.includes('/api/paper/positions'))).toBe(false)
    expect(calls.some(c => /order|submit|buy|sell/i.test(c.url))).toBe(false)
  })

  it('retains manual/local tracker functionality (Add Position, existing entries)', async () => {
    mockAccountFetch()
    useTradingStore.setState({
      positions: [{
        id: 'm1', symbol: 'ABCD', direction: 'long', shares: 100, entry: 5, stop: 4.5,
        initialStop: 4.5, targets: [], trailingMode: 'none', trailingValue: 0, trailingHigh: 5,
        status: 'open', openedAt: Date.now(), closedAt: null, closePrice: null, notes: '', tags: [],
        rating: null, plannedEntry: true, setupType: '', currentPrice: null, unrealizedPnl: null,
        unrealizedPnlPct: null, lastPriceUpdate: null,
      }],
    })
    render(<PositionTracker broker={brokerState()} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('ABCD')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /\+ Add/i })).toBeInTheDocument()
  })
})
