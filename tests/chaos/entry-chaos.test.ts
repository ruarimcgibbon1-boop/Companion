/**
 * BROKER / PAPER EXECUTION CHAOS — ENTRY (C1–C5).
 *
 * Deterministic, offline. Real PaperExecutor + DeterministicBroker. Validation only: asserts
 * the global safety invariants against adversarial entry interleavings. No production change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { PaperExecutor, DEFAULT_EXECUTOR, workingExitQty } from '@/lib/execution/executor'
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

describe('CHAOS · entry', () => {
  let broker: DeterministicBroker
  let price: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test' },
    () => {},
  )
  const stopQty = async (id: string | null) => id ? (await broker.getOrder(id))!.qty : 0
  const arm = async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    return { ex, t: ex.allTrades()[0] }
  }

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker(); price = 10; mockStore.events = []
  })
  afterEach(() => { vi.useRealTimers() })

  it('C1 — pending entry, timeout, clean cancel, zero fill → aborted, flat, no orders, resolved', async () => {
    const { ex, t } = await arm()
    broker.holdWorking.add(t.entryOrderId!)
    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()
    expect(t.state).toBe('aborted')
    expect(t.openQty).toBe(0)
    expect(t.protectiveStopOrderId).toBeNull()
    expect(broker.submittedSells).toHaveLength(0)          // no protective/exit orders
    expect(broker.truthQty('TEST')).toBe(0)                // no broker position
    expect(ex.isReconciliationUnresolved()).toBe(false)
  })

  it('C2 — cancel/full-fill race → fill booked, managed, never zero-fill aborted', async () => {
    const { ex, t } = await arm()
    broker.holdWorking.add(t.entryOrderId!)
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 1000, price: 10.05, status: 'filled' })
    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()
    expect(t.state).toBe('open')
    expect(t.entryFillQty).toBe(1000)
    expect(t.openQty).toBe(1000)
    expect(broker.truthQty('TEST')).toBe(1000)
    expect(await stopQty(t.protectiveStopOrderId)).toBe(1000)           // coverage correct
    expect(await stopQty(t.protectiveStopOrderId)).toBeLessThanOrEqual(broker.truthQty('TEST'))
    expect(ex.isReconciliationUnresolved()).toBe(false)
  })

  it('C3 — cancel/partial-fill race (400 of 1000) → 400 booked, 600 not exposure, terminal', async () => {
    const { ex, t } = await arm()
    broker.holdWorking.add(t.entryOrderId!)
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 400, price: 10.00, status: 'partially_filled' })
    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()
    expect(t.entryFillQty).toBe(400)
    expect(t.openQty).toBe(400)                            // 600 unfilled is NOT exposure
    expect(t.entryOrderTerminal).toBe(true)
    expect(t.entryFillPrice).toBeCloseTo(10.00)
    expect(t.plannedRisk).toBeCloseTo(400 * (10.00 - 9.5))
    expect(broker.truthQty('TEST')).toBe(400)
    expect(await stopQty(t.protectiveStopOrderId)).toBe(400)
    expect(ex.isReconciliationUnresolved()).toBe(false)
  })

  it('C4 — multi-step 400→700→1000 with duplicate 700 and stale 400 → monotonic/idempotent', async () => {
    const { ex, t } = await arm()
    const id = t.entryOrderId!
    broker.stepQueue.set(id, [
      { status: 'partially_filled', filledQty: 400, price: 10.00 },
      { status: 'partially_filled', filledQty: 700, price: 10.05 },
      { status: 'filled', filledQty: 1000, price: 10.10 },
    ])
    await ex.tick(); expect(t.entryFillQty).toBe(400)
    await ex.tick(); expect(t.entryFillQty).toBe(700); expect(t.openQty).toBe(700)

    // Duplicate cumulative 700 (no truth change) → no double-book.
    broker.reportStatus.set(id, 'partially_filled'); broker.reportFilledQty.set(id, 700)
    await ex.tick(); expect(t.entryFillQty).toBe(700); expect(t.openQty).toBe(700)
    // Stale lower 400 → ignored, never decreases.
    broker.reportFilledQty.set(id, 400)
    await ex.tick(); expect(t.entryFillQty).toBe(700); expect(t.openQty).toBe(700)
    // Resume: terminal 1000.
    broker.reportStatus.delete(id); broker.reportFilledQty.delete(id)
    await ex.tick()
    expect(t.entryFillQty).toBe(1000)
    expect(t.entryFillPrice).toBeCloseTo(10.10)          // cumulative VWAP
    expect(t.plannedRisk).toBeCloseTo(1000 * (10.10 - 9.5))   // 600
    expect(t.entryOrderTerminal).toBe(true)
    expect(t.openQty).toBe(1000)
    expect(broker.truthQty('TEST')).toBe(1000)
    expect(await stopQty(t.protectiveStopOrderId)).toBe(1000)
    expect(ex.isReconciliationUnresolved()).toBe(false)
  })

  it('C5 — position grows past a terminal entry order → fail closed, no fabricated basis', async () => {
    const { ex, t } = await arm()
    broker.holdWorking.add(t.entryOrderId!)
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 400, price: 10.00, status: 'partially_filled' })
    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()
    expect(t.entryFillQty).toBe(400); expect(t.entryOrderTerminal).toBe(true)

    broker.seedPosition('TEST', 1000)                     // extra 600 with no order evidence
    await ex.tick()
    expect(t.entryFillQty).toBe(400)                      // NOT fabricated to 1000
    expect(t.reconciliationStatus).toBe('manual_review')
    expect(ex.isReconciliationUnresolved()).toBe(true)   // fail closed
    expect(mockStore.events.some(e => e.event === 'entry_basis_unreconstructable')).toBe(true)
  })
})
