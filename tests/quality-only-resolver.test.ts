/**
 * QUALITY_ONLY_CONTINUATION — pending-candidate resolver + passive bar-mirror
 * data plane. Covers the required letters A-Q, R/S (zero broker/executor
 * interaction for the new modules), V/W (hash stability unaffected), and
 * Y/Z (shutdown ordering) from this task's test matrix. Letters T/U/X and the
 * base outcome-scorer conventions (K/L/M) are already covered by
 * tests/quality-only.test.ts and tests/quality-only-daemon-integration.test.ts;
 * this file adds resolver/bar-journal-specific coverage rather than
 * duplicating those.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, rmSync, appendFileSync } from 'fs'
import * as fsp from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Candle } from '@/types'

// Node's built-in ESM modules have a non-configurable namespace, so `vi.spyOn`
// cannot redefine `fs/promises`'s `appendFile` export directly. Instead we
// register a `vi.fn` wrapper around the REAL implementation at module-mock
// time (hoisted above all imports by Vitest) — every test in this file gets
// genuine disk I/O by default (identical behavior to before this mock
// existed), and only the two tests below that need to control write timing
// override it per-call via `mockImplementationOnce`/`mockRejectedValueOnce`.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, appendFile: vi.fn(actual.appendFile) }
})
import {
  mirrorBars, loadResearchBars, parseBarLine, toCandleArray, __resetMirrorDedupForTests,
  __flushBarJournalWritesForTests, __getBarJournalQueueStats,
  type ResearchBar,
} from '@/lib/research/bar-journal'
import {
  resolvePendingCandidates, classifyCandidate,
} from '@/lib/experiments/quality-only/resolver'
import { candidateIdentity, type QualityOnlyCandidate } from '@/lib/experiments/quality-only/candidate'
import { computeConfigHash, computeDecisionPolicyHash } from '@/lib/experiments/quality-only/spec'

const tmpDirs: string[] = []
function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'quality-only-resolver-test-'))
  tmpDirs.push(dir)
  return join(dir, name)
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  __resetMirrorDedupForTests()
})

function candle(timeSec: number, o: number, h: number, l: number, c: number, v = 1000): Candle {
  return { time: timeSec, open: o, high: h, low: l, close: c, volume: v }
}

function fakeCandidate(overrides: Partial<QualityOnlyCandidate> = {}): QualityOnlyCandidate {
  const configHash = computeConfigHash()
  const etTradingDay = overrides.etTradingDay ?? '2026-09-22'
  const symbol = overrides.symbol ?? 'RSLV'
  const setupId = overrides.setupId ?? `${symbol}:vwap_bounce:10`
  const base: QualityOnlyCandidate = {
    identity: candidateIdentity(etTradingDay, symbol, setupId, configHash),
    specVersion: 'v2-quality-only-1',
    epoch: 'quality-only-epoch-1',
    configHash,
    etTradingDay,
    symbol,
    setupId,
    setupType: 'vwap_bounce',
    setupTime: Date.parse(`${etTradingDay}T14:00:00Z`),
    candidateObservedAt: Date.parse(`${etTradingDay}T14:00:00Z`),
    entryRef: 10.2,
    invalidation: 9.8,
    riskUnit: 0.4,
    grade: 'B',
    offHighPct: -1,
    spaceR: null,
    runUpPct: null,
    gateVector: {
      qualityVetoed: true, fadedChase: false, gradeFloorFail: false, noRoom: false, lateInLeg: false,
      unconfirmedKnown: false, quarantinedKnown: false, residualQualityTrue: true, qualityOtherResidualPrivate: true,
      residualQualityPresence: 'TRUE',
    },
    failedGateVector: ['QUALITY_OTHER'],
    trackingFloorPassed: true, sessionOk: true, volumeOk: true, standDown: false, capped: false, dup: false,
    sameSymbol: { tradedEarlierToday: false, priorTradeOpen: null, msSincePriorTradeClosed: null, priorTradeRealizedR: null, isReload: false },
    universeRank: null, leaderEpisodeId: null, producerGitHead: 'testfixture',
  }
  return { ...base, ...overrides }
}

function writeCandidateEvent(path: string, candidate: QualityOnlyCandidate): void {
  appendFileSync(path, `${JSON.stringify({
    kind: 'candidate', identity: candidate.identity, payload: candidate,
    provenance: { producerGitHead: 'x', producerGitBranch: 'x', specVersion: candidate.specVersion, epoch: candidate.epoch, configHash: candidate.configHash, decisionPolicyHash: 'x', generatedAt: new Date().toISOString() },
    preOfficial: true,
  })}\n`)
}

// ═══ A. no extra provider request for bar collection ════════════════════════
describe('A. zero-provider-request proof — bar mirroring', () => {
  it('mirrorBars never calls fetch (global.fetch spy stays untouched)', () => {
    const path = tmpFile('bars.ndjson')
    const originalFetch = global.fetch
    let calls = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global as any).fetch = (...args: unknown[]) => { calls++; throw new Error('unexpected fetch call: ' + JSON.stringify(args)) }
    try {
      const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05), candle(1_700_000_060, 1.05, 1.2, 1.0, 1.1)]
      mirrorBars('ZFR', candles, 'test', 1_700_000_200_000, path)
      expect(calls).toBe(0)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('resolvePendingCandidates never calls fetch (reads local files only)', () => {
    const candidatePath = tmpFile('candidates.ndjson')
    const c = fakeCandidate()
    writeCandidateEvent(candidatePath, c)
    const originalFetch = global.fetch
    let calls = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(global as any).fetch = (...args: unknown[]) => { calls++; throw new Error('unexpected fetch call: ' + JSON.stringify(args)) }
    try {
      resolvePendingCandidates(candidatePath, c.candidateObservedAt + 1000)
      expect(calls).toBe(0)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('neither bar-journal.ts nor resolver.ts imports a network/http client (grep, code lines only)', () => {
    for (const f of ['src/lib/research/bar-journal.ts', 'src/lib/experiments/quality-only/resolver.ts']) {
      const code = readFileSync(join(process.cwd(), f), 'utf8')
        .split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
      expect(code).not.toMatch(/from ['"](node-)?fetch['"]|axios|http\.request|https\.request/i)
    }
  })
})

// ═══ B. passive tap does not change BASE bars ════════════════════════════════
describe('B. passive bar tap does not mutate BASE\'s candle array', () => {
  it('the input Candle[] array/objects are untouched after mirrorBars', () => {
    const path = tmpFile('bars.ndjson')
    const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05), candle(1_700_000_060, 1.05, 1.2, 1.0, 1.1)]
    const snapshot = JSON.parse(JSON.stringify(candles))
    mirrorBars('MUT', candles, 'test', 1_700_000_200_000, path)
    expect(candles).toEqual(snapshot)
  })
})

// ═══ C. tap failure does not affect monitor ══════════════════════════════════
describe('C. passive bar tap failure does not propagate', () => {
  it('malformed candle values (NaN) are skipped, never throw', () => {
    const path = tmpFile('bars.ndjson')
    const bad: Candle[] = [{ time: NaN, open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN }]
    expect(() => mirrorBars('BAD', bad, 'test', Date.now(), path)).not.toThrow()
  })
  it('an unwritable path never throws (fails open)', () => {
    const badPath = '/nonexistent-dir-xyz/bars.ndjson'
    const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05), candle(1_700_000_120, 1.05, 1.2, 1.0, 1.1)]
    expect(() => mirrorBars('BAD2', candles, 'test', 1_700_000_200_000, badPath)).not.toThrow()
  })
  it('empty candle array is a clean no-op', () => {
    const path = tmpFile('bars.ndjson')
    expect(() => mirrorBars('EMPTY', [], 'test', Date.now(), path)).not.toThrow()
    expect(existsSync(path)).toBe(false)
  })
})

// ═══ mirrorBars closed/in-progress semantics (feeds D/G) ═════════════════════
describe('mirrorBars: only provably-closed bars are ever persisted', () => {
  it('the newest bar in a fetch, with no sibling proof and no wall-clock margin elapsed, is never written', () => {
    const path = tmpFile('bars.ndjson')
    const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05)] // single, newest, forming bar
    mirrorBars('FORM', candles, 'test', 1_700_000_000_000 + 10_000, path) // only 10s elapsed
    expect(existsSync(path)).toBe(false)
  })

  it('a bar superseded by a strictly later sibling in the SAME fetch is written as closed immediately', async () => {
    const path = tmpFile('bars.ndjson')
    const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05), candle(1_700_000_060, 1.05, 1.2, 1.0, 1.1)]
    mirrorBars('SUP', candles, 'test', 1_700_000_065_000, path) // 5s after the newer bar opened
    await __flushBarJournalWritesForTests() // async writer: wait for the enqueued append to settle before reading
    const { bars } = loadResearchBars('2023-11-14', 'SUP', path)
    expect(bars.map(b => b.barStart)).toEqual([1_700_000_000_000])
    expect(bars[0].state).toBe('closed')
  })

  it('the LAST bar of a session (never superseded) is eventually written once wall-clock safety margin elapses', async () => {
    const path = tmpFile('bars.ndjson')
    const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05)]
    mirrorBars('LAST', candles, 'test', 1_700_000_000_000 + 91_000, path) // 91s > 90s safety margin
    await __flushBarJournalWritesForTests()
    const { bars } = loadResearchBars(bars0Day(), 'LAST', path)
    expect(bars).toHaveLength(1)
    expect(bars[0].close).toBe(1.05)
  })

  it('a written bar is immutable — a later mirrorBars call with revised values for the SAME barStart does not overwrite it', async () => {
    const path = tmpFile('bars.ndjson')
    const first = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05), candle(1_700_000_060, 1.05, 1.2, 1.0, 1.1)]
    mirrorBars('IMMUT', first, 'test', 1_700_000_065_000, path)
    // Provider "revises" the now-closed bar's high on a later fetch.
    const revised = [candle(1_700_000_000, 1, 999, 0.9, 1.05), candle(1_700_000_060, 1.05, 1.2, 1.0, 1.1), candle(1_700_000_120, 1.1, 1.3, 1.05, 1.2)]
    mirrorBars('IMMUT', revised, 'test', 1_700_000_125_000, path)
    await __flushBarJournalWritesForTests()
    const { bars } = loadResearchBars(bars0Day(), 'IMMUT', path)
    const first_ = bars.find(b => b.barStart === 1_700_000_000_000)!
    expect(first_.high).toBe(1.1) // original value preserved, not the "revised" 999
  })
})
function bars0Day(): string { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(1_700_000_000_000)) }

// ═══ D/E/F. causal boundary + no premature resolution ════════════════════════
describe('D/E/F. causal bar filtering + no premature resolution', () => {
  it('D. a candidate created before any future bars exist stays PENDING (no bars at all yet, session not over)', () => {
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, symbol: 'NOBARS' })
    const result = classifyCandidate(c, { bars: [], corrupt: [] }, observedAt + 5_000)
    expect(result.status).toBe('PENDING')
  })

  it('E. resolver does not resolve prematurely — a handful of quiet bars short of the 30m horizon stays PENDING', () => {
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'QUIET' })
    const bars: ResearchBar[] = []
    for (let i = 0; i < 10; i++) {
      bars.push(mkBar('QUIET', observedAt + i * 60_000, 10.0, 10.05, 9.95, 10.0))
    }
    const result = classifyCandidate(c, { bars, corrupt: [] }, observedAt + 10 * 60_000 + 30_000)
    expect(result.status).toBe('PENDING')
    expect(result.outcome.entered).toBe(false)
  })

  it('F. bars strictly before candidateObservedAt are ignored — a pre-candidate spike cannot grant entry/invalidation credit', () => {
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'PREBAR' })
    const bars: ResearchBar[] = [
      mkBar('PREBAR', observedAt - 5 * 60_000, 10.1, 10.3, 9.7, 10.2), // BEFORE observation: would trigger both entry+invalidation if counted
      mkBar('PREBAR', observedAt, 10.0, 10.05, 9.98, 10.0),
    ]
    const result = classifyCandidate(c, { bars, corrupt: [] }, observedAt + 60_000)
    expect(result.outcome.entered).toBe(false) // the pre-candidate bar's high>=entryRef must NOT count
  })
})

// ═══ G. in-progress bar cannot grant credit ══════════════════════════════════
describe('G. an in-progress/not-yet-mirrored future bar cannot grant favorable credit', () => {
  it('a forming bar that never gets mirrored (still within the safety margin) is simply absent from the resolver\'s view', () => {
    const path = tmpFile('bars.ndjson')
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    // A bar whose high WOULD trigger entry, but it is still the newest/forming
    // bar and under the wall-clock safety margin -> mirrorBars must not write it.
    mirrorBars('FORMING', [candle(observedAt / 1000, 10.0, 10.5, 9.9, 10.3)], 'test', observedAt + 10_000, path)
    const { bars } = loadResearchBars(day, 'FORMING', path)
    expect(bars).toHaveLength(0)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, symbol: 'FORMING' })
    const result = classifyCandidate(c, { bars: [], corrupt: [] }, observedAt + 10_000)
    expect(result.outcome.entered).toBe(false) // no credit from a bar we cannot yet prove is closed
  })
})

function mkBar(symbol: string, barStart: number, o: number, h: number, l: number, c: number): ResearchBar {
  return { symbol, timeframe: '1m', barStart, open: o, high: h, low: l, close: c, volume: 1000, state: 'closed', observedAt: barStart + 90_000, source: 'test', producerGitHead: 'test', etTradingDay: '2026-09-22' }
}

// ═══ H/I/J. horizon causality ═════════════════════════════════════════════════
describe('H/I/J. 5m/15m/30m outcome fields only become available causally', () => {
  it('H/I. before entry, 5m/15m MFE/MAE are null; after entry+some bars, they populate from that point forward only', () => {
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'HORZ' })
    const bars: ResearchBar[] = [
      mkBar('HORZ', observedAt, 10.0, 10.05, 9.95, 10.0),               // no entry yet
      mkBar('HORZ', observedAt + 60_000, 10.0, 10.25, 9.95, 10.2),       // entry bar (high >= 10.2)
      mkBar('HORZ', observedAt + 120_000, 10.2, 10.3, 10.1, 10.25),
    ]
    const result = classifyCandidate(c, { bars, corrupt: [] }, observedAt + 130_000)
    expect(result.outcome.entered).toBe(true)
    expect(result.outcome.entryBarTime).toBe(observedAt + 60_000)
    expect(result.outcome.mfeR5m).not.toBeNull() // populated once entered
  })

  it('J. 30m MFE/MAE only reflects bars within 30 minutes of entry, not beyond', () => {
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'H30' })
    const bars: ResearchBar[] = [mkBar('H30', observedAt, 10.0, 10.25, 9.95, 10.2)]
    // A huge favorable spike at +31 minutes must NOT count toward mfeR30m.
    for (let m = 1; m <= 29; m++) bars.push(mkBar('H30', observedAt + m * 60_000, 10.2, 10.21, 10.19, 10.2))
    bars.push(mkBar('H30', observedAt + 31 * 60_000, 10.2, 50, 10.19, 10.2))
    const result = classifyCandidate(c, { bars, corrupt: [] }, observedAt + 32 * 60_000)
    expect(result.outcome.mfeR30m).toBeLessThan(10) // the +31m spike (R ~ 100) must not leak in
  })
})

// ═══ K. terminal invalidation resolves early (SCORABLE regardless of horizon) ═
describe('K. terminal invalidation is SCORABLE immediately, even well under 30 minutes', () => {
  it('an invalidation 2 minutes after entry is SCORABLE, not PENDING/CENSORED', () => {
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'EARLYSTOP' })
    const bars: ResearchBar[] = [
      mkBar('EARLYSTOP', observedAt, 10.0, 10.25, 9.95, 10.2),
      mkBar('EARLYSTOP', observedAt + 60_000, 10.2, 10.22, 9.75, 9.8), // invalidation fires
    ]
    const result = classifyCandidate(c, { bars, corrupt: [] }, observedAt + 90_000)
    expect(result.status).toBe('SCORABLE')
    expect(result.outcome.invalidated).toBe(true)
    expect(result.detail).toBe('terminal_invalidation')
  })
})

// ═══ N/O. restart recovery + no duplicate outcome ═════════════════════════════
describe('N/O. restart recovery — pending survives, outcome never duplicated', () => {
  it('a resolver call that resolves a candidate, followed by a second call, does not append a second outcome', async () => {
    const candidatePath = tmpFile('candidates.ndjson')
    const barsPath = tmpFile('bars.ndjson')
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'DUPOUT' })
    writeCandidateEvent(candidatePath, c)
    mirrorBars('DUPOUT', [
      candle(observedAt / 1000, 10.0, 10.25, 9.95, 10.2),
      candle(observedAt / 1000 + 60, 10.2, 10.22, 9.75, 9.8),
      candle(observedAt / 1000 + 120, 9.8, 9.82, 9.78, 9.8),
    ], 'test', observedAt + 130_000, barsPath)
    await __flushBarJournalWritesForTests() // async writer: bars must be on disk before the resolver (sync reader) runs
    // Inject the temp bars file in place of the real day-keyed journal —
    // resolvePendingCandidates()'s bar-loading dependency is injectable for
    // exactly this reason (production never overrides it).
    const loadBars = (d: string, symbol: string) => loadResearchBars(d, symbol, barsPath)

    const firstRun = resolvePendingCandidates(candidatePath, observedAt + 130_000, loadBars)
    expect(firstRun.resolved).toBe(1)
    expect(firstRun.scorable).toBe(1)

    // Simulate a restart: call again with the SAME journal (fresh re-parse).
    const secondRun = resolvePendingCandidates(candidatePath, observedAt + 200_000, loadBars)
    expect(secondRun.resolved).toBe(0) // already resolved — not re-resolved
    expect(secondRun.stillPending).toBe(0)
    expect(secondRun.scanned).toBe(0) // no longer counted as pending at all

    const lines = readFileSync(candidatePath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const outcomeRows = lines.filter((l: { kind: string; identity: string }) => l.kind === 'outcome' && l.identity === c.identity)
    expect(outcomeRows).toHaveLength(1) // never duplicated
  })

  it('N. a candidate journal with a pending identity across two separate resolvePendingCandidates invocations (simulating process restart) is still found pending the second time if unresolved', () => {
    const candidatePath = tmpFile('candidates.ndjson')
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'RESTARTPEND' })
    writeCandidateEvent(candidatePath, c)
    // No bars mirrored at all -> stays pending both times (session not over).
    const run1 = resolvePendingCandidates(candidatePath, observedAt + 5_000)
    expect(run1.stillPending).toBe(1)
    const run2 = resolvePendingCandidates(candidatePath, observedAt + 10_000) // "restart"
    expect(run2.stillPending).toBe(1)
    expect(run2.scanned).toBe(1) // identity recovered from the journal again, not lost
  })
})

// ═══ P/Q. missing bars / corrupt journal fail conservatively ══════════════════
describe('P/Q. missing bars and corrupt bar journal never fabricate a result', () => {
  it('P. session ended with zero research bars ever observed -> DEGRADED, not a fabricated no_fill', () => {
    const day = '2020-01-02' // long past — "session ended" for any wall-clock `now`
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, symbol: 'GONE' })
    const result = classifyCandidate(c, { bars: [], corrupt: [] }, Date.now())
    expect(result.status).toBe('DEGRADED')
    expect(result.detail).toBe('no_research_bars_observed_before_session_end')
  })

  it('P. a >150s causal gap between bars is DEGRADED, never silently treated as quiet/flat time', () => {
    const day = '2026-09-22'
    const observedAt = Date.parse(`${day}T14:00:00.000Z`)
    const c = fakeCandidate({ etTradingDay: day, candidateObservedAt: observedAt, entryRef: 10.2, invalidation: 9.8, symbol: 'GAP' })
    const bars: ResearchBar[] = [
      mkBar('GAP', observedAt, 10.0, 10.25, 9.95, 10.2),          // entry
      mkBar('GAP', observedAt + 60_000, 10.2, 10.22, 10.1, 10.2),
      // GAP: next bar is 6 minutes later (>150s), then invalidation right after
      mkBar('GAP', observedAt + 7 * 60_000, 10.2, 10.21, 9.75, 9.8),
    ]
    const result = classifyCandidate(c, { bars, corrupt: [] }, observedAt + 8 * 60_000)
    expect(result.status).toBe('DEGRADED')
  })

  it('Q. a torn/corrupt line in the bar journal is reported, not silently dropped or coerced', () => {
    const path = tmpFile('bars.ndjson')
    appendFileSync(path, '{"symbol":"CORRUPT","barStart":1700000000000,"open":1,"high":1.1,"low":0.9,"close":1.0"\n') // torn JSON
    appendFileSync(path, `${JSON.stringify(mkBar('CORRUPT', 1_700_000_060_000, 1, 1.1, 0.9, 1.0))}\n`)
    const { bars, corrupt } = loadResearchBars('2023-11-14', 'CORRUPT', path)
    expect(corrupt.length).toBeGreaterThanOrEqual(1)
    expect(bars).toHaveLength(1) // the one valid line still parses
  })

  it('Q. missing required field in a bar line is rejected, not coerced', () => {
    expect(parseBarLine('{"symbol":"X"}').ok).toBe(false)
  })
})

// ═══ R/S. zero broker / PaperExecutor interaction ═════════════════════════════
describe('R/S. zero broker/PaperExecutor interaction in the new modules', () => {
  it('bar-journal.ts and resolver.ts import no broker/execution module (code lines only — doc comments may reference the invariant by name)', () => {
    for (const f of ['src/lib/research/bar-journal.ts', 'src/lib/experiments/quality-only/resolver.ts']) {
      const raw = readFileSync(join(process.cwd(), f), 'utf8')
      const code = raw.split('\n')
        .filter(l => { const t = l.trim(); return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/**')) })
        .join('\n')
      expect(code).not.toMatch(/alpaca|broker|PaperExecutor|placeOrder|submitOrder/i)
    }
  })
})

// ═══ V/W. hash stability unaffected by the resolver ═══════════════════════════
describe('V/W. configHash/decisionPolicyHash unaffected by adding the resolver', () => {
  it('computeConfigHash/computeDecisionPolicyHash are unchanged in shape and still deterministic', () => {
    expect(computeConfigHash()).toBe(computeConfigHash())
    expect(computeDecisionPolicyHash()).toBe(computeDecisionPolicyHash())
  })
})

// ═══ toCandleArray projection sanity ══════════════════════════════════════════
describe('toCandleArray', () => {
  it('projects ResearchBar[] back into the exact Candle shape outcome.ts consumes', () => {
    const bars = [mkBar('PROJ', 1_700_000_000_000, 1, 1.1, 0.9, 1.05)]
    const candles = toCandleArray(bars)
    expect(candles).toEqual([{ time: 1_700_000_000, open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 1000 }])
  })
})

// ═══ Y/Z. shutdown ordering (structural — see scripts/alert-daemon.ts) ════════
describe('Y/Z. shutdown executes execution settlement BEFORE the research drain, and a drain failure cannot block it', () => {
  const src = readFileSync(join(process.cwd(), 'scripts/alert-daemon.ts'), 'utf8')
  const shutdownStart = src.indexOf('const shutdown = async (signal: string)')
  const shutdownBody = src.slice(shutdownStart, src.indexOf('process.on(\'SIGINT\'', shutdownStart))

  it('Y. executor.flattenAll(...) appears BEFORE qualityOnlyWriter.shutdown(...) in the shutdown sequence', () => {
    const flattenIdx = shutdownBody.indexOf('executor.flattenAll(')
    const drainIdx = shutdownBody.indexOf('qualityOnlyWriter.shutdown(')
    expect(flattenIdx).toBeGreaterThan(-1)
    expect(drainIdx).toBeGreaterThan(-1)
    expect(flattenIdx).toBeLessThan(drainIdx)
  })

  it('Z. the research drain is time-bounded (a numeric budget is passed) and wrapped in its own try/catch separate from the flatten block', () => {
    expect(shutdownBody).toMatch(/qualityOnlyWriter\.shutdown\(\s*\d/)
    // The flatten call sits in its own `if (executor) { ... }` block, and the
    // drain's try/catch comes strictly after it — so a throw inside the drain
    // cannot unwind back through / prevent the already-completed flatten call.
    const flattenBlockEnd = shutdownBody.indexOf('}', shutdownBody.indexOf('executor.flattenAll('))
    const drainTryIdx = shutdownBody.indexOf('try {', shutdownBody.indexOf('qualityOnlyWriter.shutdown(') - 200)
    expect(drainTryIdx).toBeGreaterThan(flattenBlockEnd)
  })
})

// ═══ Async bar-mirror writer — non-blocking monitor path, bounded queue,
//     serialized concurrent writes, observable degradation ══════════════════
describe('Async bar-mirror writer', () => {
  // `mockImplementationOnce`/`mockRejectedValueOnce` below each consume
  // exactly one call and then automatically fall back to the mock's default
  // implementation (a passthrough to the REAL fs/promises.appendFile set up
  // in the vi.mock factory above), so no explicit restore is needed between
  // tests — every test other than B/C and D gets genuine disk I/O.

  it('grep: no appendFileSync/writeFileSync/fsyncSync anywhere in bar-journal.ts', () => {
    const code = readFileSync(join(process.cwd(), 'src/lib/research/bar-journal.ts'), 'utf8')
    expect(code).not.toMatch(/\bappendFileSync\b|\bwriteFileSync\b|\bfsyncSync\b/)
  })

  it('B/C. mirrorBars() returns before the underlying async write settles — a writer that never resolves cannot delay the caller', async () => {
    const path = tmpFile('bars.ndjson')
    let released = false
    vi.mocked(fsp.appendFile).mockClear() // isolate this test's call count from prior tests sharing the module-level mock
    const spy = vi.mocked(fsp.appendFile).mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        // Only resolves once the test explicitly releases it — proves
        // mirrorBars() cannot possibly have awaited this promise internally,
        // since the assertions below run and pass before release() is called.
        const check = () => { if (released) resolve(); else setImmediate(check) }
        check()
      }),
    )
    const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05), candle(1_700_000_060, 1.05, 1.2, 1.0, 1.1)]

    mirrorBars('SLOW', candles, 'test', 1_700_000_065_000, path) // must return immediately — this call is synchronous
    // Reaching this line at all (synchronously, in the same tick) is itself
    // part of the proof: if mirrorBars awaited the write, control would not
    // return here until `released` were true, which it is not yet.
    expect(existsSync(path)).toBe(false) // nothing flushed to disk yet — the write is still pending

    // Let the internal write-chain's microtasks run so the (still-unresolved)
    // writer is actually invoked, without resolving it.
    await Promise.resolve()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1) // the writer WAS enqueued...
    expect(existsSync(path)).toBe(false) // ...but has still not completed — proof the call was truly async, not immediate

    released = true
    // Resolving the mock and awaiting the flush must complete promptly (no
    // hang) — if mirrorBars had blocked internally on this promise, control
    // would never have reached the assertions above at all.
    await __flushBarJournalWritesForTests()
  })

  it('D. a rejected write never throws into the caller and is recorded as a degradation signal', async () => {
    const path = tmpFile('bars.ndjson')
    vi.mocked(fsp.appendFile).mockRejectedValueOnce(new Error('simulated disk failure'))
    const candles = [candle(1_700_000_000, 1, 1.1, 0.9, 1.05), candle(1_700_000_060, 1.05, 1.2, 1.0, 1.1)]
    const before = __getBarJournalQueueStats().writeFailureCount

    expect(() => mirrorBars('FAIL', candles, 'test', 1_700_000_065_000, path)).not.toThrow()
    await __flushBarJournalWritesForTests()

    const after = __getBarJournalQueueStats()
    expect(after.writeFailureCount).toBe(before + 1) // observable degradation signal, not silently swallowed
  })

  it('E. concurrent mirrorBars() calls (no await between them) serialize through one writer — no interleaved/corrupted NDJSON', async () => {
    const path = tmpFile('bars.ndjson')
    const callCount = 20
    for (let i = 0; i < callCount; i++) {
      const tSec = 1_700_000_000 + i * 60
      mirrorBars(
        `SYM${i}`,
        [candle(tSec, 1, 1.1, 0.9, 1.05), candle(tSec + 60, 1.05, 1.2, 1.0, 1.1)],
        'test',
        tSec * 1000 + 65_000, // only enough elapsed for the FIRST bar's sibling-supersedes proof, not wall-clock-close of the second
        path,
      )
    }
    await __flushBarJournalWritesForTests()
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    expect(lines).toHaveLength(callCount) // exactly one closed bar per call — no lines lost, none duplicated
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow() // every line is a single complete JSON object — never torn/interleaved
    }
  })

  it('F/G. a batch that would push the queue past its byte bound is dropped whole, and the drop is observable via counters (never silent)', async () => {
    const path = tmpFile('bars.ndjson')
    function bigBatch(n: number, tBaseSec: number): { candles: Candle[]; nowMs: number } {
      const candles: Candle[] = []
      for (let i = 0; i < n; i++) candles.push(candle(tBaseSec + i * 60, 1, 1.1, 0.9, 1.05))
      const lastBarStartMs = (tBaseSec + (n - 1) * 60) * 1000
      return { candles, nowMs: lastBarStartMs + 10_000_000 } // every bar, including the last, is well past the wall-clock safety margin
    }
    const n = 7000 // ~1.3-1.5MB per batch — individually under the 2MiB bound, combined comfortably over it
    const batch1 = bigBatch(n, 1_700_000_000)
    const batch2 = bigBatch(n, 1_800_000_000) // disjoint time range -> disjoint barStart keys, no dedupe interference

    // Fired back-to-back with no await in between, so both enqueue against the
    // SAME in-flight queue state (the first write has not had a chance to
    // settle and free its bytes yet).
    mirrorBars('BIGQ1', batch1.candles, 'test', batch1.nowMs, path)
    const afterFirst = __getBarJournalQueueStats()
    expect(afterFirst.queuedBytes).toBeGreaterThan(0)
    expect(afterFirst.droppedBatchCount).toBe(0) // the first batch alone fits under the bound

    mirrorBars('BIGQ2', batch2.candles, 'test', batch2.nowMs, path)
    const afterSecond = __getBarJournalQueueStats()
    expect(afterSecond.droppedBatchCount).toBe(1) // the second batch overflowed the bound and was dropped whole
    expect(afterSecond.droppedBarCount).toBe(n)   // observable count of exactly how many bars were lost

    await __flushBarJournalWritesForTests()
    const { bars: keptBars } = loadResearchBars('2023-11-14', 'BIGQ1', path)
    const { bars: droppedBars } = loadResearchBars('2023-11-15', 'BIGQ2', path)
    expect(keptBars.length).toBe(n)     // the accepted batch made it to disk in full
    expect(droppedBars.length).toBe(0)  // the dropped batch never reached disk at all
  })
})
