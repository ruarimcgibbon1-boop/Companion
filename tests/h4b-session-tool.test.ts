/**
 * H4B — session research tool end-to-end smoke: synthetic funnel candidate + tape → CSV + summary.
 * Proves the tool ingests funnel candidate events + the 1m tape, dedups by shadowCandidateId,
 * scores causally, and writes descriptive outputs. No trading action.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runH4bSession } from '../scripts/research/h4b-session'

const DAY = '2026-09-18'
const ANCHOR = Date.parse(`${DAY}T14:00:00Z`)
const T0 = Math.floor(ANCHOR / 1000)

function candidateEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'leader_continuation_candidate', strategyId: 'LEADER_CONTINUATION', mode: 'shadow',
    experimentSpecVersion: 'h4b-leadercont-1', experimentConfigHash: 'cfg', experimentEpoch: 'h4b-epoch-1',
    shadowCandidateId: 'lc-aaa-1', symbol: 'AAA', leaderEpisodeId: 'ep-1', setupId: null,
    runId: 'r1', sweepId: 's1', candidateObservedAt: new Date(ANCHOR).toISOString(),
    leaderRole: 'CORE', leaderLifecycle: 'REEXPANDING', historyComplete: true,
    globalOffHighPct: -20, offHighGroup: 'OFF_HIGH_LEGACY', dayChangePct: 60,
    impulsePct: 40, pullbackPct: 8, baseStartAt: T0 - 300, baseEndAt: T0 - 60,
    baseHigh: 100, baseLow: 90, baseRangePct: 11, baseDurationBars: 4,
    localExtensionPct: 0.5, spaceToSessionHighPct: 8, downsideToBaseLowPct: 10, reExpansionObserved: true,
    signalBarTime: T0 - 60, referencePrice: 100, referencePriceBasis: 'BASE_HIGH_BREAKOUT',
    invalidationPrice: 90, invalidationBasis: 'BASE_LOW', riskUnitPrice: 10, riskUnitPct: 10,
    monitoredRank: null, inBaseTop15: false, inTop30: null, inTop60: null,
    baseRelationship: 'NOT_IN_BASE_MONITORED_UNIVERSE', timeframe: '1m', dataQualityStatus: 'AVAILABLE',
    qualityFlags: [], localFeatureConfigHash: 'abcd', leaderConfigHash: 'ee', leaderObservationConfigHash: 'ff',
    ...over,
  }
}

function barLine(minAfter: number, o: number, h: number, l: number, c: number): string {
  const barTimeSec = T0 + minAfter * 60
  return JSON.stringify({
    eventType: 'bar_observation', symbol: 'AAA', timeframe: '1m', barTimeSec,
    open: o, high: h, low: l, close: c, volume: 1000, observedAtMs: (barTimeSec + 60) * 1000,
    revisionSequence: 0, barStatus: 'CLOSED', barFingerprint: 'x', source: 'yahoo', requestKind: 'BASE',
  })
}

describe('H4B session tool (end-to-end)', () => {
  let dir: string, out: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'h4bsess-')); out = join(dir, 'out') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ingests candidate + tape, scores causally, writes CSV + summary (COMPLETE tape)', () => {
    // Funnel: one candidate, emitted twice (repeated sweeps) → tool dedups to ONE.
    const funnel = [
      JSON.stringify(candidateEvent()),
      JSON.stringify(candidateEvent({ sweepId: 's2', candidateObservedAt: new Date(ANCHOR + 15000).toISOString() })),
    ].join('\n') + '\n'
    writeFileSync(join(dir, `.companion-funnel-${DAY}.jsonl`), funnel)

    // Tape: a clean COMPLETE run that reaches +1R (110) then rolls over, no invalidation.
    const bars: string[] = [barLine(1, 100, 105, 99.5, 104), barLine(2, 104, 111, 103, 110)]
    for (let m = 3; m <= 31; m++) bars.push(barLine(m, 108, 109, 107, 108))
    const tape = [
      JSON.stringify({ eventType: 'tape_writer_started', runId: 'tape-1' }),
      ...bars,
      JSON.stringify({ eventType: 'tape_writer_summary', cleanClose: true, eventsDropped: 0, writeFailures: 0, queueOverflows: 0, asyncWriteFailures: 0, degradedEver: false }),
    ].join('\n') + '\n'
    writeFileSync(join(dir, `.companion-1m-tape-${DAY}.jsonl`), tape)

    const { csvPath, sumPath, summary } = runH4bSession({ days: [DAY], out, funnelDir: dir, tapeDir: dir })
    expect(existsSync(csvPath)).toBe(true)
    expect(existsSync(sumPath)).toBe(true)
    expect(summary.distinctCandidates).toBe(1)              // deduped from 2 emissions
    expect(summary.scorablePrimary15m).toBe(1)
    const sg = summary.subgroups as Record<string, { candidates: number }>
    expect(sg.OFF_HIGH_LEGACY.candidates).toBe(1)
    expect(sg.NEAR_HIGH.candidates).toBe(0)

    const csv = readFileSync(csvPath, 'utf8')
    expect(csv.split('\n')[0]).toContain('shadowCandidateId')
    expect(csv).toContain('AAA')
    expect(csv).toContain('OFF_HIGH_LEGACY')
  })

  it('INCOMPLETE tape → candidate recorded but not scorable in primary', () => {
    writeFileSync(join(dir, `.companion-funnel-${DAY}.jsonl`), JSON.stringify(candidateEvent()) + '\n')
    // Tape with no terminal summary → INCOMPLETE.
    const tape = [JSON.stringify({ eventType: 'tape_writer_started', runId: 't' }), barLine(1, 100, 105, 99, 104)].join('\n') + '\n'
    writeFileSync(join(dir, `.companion-1m-tape-${DAY}.jsonl`), tape)
    const { summary } = runH4bSession({ days: [DAY], out, funnelDir: dir, tapeDir: dir })
    expect(summary.distinctCandidates).toBe(1)
    expect(summary.scorablePrimary15m).toBe(0)
  })
})
