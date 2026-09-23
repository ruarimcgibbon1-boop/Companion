import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { toTradeView, buildTradeJournalView } from '@/lib/execution/trades-view'
import { newPaperTrade } from '@/lib/execution/types'
import type { PaperTrade } from '@/lib/execution/types'
import type { BuySignalRecord } from '@/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function signal(overrides: Partial<BuySignalRecord> = {}): BuySignalRecord {
  return {
    id: 'sig-1', setupId: 'setup-1', symbol: 'STFS', timestamp: 0,
    setupType: 'premarket_breakout', triggerPrice: 5.3, entryLow: 5.25, entryHigh: 5.33,
    invalidation: 5.0, stop: 5.0, targets: [5.72, 5.8], score: 70, grade: 'strong',
    rewardRisk: 2, priceAtSignal: 5.3, ...overrides,
  } as BuySignalRecord
}

function trade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  const t = newPaperTrade(signal({ id: overrides.signalId ?? 'sig-1', symbol: overrides.symbol ?? 'STFS' }), 1449, 5.36, 1000)
  return { ...t, state: 'open', openQty: 1449, entryFillQty: 1449, entryFillPrice: 5.33, ...overrides }
}

// ── toTradeView ────────────────────────────────────────────────────────────

describe('toTradeView', () => {
  it('is always brokerLink: linked — every row originates from the ledger', () => {
    const v = toTradeView(trade())
    expect(v.brokerLink).toBe('linked')
    expect(v.tradeId).toBe('pt:sig-1')
    expect(v.setupId).toBe('setup-1')
    expect(v.signalId).toBe('sig-1')
  })

  it('carries realizedPnl verbatim from the ledger, never recomputed', () => {
    const t = trade({ state: 'closed', realizedPnl: 123.45, realizedPnlPct: 6.78, fullyClosed: true })
    const v = toTradeView(t)
    expect(v.realizedPnl).toBe(123.45)
    expect(v.realizedPnlPct).toBe(6.78)
  })

  it('sanitizes exit fills to order id + fill evidence only', () => {
    const t = trade({
      exits: [{ qty: 700, reason: 't1', intendedPrice: 5.72, decisionPrice: 5.72, orderId: 'ord-1', fillPrice: 5.7, filledAt: 5000, slippagePct: -0.3 }],
    })
    const v = toTradeView(t)
    expect(v.exits).toHaveLength(1)
    expect(v.exits[0]).toEqual({ reason: 't1', qty: 700, orderId: 'ord-1', fillPrice: 5.7, filledAt: 5000, slippagePct: -0.3 })
  })

  it('carries reconciliation status and execution warnings through unchanged', () => {
    const t = trade({ reconciliationStatus: 'discrepancy', executionWarnings: ['qty mismatch'] })
    const v = toTradeView(t)
    expect(v.reconciliationStatus).toBe('discrepancy')
    expect(v.executionWarnings).toEqual(['qty mismatch'])
  })
})

// ── buildTradeJournalView ────────────────────────────────────────────────────

describe('buildTradeJournalView', () => {
  it('returns an empty payload for zero trades', () => {
    const view = buildTradeJournalView([], 2000)
    expect(view.ok).toBe(true)
    expect(view.trades).toEqual([])
    expect(view.counts).toEqual({ total: 0, closed: 0, open: 0, verified: 0, manualReview: 0 })
  })

  it('sorts newest-first by createdAt', () => {
    const older = trade({ signalId: 'a', setupId: 'sa', createdAt: 100 })
    const newer = trade({ signalId: 'b', setupId: 'sb', createdAt: 900 })
    const view = buildTradeJournalView([older, newer])
    expect(view.trades.map(t => t.tradeId)).toEqual(['pt:b', 'pt:a'])
  })

  it('tallies counts by state and reconciliation status', () => {
    const trades = [
      trade({ signalId: 'a', setupId: 'sa', state: 'closed', reconciliationStatus: 'verified' }),
      trade({ signalId: 'b', setupId: 'sb', state: 'closed', reconciliationStatus: 'manual_review' }),
      trade({ signalId: 'c', setupId: 'sc', state: 'open' }),
    ]
    const view = buildTradeJournalView(trades)
    expect(view.counts).toEqual({ total: 3, closed: 2, open: 1, verified: 1, manualReview: 1 })
  })

  it('never invents provenance — every row keeps its real setupId/signalId, nothing synthesized', () => {
    const t = trade({ signalId: 'real-signal', setupId: 'real-setup' })
    const view = buildTradeJournalView([t])
    expect(view.trades[0].signalId).toBe('real-signal')
    expect(view.trades[0].setupId).toBe('real-setup')
  })
})

