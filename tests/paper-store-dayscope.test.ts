/**
 * Regression: cross-day contamination of the 2026-08-18 daily paper report.
 *
 * The daemon's in-memory trade list accumulates across ET days (a process that
 * spans ET-midnight, and a restart that rehydrates the day's file). On
 * 2026-08-18 that surfaced Monday 08-17's CLOSED, broker-VERIFIED STFS (+$1,782)
 * inside Tuesday's summary — it inflated the day's P&L, skewed the loss-limit
 * input, and would have passed the learning gate as Tuesday evidence.
 *
 * These tests pin the two scoping layers of the fix:
 *   1. store.scopeToTradingDay — the per-ET-day file only holds that day's trades
 *      (plus still-active carryover), so load/save self-heal.
 *   2. PaperExecutor daily report — closedToday / verifiedClosedTrades / summary
 *      count only the current ET session even when the in-memory list is mixed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { scopeToTradingDay, etDayKey } from '@/lib/execution/store'
import { newPaperTrade } from '@/lib/execution/types'
import type {
  Broker, BrokerAccount, BrokerOrder, BrokerPosition, PaperTrade, AssetInfo,
  LimitOrderRequest, StopOrderRequest,
} from '@/lib/execution/types'
import type { BuySignalRecord } from '@/types'

// Monday 2026-08-17 09:34:59 ET (13:34:59Z) — the real STFS entry instant.
const MON_STFS = new Date('2026-08-17T13:34:59Z').getTime()
// Monday 09:31 ET — XPON, the entry that never filled.
const MON_XPON = new Date('2026-08-17T13:31:00Z').getTime()
// Tuesday 2026-08-18 05:09 ET (09:09Z) — the real XOS premarket entry.
const TUE_XOS = new Date('2026-08-18T09:09:32Z').getTime()
// "Now": Tuesday 2026-08-18 10:00 ET — the session the report is being run for.
const TUE_NOW = new Date('2026-08-18T14:00:00Z').getTime()

function sig(o: Partial<BuySignalRecord> = {}): BuySignalRecord {
  return {
    id: 'sig', setupId: 'setup', symbol: 'TEST', timestamp: MON_STFS,
    setupType: 'opening_drive', triggerPrice: 5, entryLow: 4.95, entryHigh: 5,
    invalidation: 4.9, stop: 4.9, targets: [5.5, 6], score: 70, grade: 'C',
    rewardRisk: 2, priceAtSignal: 5, ...o,
  } as BuySignalRecord
}

function mk(o: Partial<PaperTrade> & { createdAt: number }): PaperTrade {
  const s = sig({ id: `${o.symbol}-sig`, setupId: `${o.symbol}-setup`, symbol: o.symbol })
  return { ...newPaperTrade(s, 100, 5, o.createdAt), ...o }
}

const stfsMon = (): PaperTrade => mk({
  symbol: 'STFS', createdAt: MON_STFS, state: 'closed',
  realizedPnl: 1782.27, reconciliationStatus: 'verified', entryFillPrice: 5.33,
})
const xponMonAborted = (): PaperTrade => mk({ symbol: 'XPON', createdAt: MON_XPON, state: 'aborted' })
const xosTue = (): PaperTrade => mk({
  symbol: 'XOS', createdAt: TUE_XOS, state: 'closed',
  realizedPnl: -438.31, reconciliationStatus: 'verified', entryFillPrice: 3.81,
})

describe('scopeToTradingDay (store)', () => {
  it('drops another day’s CLOSED/ABORTED trades, keeps today’s', () => {
    const scoped = scopeToTradingDay([stfsMon(), xponMonAborted(), xosTue()], '2026-08-18')
    expect(scoped.map(t => t.symbol)).toEqual(['XOS'])
  })

  it('an 08-17 STFS record cannot survive into the 08-18 file', () => {
    const scoped = scopeToTradingDay([stfsMon(), xosTue()], etDayKey(TUE_NOW))
    expect(scoped.some(t => t.symbol === 'STFS')).toBe(false)
  })

  it('keeps a prior-day trade that is still ACTIVE (open position must stay managed)', () => {
    const carry = mk({ symbol: 'CARRY', createdAt: MON_STFS, state: 'open', openQty: 100 })
    const scoped = scopeToTradingDay([carry, stfsMon(), xosTue()], '2026-08-18')
    expect(scoped.map(t => t.symbol).sort()).toEqual(['CARRY', 'XOS'])
  })
})

// ── Executor daily report ─────────────────────────────────────────────────────
// Keep the REAL etDayKey/scopeToTradingDay; only stub the fs + injected load.
let injected: PaperTrade[] = []
vi.mock('@/lib/execution/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/execution/store')>()),
  loadTrades: () => injected,
  saveTrades: () => {},
  appendEvent: () => {},
  isHalted: () => false,
}))

class StubBroker implements Broker {
  readonly name = 'stub'
  async getAccount(): Promise<BrokerAccount> {
    return { equity: 100_000, cash: 100_000, buyingPower: 200_000, daytradeCount: 0, blocked: false }
  }
  async getAsset(): Promise<AssetInfo | null> { return null }
  async getPositions(): Promise<BrokerPosition[]> { return [] }
  async getPosition(): Promise<BrokerPosition | null> { return null }
  async submitLimit(_r: LimitOrderRequest): Promise<BrokerOrder> { throw new Error('unused') }
  async submitStop(_r: StopOrderRequest): Promise<BrokerOrder> { throw new Error('unused') }
  async getOrder(): Promise<BrokerOrder | null> { return null }
  async cancelOrder(): Promise<void> {}
  async cancelOpenOrders(): Promise<number> { return 0 }
}

describe('PaperExecutor daily report is ET-session-scoped', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(TUE_NOW) })
  afterEach(() => { vi.useRealTimers(); injected = [] })

  async function reportWith(trades: PaperTrade[]) {
    // Import lazily so the mock above is applied.
    const { PaperExecutor, DEFAULT_EXECUTOR } = await import('@/lib/execution/executor')
    injected = trades
    const ex = new PaperExecutor(new StubBroker(), async () => new Map(), { ...DEFAULT_EXECUTOR }, () => {})
    await ex.init()
    return ex
  }

  it('closedToday excludes Monday’s STFS from Tuesday', async () => {
    const ex = await reportWith([stfsMon(), xosTue()])
    expect(ex.closedToday().map(t => t.symbol)).toEqual(['XOS'])
  })

  it('summary P&L is Tuesday-only — no +$1,782 leak', async () => {
    const ex = await reportWith([stfsMon(), xponMonAborted(), xosTue()])
    const s = ex.summary()
    expect(s).toContain('P&L $-438.31')          // XOS only
    expect(s).not.toContain('1782')              // Monday's winner is gone
    expect(s).toContain('1 considered')          // only the Tuesday trade
    expect(s).toContain('0 never filled')        // Monday's XPON abort is not Tuesday's
  })

  it('learning gate (verifiedClosedTrades) refuses Monday’s verified STFS', async () => {
    const ex = await reportWith([stfsMon(), xosTue()])
    const verified = ex.verifiedClosedTrades()
    expect(verified.map(t => t.symbol)).toEqual(['XOS'])
    expect(verified.some(t => t.symbol === 'STFS')).toBe(false)
  })

  it('a closed trade with unrecoverable P&L (FIGR-class) is unreconciled, not a loss', async () => {
    // Today's XOS lost; a same-day manual_review with null P&L must not add a
    // phantom loss to the W/L split — it is reported as unreconciled instead.
    const figrToday = mk({
      symbol: 'FIGR', createdAt: TUE_NOW, state: 'closed',
      realizedPnl: null, reconciliationStatus: 'manual_review', entryFillPrice: 34.92,
    })
    const ex = await reportWith([xosTue(), figrToday])
    const s = ex.summary()
    expect(s).toContain('closed 1 · 0W/1L')        // XOS only; FIGR not a 2nd loss
    expect(s).toContain('1 unreconciled')
    expect(ex.verifiedClosedTrades().some(t => t.symbol === 'FIGR')).toBe(false)
  })
})
