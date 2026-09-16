/**
 * Execution-authority LEASE — deterministic, offline unit tests (P0-F section A).
 *
 * Covers: (1) first process acquires, (2) second fails closed, (3) clean release allows a
 * later acquisition, (4) a failed/unsafe shutdown does NOT release, (5) a stale marker fails
 * closed and reports the holder — never auto-stolen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  acquireExecutionAuthority, makeAuthorityMetadata, readAuthorityMarker, authorityLockPath,
} from '@/lib/execution/authority'
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

const meta = (over: Partial<ReturnType<typeof makeAuthorityMetadata>> = {}) => ({
  ...makeAuthorityMetadata({ producerHead: 'abc123', branch: 'main', mode: 'PAPER_TRADE' }),
  ...over,
})

describe('execution authority lease', () => {
  let dir: string
  let lockPath: string

  beforeEach(() => {
    mockStore.events = []
    dir = mkdtempSync(join(tmpdir(), 'auth-'))
    lockPath = join(dir, '.companion-execution-authority.lock')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('default path is an execution-owned marker in home', () => {
    expect(authorityLockPath('/home/x')).toBe('/home/x/.companion-execution-authority.lock')
  })

  it('metadata carries only non-secret identity fields (no credentials)', () => {
    const m = makeAuthorityMetadata({ producerHead: 'h', branch: 'b', mode: 'PAPER_TRADE' })
    expect(Object.keys(m).sort()).toEqual(['branch', 'hostname', 'mode', 'pid', 'producerHead', 'startedAtUtc'])
    const blob = JSON.stringify(m).toLowerCase()
    for (const secret of ['key', 'secret', 'token', 'apca', 'password']) expect(blob).not.toContain(secret)
  })

  it('1. first process acquires and writes its metadata', () => {
    const a = acquireExecutionAuthority(meta(), { lockPath })
    expect(a.acquired).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf8'))
    expect(onDisk.mode).toBe('PAPER_TRADE')
    expect(onDisk.pid).toBe(process.pid)
  })

  it('2. second acquire fails closed and reports the existing holder', () => {
    const first = acquireExecutionAuthority(meta({ pid: 111 }), { lockPath })
    expect(first.acquired).toBe(true)
    const second = acquireExecutionAuthority(meta({ pid: 222 }), { lockPath })
    expect(second.acquired).toBe(false)
    expect(second.existing).not.toBeNull()
    expect(second.existing!.pid).toBe(111)   // the ORIGINAL holder, not the challenger
    expect(second.reason).toMatch(/already held/)
    expect(existsSync(lockPath)).toBe(true)   // untouched
  })

  it('3. a clean release allows a later acquisition', () => {
    const a = acquireExecutionAuthority(meta(), { lockPath })
    expect(a.acquired).toBe(true)
    a.release()
    expect(existsSync(lockPath)).toBe(false)
    const b = acquireExecutionAuthority(meta(), { lockPath })
    expect(b.acquired).toBe(true)
  })

  it('5. a STALE marker (holder gone) still fails closed — never auto-stolen', () => {
    // Simulate a crashed producer that left a marker behind with a PID that is not us.
    const stale = { pid: 999999, hostname: 'oldhost', startedAtUtc: '2020-01-01T00:00:00.000Z', producerHead: 'dead', branch: 'main', mode: 'PAPER_TRADE' }
    writeFileSync(lockPath, JSON.stringify(stale))

    const attempt = acquireExecutionAuthority(meta(), { lockPath })
    expect(attempt.acquired).toBe(false)                 // fail closed — do NOT steal
    expect(attempt.existing).toEqual(stale)              // report the holder for recovery
    expect(readAuthorityMarker({ lockPath })).toEqual(stale)   // marker untouched
  })

  it('release only removes a marker still identified as OURS', () => {
    const a = acquireExecutionAuthority(meta({ pid: 111 }), { lockPath })
    // Someone else overwrote the marker (e.g. a recovered, re-acquired lease).
    writeFileSync(lockPath, JSON.stringify({ pid: 222, hostname: 'h', startedAtUtc: 'x', producerHead: null, branch: null, mode: 'PAPER_TRADE' }))
    a.release()
    expect(existsSync(lockPath)).toBe(true)              // not ours anymore → left in place
    expect(readAuthorityMarker({ lockPath })!.pid).toBe(222)
  })

  it('4. a failed/unsafe shutdown does NOT release the marker', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    const broker = new DeterministicBroker()
    const ex = new PaperExecutor(
      broker,
      async (s: string[]) => new Map(s.map(x => [x, 10])),
      { ...DEFAULT_EXECUTOR, authorityLockPath: lockPath, settlementPollDelayMs: 0 },  // deterministic: no wall-clock wait
      () => {},
    )
    await ex.init()
    expect(ex.isExecutionAuthorized()).toBe(true)
    expect(existsSync(lockPath)).toBe(true)

    // Arm a pending entry whose cancel CANNOT be resolved (cancel throws, order stays working)
    // → shutdown is UNRESOLVED.
    await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const t = ex.allTrades()[0]
    broker.holdWorking.add(t.entryOrderId!)
    broker.failCancel.add(t.entryOrderId!)

    const result = await ex.shutdown()
    expect(result.safe).toBe(false)                      // unresolved
    expect(existsSync(lockPath)).toBe(true)              // marker RETAINED — not released
    expect(ex.isExecutionAuthorized()).toBe(true)        // still holds authority
    vi.useRealTimers()
  })
})

/**
 * Authority REQUIRED BY DEFAULT — the invariant is enforced by PaperExecutor itself, not by
 * whatever caller happens to pass a lock path. Omitting authority config CANNOT silently
 * create order authority.
 */
