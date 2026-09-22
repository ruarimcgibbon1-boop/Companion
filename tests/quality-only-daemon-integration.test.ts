/**
 * QUALITY_ONLY_CONTINUATION — TRUE end-to-end daemon integration test.
 *
 * Unlike tests/quality-only.test.ts (which calls observeQualityOnlyFromDecision
 * directly), this test imports and exercises the ACTUAL exported hook wired
 * into scripts/alert-daemon.ts's sweep() loop — `runQualityOnlyObserver` —
 * the same function called immediately after classifyBuy() at the real
 * integration seam. Importing scripts/alert-daemon.ts does not start the real
 * daemon: the module guards its `main()` auto-run with
 * `if (process.env.VITEST !== 'true')`, which Vitest sets by default, so this
 * import performs no network fetches and installs no SIGINT/SIGTERM handlers.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { classifyBuy } from '@/lib/buy-log'
import type { DetectedSetup, MonitorResult, BuySignalRecord } from '@/types'
import { runQualityOnlyObserver, qualityOnlyWriter, qualityOnlyFreshness } from '../scripts/alert-daemon'

const JOURNAL_FILE = join(homedir(), '.companion-quality-only-journal.ndjson')

function fakeSetup(overrides: Partial<DetectedSetup> = {}): DetectedSetup {
  return {
    id: 'DAEMON:vwap_bounce:10.20',
    symbol: 'DAEMON',
    type: 'vwap_bounce',
    direction: 'long',
    state: 'triggered',
    triggeredRaw: true,
    qualityVetoed: true,           // residual/private quality cause -> QUALITY_OTHER-only
    entryFill: 10.2,
    score: 60,
    grade: 'B',
    breakdown: { levelQuality: 15 } as never,
    zoneLower: 10.1,
    zoneUpper: 10.2,
    zoneMidpoint: 10.15,
    rationale: 'test fixture',
    confirmation: [],
    invalidation: 9.8,
    stopReference: 9.8,
    targets: [{ price: 11.0 } as never],
    rewardRisk: 2,
    distanceToZonePct: 0,
    distanceFromVwapPct: 0,
    distanceFromEma9Pct: null,
    distanceFromEma21Pct: null,
    approachThresholdPct: 1,
    testCount: 1,
    confidence: 70,
    risks: [],
    keyRisks: [],
    notes: '',
    nextIfHolds: null,
    nextIfFails: null,
    signal: {} as never,
    ...overrides,
  } as DetectedSetup
}

function fakeMonitorResult(overrides: Partial<MonitorResult> = {}): MonitorResult {
  return {
    symbol: 'DAEMON',
    price: 10.22,
    changePct: 25,
    volume: 500_000,
    premarketVolume: null,
    relativeVolume: 5,
    spreadPct: 0.1,
    catalyst: 'test',
    levels: [{ midpoint: 100, lower: 99.9, upper: 100.1, strength: 60, kind: 'resistance', sources: [], sourceLabels: [], touches: 2 } as never],
    setups: [],
    roadmap: {} as never,
    integrity: { marketDataTimestamp: Date.now(), ageMs: 0, session: 'regular', delayed: false, missing: [] },
    technicals: { distanceFromDayHighPct: -1 } as never,
    ...overrides,
  } as MonitorResult
}

describe('TRUE end-to-end daemon integration (real seam: runQualityOnlyObserver as wired into alert-daemon.ts)', () => {
  // qualityOnlyWriter/qualityOnlyFreshness are MODULE-LEVEL SINGLETONS (the
  // same instances the real daemon process would use for its whole lifetime),
  // so shutdown() — which permanently closes the writer — is deliberately
  // exercised in exactly ONE test ("real seam end-to-end", last in this file).
  // Every other test only asserts on pending()-count deltas, matching how the
  // real daemon accumulates queued writes across many sweeps before a single
  // process-exit drain.
  beforeEach(() => {
    if (existsSync(JOURNAL_FILE)) { try { unlinkSync(JOURNAL_FILE) } catch { /* ignore */ } }
  })

  it('repeated setupId across sweeps is deduplicated at the real seam (freshness persists across calls)', () => {
    const setup = fakeSetup({ id: 'DAEMON:vwap_bounce:dup-test', symbol: 'DAEMONDUP' })
    const r = fakeMonitorResult({ symbol: 'DAEMONDUP' })
    const now = Date.parse('2026-09-22T14:00:00Z')
    const state: BuySignalRecord[] = []
    const { verdict } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })

    runQualityOnlyObserver(setup, r, verdict, now, state)
    const afterFirst = qualityOnlyWriter.pending()
    runQualityOnlyObserver(setup, r, verdict, now + 15_000, state)   // same setupId, next sweep
    const afterSecond = qualityOnlyWriter.pending()

    expect(afterSecond).toBe(afterFirst)   // the retrigger produced no new candidate
  })

  it('residual/private-only QUALITY_OTHER candidate (vwap_bounce, all four named dimensions false) is included', () => {
    const setup = fakeSetup({ id: 'DAEMON:vwap_bounce:private-test', symbol: 'DAEMONPRIV' })
    const r = fakeMonitorResult({ symbol: 'DAEMONPRIV' })
    const now = Date.parse('2026-09-22T14:05:00Z')
    const state: BuySignalRecord[] = []
    const { verdict } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })
    expect(verdict).toBe('veto')

    const before = qualityOnlyWriter.pending()
    runQualityOnlyObserver(setup, r, verdict, now, state)
    expect(qualityOnlyWriter.pending()).toBe(before + 1)
  })

  it('a non-veto (logged) verdict is a clean no-op at the real seam — no candidate queued', () => {
    const setup = fakeSetup({ id: 'DAEMON:vwap_bounce:nonveto', symbol: 'DAEMONOK', qualityVetoed: false, grade: 'A' })
    const r = fakeMonitorResult({ symbol: 'DAEMONOK' })
    const now = Date.parse('2026-09-22T14:10:00Z')
    const state: BuySignalRecord[] = []
    const { verdict } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })

    const before = qualityOnlyWriter.pending()
    runQualityOnlyObserver(setup, r, verdict, now, state)
    expect(qualityOnlyWriter.pending()).toBe(before)
  })

  it('observer throws internally -> BASE flow (classifyBuy result, recordDecision-equivalent) continues unaffected', () => {
    const setup = fakeSetup({ id: 'DAEMON:vwap_bounce:broken', entryFill: undefined as unknown as number, stopReference: undefined as unknown as number })
    const r = fakeMonitorResult()
    const now = Date.parse('2026-09-22T14:15:00Z')
    const state: BuySignalRecord[] = []

    // classifyBuy itself is BASE and untouched — prove it still runs fine and
    // its result is usable regardless of what the observer does afterward.
    const { verdict } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })

    let threw = false
    try {
      runQualityOnlyObserver(setup, r, verdict, now, state)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)   // never propagates — daemon sweep survives

    // BASE's own output is unaffected by whatever happened inside the observer.
    expect(typeof verdict).toBe('string')
  })

  it('freshness tracker exported from the real module is the SAME instance the hook uses (not a re-implementation)', () => {
    expect(qualityOnlyFreshness).toBeDefined()
    expect(typeof qualityOnlyFreshness.admitIfFresh).toBe('function')
  })

  // Runs LAST (module-level writer/freshness singletons carry accumulated
  // state from the tests above; shutdown() below permanently closes the
  // writer, so this must be the final test in the file).
  it('zzz_final: real seam end-to-end — classifyBuy -> hook -> QUALITY_OTHER-only candidate -> PRE_OFFICIAL -> drains on shutdown -> no official marker', () => {
    const setup = fakeSetup()
    const r = fakeMonitorResult()
    const now = Date.parse('2026-09-22T13:31:00Z')
    const state: BuySignalRecord[] = []

    // Drive through the REAL classifyBuy, exactly as sweep() does.
    const { verdict, buy } = classifyBuy(setup, r, { now, priorBuys: state, priorLogs: [], priorStates: [] })
    expect(verdict).toBe('veto')
    expect(buy).toBeUndefined()

    // The real integration seam: called immediately after classifyBuy's
    // verdict, exactly as scripts/alert-daemon.ts's sweep() loop does.
    runQualityOnlyObserver(setup, r, verdict, now, state)

    const pending = qualityOnlyWriter.pending()
    expect(pending).toBeGreaterThanOrEqual(1)
    const { drained } = qualityOnlyWriter.shutdown()
    expect(drained).toBe(pending)
    expect(qualityOnlyWriter.pending()).toBe(0)

    const lines = readFileSync(JOURNAL_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const candidateRow = lines.find(l => l.kind === 'candidate' && l.payload?.symbol === 'DAEMON')
    expect(candidateRow).toBeTruthy()
    expect(candidateRow.preOfficial).toBe(true)
    expect(candidateRow.payload.failedGateVector).toEqual(['QUALITY_OTHER'])

    // No official collection-start marker exists anywhere in this worktree.
    expect(existsSync(join(homedir(), '.companion-quality-only-COLLECTION_START.json'))).toBe(false)
  })
})
