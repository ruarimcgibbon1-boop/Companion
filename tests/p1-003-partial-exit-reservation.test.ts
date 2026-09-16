/**
 * P1-003 — PARTIAL EXIT RESERVATION / PROTECTIVE STOP (adversarial reproduction, Phase P1-R)
 *
 * AUDIT CLAIM: `workingExitQty` counts a leg only while `fillPrice == null`. After an exit
 * order's FIRST partial fill, `bookExitFill` sets `fillPrice` (and overwrites `leg.qty` to the
 * cumulative filled), so a still-WORKING exit remainder is treated as reserving ZERO shares.
 * `ensureProtectiveStop` then sizes coverQty = openQty − workingExitQty, over-covering by the
 * reserved remainder (an oversized stop the broker rejects for insufficient qty).
 *
 * Construct (audit shape, scaled): openQty 1000; T1 orders 500; broker fills 200 cumulative,
 * 300 still working. Safe invariant: reserved = ordered − filled = 300, not 0.
 *
 * Real PaperExecutor + DeterministicBroker, offline. Assertions FAIL on the current base.
 * DO NOT FIX.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { PaperExecutor, DEFAULT_EXECUTOR, workingExitQty } from '@/lib/execution/executor'
import { DeterministicBroker, makeSignal, REGULAR_HOURS } from './harness/execution-safety-broker'
import type { PaperTrade } from '@/lib/execution/types'

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

describe('P1-003 partial exit reservation / protective stop', () => {
  let broker: DeterministicBroker
  let ex: PaperExecutor
  let t: PaperTrade
  let price: number
  let reservedRemainder: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test' },
    () => {},
  )

  // Set up through the T1 partial: openQty 800, one working T1 leg (ordered 500, filled 200).
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker()
    price = 10
    mockStore.events = []

    ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await ex.tick()                    // entry fills → open 1000, protective stop 1000
    t = ex.allTrades()[0]

    broker.partialSellOnce = 200       // the next sell fills 200 cumulative and stays working
    price = 11.2                       // hits T1 → order 500
    await ex.tick()

    const leg = t.exits.find(l => l.reason === 't1' && l.orderId != null)!
    const bo = (await broker.getOrder(leg.orderId!))!
    reservedRemainder = bo.qty - bo.filledQty   // 500 − 200 = 300 still held_for_orders
    expect(t.openQty).toBe(800)
    expect(reservedRemainder).toBe(300)
    expect(leg.fillPrice).not.toBeNull()        // first partial booked → fillPrice set
  })
  afterEach(() => { vi.useRealTimers() })

  it('a still-working exit remainder reserves ordered − filled (300), not 0', () => {
    // SAFE INVARIANT: while the exit order is non-terminal, reserved = orderedQty − filledQty.
    expect(workingExitQty(t)).toBe(reservedRemainder)      // 300
  })

  it('the protective stop covers only the free shares (never the reserved remainder)', async () => {
    price = 11.5                        // between the breakeven stop and T2 → ensureProtectiveStop runs
    await ex.tick()

    expect(t.protectiveStopOrderId).not.toBeNull()
    const stop = (await broker.getOrder(t.protectiveStopOrderId!))!
    const freeShares = t.openQty - reservedRemainder        // 800 − 300 = 500 truly free
    expect(freeShares).toBe(500)
    // SAFE INVARIANT: the protective stop covers only the FREE shares (500), not 800.
    expect(stop.qty).toBe(freeShares)
  })
})
