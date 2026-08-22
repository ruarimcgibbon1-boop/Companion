import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  buildPositionView,
  attributePosition,
  toPositionView,
  type Attribution,
} from '@/lib/execution/positions-view'
import { pollIntervalMs, staleThresholdMs } from '@/hooks/useBrokerPositions'
import { newPaperTrade } from '@/lib/execution/types'
import type { BrokerPosition, PaperTrade } from '@/lib/execution/types'
import type { BuySignalRecord } from '@/types'

const EXTERNAL_ATTR: Attribution = { trade: null, source: 'external', reason: 'test' }

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

function brokerPos(overrides: Partial<BrokerPosition> = {}): BrokerPosition {
  return {
    symbol: 'STFS', qty: 1449, qtyAvailable: 1449,
    avgEntryPrice: 5.33, currentPrice: 5.8, unrealizedPl: 681.03, ...overrides,
  }
}

const ASOF = 2_000

// ── Attribution ──────────────────────────────────────────────────────────────

describe('attribution', () => {
  it('labels COMPANION only for a UNIQUE active ledger trade, with full metadata (Phase 4/13.5)', () => {
    const view = buildPositionView([brokerPos()], [trade()], ASOF)
    expect(view.positions).toHaveLength(1)
    const p = view.positions[0]
    expect(p.source).toBe('companion')
    expect(p.tradeId).toBe('pt:sig-1')
    expect(p.signalId).toBe('sig-1')
    expect(p.setupType).toBe('premarket_breakout')
    expect(p.initialStop).toBe(5.0)
    expect(p.t1).toBe(5.72)
    expect(p.t2).toBe(5.8)
  })

  it('labels an untraded symbol EXTERNAL with no strategy metadata (Phase 4/13.4)', () => {
    const view = buildPositionView([brokerPos({ symbol: 'MSFT' })], [trade()], ASOF)
    const p = view.positions[0]
    expect(p.source).toBe('external')
    expect(p.tradeId).toBeNull()
    expect(p.signalId).toBeNull()
    expect(p.setupType).toBeNull()
    expect(p.initialStop).toBeNull()
    expect(p.reconciliationStatus).toBeNull()
  })

  it('stays COMPANION on the sole ACTIVE trade even beside a closed one for the symbol', () => {
    const closed = trade({ signalId: 'old', state: 'closed', openQty: 0, updatedAt: 5000, reconciliationStatus: 'verified' })
    const active = trade({ signalId: 'new', state: 'open', updatedAt: 1000, reconciliationStatus: 'pending' })
    const a = attributePosition('STFS', [closed, active])
    expect(a.source).toBe('companion')
    expect(a.trade?.signalId).toBe('new')
  })

  it('refuses COMPANION when MULTIPLE active trades share a symbol → UNATTRIBUTED (ambiguous)', () => {
    const a = trade({ signalId: 'a', setupId: 'sa', state: 'open', updatedAt: 100 })
    const b = trade({ signalId: 'b', setupId: 'sb', state: 'open', updatedAt: 900 })
    const attr = attributePosition('STFS', [a, b])
    expect(attr.source).toBe('unattributed')
    expect(attr.trade).toBeNull()

    // …and the built view carries NO strategy metadata for it.
    const p = buildPositionView([brokerPos()], [a, b], ASOF).positions[0]
    expect(p.source).toBe('unattributed')
    expect(p.tradeId).toBeNull()
    expect(p.signalId).toBeNull()
    expect(p.initialStop).toBeNull()
    expect(p.currentStop).toBeNull()
    expect(p.reconciliationStatus).toBeNull()
  })

  it('treats a STALE previous (closed-only) trade as UNATTRIBUTED, never COMPANION', () => {
    const a = trade({ signalId: 'a', state: 'closed', openQty: 0, updatedAt: 100 })
    const b = trade({ signalId: 'b', state: 'aborted', openQty: 0, updatedAt: 900 })
    const attr = attributePosition('STFS', [a, b])
    expect(attr.source).toBe('unattributed')
    expect(attr.trade).toBeNull()
    // No stale stops/targets leak onto a live broker position.
    const p = buildPositionView([brokerPos()], [a, b], ASOF).positions[0]
    expect(p.source).toBe('unattributed')
    expect(p.initialStop).toBeNull()
    expect(p.t1).toBeNull()
  })

  it('links a single active Companion trade even when a MANUAL-tracker symbol collides', () => {
    // Manual/local positions live in Zustand and are NOT part of the broker↔ledger
    // join, so they can never pull a broker row toward or away from COMPANION. The
    // ledger has exactly one active STFS trade → the broker STFS row is COMPANION.
    const view = buildPositionView([brokerPos()], [trade()], ASOF)
    expect(view.positions).toHaveLength(1)
    expect(view.positions[0].source).toBe('companion')
    expect(view.counts.companion).toBe(1)
  })

  it('an ambiguous match must NEVER silently become Companion (invariant)', () => {
    // Two active + one stale for the same symbol: still ambiguous, still refused.
    const trades = [
      trade({ signalId: 'a', setupId: 'sa', state: 'open', updatedAt: 100 }),
      trade({ signalId: 'b', setupId: 'sb', state: 'open', updatedAt: 200 }),
      trade({ signalId: 'c', setupId: 'sc', state: 'closed', openQty: 0, updatedAt: 300 }),
    ]
    expect(attributePosition('STFS', trades).source).not.toBe('companion')
  })
})

