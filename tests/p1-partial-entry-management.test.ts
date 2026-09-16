/**
 * P1 audit — PARTIAL-ENTRY MANAGEMENT SAFETY.
 *
 * Audits the deliberate behavior introduced in P1-002: a trade becomes state='open' on the
 * FIRST partial entry fill while `entryOrderTerminal` may still be false and the entry order
 * keeps filling. Proves the resulting state is internally safe across the exact progression
 * 400@10.00 → 700@10.05 → 1000@10.10, plus a target hitting while the entry is still working.
 *
 * Real PaperExecutor + DeterministicBroker, offline, deterministic. No production changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { PaperExecutor, DEFAULT_EXECUTOR, workingExitQty } from '@/lib/execution/executor'
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

describe('P1 partial-entry management safety', () => {
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
    price = 10   // between stop 9.5 and t1 11 → no exit fires during pure entry accumulation
    mockStore.events = []
  })
  afterEach(() => { vi.useRealTimers() })

  const armPending = async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    return { ex, t: ex.allTrades()[0] }
  }
  const stopQty = async (id: string | null) => id ? (await broker.getOrder(id))!.qty : 0

  it('400 → 700 → 1000: open on first partial, terminal only at the end, coverage tracks exposure', async () => {
    const { ex, t } = await armPending()
    const orderId = t.entryOrderId!
    broker.stepQueue.set(orderId, [
      { status: 'partially_filled', filledQty: 400, price: 10.00 },
      { status: 'partially_filled', filledQty: 700, price: 10.05 },
      { status: 'filled', filledQty: 1000, price: 10.10 },
    ])

    // ── After 400 ────────────────────────────────────────────────────────────
    await ex.tick()
    expect(t.state).toBe('open')                         // (1) open on first partial
    expect(t.entryOrderTerminal).toBe(false)             // (1) entry order NOT terminal
    expect(t.entryFillQty).toBe(400)
    expect(t.entryFillPrice).toBeCloseTo(10.00)
    expect(t.openQty).toBe(400)
    expect(t.plannedRisk).toBeCloseTo(400 * (10.00 - 9.5))   // 200, re-derived
    expect(workingExitQty(t)).toBe(0)                    // (4) no exit legs reserving anything
    expect(t.exits).toHaveLength(0)                      // (5) no target/exit orders yet
    let held = broker.truthQty('TEST')
    expect(held).toBe(400)
    expect(await stopQty(t.protectiveStopOrderId)).toBe(400)   // (3) coverage == exposure
    expect(await stopQty(t.protectiveStopOrderId)).toBeLessThanOrEqual(held)   // (2) never exceeds held

    // ── After 700 ────────────────────────────────────────────────────────────
    await ex.tick()
    expect(t.state).toBe('open')
    expect(t.entryOrderTerminal).toBe(false)
    expect(t.entryFillQty).toBe(700)                     // (3) cumulative
    expect(t.entryFillPrice).toBeCloseTo(10.05)          // (3) cumulative VWAP
    expect(t.openQty).toBe(700)                          // (3) exposure
    expect(t.plannedRisk).toBeCloseTo(700 * (10.05 - 9.5))   // 385
    expect(workingExitQty(t)).toBe(0)
    held = broker.truthQty('TEST')
    expect(held).toBe(700)
    expect(await stopQty(t.protectiveStopOrderId)).toBe(700)   // (3) coverage updated
    expect(await stopQty(t.protectiveStopOrderId)).toBeLessThanOrEqual(held)   // (2)

    // ── After 1000 (order terminal) ──────────────────────────────────────────
    await ex.tick()
    expect(t.state).toBe('open')
    expect(t.entryOrderTerminal).toBe(true)              // (8) terminal only on broker-terminal status
    expect(t.entryFillQty).toBe(1000)
    expect(t.entryFillPrice).toBeCloseTo(10.10)
    expect(t.openQty).toBe(1000)
    expect(t.plannedRisk).toBeCloseTo(1000 * (10.10 - 9.5))   // 600
    held = broker.truthQty('TEST')
    expect(held).toBe(1000)
    expect(await stopQty(t.protectiveStopOrderId)).toBe(1000)
    expect(await stopQty(t.protectiveStopOrderId)).toBeLessThanOrEqual(held)   // (2)
    expect(ex.isReconciliationUnresolved()).toBe(false)  // clean throughout — no false basis gap
  })

  it('(9) once entry is terminal, no later entry polling/folding occurs', async () => {
    const { ex, t } = await armPending()
    const orderId = t.entryOrderId!
    broker.stepQueue.set(orderId, [{ status: 'filled', filledQty: 1000, price: 10.10 }])
    await ex.tick()
    expect(t.entryOrderTerminal).toBe(true)
    expect(t.entryFillQty).toBe(1000)

    // A bogus higher order read after terminal must be ignored (entry no longer polled).
    broker.reportStatus.set(orderId, 'partially_filled')
    broker.reportFilledQty.set(orderId, 1200)
    await ex.tick()
    expect(t.entryFillQty).toBe(1000)                    // unchanged — not folded
    expect(t.openQty).toBe(1000)
  })

  it('(6)(7) duplicate and out-of-order lower cumulative during fill change nothing', async () => {
    const { ex, t } = await armPending()
    const orderId = t.entryOrderId!
    broker.stepQueue.set(orderId, [{ status: 'partially_filled', filledQty: 700, price: 10.05 }])
    await ex.tick()
    expect(t.entryFillQty).toBe(700)
    const stopBefore = await stopQty(t.protectiveStopOrderId)

    broker.reportStatus.set(orderId, 'partially_filled')
    broker.reportFilledQty.set(orderId, 700)            // duplicate
    await ex.tick()
    expect(t.entryFillQty).toBe(700)
    expect(t.openQty).toBe(700)

    broker.reportFilledQty.set(orderId, 400)            // out-of-order lower
    await ex.tick()
    expect(t.entryFillQty).toBe(700)                    // never decreases
    expect(t.openQty).toBe(700)
    expect(await stopQty(t.protectiveStopOrderId)).toBe(stopBefore)
  })

  it('(4)(5) a target hitting while the entry is still working cancels the remainder, never over-reserves', async () => {
    const { ex, t } = await armPending()
    const orderId = t.entryOrderId!
    broker.stepQueue.set(orderId, [{ status: 'partially_filled', filledQty: 700, price: 10.05 }])

    await ex.tick()                       // open at 700, entry still working (300 unfilled), stop 700
    expect(t.openQty).toBe(700)
    expect(t.entryOrderTerminal).toBe(false)
    const heldBeforeExit = broker.truthQty('TEST')      // 700

    price = 11.2                          // T1
    await ex.tick()

    // The T1 sell is sized to half the booked entry fill (floor(700/2) = 350), never more than held.
    const t1 = t.exits.find(l => l.reason === 't1')!
    expect(t1.orderedQty).toBe(350)
    expect(t1.orderedQty).toBeLessThanOrEqual(heldBeforeExit)   // (5) never orders more than held
    // The still-working entry remainder was cancelled by the exit path (no conflicting buy).
    const entryOrder = await broker.getOrder(orderId)
    expect(entryOrder!.status).toBe('canceled')         // (4) remainder cancelled, not left working
    // Position and reservation stay consistent: net = filled entry − sold.
    expect(broker.truthQty('TEST')).toBe(700 - t1.qty)
    expect(t.openQty).toBe(700 - t1.qty)
    expect(workingExitQty(t)).toBeLessThanOrEqual(t.openQty)   // (5) reservation never exceeds held
    expect(ex.isReconciliationUnresolved()).toBe(false)        // no false basis gap from the cancel
  })
})
