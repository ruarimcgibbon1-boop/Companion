/**
 * H4B — session research tool end-to-end, boundary-aware: candidate + tape → CSV + summary,
 * dedup by canonical key, official vs pre-official split, refusal without a start marker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runH4bSession } from '../scripts/research/h4b-session'
import { createCollectionMarker } from '../src/lib/leader/h4b-collection-marker'

const DAY = '2026-09-18'
const ANCHOR = Date.parse(`${DAY}T14:00:00Z`)
const T0 = Math.floor(ANCHOR / 1000)
const CFG = '89e8b4e0', EPOCH = 'h4b-epoch-1'

function candidateEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventType: 'leader_continuation_candidate', strategyId: 'LEADER_CONTINUATION', mode: 'shadow',
    experimentSpecVersion: 'h4b-leadercont-2', experimentConfigHash: CFG, experimentEpoch: EPOCH,
    shadowCandidateId: 'lc-aaa-1', canonicalCandidateKey: 'lc|lc-id-2|AAA|ep-1|bs=1|be=2|cfg=89e8b4e0',
    symbol: 'AAA', leaderEpisodeId: 'ep-1', setupId: null,
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
  return JSON.stringify({ eventType: 'bar_observation', symbol: 'AAA', timeframe: '1m', barTimeSec, open: o, high: h, low: l, close: c, volume: 1000, observedAtMs: (barTimeSec + 60) * 1000, revisionSequence: 0, barStatus: 'CLOSED', barFingerprint: 'x', source: 'yahoo', requestKind: 'BASE' })
}
function writeCompleteTape(dir: string): void {
  const bars: string[] = [barLine(0, 100, 100.5, 99.5, 100), barLine(1, 100, 105, 99.5, 104), barLine(2, 104, 111, 103, 110)]
  for (let m = 3; m <= 31; m++) bars.push(barLine(m, 108, 109, 107, 108))
  writeFileSync(join(dir, `.companion-1m-tape-${DAY}.jsonl`), [
    JSON.stringify({ eventType: 'tape_writer_started', runId: 'tape-1' }), ...bars,
    JSON.stringify({ eventType: 'tape_writer_summary', cleanClose: true, eventsDropped: 0, writeFailures: 0, queueOverflows: 0, asyncWriteFailures: 0, degradedEver: false }),
  ].join('\n') + '\n')
}

describe('H4B session tool (boundary-aware)', () => {
  let dir: string, out: string, mdir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'h4bsess-')); out = join(dir, 'out'); mdir = join(dir, 'markers'); process.env.COMPANION_H4B_DIR = mdir })
  afterEach(() => { delete process.env.COMPANION_H4B_DIR; rmSync(dir, { recursive: true, force: true }) })

  const startMarker = (startedAtUtc: string) => createCollectionMarker({
    startedAtUtc, experimentSpecVersion: 'h4b-leadercont-2', experimentConfigHash: CFG, experimentEpoch: EPOCH,
    decisionPolicyVersion: 'h4b-decision-2', decisionPolicyHash: 'e3c1fe88', producerHead: 'x', branch: 'b',
  })

  it('with a start marker: official candidate scored, dedup collapses repeated emission', () => {
    startMarker('2026-09-18T13:00:00Z')   // before the candidate
    const funnel = [JSON.stringify(candidateEvent()), JSON.stringify(candidateEvent({ sweepId: 's2', candidateObservedAt: new Date(ANCHOR + 15000).toISOString() }))].join('\n') + '\n'
    writeFileSync(join(dir, `.companion-funnel-${DAY}.jsonl`), funnel)
    writeCompleteTape(dir)
    const { csvPath, sumPath, summary } = runH4bSession({ days: [DAY], out, funnelDir: dir, tapeDir: dir })
    expect(existsSync(csvPath) && existsSync(sumPath)).toBe(true)
    expect(summary.officialCollectionStarted).toBe(true)
    const c = summary.counts as { official: number; preOfficial: number }
    expect(c.official).toBe(1)                 // deduped from 2 emissions
    const off = summary.official as { distinctCandidates: number; scorablePrimary15m: number; subgroups: Record<string, { scorableCandidates: number }> }
    expect(off.distinctCandidates).toBe(1)
    expect(off.scorablePrimary15m).toBe(1)
    expect(off.subgroups.OFF_HIGH_LEGACY.scorableCandidates).toBe(1)
    expect(off.subgroups.ADDITIVE.scorableCandidates).toBe(1)   // NOT_IN_BASE is additive
    expect(readFileSync(csvPath, 'utf8')).toContain('OFF_HIGH_LEGACY')
  })

  it('H. a pre-official candidate is excluded from official counts (not deleted)', () => {
    startMarker('2026-09-18T15:00:00Z')   // AFTER the candidate → candidate is pre-official
    writeFileSync(join(dir, `.companion-funnel-${DAY}.jsonl`), JSON.stringify(candidateEvent()) + '\n')
    writeCompleteTape(dir)
    const { summary } = runH4bSession({ days: [DAY], out, funnelDir: dir, tapeDir: dir })
    const c = summary.counts as { official: number; preOfficial: number }
    expect(c.official).toBe(0)
    expect(c.preOfficial).toBe(1)
    expect(summary.totalCandidateRecords).toBe(1)   // retained diagnostically
    const off = summary.official as { distinctCandidates: number }
    expect(off.distinctCandidates).toBe(0)
  })

  it('L. without a marker the tool refuses to claim official collection', () => {
    writeFileSync(join(dir, `.companion-funnel-${DAY}.jsonl`), JSON.stringify(candidateEvent()) + '\n')
    writeCompleteTape(dir)
    const { summary } = runH4bSession({ days: [DAY], out, funnelDir: dir, tapeDir: dir })
    expect(summary.officialCollectionStarted).toBe(false)
    expect((summary.official as { refused?: string }).refused).toMatch(/NO_OFFICIAL_START_MARKER/)
  })

  it('J. a wrong experiment hash does not count as official', () => {
    startMarker('2026-09-18T13:00:00Z')
    writeFileSync(join(dir, `.companion-funnel-${DAY}.jsonl`), JSON.stringify(candidateEvent({ experimentConfigHash: 'deadbeef' })) + '\n')
    writeCompleteTape(dir)
    const { summary } = runH4bSession({ days: [DAY], out, funnelDir: dir, tapeDir: dir })
    const c = summary.counts as { official: number; hashMismatch: number }
    expect(c.official).toBe(0)
    expect(c.hashMismatch).toBe(1)
  })
})
