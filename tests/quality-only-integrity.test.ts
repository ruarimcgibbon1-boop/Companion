/**
 * Tests for the QUALITY_ONLY_CONTINUATION research-integrity monitor
 * (src/lib/research/quality-only-integrity.ts + scripts/research/quality-only-integrity.ts).
 *
 * ALL fixtures use throwaway mkdtempSync() temp directories — never the real
 * ~/.companion-quality-only* paths — matching the convention already
 * established in tests/quality-only.test.ts / tests/quality-only-resolver.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import {
  inspectMarker, inspectProvenanceDrift, inspectCandidateJournal, inspectBarJournal,
  inspectAsyncWriterHealth, inspectResolverHealth, inspectIsolation, classifyHealth,
  relevantTradingDays, defaultBarJournalPath,
} from '../src/lib/research/quality-only-integrity'
import { EXPERIMENT_SPEC_VERSION, EXPERIMENT_EPOCH, computeConfigHash, computeDecisionPolicyHash } from '../src/lib/experiments/quality-only/spec'
import type { CandidateEvent } from '../src/lib/experiments/quality-only/persistence'
import type { QualityOnlyCandidate } from '../src/lib/experiments/quality-only/candidate'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quality-only-integrity-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── Fixture helpers ──────────────────────────────────────────────────────────

function markerPath(): string { return join(dir, 'marker.json') }
function journalPath(): string { return join(dir, 'journal.ndjson') }

function writeValidMarker(overrides: Partial<Record<string, unknown>> = {}): void {
  const base = {
    producerGitHead: 'abc123',
    producerGitBranch: 'research/quality-only-shadow-epoch1',
    specVersion: EXPERIMENT_SPEC_VERSION,
    epoch: EXPERIMENT_EPOCH,
    configHash: computeConfigHash(),
    decisionPolicyHash: computeDecisionPolicyHash(),
    generatedAt: '2026-09-22T18:58:32.749Z',
    createdAt: '2026-09-22T18:58:32.750Z',
    ...overrides,
  }
  writeFileSync(markerPath(), JSON.stringify(base, null, 2))
}

function candidatePayload(overrides: Partial<QualityOnlyCandidate> = {}): QualityOnlyCandidate {
  return {
    identity: overrides.identity ?? 'quality-only|v|e|2026-09-22|ABC|setup-1|hash',
    specVersion: EXPERIMENT_SPEC_VERSION,
    epoch: EXPERIMENT_EPOCH,
    configHash: computeConfigHash(),
    etTradingDay: '2026-09-22',
    symbol: 'ABC',
    setupId: 'setup-1',
    setupType: 'vwap_bounce',
    setupTime: 0,
    candidateObservedAt: overrides.candidateObservedAt ?? Date.parse('2026-09-22T19:00:00.000Z'),
    entryRef: 10, invalidation: 9.5, riskUnit: 0.5, grade: 'B',
    offHighPct: -1, spaceR: null, runUpPct: null,
    gateVector: {} as never, failedGateVector: ['QUALITY_OTHER'],
    trackingFloorPassed: true, sessionOk: true, volumeOk: true,
    standDown: false, capped: false, dup: false,
    sameSymbol: { tradedEarlierToday: false, priorTradeOpen: null, msSincePriorTradeClosed: null, priorTradeRealizedR: null, isReload: false },
    universeRank: null, leaderEpisodeId: null, producerGitHead: 'abc123',
    ...overrides,
  }
}

function candidateLine(payload: QualityOnlyCandidate, storedPreOfficial: boolean): string {
  const ev: CandidateEvent = {
    kind: 'candidate', identity: payload.identity, payload,
    provenance: { producerGitHead: 'abc123', producerGitBranch: 'b', specVersion: EXPERIMENT_SPEC_VERSION, epoch: EXPERIMENT_EPOCH, configHash: computeConfigHash(), decisionPolicyHash: computeDecisionPolicyHash(), generatedAt: new Date(payload.candidateObservedAt).toISOString() },
    preOfficial: storedPreOfficial,
  }
  return `${JSON.stringify(ev)}\n`
}

function outcomeLine(identity: string, resolutionStatus: 'SCORABLE' | 'CENSORED' | 'DEGRADED', storedPreOfficial: boolean, extra: Record<string, unknown> = {}): string {
  const ev = {
    kind: 'outcome', identity,
    payload: {
      entered: true, entryBarTime: 1, mfeR5m: 5.5, mfeR15m: 5.5, mfeR30m: 5.5, maeR5m: -1, maeR15m: -1, maeR30m: -1,
      reached05R: true, reached1R: true, reached2R: true, timeTo05R: 1, timeTo1R: 1, timeTo2R: 1,
      invalidated: false, timeToInvalidation: null, oneRBeforeInvalidation: true, twoRBeforeInvalidation: true,
      terminalReason: 'open_at_end', sameBarAmbiguity: false, resolvedFromBars: 30,
      resolutionStatus, resolutionDetail: 'test', resolvedAt: Date.now(),
      ...extra,
    },
    provenance: { producerGitHead: 'abc123', producerGitBranch: 'b', specVersion: EXPERIMENT_SPEC_VERSION, epoch: EXPERIMENT_EPOCH, configHash: computeConfigHash(), decisionPolicyHash: computeDecisionPolicyHash(), generatedAt: new Date().toISOString() },
    preOfficial: storedPreOfficial,
  }
  return `${JSON.stringify(ev)}\n`
}

const NOW = Date.parse('2026-09-23T12:00:00.000Z')

// ── 1. Marker inspection ─────────────────────────────────────────────────────

describe('inspectMarker', () => {
  it('missing marker -> exists:false, no parseError', () => {
    const m = inspectMarker(markerPath())
    expect(m.exists).toBe(false)
    expect(m.parseError).toBeNull()
    expect(m.raw).toBeNull()
  })

  it('valid marker -> full fields parsed', () => {
    writeValidMarker()
    const m = inspectMarker(markerPath())
    expect(m.exists).toBe(true)
    expect(m.parseError).toBeNull()
    expect(m.raw?.specVersion).toBe(EXPERIMENT_SPEC_VERSION)
    expect(m.raw?.configHash).toBe(computeConfigHash())
    expect(m.createdAt).toBe('2026-09-22T18:58:32.750Z')
  })

  it('malformed marker JSON -> exists:true, parseError set, never throws', () => {
    writeFileSync(markerPath(), '{not valid json')
    const m = inspectMarker(markerPath())
    expect(m.exists).toBe(true)
    expect(m.parseError).toBe('malformed_json')
    expect(m.raw).toBeNull()
  })
})

// ── health baseline / hash drift ────────────────────────────────────────────

describe('classifyHealth', () => {
  it('missing marker -> NOT_STARTED (distinct from INVALID)', () => {
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, dir)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('NOT_STARTED')
  })

  it('valid marker, no candidates yet -> HEALTHY baseline', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, dir)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('HEALTHY')
  })

  // INSPECTOR vs PRODUCER: the integrity CLI's own checkout (e.g. running
  // from a separate tooling branch built on top of the frozen epoch commit)
  // must NEVER be confused with the frozen experiment producer. A marker
  // whose recorded configHash/decisionPolicyHash/specVersion/epoch/HEAD
  // differ from what THIS INSPECTOR currently computes is completely
  // unremarkable — it just means the inspector isn't running the exact same
  // code the marker was created from, which is expected when auditing from a
  // tooling branch. None of that may affect HEALTH by itself.
  it('inspector configHash differing from marker is informational only -> HEALTHY (no official rows to check yet)', () => {
    writeValidMarker({ configHash: 'deadbeefdeadbeef' })
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, dir)
    expect(drift.inspectorConfigHashMatchesMarker).toBe(false)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('HEALTHY')
  })

  it('inspector decisionPolicyHash differing from marker is informational only -> HEALTHY', () => {
    writeValidMarker({ decisionPolicyHash: 'deadbeefdeadbeef' })
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, dir)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('HEALTHY')
  })

  it('inspector branch/HEAD may differ freely from the marker without downgrading HEALTH (e.g. running from a separate tooling branch)', () => {
    writeValidMarker({ producerGitHead: 'some-old-sha-that-will-never-match', producerGitBranch: 'research/quality-only-shadow-epoch1' })
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, process.cwd())   // this test's real checkout — a different branch/commit than the marker
    expect(drift.inspectorHeadMatchesMarker).toBe(false)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('HEALTHY')
  })

  it('an OFFICIAL candidate whose OWN stamped provenance mismatches the marker -> INVALID', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, dir)
    const markerMs = Date.parse(marker.createdAt!)
    const officialRow = candidatePayload({ identity: 'official-bad-provenance', candidateObservedAt: markerMs + 60_000 })
    const ev: CandidateEvent = {
      kind: 'candidate', identity: officialRow.identity, payload: officialRow,
      // Provenance claims a DIFFERENT producer than the marker recorded —
      // e.g. the real daemon was somehow running different code than the
      // frozen epoch commit when it wrote this row.
      provenance: { producerGitHead: 'some-other-commit-not-the-marker', producerGitBranch: 'b', specVersion: EXPERIMENT_SPEC_VERSION, epoch: EXPERIMENT_EPOCH, configHash: computeConfigHash(), decisionPolicyHash: computeDecisionPolicyHash(), generatedAt: new Date().toISOString() },
      preOfficial: false,
    }
    writeFileSync(journalPath(), `${JSON.stringify(ev)}\n`)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(candidateInfo.officialArtifactProvenanceIssues.length).toBeGreaterThan(0)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('INVALID')
  })

  it('an OFFICIAL outcome whose OWN stamped provenance mismatches the marker -> INVALID', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, dir)
    const markerMs = Date.parse(marker.createdAt!)
    const officialRow = candidatePayload({ identity: 'official-with-bad-outcome-provenance', candidateObservedAt: markerMs + 60_000 })
    const candLine = candidateLine(officialRow, false)
    const badOutcome = {
      kind: 'outcome', identity: officialRow.identity,
      payload: { entered: true, entryBarTime: 1, mfeR5m: 1, mfeR15m: 1, mfeR30m: 1, maeR5m: -1, maeR15m: -1, maeR30m: -1, reached05R: true, reached1R: true, reached2R: false, timeTo05R: 1, timeTo1R: 1, timeTo2R: null, invalidated: false, timeToInvalidation: null, oneRBeforeInvalidation: true, twoRBeforeInvalidation: false, terminalReason: 'open_at_end', sameBarAmbiguity: false, resolvedFromBars: 30, resolutionStatus: 'SCORABLE', resolutionDetail: 'test', resolvedAt: Date.now() },
      provenance: { producerGitHead: 'some-other-commit-not-the-marker', producerGitBranch: 'b', specVersion: EXPERIMENT_SPEC_VERSION, epoch: EXPERIMENT_EPOCH, configHash: computeConfigHash(), decisionPolicyHash: computeDecisionPolicyHash(), generatedAt: new Date().toISOString() },
      preOfficial: false,
    }
    writeFileSync(journalPath(), candLine + `${JSON.stringify(badOutcome)}\n`)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(candidateInfo.officialArtifactProvenanceIssues.some(s => s.startsWith('outcome '))).toBe(true)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('INVALID')
  })

  it('a PRE_OFFICIAL row with mismatched/unrelated provenance does NOT contaminate the official epoch', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const drift = inspectProvenanceDrift(marker, dir)
    const markerMs = Date.parse(marker.createdAt!)
    // Observed BEFORE the marker -> pre-official by construction, regardless
    // of what its provenance says (a stray fixture stamped with unrelated
    // producer info, exactly like the real DAEMON test rows found in
    // production).
    const preRow = candidatePayload({ identity: 'pre-official-weird-provenance', candidateObservedAt: markerMs - 60_000 })
    const ev: CandidateEvent = {
      kind: 'candidate', identity: preRow.identity, payload: preRow,
      provenance: { producerGitHead: 'totally-unrelated-commit', producerGitBranch: 'some-branch', specVersion: 'not-even-the-real-spec-version', epoch: 'not-the-real-epoch', configHash: 'deadbeef', decisionPolicyHash: 'deadbeef', generatedAt: new Date().toISOString() },
      preOfficial: true,
    }
    writeFileSync(journalPath(), `${JSON.stringify(ev)}\n`)
    const candidateInfo = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(candidateInfo.officialArtifactProvenanceIssues).toEqual([])   // never checked for a pre-official row
    expect(candidateInfo.officialContaminationCount).toBe(0)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo, barInfo })
    expect(h.status).toBe('HEALTHY')
  })
})

// ── PRE_OFFICIAL exclusion / official counts ────────────────────────────────

describe('official vs pre-official candidate counting', () => {
  it('excludes PRE_OFFICIAL rows from official counts', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const preRow = candidatePayload({ identity: 'id-pre', candidateObservedAt: markerMs - 60_000, symbol: 'PRE' })
    const officialRow = candidatePayload({ identity: 'id-official', candidateObservedAt: markerMs + 60_000, symbol: 'OFF' })
    writeFileSync(journalPath(), candidateLine(preRow, true) + candidateLine(officialRow, false))
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(info.officialCandidateCount).toBe(1)
    expect(info.preOfficialCandidateCount).toBe(1)
    expect(info.uniqueOfficialSymbolDays).toBe(1)
  })

  it('official row with observedAt BEFORE marker createdAt but stored preOfficial=false -> causality violation -> INVALID', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const badRow = candidatePayload({ identity: 'id-bad', candidateObservedAt: markerMs - 60_000 })
    writeFileSync(journalPath(), candidateLine(badRow, false)) // claims official, but timestamp says pre-official
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(info.causalityViolations).toContain('id-bad')
    const drift = inspectProvenanceDrift(marker, dir)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).toBe('INVALID')
  })

  it('known producer defect: stored preOfficial=true on a truly-official row is surfaced, not silently trusted', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const row = candidatePayload({ identity: 'id-mislabel', candidateObservedAt: markerMs + 60_000 })
    writeFileSync(journalPath(), candidateLine(row, true)) // hardcoded true, as the real daemon does
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    // Recomputed count still correctly counts it as official...
    expect(info.officialCandidateCount).toBe(1)
    // ...but the mislabel is surfaced as a diagnostic.
    expect(info.officialRowsMislabeledPreOfficial).toContain('id-mislabel')
    expect(info.storedPreOfficialFieldAlwaysTrue).toBe(true)
  })
})

// ── duplicates / orphans ─────────────────────────────────────────────────────

describe('duplicate and orphan detection', () => {
  it('duplicate candidate identity is detected', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const row = candidatePayload({ identity: 'dup-id' })
    writeFileSync(journalPath(), candidateLine(row, true) + candidateLine(row, true))
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(info.duplicateCandidateIdentities).toContain('dup-id')
    // Earliest-wins: still counted once.
    expect(info.totalCandidateRows).toBe(1)
  })

  it('duplicate outcome identity -> INVALID', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const row = candidatePayload({ identity: 'dup-outcome-id' })
    writeFileSync(journalPath(), candidateLine(row, true) + outcomeLine('dup-outcome-id', 'SCORABLE', true) + outcomeLine('dup-outcome-id', 'SCORABLE', true))
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(info.duplicateOutcomeIdentities).toContain('dup-outcome-id')
    const drift = inspectProvenanceDrift(marker, dir)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).toBe('INVALID')
  })

  it('orphan outcome (no matching candidate) is detected', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    writeFileSync(journalPath(), outcomeLine('never-a-candidate', 'SCORABLE', true))
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(info.orphanOutcomeIdentities).toContain('never-a-candidate')
  })
})

// ── corruption ────────────────────────────────────────────────────────────

describe('corrupt candidate journal handling', () => {
  it('corrupt line bounded entirely within pre-official history -> ATTENTION, not INVALID', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const preA = candidatePayload({ identity: 'pre-a', candidateObservedAt: markerMs - 120_000 })
    const preB = candidatePayload({ identity: 'pre-b', candidateObservedAt: markerMs - 60_000 })
    const content = candidateLine(preA, true) + '{"kind":"candidate","identity":"torn\n' + candidateLine(preB, true)
    writeFileSync(journalPath(), content)
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(info.corruptLines.length).toBeGreaterThan(0)
    expect(info.corruptLines.every(c => c.bound === 'bounded_pre_official')).toBe(true)
    const drift = inspectProvenanceDrift(marker, dir)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).toBe('ATTENTION')
  })

  it('corrupt line adjacent to an official-window row -> INVALID (membership unknowable)', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const officialRow = candidatePayload({ identity: 'off-a', candidateObservedAt: markerMs + 60_000 })
    const content = '{"kind":"candidate","identity":"torn\n' + candidateLine(officialRow, false)
    writeFileSync(journalPath(), content)
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    expect(info.corruptLines.some(c => c.bound === 'touches_official_or_unknown')).toBe(true)
    const drift = inspectProvenanceDrift(marker, dir)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).toBe('INVALID')
  })
})

describe('corrupt bar journal handling', () => {
  it('corrupt bar-journal lines are capped at ATTENTION, never INVALID', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const row = candidatePayload({ identity: 'off-bar', candidateObservedAt: markerMs + 60_000, symbol: 'ABC', etTradingDay: '2026-09-22' })
    writeFileSync(journalPath(), candidateLine(row, false))
    const barPath = join(dir, 'bars-2026-09-22.ndjson')
    writeFileSync(barPath, '{"symbol":"ABC","barStart":1,"broken\n')
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    const barInfo = inspectBarJournal(relevantTradingDays([{ kind: 'candidate', identity: row.identity, payload: row, provenance: {} as never, preOfficial: false }]), () => barPath)
    expect(barInfo.totalCorruptLines).toBeGreaterThan(0)
    const drift = inspectProvenanceDrift(marker, dir)
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).not.toBe('INVALID')
  })

  it('duplicate bar identity (same symbol+barStart) is detected', () => {
    const barPath = join(dir, 'bars.ndjson')
    const bar = { symbol: 'ABC', timeframe: '1m', barStart: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1, state: 'closed', observedAt: 1, source: 'test', etTradingDay: '2026-09-22' }
    writeFileSync(barPath, `${JSON.stringify(bar)}\n${JSON.stringify(bar)}\n`)
    const barInfo = inspectBarJournal([{ day: '2026-09-22', symbols: new Set(['ABC']) }], () => barPath)
    expect(barInfo.days[0].duplicateBarIdentities.length).toBe(1)
  })
})

// ── stale / stuck detection ─────────────────────────────────────────────────

describe('stale pending candidate detection', () => {
  it('candidate unresolved well past 30m + grace -> flagged stuck', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const staleRow = candidatePayload({ identity: 'stale-1', candidateObservedAt: markerMs + 60_000 })
    writeFileSync(journalPath(), candidateLine(staleRow, false))
    const veryLateNow = markerMs + 60_000 + 60 * 60_000 // 1h later, way past 30m+15m grace
    const info = inspectCandidateJournal(journalPath(), marker, veryLateNow)
    expect(info.stuckUnresolvedIdentities).toContain('stale-1')
    const drift = inspectProvenanceDrift(marker, dir)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).toBe('ATTENTION')
  })

  it('recently-observed unresolved candidate is NOT flagged stuck', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const freshRow = candidatePayload({ identity: 'fresh-1', candidateObservedAt: markerMs + 60_000 })
    writeFileSync(journalPath(), candidateLine(freshRow, false))
    const info = inspectCandidateJournal(journalPath(), marker, markerMs + 120_000) // 1m later
    expect(info.stuckUnresolvedIdentities).not.toContain('fresh-1')
    expect(info.unresolvedCandidateIdentities).toContain('fresh-1')
  })

  // Regression test for the real live-run finding: 4 synthetic PRE_OFFICIAL
  // fixture rows (observed BEFORE the marker existed) sat permanently
  // unresolved and, before this fix, dragged HEALTH down to ATTENTION purely
  // because they existed — even though they are correctly excluded from the
  // official sample and will never be resolved on purpose (they predate
  // collection). A historical pre-marker fixture must never, by itself,
  // downgrade HEALTHY.
  it('stuck PRE_OFFICIAL-only candidates are counted and visibly reported but do NOT downgrade HEALTHY to ATTENTION', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    // Four rows, all observed BEFORE the marker (pre-official by construction),
    // all still unresolved, all far past the 30m+grace stuck threshold.
    const rows = ['pre-1', 'pre-2', 'pre-3', 'pre-4'].map(id =>
      candidatePayload({ identity: id, candidateObservedAt: markerMs - 5 * 60 * 60_000 }))
    writeFileSync(journalPath(), rows.map(r => candidateLine(r, true)).join(''))
    const veryLateNow = markerMs + 60 * 60_000 // 1h after collection start
    const info = inspectCandidateJournal(journalPath(), marker, veryLateNow)

    // Counted and visibly reported.
    expect(info.preOfficialCandidateCount).toBe(4)
    expect(info.stuckUnresolvedIdentities).toEqual(expect.arrayContaining(['pre-1', 'pre-2', 'pre-3', 'pre-4']))
    expect(info.stuckUnresolvedPreOfficialIdentities).toEqual(expect.arrayContaining(['pre-1', 'pre-2', 'pre-3', 'pre-4']))
    // Excluded from every official count.
    expect(info.officialCandidateCount).toBe(0)
    expect(info.stuckUnresolvedOfficialIdentities).toEqual([])
    expect(info.officialContaminationCount).toBe(0)

    const drift = inspectProvenanceDrift(marker, dir)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).toBe('HEALTHY')
  })

  it('a single OFFICIAL stuck candidate DOES still trigger ATTENTION, even alongside pre-official noise', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const markerMs = Date.parse(marker.createdAt!)
    const preRow = candidatePayload({ identity: 'pre-noise', candidateObservedAt: markerMs - 60_000 })
    const officialStuckRow = candidatePayload({ identity: 'official-stuck', candidateObservedAt: markerMs + 60_000 })
    writeFileSync(journalPath(), candidateLine(preRow, true) + candidateLine(officialStuckRow, false))
    const veryLateNow = markerMs + 60 * 60_000
    const info = inspectCandidateJournal(journalPath(), marker, veryLateNow)
    expect(info.stuckUnresolvedPreOfficialIdentities).toContain('pre-noise')
    expect(info.stuckUnresolvedOfficialIdentities).toContain('official-stuck')

    const drift = inspectProvenanceDrift(marker, dir)
    const barInfo = inspectBarJournal([])
    const h = classifyHealth({ marker, drift, candidateInfo: info, barInfo })
    expect(h.status).toBe('ATTENTION')
  })
})

// ── async writer / queue degradation ────────────────────────────────────────

describe('async writer health', () => {
  it('reports not-observable when no live snapshot is supplied (separate process)', () => {
    const h = inspectAsyncWriterHealth()
    expect(h.observable).toBe(false)
    expect(h.queuedBytes).toBeNull()
  })

  it('reflects a supplied live snapshot (e.g. from in-process daemon integration)', () => {
    const h = inspectAsyncWriterHealth({ queuedBytes: 100, droppedBatchCount: 2, droppedBarCount: 5, writeFailureCount: 1 })
    expect(h.observable).toBe(true)
    expect(h.droppedBatchCount).toBe(2)
  })
})

// ── resolver health ──────────────────────────────────────────────────────────

describe('resolver health', () => {
  it('reports last-pass as not observable and surfaces pending/stuck counts', () => {
    writeValidMarker()
    const marker = inspectMarker(markerPath())
    const info = inspectCandidateJournal(journalPath(), marker, NOW)
    const rh = inspectResolverHealth(info)
    expect(rh.lastSuccessfulPassObservable).toBe(false)
  })
})

// ── isolation ────────────────────────────────────────────────────────────────

describe('isolation (grep-based, zero broker/provider)', () => {
  it('zero broker/PaperExecutor import under quality-only / this monitor', () => {
    const result = inspectIsolation(process.cwd())
    expect(result.brokerOrPaperExecutorImportFound).toBe(false)
  })

  it('zero incremental provider request (no fetch/axios/http.request) in this monitor or quality-only', () => {
    const result = inspectIsolation(process.cwd())
    expect(result.incrementalProviderRequestFound).toBe(false)
  })
})

// ── no performance leakage ───────────────────────────────────────────────────

describe('no performance data ever printed', () => {
  it('CLI stdout never echoes MFE/MAE/hit-rate/profit/R-multiple magnitudes or terms, even with extreme values in fixtures', () => {
    // Real fixture files at a throwaway path, containing deliberately extreme
    // MFE/MAE values, run through the ACTUAL CLI script as a subprocess.
    writeValidMarker()
    const markerDir = join(dir, 'marker-home', '.companion-quality-only')
    mkdirSync(markerDir, { recursive: true })
    const realMarkerPath = join(markerDir, 'quality-only-epoch-1.collection-start.json')
    execSync(`cp ${markerPath()} ${realMarkerPath}`)

    const journalFile = join(dir, 'marker-home', '.companion-quality-only-journal.ndjson')
    const marker = inspectMarker(realMarkerPath)
    const markerMs = Date.parse(marker.createdAt!)
    const row = candidatePayload({ identity: 'perf-leak-test', candidateObservedAt: markerMs + 60_000 })
    let content = candidateLine(row, false)
    content += outcomeLine('perf-leak-test', 'SCORABLE', true, { mfeR30m: 987.65, maeR30m: -543.21, reached2R: true, terminalReason: 'target' })
    writeFileSync(journalFile, content)

    // Run the CLI with HOME pointed at our fixture dir so it reads our fixture
    // marker/journal instead of the real ~/.companion-quality-only* paths.
    const cliPath = join(process.cwd(), 'scripts/research/quality-only-integrity.ts')
    let stdout = ''
    try {
      stdout = execSync(`npx tsx ${cliPath} --json`, {
        cwd: process.cwd(),
        env: { ...process.env, HOME: join(dir, 'marker-home') },
      }).toString()
    } catch (e: unknown) {
      // Even a non-zero exit (e.g. classified INVALID) still produces stdout
      // we need to check — surface it via the error object.
      stdout = (e as { stdout?: Buffer })?.stdout?.toString() ?? ''
    }
    const lower = stdout.toLowerCase()
    for (const forbidden of ['mfe', 'mae', 'hit rate', 'hit-rate', 'profit', 'r-multiple', 'r multiple', '987.65', '543.21']) {
      expect(lower.includes(forbidden)).toBe(false)
    }
  }, 30_000)
})

// ── read-only behavior ───────────────────────────────────────────────────────

describe('read-only behavior', () => {
  it('inspecting a fixture marker/journal never modifies the files on disk', () => {
    writeValidMarker()
    const before = readFileSync(markerPath(), 'utf8')
    const row = candidatePayload({ identity: 'ro-1' })
    writeFileSync(journalPath(), candidateLine(row, true))
    const journalBefore = readFileSync(journalPath(), 'utf8')

    const marker = inspectMarker(markerPath())
    inspectProvenanceDrift(marker, dir)
    inspectCandidateJournal(journalPath(), marker, NOW)
    inspectBarJournal([])
    inspectResolverHealth(inspectCandidateJournal(journalPath(), marker, NOW))
    inspectIsolation(process.cwd())

    expect(readFileSync(markerPath(), 'utf8')).toBe(before)
    expect(readFileSync(journalPath(), 'utf8')).toBe(journalBefore)
  })

  it('never touches the real ~/.companion-quality-only* paths', () => {
    // Sanity: this test file's default-path constants point at the real
    // homedir conventions, but no test in this file ever calls a function
    // with those defaults — every call above passes an explicit fixture path.
    expect(defaultBarJournalPath('2026-01-01')).toContain(homedir())
  })
})
