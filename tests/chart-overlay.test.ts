import { describe, it, expect } from 'vitest'

import {
  selectChartPosition,
  structuralOverlayKey,
} from '@/components/chart/position-overlay'
import type { BrokerPositionView } from '@/lib/execution/positions-view'
import type { Position } from '@/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function brokerView(overrides: Partial<BrokerPositionView> = {}): BrokerPositionView {
  return {
    symbol: 'STFS', direction: 'long', qty: 1449, qtyAvailable: 1449,
    avgEntryPrice: 5.33, currentPrice: 5.8, unrealizedPnl: 681.03, unrealizedPnlPct: 8.82,
    source: 'companion', tradeId: 'pt:sig-1', signalId: 'sig-1', setupType: 'premarket_breakout',
    initialStop: 5.0, currentStop: 5.16, hasProtectiveStop: false,
    t1: 5.72, t2: 5.8, targetState: 'none', reconciliationStatus: 'verified',
    lastUpdatedAt: 1000, ...overrides,
  }
}

function manual(overrides: Partial<Position> = {}): Position {
  return {
    id: 'm1', symbol: 'STFS', direction: 'long', shares: 500, entry: 5.20, stop: 5.00,
    initialStop: 5.00, targets: [{ label: 'T1', price: 5.6, hit: false, hitAt: null }],
    trailingMode: 'none', trailingValue: 0, trailingHigh: 5.2, status: 'open',
    openedAt: 0, closedAt: null, closePrice: null,
    currentPrice: 5.4, unrealizedPnl: 100, unrealizedPnlPct: 3.8, lastPriceUpdate: 0,
    notes: '', tags: [], rating: null, plannedEntry: true, setupType: '', ...overrides,
  }
}

const sel = (o: Partial<Parameters<typeof selectChartPosition>[0]>) =>
  selectChartPosition({ symbol: 'STFS', brokerPositions: [], manualPositions: [], ...o })

// ── Source priority (Phase 2) ────────────────────────────────────────────────

describe('overlay source priority', () => {
  it('1. Companion broker position overrides the local manual position for a symbol', () => {
    const o = sel({ brokerPositions: [brokerView()], manualPositions: [manual()] })
    expect(o?.kind).toBe('broker')
    expect(o?.source).toBe('companion')
    // The manual entry (5.20) must NOT be what we drew.
    expect(o?.entry).toBe(5.33)
  })

  it('10. Manual tracker overlay remains when no broker position exists', () => {
    const o = sel({ brokerPositions: [], manualPositions: [manual()] })
    expect(o?.kind).toBe('manual')
    expect(o?.entry).toBe(5.20)
    expect(o?.entryIsActualFill).toBe(false)
  })

  it('11. Never returns duplicate broker+manual overlays — exactly one wins', () => {
    const o = sel({ brokerPositions: [brokerView()], manualPositions: [manual()] })
    expect(o).not.toBeNull()
    expect(o?.kind).toBe('broker')   // a single descriptor; broker is authoritative
  })

  it('8. A flat broker with no manual position yields no overlay', () => {
    expect(sel({ brokerPositions: [], manualPositions: [] })).toBeNull()
  })

  it('8b. Broker flat but a manual position exists → falls back to manual (broker overlay gone)', () => {
    const o = sel({ brokerPositions: [], manualPositions: [manual()] })
    expect(o?.kind).toBe('manual')
  })

  it('returns null when no symbol is selected', () => {
    expect(selectChartPosition({ symbol: null, brokerPositions: [brokerView()], manualPositions: [] })).toBeNull()
  })
})

// ── Broker truth in the overlay (Phase 3) ────────────────────────────────────

