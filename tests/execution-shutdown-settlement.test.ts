/**
 * SHUTDOWN FLATTEN SETTLEMENT (Phase C2-S) — deterministic, offline.
 *
 * Reproduces and guards the real FPS failure: graceful shutdown submitted a flatten sell,
 * read broker truth ONCE before the fill settled (~0.5s later at Alpaca paper), saw the
 * position still held, and fail-closed to UNRESOLVED — stranding a fill that completed a beat
 * later. The fix gives a freshly-submitted flatten a BOUNDED number of fresh broker
 * settlement observations before shutdown classifies, booking any settled fill idempotently,
 * and only declaring flat when LOCAL and BROKER agree. Fail-closed direction is preserved:
 * unreadable truth or budget exhaustion still ⇒ UNRESOLVED, authority retained.
 *
 * Timing is expressed as a POLL COUNT over fresh broker reads (no wall-clock sleep), so every
 * case is deterministic — the broker double returns evolving views across reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { PaperExecutor, DEFAULT_EXECUTOR, SHUTDOWN_SETTLEMENT_POLL_DELAY_MS } from '@/lib/execution/executor'
import { DeterministicBroker, makeSignal, REGULAR_HOURS } from './harness/execution-safety-broker'

// Must match SHUTDOWN_SETTLEMENT_POLLS in src/lib/execution/executor.ts.
const POLLS = 5

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

describe('shutdown flatten settlement (C2-S)', () => {
  let broker: DeterministicBroker
  let price: number
  let dir: string
  let lockPath: string

  const build = () => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityLockPath: lockPath, settlementPollDelayMs: 0 },  // deterministic: no wall-clock wait
    () => {},
  )

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REGULAR_HOURS)
    broker = new DeterministicBroker()
    price = 10
    mockStore.events = []
    dir = mkdtempSync(join(tmpdir(), 'shutdown-settle-'))
    lockPath = join(dir, '.companion-execution-authority.lock')
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Arm a real OPEN position that mirrors FPS: entry fills, a resting protective stop is placed. */
  const armOpen = async (qty = 487, ex: PaperExecutor = build()) => {
    // Geometry tuned so fixed-fractional sizing yields exactly `qty` (487 → FPS): riskBudget
    // 100_000 × 0.005 = 500; stopDistance ≈ 500/487 ⇒ floor(500/1.0266) = 487.
    const stopDistance = 500 / (qty + 0.5)   // mid-bucket ⇒ floor(500/stopDistance) === qty
    const sig = makeSignal({ entryHigh: 10, entryLow: 9.9, triggerPrice: 10, stop: 10 - stopDistance, targets: [20, 30] })
    await ex.init()
    await ex.onSignal(sig, { sessionVolume: 10_000_000 })
    await ex.tick()                                   // entry fills → open; protective stop placed
    const t = ex.allTrades()[0]
    expect(t.state).toBe('open')
    expect(t.openQty).toBe(qty)
    expect(t.protectiveStopOrderId).toBeTruthy()
    return { ex, t }
  }

  const closedEventsFor = (tradeId: string) =>
    mockStore.events.filter(e => e.event === 'trade_closed' && e.tradeId === tradeId)

  // ── The real FPS reproduction: fill lands on a fresh read AFTER the first observation ──
  it('REPRO/mirror: 487 open, stop canceled, flatten submitted, first read still 487, next read filled → SAFE, booked once, released', async () => {
    const { ex, t } = await armOpen(487)
    // Flatten stays working on the first fresh read, then fills fully on the next (the ~0.5s FPS lag).
    broker.sellStepsOnce = [
      { status: 'open', filledQty: 0 },
      { status: 'filled', filledQty: 487, price: 10.1 },
    ]

    const res = await ex.shutdown()

    expect(res.safe).toBe(true)                       // fixed: settles within the bounded window
    expect(t.state).toBe('closed')
    expect(t.openQty).toBe(0)
    expect(t.exits.filter(l => l.fillPrice != null).reduce((s, l) => s + l.qty, 0)).toBe(487)  // booked exactly 487
    expect(t.realizedPnl).toBeTypeOf('number')        // finite realized P&L
    expect(Number.isFinite(t.realizedPnl!)).toBe(true)
    expect(closedEventsFor(t.id)).toHaveLength(1)      // exactly one trade_closed
    expect(t.closeCount).toBe(1)
    expect(broker.truthQty('TEST')).toBe(0)           // broker flat
    expect(existsSync(lockPath)).toBe(false)          // authority released
  })

  // A — immediate flatten fill → still SAFE
  it('A: flatten fills immediately → SAFE, released', async () => {
    const { ex, t } = await armOpen(487)              // no sellStepsOnce ⇒ flatten fills on first read
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  // B — flatten fills on the second settlement poll → SAFE, booked once
  it('B: flatten fills on the second settlement poll → SAFE, booked once, released', async () => {
    const { ex, t } = await armOpen(487)
    broker.sellStepsOnce = [
      { status: 'open', filledQty: 0 },               // flattenAll read
      { status: 'open', filledQty: 0 },               // settlement poll 0
      { status: 'filled', filledQty: 487, price: 10.1 }, // settlement poll 1
    ]
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(t.exits.reduce((s, l) => s + (l.fillPrice != null ? l.qty : 0), 0)).toBe(487)
    expect(closedEventsFor(t.id)).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  // C — flatten fills on the final allowed poll → SAFE
  it('C: flatten fills on the final allowed settlement poll → SAFE', async () => {
    const { ex, t } = await armOpen(487)
    // Reads: flattenAll(1) + settlement polls(POLLS). Fill on the very last allowed read.
    const steps: Array<{ status: 'open' | 'filled'; filledQty: number; price?: number }> = []
    for (let i = 0; i < POLLS; i++) steps.push({ status: 'open', filledQty: 0 })  // reads 1..POLLS stale
    steps.push({ status: 'filled', filledQty: 487, price: 10.1 })                 // read POLLS+1 = final poll
    broker.sellStepsOnce = steps
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(broker.truthQty('TEST')).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  // D — flatten never settles within budget → UNRESOLVED, authority retained
  it('D: flatten still working beyond the poll budget → UNRESOLVED, authority retained', async () => {
    const { ex, t } = await armOpen(487)
    broker.sellStepsOnce = Array.from({ length: POLLS + 4 }, () => ({ status: 'open' as const, filledQty: 0 }))
    const res = await ex.shutdown()
    expect(res.safe).toBe(false)
    expect(t.state).toBe('open')                      // still open, nothing fabricated
    expect(t.openQty).toBe(487)
    expect(broker.truthQty('TEST')).toBe(487)         // broker still holds
    expect(existsSync(lockPath)).toBe(true)           // marker RETAINED
    expect(ex.isExecutionAuthorized()).toBe(true)
  })

  // E — broker position read throws during settlement → UNRESOLVED, retained
  it('E: broker position read throws during settlement → UNRESOLVED, authority retained', async () => {
    const { ex } = await armOpen(487)
    // Flatten fills, but broker position truth is unreadable → never assume flat.
    broker.sellStepsOnce = [{ status: 'filled', filledQty: 487, price: 10.1 }]
    broker.failGetPosition.add('TEST')
    const res = await ex.shutdown()
    expect(res.safe).toBe(false)
    expect(existsSync(lockPath)).toBe(true)
    expect(ex.isExecutionAuthorized()).toBe(true)
  })

  // F — flatten partial fill, residual remains → partial booked once, NOT SAFE, residual explicit
  it('F: flatten partial-fills then residual remains → partial booked once, UNRESOLVED, residual explicit', async () => {
    const { ex, t } = await armOpen(487)
    broker.partialSellOnce = 200                      // flatten fills 200, stays working (287 held)
    const res = await ex.shutdown()
    expect(res.safe).toBe(false)                      // MUST NOT falsely SAFE
    const booked = t.exits.reduce((s, l) => s + (l.fillPrice != null ? l.qty : 0), 0)
    expect(booked).toBe(200)                          // partial booked exactly once
    expect(t.openQty).toBe(287)                       // residual exposure explicit
    expect(t.state).toBe('open')
    expect(broker.truthQty('TEST')).toBe(287)
    expect(existsSync(lockPath)).toBe(true)           // retained
  })

  // G — duplicate cumulative fill snapshots → no double P&L / qty / trade_closed
  it('G: repeated cumulative fill snapshots are booked once → SAFE, no duplicate accounting', async () => {
    const { ex, t } = await armOpen(487)
    broker.sellStepsOnce = [
      { status: 'open', filledQty: 0 },                       // flattenAll read
      { status: 'partially_filled', filledQty: 300, price: 10.1 }, // poll 0: books 300
      { status: 'partially_filled', filledQty: 300, price: 10.1 }, // poll 1: SAME cumulative → books 0
      { status: 'filled', filledQty: 487, price: 10.1 },           // poll 2: books remaining 187
    ]
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    const booked = t.exits.reduce((s, l) => s + (l.fillPrice != null ? l.qty : 0), 0)
    expect(booked).toBe(487)                          // 300 + 187, the repeated 300 never double-counts
    expect(t.openQty).toBe(0)
    expect(closedEventsFor(t.id)).toHaveLength(1)      // exactly one trade_closed
    expect(t.closeCount).toBe(1)
    expect(existsSync(lockPath)).toBe(false)
  })

  // H — broker flat while local still shows open → shutdown must RECONCILE local before SAFE,
  //     never declare SAFE with local exposure still open (hostile-review Q7).
  it('H: broker flat but local exit not yet booked → reconciled to flat BEFORE SAFE, never SAFE-with-open', async () => {
    const { ex, t } = await armOpen(487)
    // Broker truth reads flat even though the flatten order read never shows the fill. The
    // broker-truth-first reconcile must bring LOCAL to flat (here: force-flat → manual_review,
    // priced from broker fills) before shutdown may claim SAFE — it must never leave openQty>0.
    broker.seedPosition('TEST', 0)
    broker.sellStepsOnce = Array.from({ length: POLLS + 4 }, () => ({ status: 'open' as const, filledQty: 0 }))
    const res = await ex.shutdown()
    // The invariant under test: SAFE is impossible while local exposure is still open.
    if (res.safe) expect(t.openQty).toBe(0)
    expect(t.openQty).toBe(0)                          // local reconciled to broker-flat truth
    expect(t.state).toBe('closed')
    expect(res.safe).toBe(true)                        // reconciled consistently → SAFE, released
    expect(existsSync(lockPath)).toBe(false)
  })

  // ── Inter-poll settlement pacing (SHUTDOWN_SETTLEMENT_POLL_DELAY_MS) ──────────────────────
  // The delay is proven via an INJECTED sleep that records the interval and resolves immediately,
  // so timing is deterministic and no test actually waits on the wall clock.
  const buildDelayed = (sleep: (ms: number) => Promise<void>) => new PaperExecutor(
    broker,
    async (symbols: string[]) => new Map(symbols.map(s => [s, price])),
    { ...DEFAULT_EXECUTOR, authorityLockPath: lockPath, settlementPollDelayMs: SHUTDOWN_SETTLEMENT_POLL_DELAY_MS },
    () => {},
    sleep,
  )

  it('delay-1: first-poll success ⇒ NO wait (none before the first observation, none after success)', async () => {
    const waits: number[] = []
    const ex = buildDelayed(async ms => { waits.push(ms) })
    const { t } = await armOpen(487, ex)
    broker.sellStepsOnce = [
      { status: 'open', filledQty: 0 },                    // flattenAll read
      { status: 'filled', filledQty: 487, price: 10.1 },   // settlement poll 0 → settled
    ]
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(waits).toEqual([])                              // settled on the first poll → zero waits
  })

  it('delay-2: success on a later poll ⇒ waits only BETWEEN failed polls, none after success', async () => {
    const waits: number[] = []
    const ex = buildDelayed(async ms => { waits.push(ms) })
    const { t } = await armOpen(487, ex)
    broker.sellStepsOnce = [
      { status: 'open', filledQty: 0 },                    // flattenAll read
      { status: 'open', filledQty: 0 },                    // poll 0 fails → one wait
      { status: 'filled', filledQty: 487, price: 10.1 },   // poll 1 settles → no wait after
    ]
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(waits).toEqual([SHUTDOWN_SETTLEMENT_POLL_DELAY_MS])   // exactly one interval, at the constant
  })

  it('delay-3: fills on the FINAL allowed poll ⇒ SAFE, exactly POLLS−1 waits', async () => {
    const waits: number[] = []
    const ex = buildDelayed(async ms => { waits.push(ms) })
    const { t } = await armOpen(487, ex)
    const steps: Array<{ status: 'open' | 'filled'; filledQty: number; price?: number }> = []
    for (let i = 0; i < POLLS; i++) steps.push({ status: 'open', filledQty: 0 })   // reads 1..POLLS stale
    steps.push({ status: 'filled', filledQty: 487, price: 10.1 })                  // final poll fills
    broker.sellStepsOnce = steps
    const res = await ex.shutdown()
    expect(res.safe).toBe(true)
    expect(t.state).toBe('closed')
    expect(waits).toHaveLength(POLLS - 1)                        // 4 intervals, none after the final poll
    expect(waits.every(ms => ms === SHUTDOWN_SETTLEMENT_POLL_DELAY_MS)).toBe(true)
  })

  it('delay-4: budget exhausted ⇒ UNRESOLVED, exactly POLLS−1 waits, authority retained', async () => {
    const waits: number[] = []
    const ex = buildDelayed(async ms => { waits.push(ms) })
    const { t } = await armOpen(487, ex)
    broker.sellStepsOnce = Array.from({ length: POLLS + 4 }, () => ({ status: 'open' as const, filledQty: 0 }))
    const res = await ex.shutdown()
    expect(res.safe).toBe(false)
    expect(t.openQty).toBe(487)
    expect(waits).toHaveLength(POLLS - 1)                        // bounded: never after the final poll
    expect(existsSync(lockPath)).toBe(true)                      // authority NOT released while unresolved
    expect(ex.isExecutionAuthorized()).toBe(true)
  })

  it('delay-5: unreadable broker truth ⇒ UNRESOLVED, retained (pacing never weakens fail-closed)', async () => {
    const waits: number[] = []
    const ex = buildDelayed(async ms => { waits.push(ms) })
    await armOpen(487, ex)
    broker.sellStepsOnce = [{ status: 'filled', filledQty: 487, price: 10.1 }]   // flatten fills, but…
    broker.failGetPosition.add('TEST')                                           // …position truth unreadable
    const res = await ex.shutdown()
    expect(res.safe).toBe(false)
    expect(waits).toHaveLength(POLLS - 1)
    expect(existsSync(lockPath)).toBe(true)                      // no release while unresolved
    expect(ex.isExecutionAuthorized()).toBe(true)
  })
})
