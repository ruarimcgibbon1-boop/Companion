/**
 * BROKER / PAPER EXECUTION CHAOS — SHUTDOWN + AUTHORITY (C6, C7, C8, C18).
 *
 * Deterministic, offline. Real PaperExecutor.shutdown() with a real authority lease on a temp
 * marker. Validates the ordered shutdown, raced-fill flatten, fail-closed-on-unreadable-truth,
 * and the positive control (SAFE → authority released → re-acquirable).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

describe('CHAOS · shutdown + authority', () => {
  let broker: DeterministicBroker
  let price: number
  let dir: string
  let lockPath: string

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'required', authorityLockPath: lockPath, settlementPollDelayMs: 0 },  // deterministic: no wall-clock wait
    () => {},
  )
  const armPending = async () => {
    const ex = build(); await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    return { ex, t: ex.allTrades()[0] }
  }

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker(); price = 10; mockStore.events = []
    dir = mkdtempSync(join(tmpdir(), 'chaos-shutdown-'))
    lockPath = join(dir, '.companion-execution-authority.lock')
  })
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

  it('C6 — pending entry, zero fill: cancel, prove flat, SAFE, authority released', async () => {
    const { ex, t } = await armPending()
    broker.holdWorking.add(t.entryOrderId!)
    expect(existsSync(lockPath)).toBe(true)

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('aborted')
    expect(broker.canceled).toContain(t.entryOrderId!)
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)          // authority released
  })

  it('C7A — shutdown cancel races a PARTIAL fill → booked, flattened, broker flat, SAFE', async () => {
    const { ex, t } = await armPending()
    broker.holdWorking.add(t.entryOrderId!)
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 400, price: 10.05, status: 'partially_filled' })
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.entryFillQty).toBe(400)
    expect(t.state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('C7B — shutdown cancel races a FULL fill → booked, flattened, broker flat, SAFE', async () => {
    const { ex, t } = await armPending()
    broker.holdWorking.add(t.entryOrderId!)
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 1000, price: 10.05, status: 'filled' })
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('C8a — shutdown with a failing cancel → UNRESOLVED, authority RETAINED', async () => {
    const { ex, t } = await armPending()
    broker.holdWorking.add(t.entryOrderId!)
    broker.failCancel.add(t.entryOrderId!)
    const res = await ex.shutdown()
    expect(res.safe).toBe(false)
    expect(ex.isReconciliationUnresolved()).toBe(true)
    expect(t.state).toBe('pending_entry')
    expect(existsSync(lockPath)).toBe(true)           // marker retained
    expect(ex.isExecutionAuthorized()).toBe(true)
  })

  it('C8b — shutdown with unreadable position truth → UNRESOLVED, authority RETAINED', async () => {
    const { ex } = await armPending()
    // Open a real position first so there is exposure the shutdown must confirm flat.
    broker.raceFillOnCancel.clear()
    // Force a genuine open position, then make the broker position unreadable during shutdown.
    broker.seedPosition('TEST', 500)
    broker.failGetPosition.add('TEST')
    const res = await ex.shutdown()
    expect(res.safe).toBe(false)                      // cannot confirm flat → not safe
    expect(existsSync(lockPath)).toBe(true)           // marker retained
  })

  it('C18 — positive control: clean open position → SAFE → released → re-acquirable', async () => {
    const ex = build(); await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await ex.tick()                                   // entry fills → open 1000
    expect(ex.allTrades()[0].state).toBe('open')
    expect(broker.truthQty('TEST')).toBe(1000)

    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(ex.allTrades()[0].state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)          // authority released

    // A subsequent executor can now acquire the marker.
    const ex2 = build(); await ex2.init()
    expect(ex2.isExecutionAuthorized()).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
  })
})