// ── Broker truth ─────────────────────────────────────────────────────────────

describe('broker is authoritative', () => {
  it('reflects the exact broker quantity after a partial T1 scale-out (Phase 7/13.2)', () => {
    // Ledger still thinks 1449; broker has scaled to 724. Broker wins.
    const t = trade({ openQty: 1449, t1Done: true })
    const view = buildPositionView([brokerPos({ qty: 724, qtyAvailable: 724 })], [t], ASOF)
    expect(view.positions[0].qty).toBe(724)
    expect(view.positions[0].targetState).toBe('t1_hit')
  })

  it('drops the position entirely when the broker is flat (Phase 3/7/13.3)', () => {
    // Broker returns no positions; a stale local ledger trade cannot invent one.
    const view = buildPositionView([], [trade()], ASOF)
    expect(view.positions).toHaveLength(0)
    expect(view.counts.open).toBe(0)
  })

  it('never lets a local record override broker qty (Phase 7/13.8)', () => {
    const t = trade({ openQty: 9999 })   // absurd local qty
    const view = buildPositionView([brokerPos({ qty: 500, qtyAvailable: 500 })], [t], ASOF)
    expect(view.positions[0].qty).toBe(500)
  })

  it('derives direction and absolute qty from a short broker position', () => {
    const v = toPositionView(brokerPos({ qty: -300, qtyAvailable: -300 }), EXTERNAL_ATTR, ASOF)
    expect(v.direction).toBe('short')
    expect(v.qty).toBe(300)
    expect(v.qtyAvailable).toBe(300)
  })

  it('computes unrealised P&L% from broker avg/current prices', () => {
    const v = toPositionView(brokerPos({ avgEntryPrice: 5.33, currentPrice: 5.8 }), EXTERNAL_ATTR, ASOF)
    expect(v.unrealizedPnlPct).toBeCloseTo(8.818, 2)
  })
})

// ── Target progress + reconciliation ─────────────────────────────────────────

describe('target progress and reconciliation', () => {
  it('marks T2 hit once the ledger records a filled T2 leg', () => {
    const t = trade({
      t1Done: true,
      exits: [{ qty: 700, reason: 't2', intendedPrice: 5.8, decisionPrice: 5.8, orderId: 'o', fillPrice: 5.8, filledAt: 1, slippagePct: 0 }],
    })
    expect(buildPositionView([brokerPos()], [t], ASOF).positions[0].targetState).toBe('t2_hit')
  })

  it('surfaces a discrepancy reconciliation status (Phase 10/13.9)', () => {
    const t = trade({ reconciliationStatus: 'discrepancy' })
    expect(buildPositionView([brokerPos()], [t], ASOF).positions[0].reconciliationStatus).toBe('discrepancy')
  })

  it('carries verified status through to the view', () => {
    const t = trade({ reconciliationStatus: 'verified' })
    expect(buildPositionView([brokerPos()], [t], ASOF).positions[0].reconciliationStatus).toBe('verified')
  })
})

// ── Counts ───────────────────────────────────────────────────────────────────

describe('payload counts', () => {
  it('tallies companion vs external and sums unrealised P&L', () => {
    const view = buildPositionView(
      [brokerPos({ symbol: 'STFS', unrealizedPl: 681.03 }), brokerPos({ symbol: 'MSFT', unrealizedPl: -100 })],
      [trade({ symbol: 'STFS' })],
      ASOF,
    )
    expect(view.counts).toEqual({ open: 2, companion: 1, external: 1, unattributed: 0, unrealizedPnl: 581.03 })
  })
})

// ── Route: credential safety + failure shapes ────────────────────────────────

