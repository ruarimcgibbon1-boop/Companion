/**
 * P1-002 — CUMULATIVE ENTRY ACCOUNTING (remediated).
 *
 * CORE INVARIANT: entry accounting stays broker-ORDER-authoritative until the entry order is
 * terminal. Cumulative entry fills are folded idempotently (never disappear, never decrease,
 * no double-booking); entryFillQty / entryFillPrice(VWAP) / plannedRisk / openQty all follow
 * the ORDER's cumulative truth. Position quantity confirms exposure but NEVER fabricates entry
 * basis — a position that exceeds what a terminal entry order accounts for FAILS CLOSED.
 *
 * Real PaperExecutor + DeterministicBroker, offline, deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { DeterministicBroker, makeSignal, REGULAR_HOURS } from './harness/execution-safety-broker'

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

describe('P1-002 cumulative entry accounting', () => {
  let broker: DeterministicBroker
  let price: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test' },
    () => {},
  )

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker()
    price = 10   // between stop 9.5 and t1 11 → no exit fires during entry accumulation
    mockStore.events = []
  })
  afterEach(() => { vi.useRealTimers() })

  it('folds a cumulative entry order 400@10.00 → 700@10.05 → 1000@10.10 (order-authoritative)', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    const orderId = t.entryOrderId!

    // The entry ORDER reports rising cumulative fills across ticks; getOrder yields the
    // cumulative avg price (VWAP) Alpaca would report at each stage.
    broker.stepQueue.set(orderId, [
      { status: 'partially_filled', filledQty: 400, price: 10.00 },
      { status: 'partially_filled', filledQty: 700, price: 10.05 },
      { status: 'filled', filledQty: 1000, price: 10.10 },
    ])

    await ex.tick()   // fold 400
    expect(t.state).toBe('open')
    expect(t.entryFillQty).toBe(400)
    expect(t.openQty).toBe(400)
    expect(t.entryFillPrice).toBeCloseTo(10.00)

    await ex.tick()   // fold 700
    expect(t.entryFillQty).toBe(700)
    expect(t.openQty).toBe(700)
    expect(t.entryFillPrice).toBeCloseTo(10.05)

    await ex.tick()   // fold 1000, order terminal
    expect(t.entryFillQty).toBe(1000)
    expect(t.openQty).toBe(1000)
    expect(t.entryFillPrice).toBeCloseTo(10.10)                 // cumulative VWAP, not the first snapshot
    expect(t.entryOrderTerminal).toBe(true)
    expect(t.plannedRisk).toBeCloseTo(1000 * (10.10 - 9.5))     // re-derived from corrected basis = 600
    expect(broker.truthQty('TEST')).toBe(1000)
  })

  it('idempotent + monotonic: repeated and out-of-order lower cumulative never double-book or decrease', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    const orderId = t.entryOrderId!

    broker.stepQueue.set(orderId, [
      { status: 'partially_filled', filledQty: 400, price: 10.00 },
      { status: 'partially_filled', filledQty: 700, price: 10.05 },
    ])
    await ex.tick(); await ex.tick()
    expect(t.entryFillQty).toBe(700)
    expect(t.openQty).toBe(700)

    // Duplicate cumulative snapshot (same 700) → no double-booking.
    broker.reportStatus.set(orderId, 'partially_filled')
    broker.reportFilledQty.set(orderId, 700)
    await ex.tick()
    expect(t.entryFillQty).toBe(700)
    expect(t.openQty).toBe(700)

    // Out-of-order LOWER cumulative (stale 400 read) → must not decrease.
    broker.reportFilledQty.set(orderId, 400)
    await ex.tick()
    expect(t.entryFillQty).toBe(700)
    expect(t.openQty).toBe(700)
  })

  it('FAILS CLOSED when broker position exceeds a TERMINAL entry order — no fabricated basis', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    const orderId = t.entryOrderId!

    // Entry times out; a 400-share partial races the cancel and is booked; the entry order is
    // then terminal (remainder cancelled) with entryFillQty=400.
    broker.holdWorking.add(orderId)
    broker.raceFillOnCancel.set(orderId, { qty: 400, price: 10.00, status: 'partially_filled' })
    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()
    expect(t.entryFillQty).toBe(400)
    expect(t.entryOrderTerminal).toBe(true)

    // The broker position later shows 1000 — but the entry ORDER only ever accounted for 400,
    // and it is terminal. There is no order truth to reconstruct the extra 600's cost basis.
    broker.seedPosition('TEST', 1000)
    await ex.tick()

    // Exposure is surfaced, but basis is NOT fabricated from position qty, and the book fails closed.
    expect(t.entryFillQty).toBe(400)                    // NOT rewritten to 1000 from position qty
    expect(t.reconciliationStatus).toBe('manual_review')
    expect(ex.isReconciliationUnresolved()).toBe(true) // new entries blocked until reconciled
    expect(mockStore.events.some(e => e.event === 'entry_basis_unreconstructable')).toBe(true)
  })
})
