/**
 * PROSPECTIVE_DISCOVERY_CAPTURE — universe-journal.ts coverage.
 *
 * Everything here exercises the PURE functions in
 * src/lib/research/universe-journal.ts with synthetic route/daemon/monitor
 * inputs (matching the real shapes fetchUniverse()/sweep() would build) — no
 * network fetch, no real daemon process, no dependency on a running Next
 * server. Grep-based tests at the bottom cover: zero new fetch/provider
 * calls, no broker/execution import, and no QUALITY_ONLY file interaction.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, rmSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildSweepRecords, attachSetupDecision, appendSweepBatch,
  parseUniverseLine, loadUniverseJournal, sweepCompleteness, deriveUniverseDayState,
  universeJournalPath, __setGitProvenanceForTests,
  type RouteUniverseRow,
} from '@/lib/research/universe-journal'

__setGitProvenanceForTests('test-head', 'test-branch')

const tmpDirs: string[] = []
function tmpJournalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'universe-journal-test-'))
  tmpDirs.push(dir)
  return join(dir, 'journal.ndjson')
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function route(symbol: string, overrides: Partial<RouteUniverseRow> = {}): RouteUniverseRow {
  return {
    symbol, routeRank: 1, routeMomentumScore: 100, changePct: 10, price: 5, volume: 1_000_000, relativeVolume: 3,
    ...overrides,
  }
}

describe('buildSweepRecords — route/daemon/monitor layers', () => {
  it('(1) a route row is retained even when the daemon top-15 drops it', () => {
    const routeRows = [route('KEPT', { routeRank: 1 }), route('DROPPED', { routeRank: 20 })]
    const { recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: 900, routeRows,
      daemonSymbols: ['KEPT'], daemonTopN: 1,
      monitorRequestedSymbols: ['KEPT'], monitorResultSymbols: ['KEPT'],
    })
    expect(recordsBySymbol.has('DROPPED')).toBe(true)
    const dropped = recordsBySymbol.get('DROPPED')!
    expect(dropped.inDaemonExecutionUniverse).toBe(false)
    expect(dropped.daemonRank).toBeNull()
    expect(dropped.baseDecision).toBe('UNAVAILABLE')
    expect(dropped.reasonUnavailable).toBe(true)
  })

  it('(2) routeRank and daemonRank can legitimately differ for the same symbol/sweep', () => {
    const routeRows = [route('A', { routeRank: 5 }), route('B', { routeRank: 1 })]
    // Daemon re-sorts independently of route rank — B ends up daemon-ranked
    // behind A here on purpose, to prove the two ranks are tracked separately.
    const { recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: null, routeRows,
      daemonSymbols: ['A', 'B'], daemonTopN: 15,
      monitorRequestedSymbols: ['A', 'B'], monitorResultSymbols: ['A', 'B'],
    })
    expect(recordsBySymbol.get('A')!.routeRank).toBe(5)
    expect(recordsBySymbol.get('A')!.daemonRank).toBe(1)
    expect(recordsBySymbol.get('B')!.routeRank).toBe(1)
    expect(recordsBySymbol.get('B')!.daemonRank).toBe(2)
  })

  it('(3) daemon truncation is reconstructable after the fact from recorded data', () => {
    const routeRows = [route('X1'), route('X2'), route('X3')]
    const { recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: null, routeRows,
      daemonSymbols: ['X1', 'X2'], daemonTopN: 2,
      monitorRequestedSymbols: ['X1', 'X2'], monitorResultSymbols: ['X1', 'X2'],
    })
    const kept = [...recordsBySymbol.values()].filter(r => r.inDaemonExecutionUniverse).map(r => r.symbol)
    const dropped = [...recordsBySymbol.values()].filter(r => !r.inDaemonExecutionUniverse).map(r => r.symbol)
    expect(kept.sort()).toEqual(['X1', 'X2'])
    expect(dropped).toEqual(['X3'])
  })

  it('(4) monitorRequested is false for daemon-excluded symbols', () => {
    const routeRows = [route('IN'), route('OUT')]
    const { recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: null, routeRows,
      daemonSymbols: ['IN'], daemonTopN: 1,
      monitorRequestedSymbols: ['IN'], monitorResultSymbols: ['IN'],
    })
    expect(recordsBySymbol.get('IN')!.monitorRequested).toBe(true)
    expect(recordsBySymbol.get('OUT')!.monitorRequested).toBe(false)
  })

  it('(5) setup/BASE linkage is correct for symbols that DO reach that point', () => {
    const routeRows = [route('TAKEN'), route('VETOED')]
    const { recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: null, routeRows,
      daemonSymbols: ['TAKEN', 'VETOED'], daemonTopN: 15,
      monitorRequestedSymbols: ['TAKEN', 'VETOED'], monitorResultSymbols: ['TAKEN', 'VETOED'],
    })
    attachSetupDecision(recordsBySymbol.get('TAKEN')!, 'TAKEN:vwap_bounce:5.00', 'logged')
    attachSetupDecision(recordsBySymbol.get('VETOED')!, 'VETOED:vwap_bounce:5.00', 'veto')

    const taken = recordsBySymbol.get('TAKEN')!
    expect(taken.setupTriggered).toBe(true)
    expect(taken.setupId).toBe('TAKEN:vwap_bounce:5.00')
    expect(taken.baseDecision).toBe('TAKE')
    expect(taken.baseVerdictRaw).toBe('logged')
    expect(taken.reasonUnavailable).toBe(false)

    const vetoed = recordsBySymbol.get('VETOED')!
    expect(vetoed.baseDecision).toBe('VETO')
    expect(vetoed.baseVerdictRaw).toBe('veto')
  })

  it('a symbol reaching monitor but with no triggered setup is NO_TRIGGER, not VETO/UNAVAILABLE', () => {
    const routeRows = [route('QUIET')]
    const { recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: null, routeRows,
      daemonSymbols: ['QUIET'], daemonTopN: 15,
      monitorRequestedSymbols: ['QUIET'], monitorResultSymbols: ['QUIET'],
    })
    expect(recordsBySymbol.get('QUIET')!.baseDecision).toBe('NO_TRIGGER')
    expect(recordsBySymbol.get('QUIET')!.reasonUnavailable).toBe(false)
  })

  it('(6) an unavailable upstream exclusion reason stays reasonUnavailable:true, never invented', () => {
    const routeRows = [route('NOMONITOR')]
    const { recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: null, routeRows,
      daemonSymbols: ['NOMONITOR'], daemonTopN: 15,
      monitorRequestedSymbols: ['NOMONITOR'], monitorResultSymbols: [],   // monitor never returned a result
    })
    const rec = recordsBySymbol.get('NOMONITOR')!
    expect(rec.reasonUnavailable).toBe(true)
    expect(rec.baseDecision).toBe('UNAVAILABLE')
    // Never invents a setupId/verdict it doesn't have.
    expect(rec.setupId).toBeNull()
    expect(rec.baseVerdictRaw).toBeNull()
  })
})

describe('appendSweepBatch + loadUniverseJournal — durability & reconstruction', () => {
  it('(8) a complete sweep reconstructs correctly from its journal rows', () => {
    const path = tmpJournalPath()
    const routeRows = [route('A'), route('B')]
    const { envelope, recordsBySymbol } = buildSweepRecords({
      now: 5000, sweepId: 'sweep-5000', routeComputedAt: 4900, routeRows,
      daemonSymbols: ['A'], daemonTopN: 1,
      monitorRequestedSymbols: ['A'], monitorResultSymbols: ['A'],
    })
    const day = envelope.etTradingDay
    // Route the writer at our tmp path by monkeying with the day-keyed path:
    // simplest is to write directly via appendSweepBatch then read back from
    // the REAL day path is undesirable in a test — instead exercise the same
    // shape via loadUniverseJournal's pathOverride against a manually
    // constructed file using the exact serialization appendSweepBatch uses.
    appendFileSync(path, JSON.stringify(envelope) + '\n')
    for (const r of recordsBySymbol.values()) appendFileSync(path, JSON.stringify(r) + '\n')

    const loaded = loadUniverseJournal(day, path)
    expect(loaded.corrupt).toEqual([])
    expect(loaded.envelopes).toHaveLength(1)
    expect(loaded.symbolRecords).toHaveLength(2)
    expect(loaded.symbolRecords.map(r => r.symbol).sort()).toEqual(['A', 'B'])
  })

  it('appendSweepBatch actually writes to the real day-keyed path', () => {
    const routeRows = [route('LIVE')]
    const { envelope, recordsBySymbol } = buildSweepRecords({
      now: Date.parse('2026-09-23T14:00:00Z'), sweepId: 'sweep-live-1', routeComputedAt: null, routeRows,
      daemonSymbols: ['LIVE'], daemonTopN: 15,
      monitorRequestedSymbols: ['LIVE'], monitorResultSymbols: ['LIVE'],
    })
    const { recordCount } = appendSweepBatch(envelope, [...recordsBySymbol.values()])
    expect(recordCount).toBe(2)   // 1 envelope + 1 symbol record
    const path = universeJournalPath(envelope.etTradingDay)
    const loaded = loadUniverseJournal(envelope.etTradingDay, path)
    expect(loaded.symbolRecords.some(r => r.sweepId === 'sweep-live-1' && r.symbol === 'LIVE')).toBe(true)
    // Clean up the real on-disk file this test wrote.
    try { rmSync(path) } catch { /* ignore */ }
  })

  it('(9) a partial/torn sweep is detected via expected vs actual row count', () => {
    const path = tmpJournalPath()
    const routeRows = [route('A'), route('B'), route('C')]
    const { envelope, recordsBySymbol } = buildSweepRecords({
      now: 5000, sweepId: 'sweep-torn', routeComputedAt: null, routeRows,
      daemonSymbols: ['A'], daemonTopN: 1,
      monitorRequestedSymbols: ['A'], monitorResultSymbols: ['A'],
    })
    expect(envelope.expectedSymbolRowCount).toBe(3)
    appendFileSync(path, JSON.stringify(envelope) + '\n')
    // Only write 2 of the 3 declared symbol rows — simulating a crash mid-write.
    let i = 0
    for (const r of recordsBySymbol.values()) {
      if (i++ >= 2) break
      appendFileSync(path, JSON.stringify(r) + '\n')
    }
    const result = sweepCompleteness(envelope.etTradingDay, 'sweep-torn', path)
    expect(result.envelopeFound).toBe(true)
    expect(result.expected).toBe(3)
    expect(result.actual).toBe(2)
    expect(result.complete).toBe(false)
  })

  it('(10) a duplicate sweep identity is detected/deduped (earliest wins)', () => {
    const path = tmpJournalPath()
    const routeRows = [route('DUP')]
    const { envelope: env1, recordsBySymbol: r1 } = buildSweepRecords({
      now: 1000, sweepId: 'sweep-dup', routeComputedAt: null, routeRows,
      daemonSymbols: ['DUP'], daemonTopN: 15,
      monitorRequestedSymbols: ['DUP'], monitorResultSymbols: ['DUP'],
    })
    attachSetupDecision(r1.get('DUP')!, 'DUP:vwap_bounce:1.00', 'logged')
    appendFileSync(path, JSON.stringify(env1) + '\n')
    appendFileSync(path, JSON.stringify(r1.get('DUP')!) + '\n')

    // A second, later append under the SAME sweepId (e.g. a restart re-ran
    // the same sweep clock tick) — should be ignored, earliest wins.
    const { envelope: env2, recordsBySymbol: r2 } = buildSweepRecords({
      now: 1000, sweepId: 'sweep-dup', routeComputedAt: null, routeRows,
      daemonSymbols: ['DUP'], daemonTopN: 15,
      monitorRequestedSymbols: ['DUP'], monitorResultSymbols: ['DUP'],
    })
    // This duplicate never got a setup decision — proves the FIRST (with
    // baseDecision TAKE) is the one retained, not the later one.
    appendFileSync(path, JSON.stringify(env2) + '\n')
    appendFileSync(path, JSON.stringify(r2.get('DUP')!) + '\n')

    const loaded = loadUniverseJournal(env1.etTradingDay, path)
    expect(loaded.envelopes).toHaveLength(1)
    expect(loaded.symbolRecords).toHaveLength(1)
    expect(loaded.symbolRecords[0].baseDecision).toBe('TAKE')   // the earliest one
  })

  it('(11) a corrupt/torn line is detected and surfaced, never silently repaired', () => {
    const path = tmpJournalPath()
    const routeRows = [route('OK')]
    const { envelope, recordsBySymbol } = buildSweepRecords({
      now: 1000, sweepId: 'sweep-corrupt', routeComputedAt: null, routeRows,
      daemonSymbols: ['OK'], daemonTopN: 15,
      monitorRequestedSymbols: ['OK'], monitorResultSymbols: ['OK'],
    })
    appendFileSync(path, JSON.stringify(envelope) + '\n')
    appendFileSync(path, JSON.stringify(recordsBySymbol.get('OK')!) + '\n')
    appendFileSync(path, '{"schemaVersion":1,"recordType":"symbol_record"' /* torn, no closing */)

    const loaded = loadUniverseJournal(envelope.etTradingDay, path)
    expect(loaded.symbolRecords).toHaveLength(1)
    expect(loaded.corrupt).toHaveLength(1)
    expect(loaded.corrupt[0].ok).toBe(false)
    if (!loaded.corrupt[0].ok) {
      expect(['torn_line', 'malformed_json']).toContain(loaded.corrupt[0].reason)
    }
  })

  it('parseUniverseLine rejects a line missing a required field, never coerces it', () => {
    const parsed = parseUniverseLine(JSON.stringify({ schemaVersion: 1, recordType: 'symbol_record' }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toBe('missing_required_field')
  })

  it('parseUniverseLine rejects an empty line', () => {
    const parsed = parseUniverseLine('   ')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toBe('empty')
  })
})

