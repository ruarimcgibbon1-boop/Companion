/**
 * H4B — HARD EXECUTION ISOLATION (STEP 11 / STEP 28, load-bearing).
 *
 * The LEADER_CONTINUATION shadow engine + its outcome evaluator must have NO path to execution:
 * no executor/broker/risk/arbitration/order import, and no execution-capable return type. This
 * scans the module source (and its first-level local dependencies) and asserts the candidate is
 * pure JSON data.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { evaluateLeaderContinuation, type LeaderContinuationInput } from '../src/lib/leader/leader-continuation'
import type { LocalStructureFeatures } from '../src/lib/leader/local-structure'

const ROOT = process.cwd()
// Anything that would constitute an execution/order/risk/arbitration path.
const FORBIDDEN = /(executor|paper-|paperexecutor|\/broker|broker-|arbitrat|risk-manager|\/execution\/|order-|place.?order|submit.?order|onSignal)/i

function importLines(relPath: string): string[] {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  return src.split('\n').filter(l => /^\s*import\b/.test(l) || /^\s*}?\s*from\s+['"]/.test(l))
}

describe('H4B hard execution isolation', () => {
  const engineFiles = [
    'src/lib/leader/leader-continuation.ts',
    'src/lib/leader/leader-continuation-outcome.ts',
  ]
  // First-level local dependencies the engine pulls in — they must also be execution-free.
  const depFiles = [
    'src/lib/leader/local-structure.ts',
    'src/lib/research/tape-1m-replay.ts',
  ]

  for (const f of [...engineFiles, ...depFiles]) {
    it(`${f} imports no executor/broker/risk/arbitration/order module`, () => {
      for (const line of importLines(f)) {
        expect(FORBIDDEN.test(line), `forbidden import in ${f}: ${line.trim()}`).toBe(false)
      }
    })
  }

  it('the engine source names no PaperExecutor / execution-request symbol', () => {
    const src = engineFiles.map(f => readFileSync(join(ROOT, f), 'utf8')).join('\n')
    expect(/PaperExecutor|ExecutionRequest|RiskManager|submitOrder|placeOrder/.test(src)).toBe(false)
  })

  it('evaluateLeaderContinuation returns pure JSON data (no execution handle)', () => {
    const ls = {
      status: 'AVAILABLE', qualityFlags: [], resetState: 'SHALLOW',
      global: { sessionHigh: 12, offHighPct: -2, dayChangePct: 40, distanceFromVWAPPct: null, distanceFromEMA9Pct: null, distanceFromEMA21Pct: null, timeSinceSessionHighSec: null },
      impulse: { detected: true, startAt: 1, startPrice: 8, peakAt: 2, peakPrice: 11, pct: 30, durationBars: 5, volume: 1, volumeVsWindowRatio: 2, dominantImpulsePct: 30 },
      pullback: { startAt: 2, lowAt: 3, lowPrice: 10, pctFromImpulsePeak: 8, maxPct: 8, durationBars: 3, retracementRatio: 0.3, stillPullingBack: false },
      base: { detected: true, startAt: 220, endAt: 340, durationBars: 4, high: 10.8, low: 10.2, rangePct: 5, rangeContraction: 0.7, volumeContraction: 0.6, realizedVolContraction: 0.7, slopePctPerBar: 0.1, upperTests: 2, lowerTests: 2 },
      localExtension: { referencePrice: 10.8, distanceFromBaseHighPct: 1, distanceFromBaseLowPct: 6, localExtensionPct: 0.5, downsideToBaseLowPct: 5, spaceToSessionHighPct: 8, globalVsLocalExtensionRatio: 4 },
      reExpansion: { observed: true, breakoutAboveBaseHighPct: 1, volumeExpansion: 2, barsSinceBaseBreak: 1, reclaimedVWAP: true, reclaimedEMA9: true },
      pathRisk: { recentLocalMAEProxy: 8, distanceToBaseLowPct: 5, distanceToImpulseLowPct: 20, atrPct: 2, realizedVolPct: 3, spreadPct: null },
      provenance: { symbol: 'AAA', leaderEpisodeId: 'ep-1', sweepId: 's', runId: 'r', asOfUtc: 'x', timeframe: '1m', barsStartAt: 1, barsEndAt: 2, barsCount: 60, dataFreshnessMs: 1, discontinuityInWindow: false, sessionsInWindow: ['regular'], containsSessionBoundary: false, cadenceConsistency: 1, featureSchemaVersion: 1, localFeatureConfigVersion: 'v', localFeatureConfigHash: 'h' },
    } as unknown as LocalStructureFeatures
    const input: LeaderContinuationInput = {
      symbol: 'AAA', localStructure: ls,
      leader: { leaderEpisodeId: 'ep-1', lifecycleState: 'REEXPANDING', role: 'CORE', historyComplete: true },
      baseRelationship: 'NOT_IN_BASE_MONITORED_UNIVERSE',
      ranks: { monitoredRank: null, inBaseTop15: false, inTop30: null, inTop60: null },
      runId: 'r', sweepId: 's', nowMs: Date.now(),
    }
    const res = evaluateLeaderContinuation(input)
    expect(res.candidate).not.toBeNull()
    // Pure data: round-trips through JSON with no lost functions/handles.
    const round = JSON.parse(JSON.stringify(res.candidate))
    expect(round.shadowCandidateId).toBe(res.candidate!.shadowCandidateId)
    expect(Object.values(res.candidate!).every(v => typeof v !== 'function')).toBe(true)
  })
})
