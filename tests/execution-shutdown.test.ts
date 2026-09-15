/**
 * Graceful SHUTDOWN sequence — deterministic, offline (P0-F sections E & F).
 *
 * Exercises PaperExecutor.shutdown() end-to-end with a real authority lease on a temp path:
 * zero/partial/full fills, pending_cancel evolving to canceled/filled, cancel failure,
 * getOrder failure, an ordinary open-position shutdown, and admission-closed-during-shutdown.
 * SAFE ⇒ authority released & marker removed; UNRESOLVED ⇒ marker retained.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

describe('graceful shutdown sequence', () => {
  let broker: DeterministicBroker
  let price: number
  let dir: string
  let lockPath: string

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityLockPath: lockPath },
    () => {},
  )

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker()
    price = 10
    mockStore.events = []
    dir = mkdtempSync(join(tmpdir(), 'shutdown-'))
    lockPath = join(dir, '.companion-execution-authority.lock')
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const armPending = async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    return { ex, t, orderId: t.entryOrderId! }
  }

  it('zero-fill pending order → SAFE, aborted, authority released', async () => {
    const { ex, t, orderId } = await armPending()
    broker.holdWorking.add(orderId)

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('aborted')
    expect(broker.canceled).toContain(orderId)
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)          // marker released
  })

  it('partial-fill racing the shutdown cancel → booked + flattened → SAFE', async () => {
    const { ex, t, orderId } = await armPending()
    broker.holdWorking.add(orderId)
    broker.raceFillOnCancel.set(orderId, { qty: 400, price: 10.05, status: 'partially_filled' })

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.entryFillQty).toBe(400)
    expect(t.state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('full fill racing the shutdown cancel → booked + flattened → SAFE', async () => {
    const { ex, t, orderId } = await armPending()
    broker.holdWorking.add(orderId)
    broker.raceFillOnCancel.set(orderId, { qty: 1000, price: 10.05, status: 'filled' })

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('pending_cancel BEFORE canceled → settles to abort → SAFE', async () => {
    const { ex, t, orderId } = await armPending()
    // getOrder yields pending_cancel (mapped to non-terminal 'open') then a settled canceled.
    broker.stepQueue.set(orderId, [
      { status: 'open', filledQty: 0 },
      { status: 'canceled', filledQty: 0 },
    ])

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('aborted')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('pending_cancel BEFORE filled → books the fill then flattens → SAFE', async () => {
    const { ex, t, orderId } = await armPending()
    broker.stepQueue.set(orderId, [
      { status: 'open', filledQty: 0 },                          // pending_cancel, still working
      { status: 'filled', filledQty: 1000, price: 10.05 },       // then it fills
    ])

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.entryFillQty).toBe(1000)
    expect(t.state).toBe('closed')                               // booked, then flattened
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('cancel FAILURE → UNRESOLVED → authority retained', async () => {
    const { ex, t, orderId } = await armPending()
    broker.holdWorking.add(orderId)
    broker.failCancel.add(orderId)                               // cancel request errors

    const res = await ex.shutdown()
    expect(res.safe).toBe(false)
    expect(ex.isReconciliationUnresolved()).toBe(true)
    expect(t.state).toBe('pending_entry')                        // never resolved
    expect(existsSync(lockPath)).toBe(true)                      // marker RETAINED
    expect(ex.isExecutionAuthorized()).toBe(true)
  })

  it('broker getOrder FAILURE during settlement → UNRESOLVED → authority retained', async () => {
    const { ex, orderId } = await armPending()
    broker.holdWorking.add(orderId)
    broker.failGetOrder.add(orderId)                            // cannot read broker truth

    const res = await ex.shutdown()
    expect(res.safe).toBe(false)
    expect(ex.isReconciliationUnresolved()).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('broker residual position (unreadable close) → UNRESOLVED → authority retained', async () => {
    // Pending settles to aborted, but the broker still shows a position we cannot explain.
    const { ex, orderId } = await armPending()
    broker.holdWorking.add(orderId)
    // After settlement the pending aborts; seed a residual so the broker-truth check trips.
    const res1Promise = (async () => {
      // seed the residual AFTER the settlement's reconcile would have run is hard to time;
      // instead seed now — reconcile will adopt it (discrepancy) and shutdown flags residual.
      broker.seedPosition('TEST', 250)
      return ex.shutdown()
    })()
    const res = await res1Promise
    expect(res.safe).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
  })

  it('ordinary OPEN-position shutdown still works → flattened → SAFE, released', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await ex.tick()                                             // entry fills → open 1000
    expect(ex.allTrades()[0].state).toBe('open')

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(ex.allTrades()[0].state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('F: once shutdown has begun, a new BUY is admitted CLOSED (no race)', async () => {
    const ex = build()
    await ex.init()

    const shutdownPromise = ex.shutdown()                       // sets shuttingDown synchronously
    const res = await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await shutdownPromise

    expect(res.taken).toBe(false)
    expect(res.reason).toMatch(/shutting down/)
    expect(broker.submittedBuys).toHaveLength(0)               // nothing admitted
  })
})
