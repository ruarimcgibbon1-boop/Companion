/**
 * P0-002 — CANCEL/FILL RACE on the ENTRY-TIMEOUT path (safe-invariant suite, now REMEDIATED)
 *
 * AUDIT CLAIM (P0-R):
 *   (A) reconcileEntry decided abort from a PRE-cancel snapshot; a fill that raced the cancel
 *       was disowned (local aborted, broker long).
 *   (B) mapStatus collapsed `pending_cancel` → terminal `canceled`, so a still-fillable order
 *       was treated as dead.
 *
 * REMEDIATION (P0-F):
 *   (A) reconcileEntry timeout path now settles via settleCanceledEntry — cancel, then read
 *       FRESH broker truth, and book any raced fill (manage it) rather than reusing the stale
 *       snapshot. A raced fill is NEVER disowned.
 *   (B) mapStatus maps `pending_cancel` → non-terminal 'open'; only settled `canceled` is terminal.
 *
 * NOTE ON A CORRECTED ASSERTION: the P0-R reproduction guessed the safe response to a raced
 * fill ABOVE the stop was to FLATTEN it (truthQty→0). The authoritative P0-F spec (section C)
 * is to BOOK the fill and MANAGE the exposure — a valid fill is a real position. These
 * assertions therefore check book-and-manage, not flatten. The core invariant is unchanged:
 * local truth must account for broker truth; the entry is never silently aborted while long.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { mapStatus } from '@/lib/execution/alpaca'
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

describe('P0-002 cancel/fill race — entry timeout path (remediated)', () => {
  let broker: DeterministicBroker
  let price: number

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test' },   // unit tests of the race, not of authority
    () => {},
  )

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker()
    price = 10   // above the 9.5 stop → geometry invalidation never fires; isolates the timeout path
    mockStore.events = []
  })
  afterEach(() => { vi.useRealTimers() })

  /** Arm a genuine working entry (unfilled) and time it out. */
  const armTimedOut = async () => {
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    broker.holdWorking.add(t.entryOrderId!)   // broker keeps it working, filledQty 0
    return { ex, t }
  }

  it('FULL fill races the timeout cancel → booked + managed, never disowned', async () => {
    const { ex, t } = await armTimedOut()
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 1000, price: 10.05, status: 'filled' })

    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()

    expect(broker.truthQty('TEST')).toBe(1000)   // broker holds the position
    expect(t.entryFillQty).toBe(1000)            // fill booked, not disowned
    expect(t.openQty).toBe(1000)                 // local truth == broker truth
    expect(t.state).toBe('open')                 // managed (fill above stop), not aborted
  })

  it('PARTIAL fill races the timeout cancel → the filled shares are booked, remainder cancelled', async () => {
    const { ex, t } = await armTimedOut()
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 700, price: 10.05, status: 'partially_filled' })

    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()

    expect(broker.truthQty('TEST')).toBe(700)    // only the 700 that filled
    expect(t.entryFillQty).toBe(700)
    expect(t.openQty).toBe(700)
    expect(t.state).toBe('open')
    expect(broker.canceled.length).toBeGreaterThan(0)   // remainder cancellation requested
  })

  it('ZERO fill at the timeout → clean abort (unchanged safe behaviour)', async () => {
    const { ex, t } = await armTimedOut()   // no race fill configured

    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()

    expect(broker.truthQty('TEST')).toBe(0)
    expect(t.state).toBe('aborted')
    expect(t.openQty).toBe(0)
    expect(mockStore.events.some(e => e.event === 'entry_timeout')).toBe(true)
  })

  it('FULL fill BELOW the stop races the cancel → booked then flattened (invalid geometry)', async () => {
    const { ex, t } = await armTimedOut()
    broker.raceFillOnCancel.set(t.entryOrderId!, { qty: 1000, price: 9.4, status: 'filled' })   // below 9.5 stop

    vi.setSystemTime(REGULAR_HOURS + DEFAULT_EXECUTOR.entryTimeoutMs + 1_000)
    await ex.tick()

    expect(t.entryFillQty).toBe(1000)            // fill still booked (never disowned)
    expect(t.executionWarnings.some(w => w.startsWith('INVALID_POST_FILL_GEOMETRY'))).toBe(true)
    expect(t.state).toBe('closed')               // flattened by the invalid-geometry guard
    expect(broker.truthQty('TEST')).toBe(0)      // nothing stranded
  })

  // ── Alpaca status adapter ───────────────────────────────────────────────────────
  describe('mapStatus', () => {
    it('pending_cancel is NON-terminal (a pending_cancel order can still fill)', () => {
      const mapped = mapStatus('pending_cancel')
      expect(mapped).not.toBe('canceled')
      expect(['open', 'partially_filled', 'pending']).toContain(mapped)
    })
    it('a settled canceled is terminal', () => {
      expect(mapStatus('canceled')).toBe('canceled')
    })
    it('filled is terminal', () => {
      expect(mapStatus('filled')).toBe('filled')
    })
  })

  it('an entry sitting in pending_cancel (mapped to open) is NOT aborted, then books its fill', async () => {
    // With the fixed adapter, a pending_cancel entry reaches the executor as non-terminal
    // 'open'. Not timed out, so reconcileEntry leaves it pending (never aborts). When the
    // pending_cancel then resolves to a fill, broker truth is booked.
    const ex = build()
    await ex.init()
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    const orderId = t.entryOrderId!

    // Tick 1: broker reports the order as 'open' (the fixed pending_cancel mapping), 0 filled.
    broker.reportStatus.set(orderId, 'open')
    broker.reportFilledQty.set(orderId, 0)
    await ex.tick()
    expect(t.state).toBe('pending_entry')        // NOT aborted — pending_cancel is non-terminal
    expect(t.state).not.toBe('aborted')

    // Tick 2: the pending_cancel resolves to a full fill; broker truth is booked and managed.
    broker.reportStatus.delete(orderId)
    broker.reportFilledQty.delete(orderId)
    broker.holdWorking.delete(orderId)           // broker now fills on read (default path)
    await ex.tick()
    expect(t.state).toBe('open')
    expect(t.entryFillQty).toBe(1000)
    expect(broker.truthQty('TEST')).toBe(1000)
  })
})
