/**
 * P0-003 — SHUTDOWN WITH PENDING ENTRY (safe-invariant suite, now REMEDIATED)
 *
 * AUDIT CLAIM (P0-R): flattenAll only iterated 'open' trades, so a 'pending_entry' with a
 * working broker order was skipped — never cancelled, never reconciled — and the process
 * could exit with the entry still live.
 *
 * REMEDIATION (P0-F): flattenAll now handles pending entries FIRST — it cancels the working
 * order, settles against fresh broker truth (booking any raced fill), then reconciles. The
 * full ordered shutdown (authority release, SAFE/UNRESOLVED) is covered in
 * tests/execution-shutdown.test.ts; this suite pins the flattenAll pending-handling invariants.
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

describe('P0-003 shutdown with a pending entry (remediated)', () => {
  let broker: DeterministicBroker
  let price: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test' },   // pending/shutdown unit tests, not authority
    () => {},
  )

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker()
    price = 10
    mockStore.events = []
  })
  afterEach(() => { vi.useRealTimers() })

  /** Arm a genuine pending_entry: entry submitted, working at the broker, nothing filled. */
  const armPending = async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    broker.holdWorking.add(t.entryOrderId!)
    expect(t.state).toBe('pending_entry')
    expect(broker.workingOrderCount('TEST')).toBe(1)
    return { ex, t }
  }

  it('SAFE: shutdown CANCELS the working pending entry order', async () => {
    const { ex, t } = await armPending()
    const orderId = t.entryOrderId!
    await ex.flattenAll('risk_halt')
    expect(broker.canceled).toContain(orderId)
  })

  it('SAFE: shutdown reconciles broker terminal truth for the pending entry', async () => {
    const { ex, t } = await armPending()
    await ex.flattenAll('risk_halt')
    expect(t.lastReconciledAt).not.toBeNull()     // broker truth stamped
    expect(t.state).not.toBe('pending_entry')     // resolved (aborted on broker no-fill)
    expect(t.state).toBe('aborted')
  })

  it('SAFE: no working entry order remains at the broker after shutdown', async () => {
    const { ex } = await armPending()
    await ex.flattenAll('risk_halt')
    expect(broker.workingOrderCount('TEST')).toBe(0)
  })

  it('SAFE: a PARTIAL fill racing the shutdown cancel is booked then flattened, not stranded', async () => {
    const { ex, t } = await armPending()
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 400, price: 10.05, status: 'partially_filled' })
    await ex.flattenAll('risk_halt')
    expect(broker.truthQty('TEST')).toBe(0)       // 400 booked then flattened — nothing left
    expect(t.state).not.toBe('pending_entry')
    expect(t.state).toBe('closed')
  })

  it('SAFE: a FULL fill racing the shutdown cancel is booked then flattened, not stranded', async () => {
    const { ex, t } = await armPending()
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 1000, price: 10.05, status: 'filled' })
    await ex.flattenAll('risk_halt')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(t.state).toBe('closed')
  })

  it('control: an OPEN position IS flattened on shutdown (proves the path is intact)', async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await ex.tick()   // entry fills → open, 1000 sh
    expect(ex.allTrades()[0].state).toBe('open')
    expect(broker.truthQty('TEST')).toBe(1000)

    await ex.flattenAll('risk_halt')

    expect(ex.allTrades()[0].state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
  })
})