describe('appendSweepBatch — exactly ONE filesystem append per sweep (non-interference)', () => {
  it('one sweep with many symbol records still causes exactly ONE appendFileSync call', () => {
    const routeRows = Array.from({ length: 25 }, (_, i) => route(`SYM${i}`))
    const { envelope, recordsBySymbol } = buildSweepRecords({
      now: 5000, sweepId: 'sweep-many', routeComputedAt: null, routeRows,
      daemonSymbols: routeRows.slice(0, 15).map(r => r.symbol), daemonTopN: 15,
      monitorRequestedSymbols: routeRows.slice(0, 15).map(r => r.symbol),
      monitorResultSymbols: routeRows.slice(0, 15).map(r => r.symbol),
    })
    expect(recordsBySymbol.size).toBe(25)

    // Inject a counting writeFn (appendSweepBatch's optional third param —
    // see its doc comment for why: Node's built-in `fs` module proved
    // unreliable to intercept via `vi.spyOn` under this project's module
    // transform, so a plain injectable seam is used instead, matching this
    // codebase's existing PriceFetcher/GitRunner injection pattern). Still
    // delegates to a REAL appendFileSync against a real tmp path, so this
    // test verifies actual end-state content too, not just the call count.
    const path = tmpJournalPath()
    let callCount = 0
    // Route the write at our own tmp path (rather than the real day-keyed
    // home-directory path universeJournalPath() would pick) while counting
    // calls.
    const writeToTmp = (_p: string, data: string) => { callCount++; appendFileSync(path, data) }

    const { recordCount } = appendSweepBatch(envelope, [...recordsBySymbol.values()], writeToTmp)
    expect(recordCount).toBe(26)   // 1 envelope + 25 symbol records
    expect(callCount).toBe(1)   // <-- the actual non-interference proof
    const loaded = loadUniverseJournal(envelope.etTradingDay, path)
    expect(loaded.symbolRecords).toHaveLength(25)
  })

  it('appendSweepBatch throwing (simulated write failure) is a normal thrown error the CALLER must contain — this module does not swallow it internally', () => {
    const routeRows = [route('FAIL')]
    const { envelope, recordsBySymbol } = buildSweepRecords({
      now: 6000, sweepId: 'sweep-fail', routeComputedAt: null, routeRows,
      daemonSymbols: ['FAIL'], daemonTopN: 15,
      monitorRequestedSymbols: ['FAIL'], monitorResultSymbols: ['FAIL'],
    })
    const failingWrite = () => { throw new Error('simulated disk failure') }
    // universe-journal.ts's appendSweepBatch does NOT catch this itself — it
    // is the CALLER's (scripts/alert-daemon.ts's sweep()) responsibility to
    // wrap this call in try/catch so a capture-layer write failure can never
    // alter BASE/execution behavior. Proving the error propagates here is
    // what proves that boundary contract actually has something real to
    // catch, rather than this function silently eating failures.
    expect(() => appendSweepBatch(envelope, [...recordsBySymbol.values()], failingWrite)).toThrow('simulated disk failure')
  })

  it('a simulated mid-sweep crash (partial payload never reaching disk) remains detectable by the reader via expected vs actual row count', () => {
    // Even with a single appendFileSync call per sweep, an OS/process crash
    // WHILE that single write is in flight can still leave a torn/partial
    // line on disk (this is a filesystem-level guarantee this module cannot
    // control) — sweepCompleteness must still detect it as incomplete, never
    // silently treat a torn write as a valid complete sweep.
    const path = tmpJournalPath()
    const routeRows = [route('A'), route('B')]
    const { envelope } = buildSweepRecords({
      now: 7000, sweepId: 'sweep-crash', routeComputedAt: null, routeRows,
      daemonSymbols: ['A', 'B'], daemonTopN: 2,
      monitorRequestedSymbols: ['A', 'B'], monitorResultSymbols: ['A', 'B'],
    })
    // Simulate the payload string being cut off mid-write (e.g. process
    // killed after the OS flushed only part of the buffer) by writing a
    // deliberately truncated version of what appendSweepBatch WOULD have
    // written — envelope line complete, then a torn fragment of the first
    // symbol record's JSON.
    appendFileSync(path, `${JSON.stringify(envelope)}\n{"schemaVersion":1,"symbol":"A","recordType":"sym`)
    const result = sweepCompleteness(envelope.etTradingDay, 'sweep-crash', path)
    expect(result.envelopeFound).toBe(true)
    expect(result.expected).toBe(2)
    expect(result.actual).toBe(0)   // the torn line never parsed as a valid symbol record
    expect(result.complete).toBe(false)
    const loaded = loadUniverseJournal(envelope.etTradingDay, path)
    expect(loaded.corrupt.length).toBe(1)
    expect(loaded.corrupt[0].ok).toBe(false)
  })
})