// ── Route: credential-free, unavailable vs empty ──────────────────────────────

const loadRecentTradesMock = vi.fn()

vi.mock('@/lib/execution/store', () => ({
  loadRecentTrades: (...a: unknown[]) => loadRecentTradesMock(...a),
}))

describe('GET /api/paper/trades', () => {
  beforeEach(() => {
    loadRecentTradesMock.mockReset()
  })
  afterEach(() => vi.resetModules())

  it('returns sanitized ledger rows for the default 7-day window', async () => {
    loadRecentTradesMock.mockReturnValue([trade()])
    const { GET } = await import('@/app/api/paper/trades/route')
    const res = await GET(new Request('http://x/api/paper/trades'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.trades).toHaveLength(1)
    expect(loadRecentTradesMock).toHaveBeenCalledWith(7)
  })

  it('respects a days= query param, capped at 30', async () => {
    loadRecentTradesMock.mockReturnValue([])
    const { GET } = await import('@/app/api/paper/trades/route')
    await GET(new Request('http://x/api/paper/trades?days=90'))
    expect(loadRecentTradesMock).toHaveBeenCalledWith(30)
  })

  it('returns an empty (not error) payload when the ledger has no trades', async () => {
    loadRecentTradesMock.mockReturnValue([])
    const { GET } = await import('@/app/api/paper/trades/route')
    const res = await GET(new Request('http://x/api/paper/trades'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.trades).toEqual([])
  })

  it('reports UNAVAILABLE (not empty) when the ledger read throws', async () => {
    loadRecentTradesMock.mockImplementation(() => { throw new Error('disk error') })
    const { GET } = await import('@/app/api/paper/trades/route')
    const res = await GET(new Request('http://x/api/paper/trades'))
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.error).not.toMatch(/disk error/)
  })
})

// ── Route: /api/paper/account ─────────────────────────────────────────────────

const accountBrokerMock = { getAccount: vi.fn() }
let accountConstructorShouldThrow = false

vi.mock('@/lib/execution/alpaca', async () => {
  const actual = await vi.importActual<typeof import('@/lib/execution/alpaca')>('@/lib/execution/alpaca')
  return {
    ...actual,
    AlpacaBroker: class {
      constructor() { if (accountConstructorShouldThrow) throw new Error('ALPACA_KEY_ID / ALPACA_SECRET_KEY missing') }
      getAccount = accountBrokerMock.getAccount
    },
  }
})

describe('GET /api/paper/account', () => {
  beforeEach(() => {
    accountConstructorShouldThrow = false
    accountBrokerMock.getAccount.mockReset()
  })
  afterEach(() => vi.resetModules())

  it('returns sanitized account fields with no credentials in the body', async () => {
    accountBrokerMock.getAccount.mockResolvedValue({
      equity: 100_000, cash: 90_000, buyingPower: 180_000, daytradeCount: 0, blocked: false,
    })
    const { GET } = await import('@/app/api/paper/account/route')
    const res = await GET()
    const body = await res.json()
    const raw = JSON.stringify(body)
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.equity).toBe(100_000)
    expect(raw).not.toMatch(/APCA|SECRET|KEY_ID|secretKey|keyId/i)
  })

  it('reports UNAVAILABLE when credentials are missing', async () => {
    accountConstructorShouldThrow = true
    const { GET } = await import('@/app/api/paper/account/route')
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/not configured/i)
  })

  it('reports UNAVAILABLE (not a zeroed account) when the broker call throws', async () => {
    accountBrokerMock.getAccount.mockRejectedValue(new Error('network down'))
    const { GET } = await import('@/app/api/paper/account/route')
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.error).not.toMatch(/network down/)
  })
})