const brokerMock = {
  getPositions: vi.fn(),
}
const loadTradesMock = vi.fn()
let constructorShouldThrow = false

vi.mock('@/lib/execution/alpaca', async () => {
  const actual = await vi.importActual<typeof import('@/lib/execution/alpaca')>('@/lib/execution/alpaca')
  return {
    ...actual,
    AlpacaBroker: class {
      constructor() { if (constructorShouldThrow) throw new Error('ALPACA_KEY_ID / ALPACA_SECRET_KEY missing') }
      getPositions = brokerMock.getPositions
    },
  }
})

vi.mock('@/lib/execution/store', () => ({
  loadTrades: (...a: unknown[]) => loadTradesMock(...a),
}))

describe('GET /api/paper/positions', () => {
  beforeEach(() => {
    constructorShouldThrow = false
    brokerMock.getPositions.mockReset()
    loadTradesMock.mockReset()
    loadTradesMock.mockReturnValue([trade()])
  })
  afterEach(() => vi.resetModules())

  it('returns sanitized rows with NO credentials anywhere in the body (Phase 3/13.7)', async () => {
    brokerMock.getPositions.mockResolvedValue([brokerPos()])
    const { GET } = await import('@/app/api/paper/positions/route')
    const res = await GET()
    const body = await res.json()
    const raw = JSON.stringify(body)

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.positions[0].source).toBe('companion')
    // No secret material of any kind.
    expect(raw).not.toMatch(/APCA|SECRET|KEY_ID|secretKey|keyId/i)
    expect(raw).not.toContain(process.env.ALPACA_SECRET_KEY ?? '__no_secret__')
  })

  it('reports UNAVAILABLE (not flat) when credentials are missing (Phase 11)', async () => {
    constructorShouldThrow = true
    const { GET } = await import('@/app/api/paper/positions/route')
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/not configured/i)
  })

  it('reports UNAVAILABLE (not flat) when the broker query throws (Phase 5/11/13.6)', async () => {
    brokerMock.getPositions.mockRejectedValue(new Error('network down'))
    const { GET } = await import('@/app/api/paper/positions/route')
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.error).not.toMatch(/network down/)   // raw error text not forwarded
  })

  it('reports FLAT (ok, empty) when the broker holds nothing', async () => {
    brokerMock.getPositions.mockResolvedValue([])
    loadTradesMock.mockReturnValue([])
    const { GET } = await import('@/app/api/paper/positions/route')
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.positions).toEqual([])
  })
})

// ── Poll-aware stale threshold (Phase 2 hardening) ───────────────────────────

// A Wednesday 10:00 ET → regular session; a Saturday → closed session. Both are
// deterministic inputs to getSessionType, so the cadence/threshold maths is testable
// without touching React.
const REGULAR_TS = new Date('2026-08-19T14:00:00Z').getTime()   // Wed 10:00 ET
const CLOSED_TS = new Date('2026-08-15T14:00:00Z').getTime()    // Sat (weekend)

describe('stale threshold scales with poll cadence', () => {
  it('uses the 2.5s RTH cadence and a 15s floor during regular hours', () => {
    expect(pollIntervalMs(REGULAR_TS)).toBe(2_500)
    // max(15_000, 2_500*3=7_500) → floor wins.
    expect(staleThresholdMs(REGULAR_TS)).toBe(15_000)
  })

  it('scales to 90s at the 30s closed-session cadence', () => {
    expect(pollIntervalMs(CLOSED_TS)).toBe(30_000)
    expect(staleThresholdMs(CLOSED_TS)).toBe(90_000)   // 30_000*3
  })

  it('does NOT flag a healthy 30s closed-session poll as stale', () => {
    const interval = pollIntervalMs(CLOSED_TS)         // 30_000
    const threshold = staleThresholdMs(CLOSED_TS)      // 90_000
    // A successful poll every `interval`, plus jitter, stays well under threshold.
    expect(interval).toBeLessThan(threshold)
    expect(interval * 2).toBeLessThan(threshold)       // even a skipped cycle is fine
    // Regression guard: the old fixed 15s threshold WOULD have falsely tripped here.
    expect(interval).toBeGreaterThan(15_000)
  })

  it('always keeps the threshold at least 3× the cadence and never below the floor', () => {
    for (const ts of [REGULAR_TS, CLOSED_TS]) {
      expect(staleThresholdMs(ts)).toBeGreaterThanOrEqual(pollIntervalMs(ts) * 3)
      expect(staleThresholdMs(ts)).toBeGreaterThanOrEqual(15_000)
    }
  })
})