describe('broker overlay content', () => {
  it('2. uses broker avgEntryPrice as the actual fill, flagged as a real fill', () => {
    const o = sel({ brokerPositions: [brokerView({ avgEntryPrice: 5.33 })] })
    expect(o?.entry).toBe(5.33)
    expect(o?.entryIsActualFill).toBe(true)
  })

  it('3. carries the broker quantity', () => {
    const o = sel({ brokerPositions: [brokerView({ qty: 1449 })] })
    expect(o?.qty).toBe(1449)
  })

  it('4. reflects a reduced quantity after a partial scale-out', () => {
    const before = sel({ brokerPositions: [brokerView({ qty: 1449 })] })
    const after = sel({ brokerPositions: [brokerView({ qty: 724, targetState: 't1_hit' })] })
    expect(before?.qty).toBe(1449)
    expect(after?.qty).toBe(724)
    // Structural change → chart should rebuild.
    expect(structuralOverlayKey(before)).not.toBe(structuralOverlayKey(after))
  })

  it('5. VERIFIED Companion exposes stop, T1, T2 and completion state', () => {
    const o = sel({ brokerPositions: [brokerView({ targetState: 't1_hit', reconciliationStatus: 'verified' })] })
    expect(o?.stop).toBe(5.16)
    expect(o?.reconciliationStatus).toBe('verified')
    expect(o?.targets).toEqual([
      { label: 'T1', price: 5.72, hit: true },
      { label: 'T2', price: 5.8, hit: false },
    ])
  })

  it('maps t2_hit to both targets completed', () => {
    const o = sel({ brokerPositions: [brokerView({ targetState: 't2_hit' })] })
    expect(o?.targets.map(t => t.hit)).toEqual([true, true])
  })

  it('labels a stop at entry as breakeven', () => {
    const o = sel({ brokerPositions: [brokerView({ currentStop: 5.33, avgEntryPrice: 5.33, targetState: 't1_hit' })] })
    expect(o?.stopIsBreakeven).toBe(true)
  })

  it('only marks a protective stop when the ledger records one', () => {
    expect(sel({ brokerPositions: [brokerView({ hasProtectiveStop: false })] })?.hasProtectiveStop).toBe(false)
    expect(sel({ brokerPositions: [brokerView({ hasProtectiveStop: true })] })?.hasProtectiveStop).toBe(true)
  })
})

// ── External / Unattributed carry no invented metadata (Phase 4) ─────────────

describe('external and unattributed overlays', () => {
  it('6. EXTERNAL gets entry + exposure but NO Companion stop/targets', () => {
    const o = sel({ brokerPositions: [brokerView({ source: 'external', tradeId: null, signalId: null })] })
    expect(o?.source).toBe('external')
    expect(o?.entry).toBe(5.33)
    expect(o?.entryIsActualFill).toBe(true)
    expect(o?.qty).toBe(1449)
    expect(o?.stop).toBeNull()
    expect(o?.initialStop).toBeNull()
    expect(o?.targets).toEqual([])
    expect(o?.reconciliationStatus).toBeNull()
  })

  it('7. UNATTRIBUTED gets exposure but NO Companion targets/stop', () => {
    const o = sel({ brokerPositions: [brokerView({ source: 'unattributed', tradeId: null })] })
    expect(o?.source).toBe('unattributed')
    expect(o?.stop).toBeNull()
    expect(o?.targets).toEqual([])
    expect(o?.hasProtectiveStop).toBe(false)
  })
})

// ── Stale retention (Phase 8) ────────────────────────────────────────────────

describe('stale / unavailable retention', () => {
  it('9. still resolves the broker overlay from retained positions (staleness is orthogonal)', () => {
    // useBrokerPositions keeps the last snapshot on error; selection over those
    // retained positions must still return the broker overlay, never fall to flat.
    const o = sel({ brokerPositions: [brokerView()], manualPositions: [manual()] })
    expect(o?.kind).toBe('broker')
    expect(o?.qty).toBe(1449)
  })
})

// ── Structural vs live key (Phase 11) ────────────────────────────────────────

describe('structural overlay key isolates P&L churn', () => {
  it('12. is UNCHANGED when only current price / P&L move (no chart rebuild)', () => {
    const a = sel({ brokerPositions: [brokerView({ currentPrice: 5.80, unrealizedPnl: 681.03, unrealizedPnlPct: 8.82 })] })
    const b = sel({ brokerPositions: [brokerView({ currentPrice: 5.95, unrealizedPnl: 898.4, unrealizedPnlPct: 11.6 })] })
    expect(structuralOverlayKey(a)).toBe(structuralOverlayKey(b))
  })

  it('12b. CHANGES when geometry moves (stop advance, target completion, qty)', () => {
    const base = sel({ brokerPositions: [brokerView()] })
    const stopMoved = sel({ brokerPositions: [brokerView({ currentStop: 5.33 })] })
    const t1Done = sel({ brokerPositions: [brokerView({ targetState: 't1_hit' })] })
    const scaled = sel({ brokerPositions: [brokerView({ qty: 700 })] })
    expect(structuralOverlayKey(base)).not.toBe(structuralOverlayKey(stopMoved))
    expect(structuralOverlayKey(base)).not.toBe(structuralOverlayKey(t1Done))
    expect(structuralOverlayKey(base)).not.toBe(structuralOverlayKey(scaled))
  })

  it('null overlay hashes to empty string', () => {
    expect(structuralOverlayKey(null)).toBe('')
  })
})
