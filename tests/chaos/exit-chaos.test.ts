/**
 * BROKER / PAPER EXECUTION CHAOS — EXITS (C9–C11).
 *
 * Deterministic, offline. Real PaperExecutor + DeterministicBroker. Validates partial-exit
 * reservation, coverage math, idempotent cumulative exit booking, and cancel/replace safety.
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

describe('CHAOS · exits', () => {
  let broker: DeterministicBroker
  let price: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test' },
    () => {},
  )
  const stopQty = async (id: string | null) => id ? (await broker.getOrder(id))!.qty : 0

  // Open a full 1000-share position (entry fills, protective stop placed).
  const openFull = async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await ex.tick()
    const t = ex.allTrades()[0]
    expect(t.state).toBe('open'); expect(t.openQty).toBe(1000)
    return { ex, t }
  }

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker(); price = 10; mockStore.events = []
  })
  afterEach(() => { vi.useRealTimers() })

  it('C9 — partial exit still working: reservation, free qty, coverage; cumulative +150 booked once', async () => {
    const { ex, t } = await openFull()

    // T1 ordered 500, only 200 fills and stays working.
    broker.partialSellOnce = 200
    price = 11.2
    await ex.tick()
    const leg = t.exits.find(l => l.reason === 't1' && l.orderId != null)!
    expect(t.openQty).toBe(800)                 // 1000 − 200 sold
    expect(leg.orderedQty).toBe(500)
    expect(leg.qty).toBe(200)                   // cumulative filled
    expect(workingExitQty(t)).toBe(300)         // 500 − 200 reserved
    expect(t.openQty - workingExitQty(t)).toBe(500)   // free

    // Cumulative advances to 350/500 → +150 booked once.
    broker.partialSellOnce = null
    broker.stepQueue.set(leg.orderId!, [{ status: 'partially_filled', filledQty: 350, price: 11.2 }])
    price = 11.5                                 // between breakeven stop and T2 → ensureProtectiveStop runs
    await ex.tick()
    expect(leg.qty).toBe(350)
    expect(t.openQty).toBe(650)                  // 1000 − 350
    expect(workingExitQty(t)).toBe(150)          // 500 − 350
    expect(t.openQty - workingExitQty(t)).toBe(500)   // free unchanged
    expect(await stopQty(t.protectiveStopOrderId)).toBe(500)                    // coverage == free
    // Coverage never exceeds free held: stop(500) + working exit(150) = 650 = held.
    expect((await stopQty(t.protectiveStopOrderId)) + workingExitQty(t)).toBe(t.openQty)
    expect(broker.truthQty('TEST')).toBe(650)

    // Duplicate cumulative 350 → no change (booked once).
    broker.reportStatus.set(leg.orderId!, 'partially_filled')
    broker.reportFilledQty.set(leg.orderId!, 350)
    await ex.tick()
    expect(leg.qty).toBe(350)
    expect(t.openQty).toBe(650)
    expect(workingExitQty(t)).toBe(150)
  })

  it('C10 — partial exit then cancel remainder: 200 booked, 300 released, coverage reclaimed, no dup', async () => {
    const { ex, t } = await openFull()
    broker.partialSellOnce = 200
    price = 11.2
    await ex.tick()
    const leg = t.exits.find(l => l.reason === 't1' && l.orderId != null)!
    expect(leg.qty).toBe(200); expect(workingExitQty(t)).toBe(300); expect(t.openQty).toBe(800)

    // The working remainder is cancelled (terminal canceled, 200 filled).
    broker.partialSellOnce = null
    broker.reportStatus.set(leg.orderId!, 'canceled')
    broker.reportFilledQty.set(leg.orderId!, 200)
    price = 11.5
    await ex.tick()
    expect(leg.qty).toBe(200)                    // 200 stays booked
    expect(workingExitQty(t)).toBe(0)            // 300 no longer reserved
    expect(t.openQty).toBe(800)
    // Coverage reclaims the now-free 300: stop covers all 800 held.
    expect(await stopQty(t.protectiveStopOrderId)).toBe(800)
    expect(await stopQty(t.protectiveStopOrderId)).toBeLessThanOrEqual(broker.truthQty('TEST'))
    expect(broker.truthQty('TEST')).toBe(800)
  })

  it('C11 — a fill during the protective-order lifecycle is booked once; no oversized replacement', async () => {
    // Architecture note: within a tick, reconcileExits SETTLES broker fills before manageOpen
    // sizes any new order, so a fresh cumulative fill is always booked first and replacements
    // are sized from post-fill exposure. Here the resting protective stop partially fills at
    // the broker; the increment is booked once and the still-working remainder covers the rest,
    // so no oversized/over-covering replacement is placed.
    const { ex, t } = await openFull()
    const stopId = t.protectiveStopOrderId!
    expect(await stopQty(stopId)).toBe(1000)

    // Broker reports the resting stop partially filled (300 of 1000), still working.
    broker.stepQueue.set(stopId, [{ status: 'partially_filled', filledQty: 300, price: 9.5 }])
    price = 10
    await ex.tick()

    const stopLeg = t.exits.find(l => l.reason === 'stop')!
    expect(stopLeg.qty).toBe(300)               // increment booked once
    expect(t.openQty).toBe(700)                 // 1000 − 300
    expect(broker.truthQty('TEST')).toBe(700)
    // The still-working stop remainder reserves exactly the held shares; no new stop is stacked.
    expect(workingExitQty(t)).toBe(700)         // orderedQty 1000 − filled 300
    expect(t.openQty - workingExitQty(t)).toBe(0)   // free 0 → no replacement needed
    // Total sell exposure never exceeds the position: filled 300 + working 700 = 1000 (original held).
    expect(stopLeg.qty + workingExitQty(t)).toBe(1000)

    // Duplicate read of the same cumulative → no double-book.
    broker.stepQueue.set(stopLeg.orderId!, [{ status: 'partially_filled', filledQty: 300, price: 9.5 }])
    await ex.tick()
    expect(stopLeg.qty).toBe(300)
    expect(t.openQty).toBe(700)
  })
})
