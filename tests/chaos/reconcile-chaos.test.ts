/**
 * BROKER / PAPER EXECUTION CHAOS — RECONCILIATION (C12, C13, C16).
 *
 * Deterministic, offline. Real PaperExecutor + DeterministicBroker. Validates broker/local
 * disagreement classification, fail-closed on malformed/unreadable broker truth mid-lifecycle,
 * and idempotent repeated reconciliation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { DeterministicBroker, makeSignal, REGULAR_HOURS } from '../harness/execution-safety-broker'

const mockStore = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/execution/store', () => ({
  loadTrades: () => [],
  saveTrades: () => {},
  appendEvent: (e: Record<string, unknown>) => { mockStore.events.push(e) },
  isHalted: () => false,
  haltFile: () => '/tmp/.companion-halt',
  etDayKey: () => '2026-08-07',
  tradesFile: () => '/tmp/trades.json',
  eventsFile: () => '/tmp/events.jsonl',
}))

describe('CHAOS · reconciliation', () => {
  let broker: DeterministicBroker
  let price: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test' },
    () => {},
  )
  // Open a 400-share position via a partial cancel/fill race (entryFillQty 400, terminal).
  const open400 = async () => {
    const ex = build(); await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    broker.holdWorking.add(t.entryOrderId!)
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 400, price: 10.00, status: 'partially_filled' })
    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()
    expect(t.entryFillQty).toBe(400); expect(t.openQty).toBe(400); expect(t.entryOrderTerminal).toBe(true)
    vi.setSystemTime(REGULAR_HOURS)   // back to normal for subsequent ticks
    return { ex, t }
  }

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker(); price = 10; mockStore.events = []
  })
  afterEach(() => { vi.useRealTimers() })

  // ── C12 — broker position disagreement ─────────────────────────────────────────
  it('C12-A — local 400, broker 500 (exceeds accounted entry) → fail closed (manual_review)', async () => {
    const { ex, t } = await open400()
    broker.seedPosition('TEST', 500)
    await ex.tick()
    expect(t.reconciliationStatus).toBe('manual_review')   // basis gap: 500 > accounted 400
    expect(ex.isReconciliationUnresolved()).toBe(true)
    expect(t.entryFillQty).toBe(400)                        // no fabricated basis
  })

  it('C12-B — local 400, broker 0 → broker-truth-first forced flat, manual_review, closed', async () => {
    const { ex, t } = await open400()
    broker.seedPosition('TEST', 0)
    await ex.tick()
    expect(t.openQty).toBe(0)
    expect(t.state).toBe('closed')
    expect(t.reconciliationStatus).toBe('manual_review')
    expect(t.reconciliationStatus).not.toBe('verified')    // no false VERIFIED
  })

  it('C12-C — local flat, broker holds 400 (startup) → AMBIGUOUS, fail closed', async () => {
    broker.seedPosition('TEST', 400)                        // broker holds, no local owner
    const ex = build()
    await ex.init()
    expect(ex.isReconciliationUnresolved()).toBe(true)      // startup reconciliation blocks new entries
    expect(mockStore.events.some(e => e.event === 'startup_orphan_detected')).toBe(true)
  })

  it('C12-D — local open, position snapshot unavailable → no fabrication, managed on last-known local', async () => {
    const ex = build(); await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await ex.tick()
    const t = ex.allTrades()[0]
    expect(t.openQty).toBe(1000)

    broker.failGetPosition.add('TEST')                      // snapshot unreadable
    await ex.tick()                                         // must not crash or fabricate
    expect(t.state).toBe('open')
    expect(t.openQty).toBe(1000)                            // unchanged — not zeroed / not disowned
    expect(t.reconciliationStatus).not.toBe('verified')
  })

  // ── C13 — malformed broker data mid-lifecycle ──────────────────────────────────
  it('C13 — a broker read that throws BrokerDataError mid-lifecycle fails closed (no zero, no flatten)', async () => {
    const ex = build(); await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await ex.tick()
    const t = ex.allTrades()[0]
    expect(t.openQty).toBe(1000)

    // getPosition throws (adapter would raise BrokerDataError on malformed numerics).
    broker.failGetPosition.add('TEST')
    await ex.tick()
    expect(t.openQty).toBe(1000)                            // never translated to 0
    expect(t.state).toBe('open')                            // not flattened on a fabricated zero
    expect(t.reconciliationStatus).not.toBe('verified')

    // Recover: broker readable again and consistent → normal management resumes, no corruption.
    broker.failGetPosition.delete('TEST')
    await ex.tick()
    expect(t.openQty).toBe(1000)
    expect(broker.truthQty('TEST')).toBe(1000)
  })

  // ── C16 — repeated reconciliation is idempotent ────────────────────────────────
  it('C16 — repeated reconciliation of entry / partial-exit / close never double-books', async () => {
    const ex = build(); await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })

    // Entry: fill, then re-tick the same snapshot repeatedly.
    await ex.tick()
    const t = ex.allTrades()[0]
    expect(t.entryFillQty).toBe(1000)
    await ex.tick(); await ex.tick()
    expect(t.entryFillQty).toBe(1000); expect(t.openQty).toBe(1000)   // no double entry

    // Partial exit: T1 fills 200 and stays working; re-tick same snapshot.
    broker.partialSellOnce = 200
    price = 11.2
    await ex.tick()
    const leg = t.exits.find(l => l.reason === 't1')!
    expect(leg.qty).toBe(200)
    price = 11.5
    await ex.tick(); await ex.tick()
    expect(leg.qty).toBe(200); expect(t.openQty).toBe(800)            // no double exit booking

    // Close: flatten the rest, then re-tick — terminal accounting fires exactly once.
    broker.partialSellOnce = null                                   // flatten fills fully
    await ex.flattenAll('risk_halt')
    expect(t.state).toBe('closed')
    const closesAfter = () => mockStore.events.filter(e => e.event === 'trade_closed').length
    const closes1 = closesAfter()
    const pnl1 = t.realizedPnl
    const cc1 = t.closeCount
    await ex.tick(); await ex.tick()
    expect(closesAfter()).toBe(closes1)                              // no duplicate trade_closed
    expect(t.realizedPnl).toBe(pnl1)                                 // P&L unchanged
    expect(t.closeCount).toBe(cc1)                                   // closeCount unchanged
  })
})