describe('deriveUniverseDayState — restart-safe re-derivation', () => {
  function writeSweep(path: string, now: number, sweepId: string, present: string[], daemonKept: string[]): void {
    const routeRows = present.map(s => route(s))
    const { envelope, recordsBySymbol } = buildSweepRecords({
      now, sweepId, routeComputedAt: null, routeRows,
      daemonSymbols: daemonKept, daemonTopN: 15,
      monitorRequestedSymbols: daemonKept, monitorResultSymbols: daemonKept,
    })
    appendFileSync(path, JSON.stringify(envelope) + '\n')
    for (const r of recordsBySymbol.values()) appendFileSync(path, JSON.stringify(r) + '\n')
  }

  it('(14) leave -> re-enter is represented causally, no future information used', () => {
    const path = tmpJournalPath()
    const day = '2026-09-23'
    writeSweep(path, 1000, 's1', ['ALPHA'], ['ALPHA'])
    writeSweep(path, 2000, 's2', [], [])              // ALPHA absent
    writeSweep(path, 3000, 's3', ['ALPHA'], ['ALPHA']) // ALPHA back

    const state = deriveUniverseDayState(day, path)
    const alpha = state.get('ALPHA')!
    expect(alpha.firstSeenAt).toBe(1000)
    expect(alpha.firstAbsentObservedAt).toBe(2000)   // observed at the NEXT sweep, not sweep 1
    expect(alpha.reenteredAt).toBe(3000)
    expect(alpha.lastSeenAt).toBe(3000)
  })

  it('(15) firstAbsentObservedAt is distinct from any exit-time claim — no exitedUniverseAt field exists', () => {
    const path = tmpJournalPath()
    writeSweep(path, 1000, 's1', ['BETA'], ['BETA'])
    writeSweep(path, 2000, 's2', [], [])
    const state = deriveUniverseDayState('2026-09-23', path)
    const beta = state.get('BETA')!
    expect(beta.firstAbsentObservedAt).toBe(2000)
    expect('exitedUniverseAt' in beta).toBe(false)
    // The type itself has no such key — this assertion plus the interface
    // definition in universe-journal.ts (no exitedUniverseAt field anywhere)
    // together make the exact-exit-time claim structurally impossible.
  })

  it('(12) same-day restart re-derivation is deterministic', () => {
    const path = tmpJournalPath()
    writeSweep(path, 1000, 's1', ['A', 'B'], ['A'])
    writeSweep(path, 2000, 's2', ['A'], ['A'])
    const first = deriveUniverseDayState('2026-09-23', path)
    const second = deriveUniverseDayState('2026-09-23', path)
    expect(JSON.stringify([...first.entries()])).toBe(JSON.stringify([...second.entries()]))
  })

  it('(13) day rollover is deterministic — a sweep just after ET midnight lands in a new file path', () => {
    // ET midnight in late September 2026 is EDT (UTC-4) -> 04:00 UTC.
    // 03:59 UTC = 2026-09-22 23:59 ET (just before midnight);
    // 04:01 UTC = 2026-09-23 00:01 ET (just after midnight).
    const beforeMidnight = Date.parse('2026-09-23T03:59:00Z')
    const afterMidnight = Date.parse('2026-09-23T04:01:00Z')
    const { envelope: e1 } = buildSweepRecords({
      now: beforeMidnight, sweepId: 'x', routeComputedAt: null, routeRows: [],
      daemonSymbols: [], daemonTopN: 15, monitorRequestedSymbols: [], monitorResultSymbols: [],
    })
    const { envelope: e2 } = buildSweepRecords({
      now: afterMidnight, sweepId: 'y', routeComputedAt: null, routeRows: [],
      daemonSymbols: [], daemonTopN: 15, monitorRequestedSymbols: [], monitorResultSymbols: [],
    })
    expect(e1.etTradingDay).not.toBe(e2.etTradingDay)
    expect(universeJournalPath(e1.etTradingDay)).not.toBe(universeJournalPath(e2.etTradingDay))
  })

  it('previousRouteRank/previousDaemonRank track the prior sweep, not the current one', () => {
    const path = tmpJournalPath()
    // Sweep 1: GAMMA routeRank 3. Sweep 2: GAMMA routeRank 1.
    const r1 = buildSweepRecords({
      now: 1000, sweepId: 's1', routeComputedAt: null, routeRows: [route('GAMMA', { routeRank: 3 })],
      daemonSymbols: ['GAMMA'], daemonTopN: 15, monitorRequestedSymbols: ['GAMMA'], monitorResultSymbols: ['GAMMA'],
    })
    appendFileSync(path, JSON.stringify(r1.envelope) + '\n')
    appendFileSync(path, JSON.stringify(r1.recordsBySymbol.get('GAMMA')!) + '\n')
    const r2 = buildSweepRecords({
      now: 2000, sweepId: 's2', routeComputedAt: null, routeRows: [route('GAMMA', { routeRank: 1 })],
      daemonSymbols: ['GAMMA'], daemonTopN: 15, monitorRequestedSymbols: ['GAMMA'], monitorResultSymbols: ['GAMMA'],
    })
    appendFileSync(path, JSON.stringify(r2.envelope) + '\n')
    appendFileSync(path, JSON.stringify(r2.recordsBySymbol.get('GAMMA')!) + '\n')

    const state = deriveUniverseDayState(r1.envelope.etTradingDay, path)
    expect(state.get('GAMMA')!.previousRouteRank).toBe(3)
  })
})

