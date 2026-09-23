#!/usr/bin/env -S npx tsx
/**
 * QUALITY_ONLY_CONTINUATION research-integrity CLI.
 *
 * READ-ONLY. Never mutates the marker or journal files. Never touches the
 * broker/PaperExecutor. Issues zero provider requests. Prints ONLY
 * integrity/lifecycle metadata — no MFE/MAE/R-multiple/hit-rate/profit/
 * performance field of any kind (see src/lib/research/quality-only-integrity.ts
 * module doc + tests/quality-only-integrity.test.ts's "no performance leakage"
 * test, which greps this CLI's own stdout for forbidden substrings).
 *
 * Usage:
 *   npx tsx scripts/research/quality-only-integrity.ts [--json] [--out <path>]
 *
 *   --json        also print a machine-parseable JSON snapshot to stdout
 *                  (in addition to the human-readable sections).
 *   --out <path>  also write that JSON snapshot to <path> (must be under
 *                  reviews/ or a /tmp-style scratch path — this is a derived,
 *                  regeneratable diagnostic artifact, never a new source of
 *                  truth, and this script refuses to write anywhere under the
 *                  real ~/.companion-quality-only* research-data locations).
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'
import {
  DEFAULT_MARKER_PATH, DEFAULT_JOURNAL_PATH, defaultBarJournalPath,
  inspectMarker, inspectProvenanceDrift, inspectCandidateJournal, inspectBarJournal,
  inspectAsyncWriterHealth, inspectResolverHealth, inspectIsolation, classifyHealth,
  relevantTradingDays,
} from '../../src/lib/research/quality-only-integrity'
import { parseJournal } from '../../src/lib/experiments/quality-only/persistence'
import { existsSync, readFileSync } from 'fs'

function fmtBool(b: boolean | null): string {
  if (b === null) return 'n/a (no marker)'
  return b ? 'yes' : 'no'
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`)
}

function main(): void {
  const args = process.argv.slice(2)
  const wantJson = args.includes('--json')
  const outIdx = args.indexOf('--out')
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null
  if (outPath) {
    const abs = resolve(outPath)
    const forbiddenPrefixes = [
      resolve(homedir(), '.companion-quality-only'),
      resolve(homedir(), '.companion-quality-only-journal.ndjson'),
      resolve(homedir(), '.companion-research-bars-'),
    ]
    if (forbiddenPrefixes.some(p => abs.startsWith(p))) {
      console.error(`Refusing to write --out snapshot into a real research-data location: ${abs}`)
      process.exit(1)
    }
  }

  const nowMs = Date.now()

  const marker = inspectMarker(DEFAULT_MARKER_PATH)
  const drift = inspectProvenanceDrift(marker)
  const candidateInfo = inspectCandidateJournal(DEFAULT_JOURNAL_PATH, marker, nowMs)

  // Discover relevant trading days directly from the raw journal (candidate
  // events only) to hand to the bar-journal inspector.
  let days: { day: string; symbols: Set<string> }[] = []
  if (existsSync(DEFAULT_JOURNAL_PATH)) {
    try {
      const { events } = parseJournal(readFileSync(DEFAULT_JOURNAL_PATH, 'utf8'))
      days = relevantTradingDays(events.filter(e => e.kind === 'candidate') as never)
    } catch { /* handled elsewhere as journal corruption */ }
  }
  const barInfo = inspectBarJournal(days, defaultBarJournalPath)
  const asyncWriterHealth = inspectAsyncWriterHealth() // no live snapshot available to a one-shot CLI process
  const resolverHealth = inspectResolverHealth(candidateInfo)
  const isolation = inspectIsolation()

  const health = classifyHealth({ marker, drift, candidateInfo, barInfo })

  console.log('QUALITY_ONLY_CONTINUATION — research-integrity report')
  console.log(`generatedAt: ${new Date(nowMs).toISOString()}`)
  console.log(`\nHEALTH: ${health.status}`)
  for (const r of health.reasons) console.log(`  - ${r}`)

  section('1. Official marker')
  console.log(`path:        ${marker.path}`)
  console.log(`exists:      ${marker.exists}`)
  console.log(`parseError:  ${marker.parseError ?? 'none'}`)
  console.log(`createdAt:   ${marker.createdAt ?? 'n/a'}`)
  if (marker.raw) {
    console.log(`specVersion:        ${marker.raw.specVersion}`)
    console.log(`epoch:              ${marker.raw.epoch}`)
    console.log(`configHash:         ${marker.raw.configHash}`)
    console.log(`decisionPolicyHash: ${marker.raw.decisionPolicyHash}`)
    console.log(`producerGitHead:    ${marker.raw.producerGitHead}`)
    console.log(`producerGitBranch:  ${marker.raw.producerGitBranch}`)
  }

  section('2. Provenance drift (INSPECTOR only — informational, never gates HEALTH)')
  console.log(`This CLI's own checkout — NOT the frozen experiment producer. Official-epoch`)
  console.log(`validity is judged from OFFICIAL artifacts' own stamped provenance instead;`)
  console.log(`see Section 3's "OFFICIAL contamination violations" line for that real check.`)
  console.log(`inspectorGitHead:    ${drift.inspectorGitHead}`)
  console.log(`inspectorGitBranch:  ${drift.inspectorGitBranch}`)
  console.log(`inspector HEAD matches marker (informational only): ${fmtBool(drift.inspectorHeadMatchesMarker)}`)
  console.log(`inspector specVersion matches marker (informational only):        ${fmtBool(drift.inspectorSpecVersionMatchesMarker)}`)
  console.log(`inspector epoch matches marker (informational only):              ${fmtBool(drift.inspectorEpochMatchesMarker)}`)
  console.log(`inspector configHash matches marker (informational only):         ${fmtBool(drift.inspectorConfigHashMatchesMarker)}`)
  console.log(`inspector decisionPolicyHash matches marker (informational only): ${fmtBool(drift.inspectorDecisionPolicyHashMatchesMarker)}`)

  section('3. Candidate collection')
  console.log(`journal exists:              ${candidateInfo.exists}`)
  console.log(`total distinct candidates:   ${candidateInfo.totalCandidateRows}`)
  console.log(`PRE_OFFICIAL rows:           ${candidateInfo.preOfficialCandidateCount}  (recomputed from candidateObservedAt vs marker.createdAt — historical, excluded from every official count below, does not affect HEALTH by itself)`)
  console.log(`OFFICIAL rows:               ${candidateInfo.officialCandidateCount}`)
  console.log(`OFFICIAL contamination violations: ${candidateInfo.officialContaminationCount}  (causality violations + duplicate outcome identities + corrupt lines touching the official window + official-artifact provenance mismatches — this is what HEALTH's INVALID gate checks, never the mere existence of pre-official rows)`)
  console.log(`  official-artifact provenance mismatches: ${candidateInfo.officialArtifactProvenanceIssues.length}  (checked against the MARKER's recorded provenance, never the inspector's own checkout)`)
  console.log(`unique official symbol-days: ${candidateInfo.uniqueOfficialSymbolDays}`)
  console.log(`unique official trading days:${candidateInfo.uniqueOfficialTradingDays}`)
  console.log(`duplicate candidate identities: ${candidateInfo.duplicateCandidateIdentities.length}  (official: ${candidateInfo.duplicateCandidateIdentitiesOfficial.length}, pre-official-only: ${candidateInfo.duplicateCandidateIdentitiesPreOfficialOnly.length})`)
  console.log(`corrupt/torn journal lines:  ${candidateInfo.corruptLines.length} (torn=${candidateInfo.tornLineCount} malformed=${candidateInfo.malformedLineCount})`)
  console.log(`  bounded pre-official only: ${candidateInfo.corruptLines.filter(c => c.bound === 'bounded_pre_official').length}`)
  console.log(`  touches official/unknown:  ${candidateInfo.corruptLines.filter(c => c.bound === 'touches_official_or_unknown').length}`)
  console.log(`causality violations:        ${candidateInfo.causalityViolations.length}`)
  console.log(`stored preOfficial field always true (known producer limitation): ${candidateInfo.storedPreOfficialFieldAlwaysTrue}`)
  console.log(`official rows mislabeled preOfficial=true on disk: ${candidateInfo.officialRowsMislabeledPreOfficial.length}`)

  section('4. Outcome lifecycle')
  console.log(`SCORABLE: ${candidateInfo.outcomeStatusCounts.SCORABLE}  CENSORED: ${candidateInfo.outcomeStatusCounts.CENSORED}  DEGRADED: ${candidateInfo.outcomeStatusCounts.DEGRADED}  (all rows)`)
  console.log(`OFFICIAL-only — SCORABLE: ${candidateInfo.officialOutcomeStatusCounts.SCORABLE}  CENSORED: ${candidateInfo.officialOutcomeStatusCounts.CENSORED}  DEGRADED: ${candidateInfo.officialOutcomeStatusCounts.DEGRADED}  (HEALTH gates on this row, never the "all rows" one above)`)
  console.log(`unresolved (no outcome yet): ${candidateInfo.unresolvedCandidateIdentities.length}`)
  console.log(`oldest unresolved age (ms):  ${candidateInfo.oldestUnresolvedAgeMs ?? 'n/a'}`)
  console.log(`duplicate outcome identities: ${candidateInfo.duplicateOutcomeIdentities.length}`)
  console.log(`orphan outcomes (no matching candidate): ${candidateInfo.orphanOutcomeIdentities.length}`)
  console.log(`possible stuck-resolver candidates: ${candidateInfo.stuckUnresolvedIdentities.length}  (official: ${candidateInfo.stuckUnresolvedOfficialIdentities.length}, pre-official: ${candidateInfo.stuckUnresolvedPreOfficialIdentities.length} — HEALTH gates on official only)`)

  section('5. Bar-journal integrity')
  console.log(`relevant trading days checked: ${barInfo.days.length}`)
  console.log(`days missing a bar-journal file entirely: ${barInfo.daysMissingEntirely.length} ${barInfo.daysMissingEntirely.length ? `(${barInfo.daysMissingEntirely.join(', ')})` : ''}`)
  console.log(`total corrupt/torn bar-journal lines: ${barInfo.totalCorruptLines}`)
  for (const d of barInfo.days) {
    console.log(`  ${d.day}: exists=${d.exists} bars=${d.totalBarRows} corrupt=${d.corruptLineCount} dupBarIds=${d.duplicateBarIdentities.length} causalGapSymbols=${Object.entries(d.causalGapBySymbol).filter(([, v]) => v).map(([k]) => k).join(',') || 'none'}`)
  }

  section('6. Async writer health (bar-journal.ts queue)')
  console.log(`observable from this process: ${asyncWriterHealth.observable}`)
  console.log(`note: ${asyncWriterHealth.note}`)

  section('7. Resolver health')
  console.log(`last successful pass observable: ${resolverHealth.lastSuccessfulPassObservable}`)
  console.log(`note: ${resolverHealth.note}`)
  console.log(`still pending: ${resolverHealth.stillPendingCount}`)
  console.log(`stuck candidates: ${resolverHealth.stuckCandidateIdentities.length}`)
  console.log(`journal readable: ${resolverHealth.journalReadable}`)

  section('8. Isolation (static/grep-based)')
  console.log(`ok: ${isolation.ok}`)
  console.log(`broker/PaperExecutor import found: ${isolation.brokerOrPaperExecutorImportFound}`)
  console.log(`incremental provider request found: ${isolation.incrementalProviderRequestFound}`)

  const snapshot = {
    generatedAt: new Date(nowMs).toISOString(),
    health,
    marker,
    drift,
    candidateInfo: { ...candidateInfo, corruptLines: candidateInfo.corruptLines.map(c => ({ reason: c.reason, bound: c.bound })) },
    barInfo,
    asyncWriterHealth,
    resolverHealth,
    isolation,
  }

  if (wantJson) {
    console.log('\n── JSON snapshot (derived, regeneratable — not a source of truth) ──')
    console.log(JSON.stringify(snapshot, null, 2))
  }
  if (outPath) {
    writeFileSync(resolve(outPath), JSON.stringify(snapshot, null, 2))
    console.log(`\nWrote JSON snapshot to ${resolve(outPath)}`)
  }

  process.exit(health.status === 'INVALID' ? 2 : 0)
}

main()