describe('authority required by default (executor-enforced)', () => {
  let dir: string
  let lockPath: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    mockStore.events = []
    dir = mkdtempSync(join(tmpdir(), 'auth-mode-'))
    lockPath = join(dir, '.companion-execution-authority.lock')
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const make = (over: Partial<import('@/lib/execution/executor').ExecutorConfig>) =>
    new PaperExecutor(
      new DeterministicBroker(),
      async (s: string[]) => new Map(s.map(x => [x, 10])),
      { ...DEFAULT_EXECUTOR, settlementPollDelayMs: 0, ...over },  // deterministic default; a test may still override
      () => {},
    )

  it('DEFAULT_EXECUTOR.authorityMode is "required"', () => {
    expect(DEFAULT_EXECUTOR.authorityMode).toBe('required')
  })

  it('omitting authority config CANNOT silently create order authority (fail closed)', async () => {
    // required mode (the default) with NO lock path → not execution-capable, no orders.
    const ex = make({})   // no authorityMode override, no authorityLockPath
    await ex.init()
    expect(ex.isExecutionAuthorized()).toBe(false)
    const res = await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    expect(res.taken).toBe(false)
    expect(res.reason).toMatch(/no execution authority/)
    expect(ex.allTrades()).toHaveLength(0)              // nothing submitted
  })

  it('explicit authorityMode:"required" with no lock path also fails closed', async () => {
    const ex = make({ authorityMode: 'required' })
    await ex.init()
    expect(ex.isExecutionAuthorized()).toBe(false)
    expect((await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })).taken).toBe(false)
  })

  it('explicit disabled_for_test preserves unit-test ergonomics (order-capable, no lease)', async () => {
    const ex = make({ authorityMode: 'disabled_for_test' })   // no lock path needed
    await ex.init()
    expect(ex.isExecutionAuthorized()).toBe(true)
    expect(existsSync(lockPath)).toBe(false)                   // no marker created
    const res = await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    expect(res.taken).toBe(true)
  })

  it('required mode WITH a lock path acquires — the production/daemon configuration', async () => {
    const ex = make({ authorityMode: 'required', authorityLockPath: lockPath })
    await ex.init()
    expect(ex.isExecutionAuthorized()).toBe(true)
    expect(existsSync(lockPath)).toBe(true)
    expect((await ex.onSignal(makeSignal(), { sessionVolume: 10_000_000 })).taken).toBe(true)
  })
})