describe('(16) no future/EOD/hindsight fields exist anywhere in the schema', () => {
  it('no banned field is actually DECLARED (as a property) anywhere — comments may name what is deliberately absent', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/research/universe-journal.ts'), 'utf8')
    // Match an actual TS property declaration (`name:` or `name?:`), not a
    // mention of the name in prose (this file's doc comments explicitly
    // name `exitedUniverseAt` to explain why it does NOT exist).
    for (const banned of ['exitedUniverseAt', 'eodPrice', 'mfe', 'mae', 'outcomeCandles', 'finalVerdict']) {
      const declPattern = new RegExp(`\\b${banned}\\??:`)
      expect(declPattern.test(src)).toBe(false)
    }
  })
})

describe('(17)/(18) isolation — no QUALITY_ONLY file or broker/execution interaction', () => {
  it('universe-journal.ts never references QUALITY_ONLY journal/marker paths', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/research/universe-journal.ts'), 'utf8')
    expect(src).not.toMatch(/companion-quality-only/)
    expect(src).not.toMatch(/QUALITY_ONLY_JOURNAL_FILE|QUALITY_ONLY_MARKER_FILE/)
  })

  it('universe-journal.ts imports no broker/execution-authority module', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/research/universe-journal.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"]@\/lib\/execution/)
    // Actual usage (import/instantiation), not a mention in a doc comment
    // explaining that this file does NOT depend on the broker/executor.
    expect(src).not.toMatch(/import\s*{[^}]*\b(AlpacaBroker|PaperExecutor)\b/)
    expect(src).not.toMatch(/new\s+(AlpacaBroker|PaperExecutor)\s*\(/)
  })

  it('(7) universe-journal.ts performs no fetch/network calls of its own', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/research/universe-journal.ts'), 'utf8')
    expect(src).not.toMatch(/\bfetch\(/)
    expect(src).not.toMatch(/\baxios\b/)
  })

  it('(7) the widened fetchUniverse() in alert-daemon.ts still issues exactly one gainers fetch (no new fetch call added)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/alert-daemon.ts'), 'utf8')
    const fetchUniverseBody = src.slice(src.indexOf('async function fetchUniverse'), src.indexOf('async function fetchResults'))
    const fetchCalls = fetchUniverseBody.match(/\bfetch\(/g) ?? []
    expect(fetchCalls).toHaveLength(1)
  })

  it('the capture call sites in alert-daemon.ts are all try/catch-wrapped (never throw into BASE)', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/alert-daemon.ts'), 'utf8')
    const idx = src.indexOf('PROSPECTIVE_DISCOVERY_CAPTURE — build this sweep')
    expect(idx).toBeGreaterThan(-1)
    const nearby = src.slice(idx, idx + 900)
    expect(nearby).toMatch(/try\s*{/)
  })
})
