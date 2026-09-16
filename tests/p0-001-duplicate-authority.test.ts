/**
 * P0-001 — DUPLICATE EXECUTION AUTHORITY (safe-invariant suite, now REMEDIATED)
 *
 * AUDIT CLAIM (P0-R): two PAPER_TRADE producers could both obtain execution authority
 * because provenance verifies SOURCE STATE but there was no PROCESS-EXCLUSIVE LEASE.
 *
 * REMEDIATION (P0-F): src/lib/execution/authority.ts adds an atomic exclusive-create lease;
 * PaperExecutor.init() must acquire it before becoming execution-capable, and onSignal fails
 * closed without it. Provenance is unchanged and is NOT the lease.
 *
 * These assertions encode the SAFE invariant (single execution authority) and now PASS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  resolveProvenance, decideProducer, enforceProducerProvenance, type GitRunner,
} from '@/lib/execution/provenance'
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

/** A GitRunner modelling a CLEAN repo on a real commit — the case the provenance guard ALLOWS. */
function cleanGit(): GitRunner {
  return (args) => {
    const a = args.join(' ')
    if (a === 'rev-parse --is-inside-work-tree') return { status: 0, stdout: 'true', stderr: '' }
    if (a === 'rev-parse HEAD') return { status: 0, stdout: 'a'.repeat(40), stderr: '' }
    if (a === 'rev-parse --abbrev-ref HEAD') return { status: 0, stdout: 'main', stderr: '' }
    if (a === 'diff --quiet') return { status: 0, stdout: '', stderr: '' }
    if (a === 'diff --cached --quiet') return { status: 0, stdout: '', stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
}

describe('P0-001 duplicate execution authority (remediated)', () => {
  let dir: string
  let lockPath: string

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    mockStore.events = []
    dir = mkdtempSync(join(tmpdir(), 'p0-001-'))
    lockPath = join(dir, '.companion-execution-authority.lock')
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const build = () => new PaperExecutor(
    new DeterministicBroker(),
    async (symbols: string[]) => new Map(symbols.map(s => [s, 10])),
    { ...DEFAULT_EXECUTOR, authorityLockPath: lockPath, settlementPollDelayMs: 0 },  // deterministic: no wall-clock wait
    () => {},
  )

  it('provenance is a source-state gate, NOT a lease: two clean producers both pass provenance', () => {
    // The lease is a SEPARATE mechanism from provenance. Provenance still allows both clean
    // producers — mutual exclusion is enforced by the lease, not by source state.
    expect(decideProducer(resolveProvenance(cleanGit(), { override: false })).allowed).toBe(true)
    expect(decideProducer(resolveProvenance(cleanGit(), { override: false })).allowed).toBe(true)
    const exits: number[] = []
    enforceProducerProvenance({ requireAuthority: true, override: false, git: cleanGit(), log: () => {}, exit: c => exits.push(c) })
    enforceProducerProvenance({ requireAuthority: true, override: false, git: cleanGit(), log: () => {}, exit: c => exits.push(c) })
    expect(exits).toEqual([])
  })

  it('SAFE: only ONE producer may hold authority against a shared account', async () => {
    const producerA = build()
    const producerB = build()   // shares the same lease path (same account/host)
    await producerA.init()
    await producerB.init()

    // A holds the lease; B is denied and is NOT execution-capable.
    expect(producerA.isExecutionAuthorized()).toBe(true)
    expect(producerB.isExecutionAuthorized()).toBe(false)
    expect(producerB.deniedAuthorityInfo()).not.toBeNull()   // B can see who holds it
    expect(producerA.isReconciliationUnresolved()).toBe(false)
    expect(producerB.isReconciliationUnresolved()).toBe(false)

    const resA = await producerA.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    const resB = await producerB.onSignal(makeSignal(), { sessionVolume: 10_000_000 })

    expect(resA.taken).toBe(true)
    expect(resB.taken).toBe(false)                    // denied — the lease holder is already live
    expect(resB.reason).toMatch(/no execution authority/)
  })

  it('SAFE: a shared account never receives two entry orders for one setup', async () => {
    const brokerA = new DeterministicBroker()
    const brokerB = new DeterministicBroker()
    const mk = (b: DeterministicBroker) => new PaperExecutor(
      b, async (s: string[]) => new Map(s.map(x => [x, 10])),
      { ...DEFAULT_EXECUTOR, authorityLockPath: lockPath, settlementPollDelayMs: 0 }, () => {},
    )
    const producerA = mk(brokerA)
    const producerB = mk(brokerB)
    await producerA.init()
    await producerB.init()

    await producerA.onSignal(makeSignal(), { sessionVolume: 10_000_000 })
    await producerB.onSignal(makeSignal(), { sessionVolume: 10_000_000 })

    // Only the authorised producer submitted an entry — no duplicated exposure.
    expect(brokerA.submittedBuys).toHaveLength(1)
    expect(brokerB.submittedBuys).toHaveLength(0)
  })

  it('SAFE: authority marker released on clean shutdown allows a later producer to acquire', async () => {
    const producerA = build()
    await producerA.init()
    expect(producerA.isExecutionAuthorized()).toBe(true)
    expect(existsSync(lockPath)).toBe(true)

    // Clean shutdown on a flat book → SAFE → marker released.
    const result = await producerA.shutdown()
    expect(result.safe).toBe(true)
    expect(existsSync(lockPath)).toBe(false)

    // A later producer can now acquire.
    const producerC = build()
    await producerC.init()
    expect(producerC.isExecutionAuthorized()).toBe(true)
  })
})
