/**
 * BROKER / PAPER EXECUTION CHAOS — RESTART + AUTHORITY RECOVERY (C14, C15, C17).
 *
 * Deterministic, offline. Uses the REAL store (saveTrades/loadTrades) redirected to a temp
 * HOME so restart exercises real serialization/deserialization + startup reconciliation, and
 * the REAL authority lease. The broker/account persists across the "restart" (same instance);
 * only the executor is re-instantiated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { PaperExecutor, DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { DeterministicBroker, makeSignal, REGULAR_HOURS } from '../harness/execution-safety-broker'

// NOTE: no vi.mock of the store — these tests use the real store against a temp HOME.

describe('CHAOS · restart + authority recovery', () => {
  let broker: DeterministicBroker
  let price: number
  let home: string
  let prevHome: string | undefined

  const build = (over: Partial<import('@/lib/execution/executor').ExecutorConfig> = {}) => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityMode: 'disabled_for_test', settlementPollDelayMs: 0, ...over },  // deterministic: no wall-clock wait
    () => {},
  )

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker(); price = 10
    home = mkdtempSync(join(tmpdir(), 'chaos-home-'))
    prevHome = process.env.HOME
    process.env.HOME = home           // redirect the real store's homedir() to a temp dir
  })
  afterEach(() => {
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('C14 — restart with MATCHING broker state: no duplicate entry/position/P&L, consistent', async () => {
    // Executor A opens a full position and persists (real saveTrades in tick).
    const a = build(); await a.init()
    await a.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await a.tick()
    expect(a.allTrades()[0].state).toBe('open')
    expect(a.allTrades()[0].openQty).toBe(1000)
    expect(existsSync(join(home, '.companion-paper-trades-2026-08-07.json'))).toBe(true)
    expect(broker.truthQty('TEST')).toBe(1000)

    // Executor B restarts against the SAME broker (account) + the persisted store.
    const b = build(); await b.init()
    expect(b.allTrades()).toHaveLength(1)                 // loaded once, not duplicated
    const t = b.allTrades()[0]
    expect(t.openQty).toBe(1000)
    expect(t.entryFillQty).toBe(1000)                     // entry not re-booked
    expect(t.entryOrderTerminal).toBe(true)
    expect(b.isReconciliationUnresolved()).toBe(false)   // represented — broker matches

    await b.tick()                                        // reconcile against matching broker
    expect(t.openQty).toBe(1000)                          // no double
    expect(broker.truthQty('TEST')).toBe(1000)           // no duplicate position
  })

  it('C15 — restart with broker/local MISMATCH: detected, fail closed, no fabricated basis', async () => {
    const a = build(); await a.init()
    await a.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await a.tick()
    expect(a.allTrades()[0].openQty).toBe(1000)

    // The account materially changed while the process was down (broker now holds 400).
    broker.seedPosition('TEST', 400)

    const b = build(); await b.init()
    const t = b.allTrades()[0]
    expect(b.isReconciliationUnresolved()).toBe(true)    // startup reconciliation fails closed
    expect(t.entryFillQty).toBe(1000)                    // basis NOT fabricated down to 400
    expect(t.reconciliationStatus).not.toBe('verified')  // no false VERIFIED
  })

  it('C17 — authority retained after unresolved shutdown; a second executor fails closed (no steal)', async () => {
    const lockPath = join(home, '.companion-execution-authority.lock')
    const a = build({ authorityMode: 'required', authorityLockPath: lockPath })
    await a.init()
    expect(a.isExecutionAuthorized()).toBe(true)
    expect(existsSync(lockPath)).toBe(true)

    // Force an UNRESOLVED shutdown: pending entry whose cancel fails.
    await a.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const ta = a.allTrades()[0]
    broker.holdWorking.add(ta.entryOrderId!)
    broker.failCancel.add(ta.entryOrderId!)
    const res = await a.shutdown()
    expect(res.safe).toBe(false)
    expect(existsSync(lockPath)).toBe(true)              // marker retained

    // A second executor must fail closed — the marker is NOT auto-stolen.
    const b = build({ authorityMode: 'required', authorityLockPath: lockPath })
    await b.init()
    expect(b.isExecutionAuthorized()).toBe(false)
    expect(b.deniedAuthorityInfo()).not.toBeNull()
    expect(existsSync(lockPath)).toBe(true)
  })
})
