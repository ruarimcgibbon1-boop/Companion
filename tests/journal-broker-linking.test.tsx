// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import { TradeJournal } from '@/components/journal/TradeJournal'
import { useTradingStore } from '@/store/trading-store'
import type { BrokerTradeView, JournalTradesPayload } from '@/lib/execution/trades-view'

function brokerTrade(overrides: Partial<BrokerTradeView> = {}): BrokerTradeView {
  return {
    tradeId: 'pt:sig-1', signalId: 'sig-1', setupId: 'setup-1', symbol: 'STFS',
    setupType: 'premarket_breakout', state: 'closed', brokerLink: 'linked',
    qty: 1449, openQty: 0, entryOrderId: 'ord-entry', entryFillPrice: 5.33, entryFilledAt: 1000,
    entrySlippagePct: 0.1,
    exits: [{ reason: 't1', qty: 700, orderId: 'ord-t1', fillPrice: 5.7, filledAt: 2000, slippagePct: -0.2 }],
    realizedPnl: 245.6, realizedPnlPct: 4.1, fullyClosed: true,
    reconciliationStatus: 'verified', executionWarnings: [],
    createdAt: 1000, updatedAt: 3000,
    ...overrides,
  }
}

function mockTradesFetch(payload: JournalTradesPayload | { ok: false; asOf: number; error: string }, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status })))
}

const existingManualPosition = {
  id: 'm1', symbol: 'HIST', direction: 'long' as const, shares: 200, entry: 3, stop: 2.5,
  initialStop: 2.5, targets: [], trailingMode: 'none' as const, trailingValue: 0, trailingHigh: 3,
  status: 'closed' as const, openedAt: 1000, closedAt: 5000, closePrice: 3.5, notes: '', tags: [],
  rating: null, plannedEntry: true, setupType: 'Breakout', currentPrice: null, unrealizedPnl: null,
  unrealizedPnlPct: null, lastPriceUpdate: null,
}

beforeEach(() => {
  useTradingStore.setState({ positions: [existingManualPosition] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TradeJournal broker-linked section', () => {
  it('still renders existing manual/local historical entries', () => {
    mockTradesFetch({ ok: true, asOf: Date.now(), trades: [], counts: { total: 0, closed: 0, open: 0, verified: 0, manualReview: 0 } })
    render(<TradeJournal onClose={() => {}} />)
    expect(screen.getByText('HIST')).toBeInTheDocument()
  })

  it('shows a broker-linked ledger trade as a passive "Linked" status with its reconciliation status', async () => {
    const payload: JournalTradesPayload = {
      ok: true, asOf: Date.now(), trades: [brokerTrade()],
      counts: { total: 1, closed: 1, open: 0, verified: 1, manualReview: 0 },
    }
    mockTradesFetch(payload)
    render(<TradeJournal onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('STFS')).toBeInTheDocument())
    expect(screen.getByText('Linked')).toBeInTheDocument()
    expect(screen.getByText('Verified')).toBeInTheDocument()
  })

  it('never fabricates strategy provenance — every ledger row keeps its real setupType', async () => {
    const payload: JournalTradesPayload = {
      ok: true, asOf: Date.now(), trades: [brokerTrade({ setupType: 'opening_drive' })],
      counts: { total: 1, closed: 1, open: 0, verified: 1, manualReview: 0 },
    }
    mockTradesFetch(payload)
    render(<TradeJournal onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('opening_drive')).toBeInTheDocument())
  })

  it('shows the ledger-unavailable state distinctly, not as an empty list', async () => {
    mockTradesFetch({ ok: false, asOf: Date.now(), error: 'Ledger unavailable' }, 503)
    render(<TradeJournal onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/Ledger unavailable/)).toBeInTheDocument())
  })
})
