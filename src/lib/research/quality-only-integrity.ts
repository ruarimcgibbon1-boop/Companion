/**
 * QUALITY_ONLY_CONTINUATION research-integrity monitor — read-only, static
 * inspection of the experiment's on-disk artifacts (marker, candidate/outcome
 * journal, passive bar-journal mirror).
 *
 * ── SCOPE, PRECISELY ─────────────────────────────────────────────────────
 * This module answers ONE question: "is the QUALITY_ONLY_CONTINUATION data
 * collection valid, complete, and causally sound?" It NEVER answers "is the
 * strategy performing well?" — no MFE/MAE/R-multiple/hit-rate/profit field is
 * ever read out of an outcome payload here; only lifecycle/state metadata
 * (resolutionStatus, identity, timestamps, counts) is inspected. See
 * outcome.ts's QualityOnlyOutcome for the full outcome shape — this module
 * deliberately narrows every outcome it touches down to
 * `{ resolutionStatus, resolutionDetail, resolvedAt }` before doing anything
 * else with it, so a magnitude field can never leak into a metric or a log
 * line by accident.
 *
 * FROZEN, UNTOUCHED: this module does not change candidate eligibility, the
 * freshness definition, the outcome scorer, the SCORABLE/PENDING/CENSORED/
 * DEGRADED definitions, the 30m horizon, the 150s completeness rule, the
 * queue limit, BASE, Mike, or execution logic. It is a new, separate,
 * read-only CONSUMER of persistence.ts/spec.ts/resolver.ts/bar-journal.ts's
 * existing exports (and, for the 150s gap rule and PENDING-window grace,
 * mirrors resolver.ts's own already-documented literals rather than
 * importing an unexported internal — see `CAUSAL_GAP_MS` and
 * `RESOLUTION_GRACE_MS` below, both cited back to resolver.ts).
 *
 * PAPER/RESEARCH ONLY. No broker/PaperExecutor import. No provider request —
 * every input here is a local file already on disk (or `git rev-parse`, a
 * local read of this repo's own state). Never writes to the real marker or
 * journal files; only reads them.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import {
  parseJournal, isPreOfficial, type JournalEvent, type CandidateEvent, type OutcomeEvent,
} from '@/lib/experiments/quality-only/persistence'
import {
  EXPERIMENT_SPEC_VERSION, EXPERIMENT_EPOCH, computeConfigHash, computeDecisionPolicyHash,
} from '@/lib/experiments/quality-only/spec'
import { parseBarLine, type ParsedBarLine, type ResearchBar } from '@/lib/research/bar-journal'
import type { QualityOnlyCandidate } from '@/lib/experiments/quality-only/candidate'
import type { ResolutionStatus, ResolvedOutcome } from '@/lib/experiments/quality-only/resolver'

// ── Real, permanent paths (same conventions as scripts/alert-daemon.ts /
//    scripts/research/create-quality-only-marker.ts — cited, not re-derived) ──

export const DEFAULT_MARKER_PATH = join(homedir(), '.companion-quality-only', 'quality-only-epoch-1.collection-start.json')
export const DEFAULT_JOURNAL_PATH = join(homedir(), '.companion-quality-only-journal.ndjson')
export function defaultBarJournalPath(day: string): string {
  return join(homedir(), `.companion-research-bars-${day}.ndjson`)
}

/** 30m preregistered horizon, mirrored from resolver.ts's HORIZON_MS (that
 *  file is frozen and does not export it, so this is a documented, literal
 *  copy of the same constant — see resolver.ts's own comment above its
 *  `HORIZON_MS`). Used ONLY to detect a possible stuck-resolver backlog, never
 *  to reclassify an outcome. */
const HORIZON_MS = 30 * 60_000
/** Grace period on top of HORIZON_MS before an unresolved candidate is
 *  flagged as a *possible* stuck-resolver signal rather than merely
 *  "still within its normal resolution window". Deliberately generous (15m)
 *  since the resolver only runs once per daemon sweep. */
const RESOLUTION_GRACE_MS = 15 * 60_000
/** >150s between consecutive causal bars = an unprovable gap. Mirrored from
 *  resolver.ts's `hasCausalGap` (unexported, same literal, cited not reimplemented
 *  logic — see resolver.ts's module doc, "150s completeness rule"). */
const CAUSAL_GAP_SECONDS = 150

function safeGit(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, { cwd: cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'unknown'
  }
}

// ── 1. Marker inspection ────────────────────────────────────────────────────

export interface MarkerRawFields {
  producerGitHead: string | null
  producerGitBranch: string | null
  specVersion: string | null
  epoch: string | null
  configHash: string | null
  decisionPolicyHash: string | null
  generatedAt: string | null
}

export interface MarkerInfo {
  path: string
  exists: boolean
  /** null unless the file exists but could not be parsed as JSON. */
  parseError: string | null
  createdAt: string | null
  raw: MarkerRawFields | null
}

/**
 * Reads and parses the FULL marker JSON (persistence.ts's `readStartMarker`
 * only exposes `exists`/`createdAt`; this reads the same file directly for
 * the rest of the provenance fields, read-only, no re-implementation of the
 * write path). Fails conservatively: a malformed marker reports
 * `exists: true, parseError: <reason>`, never throws, never fabricates
 * field values.
 */
export function inspectMarker(markerPath: string): MarkerInfo {
  if (!existsSync(markerPath)) {
    return { path: markerPath, exists: false, parseError: null, createdAt: null, raw: null }
  }
  let text: string
  try {
    text = readFileSync(markerPath, 'utf8')
  } catch (e) {
    return { path: markerPath, exists: true, parseError: `read_error: ${e instanceof Error ? e.message : String(e)}`, createdAt: null, raw: null }
  }
  try {
    const obj = JSON.parse(text) as Record<string, unknown>
    const str = (k: string): string | null => (typeof obj[k] === 'string' ? (obj[k] as string) : null)
    return {
      path: markerPath,
      exists: true,
      parseError: null,
      createdAt: str('createdAt'),
      raw: {
        producerGitHead: str('producerGitHead'),
        producerGitBranch: str('producerGitBranch'),
        specVersion: str('specVersion'),
        epoch: str('epoch'),
        configHash: str('configHash'),
        decisionPolicyHash: str('decisionPolicyHash'),
        generatedAt: str('generatedAt'),
      },
    }
  } catch {
    // Malformed/torn marker file: report it exists (so "not started" is never
    // conflated with "started but unreadable") with everything else unknown.
    return { path: markerPath, exists: true, parseError: 'malformed_json', createdAt: null, raw: null }
  }
}

// ── 2. Provenance drift ─────────────────────────────────────────────────────

/**
 * INSPECTOR vs PRODUCER — a load-bearing distinction this module must never
 * blur. The fields below describe the INTEGRITY TOOL'S OWN currently-checked-
 * out git state (whatever branch/commit happens to be on disk wherever
 * `npm run quality-only:integrity` is invoked from) — they are NOT the
 * frozen experiment producer's provenance. Running this CLI from a separate
 * tooling branch (e.g. research/quality-only-epoch1-integrity, which carries
 * unrelated integrity-monitor code on top of the frozen epoch commit) is
 * completely normal and must never, by itself, make the epoch look INVALID.
 * Every field here is REPORTED ONLY — `classifyHealth` never reads any of
 * them. Official-epoch validity is instead judged by comparing the marker's
 * recorded provenance against the provenance ACTUALLY STAMPED ON EACH
 * OFFICIAL candidate/outcome ARTIFACT (see `officialArtifactProvenanceIssues`
 * on `CandidateJournalInfo` below) — i.e. what the real producer process
 * (the live daemon, running from the frozen epoch branch) wrote at the time,
 * not what code some inspector happens to have checked out right now.
 */
export interface ProvenanceDrift {
  inspectorGitHead: string
  inspectorGitBranch: string
  inspectorSpecVersion: string
  inspectorEpoch: string
  inspectorConfigHash: string
  inspectorDecisionPolicyHash: string
  /** Informational only, always — comparing the INSPECTOR's own checkout to
   *  the marker is never a validity signal, only a "heads up, you're looking
   *  at this from a different branch/commit than the marker was created on"
   *  note for a human reading the report. */
  inspectorHeadMatchesMarker: boolean | null
  inspectorSpecVersionMatchesMarker: boolean | null
  inspectorEpochMatchesMarker: boolean | null
  inspectorConfigHashMatchesMarker: boolean | null
  inspectorDecisionPolicyHashMatchesMarker: boolean | null
}

export function inspectProvenanceDrift(marker: MarkerInfo, cwd?: string): ProvenanceDrift {
  const inspectorGitHead = safeGit('git rev-parse HEAD', cwd)
  const inspectorGitBranch = safeGit('git rev-parse --abbrev-ref HEAD', cwd)
  const inspectorSpecVersion = EXPERIMENT_SPEC_VERSION
  const inspectorEpoch = EXPERIMENT_EPOCH
  const inspectorConfigHash = computeConfigHash()
  const inspectorDecisionPolicyHash = computeDecisionPolicyHash()
  const r = marker.raw
  return {
    inspectorGitHead, inspectorGitBranch, inspectorSpecVersion, inspectorEpoch, inspectorConfigHash, inspectorDecisionPolicyHash,
    inspectorHeadMatchesMarker: r ? inspectorGitHead === r.producerGitHead : null,
    inspectorSpecVersionMatchesMarker: r ? inspectorSpecVersion === r.specVersion : null,
    inspectorEpochMatchesMarker: r ? inspectorEpoch === r.epoch : null,
    inspectorConfigHashMatchesMarker: r ? inspectorConfigHash === r.configHash : null,
    inspectorDecisionPolicyHashMatchesMarker: r ? inspectorDecisionPolicyHash === r.decisionPolicyHash : null,
  }
}

// ── 3+4. Candidate + outcome journal inspection ─────────────────────────────

export type CorruptLineBound = 'bounded_pre_official' | 'touches_official_or_unknown'

export interface BoundedCorruptLine {
  ok: false
  reason: 'empty' | 'malformed_json' | 'missing_required_field' | 'torn_line'
  raw: string
  bound: CorruptLineBound
}

export interface CandidateJournalInfo {
  path: string
  exists: boolean
  totalCandidateRows: number
  totalOutcomeRows: number
  corruptLines: BoundedCorruptLine[]
  tornLineCount: number
  malformedLineCount: number
  /** Recomputed from real timestamps against the marker (isPreOfficial(),
   *  reused from persistence.ts) — see module doc "STORED preOfficial FIELD
   *  IS UNRELIABLE" below. This is the authoritative official/pre-official
   *  split this monitor reports as the headline count. */
  officialCandidateCount: number
  preOfficialCandidateCount: number
  uniqueOfficialSymbolDays: number
  uniqueOfficialTradingDays: number
  duplicateCandidateIdentities: string[]
  duplicateOutcomeIdentities: string[]
  orphanOutcomeIdentities: string[]
  unresolvedCandidateIdentities: string[]
  oldestUnresolvedAgeMs: number | null
  /** Outcome lifecycle counts among rows that HAVE an outcome event, keyed by
   *  resolutionStatus (SCORABLE/CENSORED/DEGRADED — PENDING is never stored,
   *  it is the absence of an outcome event, tracked separately above). */
  outcomeStatusCounts: Record<Exclude<ResolutionStatus, 'PENDING'>, number>
  /** Same breakdown, but counting ONLY rows whose candidate is OFFICIAL
   *  (recomputed). A PRE_OFFICIAL fixture resolving DEGRADED is expected
   *  historical noise, not a current-epoch concern — classifyHealth gates on
   *  this field, never on the unscoped `outcomeStatusCounts` above. */
  officialOutcomeStatusCounts: Record<Exclude<ResolutionStatus, 'PENDING'>, number>
  stuckUnresolvedIdentities: string[]
  /** Same identities, split by whether the STUCK candidate itself is
   *  OFFICIAL or PRE_OFFICIAL (recomputed from candidateObservedAt vs the
   *  marker). classifyHealth gates ATTENTION on `...Official` only — a
   *  pre-official fixture that will simply never resolve (e.g. a synthetic
   *  test row) must not, by itself, downgrade HEALTHY. Both are still fully
   *  reported for visibility (per the task's "must be visibly reported"
   *  requirement) — nothing is hidden, only excluded from the health gate. */
  stuckUnresolvedOfficialIdentities: string[]
  stuckUnresolvedPreOfficialIdentities: string[]
  /** Duplicate candidate identities, split by whether ANY occurrence of that
   *  identity is OFFICIAL. Two duplicate rows that are BOTH pre-official
   *  (e.g. from a stray test-fixture write, replayed twice) are historical
   *  noise, not a current-epoch concern. */
  duplicateCandidateIdentitiesOfficial: string[]
  duplicateCandidateIdentitiesPreOfficialOnly: string[]
  /** Total contamination count for the OFFICIAL sample specifically — the
   *  sum of every finding that would make official-epoch membership
   *  untrustworthy: causality violations, duplicate OUTCOME identities (a
   *  hard invariant break regardless of scope — see module doc), and
   *  corrupt/torn lines that could not be conservatively bounded away from
   *  the official window. This is the single number the task's "OFFICIAL
   *  contamination violations" report line surfaces; it is 0 in the healthy
   *  case even when preOfficialCandidateCount > 0. */
  officialContaminationCount: number
  /** Provenance mismatches found on OFFICIAL artifacts' OWN stamped
   *  `event.provenance` field (producerGitHead/producerGitBranch/specVersion/
   *  epoch/configHash/decisionPolicyHash) against the marker's recorded
   *  values — this is the REAL producer-validity check, deliberately
   *  independent of whatever code the INSPECTOR (this CLI's own checkout)
   *  happens to be running. A PRE_OFFICIAL row's provenance is NEVER checked
   *  here (a stray pre-collection fixture stamped with unrelated provenance
   *  is expected historical noise, not an official-epoch concern). Included
   *  in `officialContaminationCount`. Empty whenever officialCandidateCount
   *  is 0 — there is nothing yet to validate, and the marker alone remains
   *  authoritative. */
  officialArtifactProvenanceIssues: string[]
  /** Rows whose STORED preOfficial=false claims "official" but whose real
   *  candidateObservedAt is before the marker's createdAt — a genuine
   *  causality violation: the official sample would include a row that was
   *  never causally after collection start. */
  causalityViolations: string[]
  /** Rows whose STORED preOfficial=true claims "pre-official" but whose real
   *  candidateObservedAt is AT/AFTER the marker's createdAt — i.e. a truly
   *  official row mislabeled as pre-official on disk. Does not corrupt the
   *  official sample (this monitor recomputes official status from
   *  timestamps, not the stored flag) but means any OTHER consumer that
   *  trusts the stored field alone will silently miscount. See
   *  "KNOWN PRODUCER DEFECT" note below. */
  officialRowsMislabeledPreOfficial: string[]
  /** Diagnostic: true iff every candidate/outcome event's stored `preOfficial`
   *  field is `true`, i.e. the stored field carries no information at all
   *  (matches the known scripts/alert-daemon.ts / resolver.ts behavior of
   *  hardcoding `preOfficial: true` unconditionally at every write site —
   *  see module doc). */
  storedPreOfficialFieldAlwaysTrue: boolean
}

/**
 * KNOWN PRODUCER DEFECT (found by this monitor, not fixed by it — fixing it
 * would mean editing scripts/alert-daemon.ts / resolver.ts, both frozen for
 * this task): every candidate/outcome event written by the live daemon
 * (scripts/alert-daemon.ts's `runQualityOnlyObserver`) and by the resolver
 * (resolver.ts's `resolvePendingCandidates`) hardcodes `preOfficial: true`
 * unconditionally, regardless of whether a collection-start marker exists —
 * see the literal comments at those call sites ("no collection-start marker
 * exists anywhere in this task"). That means the STORED `preOfficial` field
 * on disk can never be trusted to mean "observed before official collection
 * start" once a marker DOES exist; it will always read `true`. This monitor
 * therefore never trusts the stored field for its headline official/
 * pre-official counts — it recomputes official status independently from
 * `candidateObservedAt` vs the marker's `createdAt`, using persistence.ts's
 * own `isPreOfficial()` (reused, not reimplemented). The stored-field
 * mismatch is still surfaced (`officialRowsMislabeledPreOfficial`,
 * `storedPreOfficialFieldAlwaysTrue`) as an ATTENTION-worthy finding for any
 * OTHER downstream consumer that might trust the raw field.
 */
export function inspectCandidateJournal(journalPath: string, marker: MarkerInfo, nowMs: number): CandidateJournalInfo {
  const empty: CandidateJournalInfo = {
    path: journalPath, exists: false, totalCandidateRows: 0, totalOutcomeRows: 0,
    corruptLines: [], tornLineCount: 0, malformedLineCount: 0,
    officialCandidateCount: 0, preOfficialCandidateCount: 0,
    uniqueOfficialSymbolDays: 0, uniqueOfficialTradingDays: 0,
    duplicateCandidateIdentities: [], duplicateOutcomeIdentities: [], orphanOutcomeIdentities: [],
    unresolvedCandidateIdentities: [], oldestUnresolvedAgeMs: null,
    outcomeStatusCounts: { SCORABLE: 0, CENSORED: 0, DEGRADED: 0 },
    officialOutcomeStatusCounts: { SCORABLE: 0, CENSORED: 0, DEGRADED: 0 },
    stuckUnresolvedIdentities: [], causalityViolations: [], officialRowsMislabeledPreOfficial: [],
    stuckUnresolvedOfficialIdentities: [], stuckUnresolvedPreOfficialIdentities: [],
    duplicateCandidateIdentitiesOfficial: [], duplicateCandidateIdentitiesPreOfficialOnly: [],
    officialContaminationCount: 0, officialArtifactProvenanceIssues: [],
    storedPreOfficialFieldAlwaysTrue: true,
  }
  if (!existsSync(journalPath)) return empty

  let raw: string
  try {
    raw = readFileSync(journalPath, 'utf8')
  } catch {
    return empty
  }

  const lines = raw.split('\n')
  // Parse with index preserved so corrupt lines can be bounded by their
  // nearest valid neighbors' timestamps.
  type BadLine = { ok: false; reason: 'empty' | 'malformed_json' | 'missing_required_field' | 'torn_line'; raw: string }
  type Slot = { ok: true; event: JournalEvent; ts: number | null } | { ok: false; parsed: BadLine }
  const slots: Slot[] = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const single = parseJournal(`${line}\n`)
    if (single.events.length === 1) {
      const ev = single.events[0]
      const ts = ev.kind === 'candidate' ? (ev.payload as QualityOnlyCandidate)?.candidateObservedAt ?? null : null
      slots.push({ ok: true, event: ev, ts: typeof ts === 'number' ? ts : null })
    } else {
      const bad = single.corrupt[0]
      slots.push({ ok: false, parsed: bad && !bad.ok ? bad : { ok: false, reason: 'malformed_json', raw: line } })
    }
  }

  const markerCreatedMs = marker.exists && marker.createdAt ? Date.parse(marker.createdAt) : null

  // Bound each corrupt line using nearest valid neighbor timestamps.
  const corruptLines: BoundedCorruptLine[] = []
  let tornLineCount = 0
  let malformedLineCount = 0
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    if (s.ok) continue
    if (s.parsed.reason === 'torn_line') tornLineCount++
    else malformedLineCount++
    let prevTs: number | null = null
    for (let j = i - 1; j >= 0; j--) { const cand = slots[j]; if (cand.ok && cand.ts != null) { prevTs = cand.ts; break } }
    let nextTs: number | null = null
    for (let j = i + 1; j < slots.length; j++) { const cand = slots[j]; if (cand.ok && cand.ts != null) { nextTs = cand.ts; break } }
    const bound: CorruptLineBound = (() => {
      if (markerCreatedMs == null) return 'bounded_pre_official' // no marker yet -> everything is pre-official by definition
      const neighborTs = [prevTs, nextTs].filter((t): t is number => t != null)
      if (neighborTs.length === 0) return 'touches_official_or_unknown' // no bearings at all -- fail conservative
      // If EITHER neighbor is at/after the marker, we cannot rule out the
      // corrupt line itself belonging to the official window -> conservative.
      if (neighborTs.some(t => t >= markerCreatedMs)) return 'touches_official_or_unknown'
      return 'bounded_pre_official'
    })()
    corruptLines.push({ ...s.parsed, bound })
  }

  const candidatesByIdentity = new Map<string, { event: CandidateEvent; firstIndex: number }>()
  const candidateIdentityCounts = new Map<string, number>()
  const outcomesByIdentity = new Map<string, OutcomeEvent>()
  const outcomeIdentityCounts = new Map<string, number>()
  let anyStoredPreOfficialFalse = false

  for (const s of slots) {
    if (!s.ok) continue
    const ev = s.event
    if (ev.preOfficial === false) anyStoredPreOfficialFalse = true
    if (ev.kind === 'candidate') {
      candidateIdentityCounts.set(ev.identity, (candidateIdentityCounts.get(ev.identity) ?? 0) + 1)
      if (!candidatesByIdentity.has(ev.identity)) candidatesByIdentity.set(ev.identity, { event: ev, firstIndex: slots.indexOf(s) })
    } else {
      outcomeIdentityCounts.set(ev.identity, (outcomeIdentityCounts.get(ev.identity) ?? 0) + 1)
      if (!outcomesByIdentity.has(ev.identity)) outcomesByIdentity.set(ev.identity, ev)
    }
  }

  const duplicateCandidateIdentities = [...candidateIdentityCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id)
  const duplicateOutcomeIdentities = [...outcomeIdentityCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id)
  const orphanOutcomeIdentities = [...outcomesByIdentity.keys()].filter(id => !candidatesByIdentity.has(id))

  let officialCandidateCount = 0
  let preOfficialCandidateCount = 0
  const officialSymbolDays = new Set<string>()
  const officialTradingDays = new Set<string>()
  const causalityViolations: string[] = []
  const officialRowsMislabeledPreOfficial: string[] = []
  const unresolvedCandidateIdentities: string[] = []
  const stuckUnresolvedIdentities: string[] = []
  let oldestUnresolvedAgeMs: number | null = null

  const markerForRecompute = { exists: marker.exists, createdAt: marker.createdAt }
  const stuckUnresolvedOfficialIdentities: string[] = []
  const stuckUnresolvedPreOfficialIdentities: string[] = []
  const officialArtifactProvenanceIssues: string[] = []
  // Tracks, per identity, whether it recomputed as official — reused below to
  // scope duplicate-identity and outcome-status counts to the official sample
  // without a second file pass.
  const identityIsOfficial = new Map<string, boolean>()

  // Checks an OFFICIAL artifact's OWN stamped `provenance` field against the
  // marker's recorded values — the real producer-validity check (see the
  // `officialArtifactProvenanceIssues` doc comment above). Never called for a
  // PRE_OFFICIAL row. No-op (returns nothing to push) if there is no valid
  // marker to compare against — validity has nothing to be checked against.
  function checkOfficialArtifactProvenance(kind: 'candidate' | 'outcome', identity: string, provenance: { producerGitHead?: unknown; specVersion?: unknown; epoch?: unknown; configHash?: unknown; decisionPolicyHash?: unknown } | null | undefined): void {
    const r = marker.raw
    if (!r || !provenance) return
    const checks: Array<[string, unknown, unknown]> = [
      ['producerGitHead', provenance.producerGitHead, r.producerGitHead],
      ['specVersion', provenance.specVersion, r.specVersion],
      ['epoch', provenance.epoch, r.epoch],
      ['configHash', provenance.configHash, r.configHash],
      ['decisionPolicyHash', provenance.decisionPolicyHash, r.decisionPolicyHash],
    ]
    for (const [field, actual, expected] of checks) {
      if (actual !== expected) {
        officialArtifactProvenanceIssues.push(`${kind} ${identity}: ${field} mismatch (artifact=${JSON.stringify(actual)}, marker=${JSON.stringify(expected)})`)
      }
    }
  }

  for (const [identity, { event }] of candidatesByIdentity) {
    const payload = event.payload as QualityOnlyCandidate
    const observedAtMs = typeof payload?.candidateObservedAt === 'number' ? payload.candidateObservedAt : null
    const recomputedPreOfficial = observedAtMs != null ? isPreOfficial(observedAtMs, markerForRecompute) : true
    identityIsOfficial.set(identity, !recomputedPreOfficial)
    if (recomputedPreOfficial) {
      preOfficialCandidateCount++
    } else {
      officialCandidateCount++
      officialSymbolDays.add(`${payload.symbol}:${payload.etTradingDay}`)
      officialTradingDays.add(payload.etTradingDay)
      checkOfficialArtifactProvenance('candidate', identity, event.provenance)
    }
    // Stored field says NOT pre-official (claims official) but recomputation
    // says it actually IS pre-official -> causality violation (a row that was
    // never causally after collection start is claiming official membership).
    if (event.preOfficial === false && recomputedPreOfficial === true) causalityViolations.push(identity)
    // Stored field says pre-official but recomputation says it is actually
    // official -> mislabeled (known producer defect, documented above).
    if (event.preOfficial === true && recomputedPreOfficial === false) officialRowsMislabeledPreOfficial.push(identity)

    if (!outcomesByIdentity.has(identity)) {
      unresolvedCandidateIdentities.push(identity)
      if (observedAtMs != null) {
        const age = nowMs - observedAtMs
        if (oldestUnresolvedAgeMs == null || age > oldestUnresolvedAgeMs) oldestUnresolvedAgeMs = age
        if (age > HORIZON_MS + RESOLUTION_GRACE_MS) {
          stuckUnresolvedIdentities.push(identity)
          ;(recomputedPreOfficial ? stuckUnresolvedPreOfficialIdentities : stuckUnresolvedOfficialIdentities).push(identity)
        }
      }
    }
  }

  // A duplicate identity "touches official" if ANY of its occurrences (the
  // kept-first row plus any later repeats) recomputed as official — the
  // per-identity map above only reflects the FIRST occurrence's timestamp,
  // which is what candidatesByIdentity/earliest-wins already keeps, so this
  // is exact for the common case (repeats of the same identity share the
  // same causal day/symbol/setupId by construction) and conservative
  // (official-leaning) for any edge case.
  const duplicateCandidateIdentitiesOfficial = duplicateCandidateIdentities.filter(id => identityIsOfficial.get(id) === true)
  const duplicateCandidateIdentitiesPreOfficialOnly = duplicateCandidateIdentities.filter(id => identityIsOfficial.get(id) !== true)

  const outcomeStatusCounts: Record<Exclude<ResolutionStatus, 'PENDING'>, number> = { SCORABLE: 0, CENSORED: 0, DEGRADED: 0 }
  const officialOutcomeStatusCounts: Record<Exclude<ResolutionStatus, 'PENDING'>, number> = { SCORABLE: 0, CENSORED: 0, DEGRADED: 0 }
  let totalOutcomeRows = 0
  for (const [identity, ev] of outcomesByIdentity) {
    totalOutcomeRows++
    const status = (ev.payload as Partial<ResolvedOutcome>)?.resolutionStatus
    const outcomeIsOfficial = identityIsOfficial.get(identity) === true
    if (status === 'SCORABLE' || status === 'CENSORED' || status === 'DEGRADED') {
      outcomeStatusCounts[status]++
      if (outcomeIsOfficial) officialOutcomeStatusCounts[status]++
    }
    // An outcome's official/pre-official status is inherited from its
    // CANDIDATE's recomputed status (an outcome has no candidateObservedAt of
    // its own) — checked only when the candidate is official.
    if (outcomeIsOfficial) checkOfficialArtifactProvenance('outcome', identity, ev.provenance)
  }

  // Single headline number for "does the OFFICIAL sample's membership have a
  // demonstrated integrity problem" — causality violations and corrupt lines
  // that touch/can't-be-bounded-away-from the official window are inherently
  // official-scoped already; duplicate OUTCOME identities are kept unscoped
  // (a hard append-only-invariant break is evidence the guarantee can fail
  // for official rows too, not "merely a historical pre-marker fixture").
  const officialTouchingCorruptionCount = corruptLines.filter(c => c.bound === 'touches_official_or_unknown').length
  const officialContaminationCount = causalityViolations.length + duplicateOutcomeIdentities.length + officialTouchingCorruptionCount + officialArtifactProvenanceIssues.length

  return {
    path: journalPath,
    exists: true,
    totalCandidateRows: candidatesByIdentity.size,
    totalOutcomeRows,
    corruptLines,
    tornLineCount,
    malformedLineCount,
    officialCandidateCount,
    preOfficialCandidateCount,
    uniqueOfficialSymbolDays: officialSymbolDays.size,
    uniqueOfficialTradingDays: officialTradingDays.size,
    duplicateCandidateIdentities,
    duplicateCandidateIdentitiesOfficial,
    duplicateCandidateIdentitiesPreOfficialOnly,
    duplicateOutcomeIdentities,
    orphanOutcomeIdentities,
    unresolvedCandidateIdentities,
    oldestUnresolvedAgeMs,
    outcomeStatusCounts,
    officialOutcomeStatusCounts,
    stuckUnresolvedIdentities,
    stuckUnresolvedOfficialIdentities,
    stuckUnresolvedPreOfficialIdentities,
    officialContaminationCount,
    officialArtifactProvenanceIssues,
    causalityViolations,
    officialRowsMislabeledPreOfficial,
    storedPreOfficialFieldAlwaysTrue: !anyStoredPreOfficialFalse,
  }
}

// ── 5. Bar-journal integrity ─────────────────────────────────────────────────

export interface BarJournalDaySummary {
  day: string
  path: string
  exists: boolean
  totalBarRows: number
  corruptLineCount: number
  tornLineCount: number
  duplicateBarIdentities: string[]
  /** symbol -> latest observed bar's barStart (ms), among symbols relevant to
   *  this day's official/pre-official candidates only (bounded scan). */
  latestBarStartBySymbol: Record<string, number>
  /** symbol -> true if a >150s gap was found between consecutive bars for
   *  that symbol (mirrors resolver.ts's own causal-gap convention, read-only). */
  causalGapBySymbol: Record<string, boolean>
}

export interface BarJournalSummary {
  days: BarJournalDaySummary[]
  totalCorruptLines: number
  daysMissingEntirely: string[]
}

/** Discover the set of ET trading days worth checking the bar journal for —
 *  every day that appears in the candidate journal (official or pre-official),
 *  since that is the set the resolver would actually need bars for. */
export function relevantTradingDays(candidateEvents: CandidateEvent[]): { day: string; symbols: Set<string> }[] {
  const byDay = new Map<string, Set<string>>()
  for (const ev of candidateEvents) {
    const payload = ev.payload as QualityOnlyCandidate
    if (!payload?.etTradingDay || !payload?.symbol) continue
    if (!byDay.has(payload.etTradingDay)) byDay.set(payload.etTradingDay, new Set())
    byDay.get(payload.etTradingDay)!.add(payload.symbol)
  }
  return [...byDay.entries()].map(([day, symbols]) => ({ day, symbols }))
}

export function inspectBarJournal(
  daysAndSymbols: { day: string; symbols: Set<string> }[],
  pathForDay: (day: string) => string = defaultBarJournalPath,
): BarJournalSummary {
  const days: BarJournalDaySummary[] = []
  const daysMissingEntirely: string[] = []
  for (const { day, symbols } of daysAndSymbols) {
    const path = pathForDay(day)
    if (!existsSync(path)) {
      daysMissingEntirely.push(day)
      days.push({
        day, path, exists: false, totalBarRows: 0, corruptLineCount: 0, tornLineCount: 0,
        duplicateBarIdentities: [], latestBarStartBySymbol: {}, causalGapBySymbol: {},
      })
      continue
    }
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch {
      daysMissingEntirely.push(day)
      days.push({
        day, path, exists: false, totalBarRows: 0, corruptLineCount: 0, tornLineCount: 0,
        duplicateBarIdentities: [], latestBarStartBySymbol: {}, causalGapBySymbol: {},
      })
      continue
    }
    const seen = new Map<string, ResearchBar>()
    const byIdentityCount = new Map<string, number>()
    const barsBySymbol = new Map<string, ResearchBar[]>()
    let corruptLineCount = 0
    let tornLineCount = 0
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      const parsed: ParsedBarLine = parseBarLine(line)
      if (!parsed.ok) {
        corruptLineCount++
        if (parsed.reason === 'torn_line') tornLineCount++
        continue
      }
      const key = `${parsed.bar.symbol}:${parsed.bar.barStart}`
      byIdentityCount.set(key, (byIdentityCount.get(key) ?? 0) + 1)
      if (!seen.has(key)) seen.set(key, parsed.bar)
      if (symbols.has(parsed.bar.symbol)) {
        if (!barsBySymbol.has(parsed.bar.symbol)) barsBySymbol.set(parsed.bar.symbol, [])
        barsBySymbol.get(parsed.bar.symbol)!.push(parsed.bar)
      }
    }
    const duplicateBarIdentities = [...byIdentityCount.entries()].filter(([, c]) => c > 1).map(([k]) => k)
    const latestBarStartBySymbol: Record<string, number> = {}
    const causalGapBySymbol: Record<string, boolean> = {}
    for (const [symbol, bars] of barsBySymbol) {
      const sorted = [...bars].sort((a, b) => a.barStart - b.barStart)
      latestBarStartBySymbol[symbol] = sorted[sorted.length - 1].barStart
      let gap = false
      for (let i = 1; i < sorted.length; i++) {
        if ((sorted[i].barStart - sorted[i - 1].barStart) / 1000 > CAUSAL_GAP_SECONDS) { gap = true; break }
      }
      causalGapBySymbol[symbol] = gap
    }
    days.push({
      day, path, exists: true, totalBarRows: seen.size, corruptLineCount, tornLineCount,
      duplicateBarIdentities, latestBarStartBySymbol, causalGapBySymbol,
    })
  }
  return { days, totalCorruptLines: days.reduce((s, d) => s + d.corruptLineCount, 0), daysMissingEntirely }
}

// ── 6. Async writer health (bar-journal.ts's queue) ─────────────────────────

export interface AsyncWriterHealth {
  observable: boolean
  note: string
  /** Populated only when `observable` is true (this process IS the daemon's
   *  live process — practically never true for a one-shot CLI run). */
  queuedBytes: number | null
  droppedBatchCount: number | null
  droppedBarCount: number | null
  writeFailureCount: number | null
}

/**
 * bar-journal.ts's queue counters (`__getBarJournalQueueStats()`) are
 * module-level `let` variables inside that file's own process — there is no
 * persisted counter file or degradation log on disk (verified by reading
 * bar-journal.ts in full: `degradationSignal()` only ever calls
 * `console.warn`, it never appends to a file). A separate one-shot CLI
 * process importing bar-journal.ts gets a FRESH module instance with all
 * counters at zero — that would be actively misleading to report as "0
 * drops", since it says nothing about the real daemon process's queue. This
 * function therefore honestly reports "not observable" rather than reading
 * (and silently misrepresenting) counters from the wrong process, UNLESS the
 * caller explicitly passes a live snapshot obtained by running in-process
 * inside the daemon itself.
 */
export function inspectAsyncWriterHealth(liveSnapshot?: {
  queuedBytes: number; droppedBatchCount: number; droppedBarCount: number; writeFailureCount: number
}): AsyncWriterHealth {
  if (liveSnapshot) {
    return {
      observable: true,
      note: 'live snapshot passed in from the process holding bar-journal.ts\'s in-memory queue state',
      queuedBytes: liveSnapshot.queuedBytes,
      droppedBatchCount: liveSnapshot.droppedBatchCount,
      droppedBarCount: liveSnapshot.droppedBarCount,
      writeFailureCount: liveSnapshot.writeFailureCount,
    }
  }
  return {
    observable: false,
    note: 'bar-journal.ts\'s write-queue counters are in-memory only (no persisted counter/degradation-log file exists on disk); this monitor runs as a separate one-shot process and cannot see the live daemon\'s in-memory state. Not observable from here — this is an honest limitation, not a zero reading.',
    queuedBytes: null, droppedBatchCount: null, droppedBarCount: null, writeFailureCount: null,
  }
}

// ── 7. Resolver health ───────────────────────────────────────────────────────

export interface ResolverHealth {
  lastSuccessfulPassObservable: boolean
  note: string
  stillPendingCount: number
  stuckCandidateIdentities: string[]
  journalReadable: boolean
}

export function inspectResolverHealth(candidateInfo: CandidateJournalInfo): ResolverHealth {
  return {
    lastSuccessfulPassObservable: false,
    note: 'resolver.ts keeps no separate cursor/state file of its own (its own module doc: "this module keeps no separate cursor/state file of its own" — it re-derives pending state from the journal on every call), so there is no persisted last-run timestamp/heartbeat to read. Not observable from a static file inspection.',
    stillPendingCount: candidateInfo.unresolvedCandidateIdentities.length,
    stuckCandidateIdentities: candidateInfo.stuckUnresolvedIdentities,
    journalReadable: candidateInfo.exists,
  }
}

// ── 8. Isolation (static, grep-based) ───────────────────────────────────────

export interface IsolationCheck {
  ok: boolean
  brokerOrPaperExecutorImportFound: boolean
  incrementalProviderRequestFound: boolean
  details: string[]
}

/**
 * Static structural proof, mirroring tests/quality-only.test.ts's existing
 * grep-based checks (test 16/17/20-ish) — never runs any code, just greps
 * source text under src/lib/experiments/quality-only/ and
 * src/lib/research/quality-only-integrity.ts (this file) for prohibited
 * imports/identifiers.
 */
export function inspectIsolation(cwd: string = process.cwd()): IsolationCheck {
  const details: string[] = []
  let brokerFound = false
  let providerFound = false
  try {
    const grepBroker = execSync(
      // Only match an actual ES import/require statement whose module
      // specifier names a broker/alpaca/executor module — NOT prose comments
      // that merely document the prohibition's absence (those legitimately
      // contain the same words).
      `grep -rnE "^\\s*(import .*from\\s+['\\"].*(alpaca|broker|executor)|.*=\\s*require\\(['\\"].*(alpaca|broker|executor))" src/lib/experiments/quality-only src/lib/research/quality-only-integrity.ts || true`,
      { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim()
    const suspiciousLines = grepBroker.split('\n').filter(l => l.trim().length > 0)
    if (suspiciousLines.length > 0) { brokerFound = true; details.push(...suspiciousLines) }
  } catch { /* grep failure -> fail open on the check running, not on the verdict */ }
  try {
    const grepFetch = execSync(
      `grep -rniE "\\bfetch\\(|axios\\.|http\\.request" src/lib/experiments/quality-only src/lib/research/quality-only-integrity.ts || true`,
      { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim()
    if (grepFetch.length > 0) { providerFound = true; details.push(...grepFetch.split('\n')) }
  } catch { /* ditto */ }
  return { ok: !brokerFound && !providerFound, brokerOrPaperExecutorImportFound: brokerFound, incrementalProviderRequestFound: providerFound, details }
}

// ── Health classification — pure, deterministic ─────────────────────────────

export type HealthStatus = 'NOT_STARTED' | 'HEALTHY' | 'ATTENTION' | 'INVALID'

export interface HealthClassification {
  status: HealthStatus
  reasons: string[]
}

/**
 * Pure decision function — no I/O. `NOT_STARTED` is a DISTINCT lifecycle
 * state, not a member of the HEALTHY/ATTENTION/INVALID triad the task asks
 * for: it means "there is no official collection yet to judge," which is
 * categorically different from "there IS a collection and it is invalid."
 * Conflating the two would make an operator page-worthy-panic over a state
 * that just means "haven't started the epoch yet." Every other input here
 * assumes a marker exists.
 */
export function classifyHealth(input: {
  marker: MarkerInfo
  drift: ProvenanceDrift
  candidateInfo: CandidateJournalInfo
  barInfo: BarJournalSummary
}): HealthClassification {
  const reasons: string[] = []

  if (!input.marker.exists) {
    return { status: 'NOT_STARTED', reasons: ['no collection-start marker exists yet at the configured path — epoch 1 has not begun. This is a lifecycle state, not a defect.'] }
  }
  if (input.marker.parseError) {
    return { status: 'INVALID', reasons: [`marker file exists but is unparseable (${input.marker.parseError}) — official sample membership cannot be established without a valid, readable marker.`] }
  }

  // `input.drift` (inspector-only provenance) is intentionally never read
  // here — see the NOTE above the INVALID block. Kept in the input type for
  // callers/future reporting use, not because classifyHealth needs it.
  const { candidateInfo, barInfo } = input

  // ── Hard INVALID conditions ────────────────────────────────────────────
  // NOTE: this deliberately does NOT compare the marker against `drift`'s
  // inspectorSpecVersion/inspectorEpoch/inspectorConfigHash/
  // inspectorDecisionPolicyHash fields — those describe whatever code this
  // CLI's own checkout happens to have on disk right now (e.g. a separate
  // tooling branch with unrelated changes), never the frozen experiment
  // producer. Official-epoch validity is judged from what the real producer
  // (the live daemon) actually STAMPED on each OFFICIAL candidate/outcome
  // artifact's own `provenance` field — see `officialArtifactProvenanceIssues`
  // (computed in inspectCandidateJournal, checked against the marker there).
  // Zero official rows -> nothing to check yet -> the marker alone remains
  // authoritative, exactly as intended.
  if (candidateInfo.officialArtifactProvenanceIssues.length > 0) {
    reasons.push(`${candidateInfo.officialArtifactProvenanceIssues.length} OFFICIAL artifact(s) have provenance that does not match the marker (producerGitHead/specVersion/epoch/configHash/decisionPolicyHash) — the official sample's producer identity cannot be trusted. Detail: ${candidateInfo.officialArtifactProvenanceIssues.slice(0, 3).join('; ')}${candidateInfo.officialArtifactProvenanceIssues.length > 3 ? '; ...' : ''}`)
  }
  if (candidateInfo.causalityViolations.length > 0) {
    reasons.push(`${candidateInfo.causalityViolations.length} candidate row(s) claim official membership (stored preOfficial=false) but were actually observed before the marker's createdAt — causality violation, official sample membership cannot be trusted.`)
  }
  if (candidateInfo.duplicateOutcomeIdentities.length > 0) {
    reasons.push(`${candidateInfo.duplicateOutcomeIdentities.length} identity(ies) have more than one outcome event — violates the exactly-one-outcome-per-candidate invariant.`)
  }
  const officialTouchingCorruption = candidateInfo.corruptLines.filter(c => c.bound === 'touches_official_or_unknown')
  if (officialTouchingCorruption.length > 0) {
    reasons.push(`${officialTouchingCorruption.length} corrupt/torn journal line(s) cannot be conservatively bounded away from the official window — official sample membership around those lines is unknowable.`)
  }
  if (reasons.length > 0) return { status: 'INVALID', reasons }

  // ── ATTENTION conditions ────────────────────────────────────────────────
  // NOTE ON SCOPING: every condition below that could be satisfied purely by
  // historical PRE_OFFICIAL fixtures (rows observed before the marker even
  // existed) is gated on the OFFICIAL-scoped variant of that count, never the
  // raw/global one. A stuck synthetic test candidate from before collection
  // started is expected, permanent, harmless noise — it is still counted and
  // visibly reported (see the CLI's "PRE_OFFICIAL" section), but it must not
  // by itself downgrade HEALTHY to ATTENTION. Findings that are inherently
  // about the OFFICIAL sample's own trustworthiness (mislabeling, duplicate
  // OUTCOME identities) remain unscoped/global, since those are correctness
  // signals regardless of which rows they were first observed on.
  const attention: string[] = []
  if (candidateInfo.officialOutcomeStatusCounts.DEGRADED > 0) {
    attention.push(`${candidateInfo.officialOutcomeStatusCounts.DEGRADED} OFFICIAL outcome(s) resolved DEGRADED — an expected, handled state, worth a look.`)
  }
  if (candidateInfo.duplicateCandidateIdentitiesOfficial.length > 0) {
    attention.push(`${candidateInfo.duplicateCandidateIdentitiesOfficial.length} OFFICIAL candidate identity(ies) appear more than once (earliest-wins convention absorbs this, but worth a look).`)
  }
  if (candidateInfo.orphanOutcomeIdentities.length > 0) {
    attention.push(`${candidateInfo.orphanOutcomeIdentities.length} outcome event(s) have no matching candidate event.`)
  }
  if (candidateInfo.officialRowsMislabeledPreOfficial.length > 0) {
    attention.push(`${candidateInfo.officialRowsMislabeledPreOfficial.length} truly-official row(s) are mislabeled preOfficial=true on disk (known producer defect — see module doc). This monitor's own counts recompute correctly, but any other consumer trusting the raw field will undercount the official sample.`)
  }
  if (candidateInfo.stuckUnresolvedOfficialIdentities.length > 0) {
    attention.push(`${candidateInfo.stuckUnresolvedOfficialIdentities.length} OFFICIAL candidate(s) unresolved well past the 30m horizon + grace window — possible stuck resolver.`)
  }
  const boundedCorruption = candidateInfo.corruptLines.filter(c => c.bound === 'bounded_pre_official')
  if (boundedCorruption.length > 0) {
    attention.push(`${boundedCorruption.length} corrupt/torn journal line(s) found, but conservatively bounded to the pre-official window only — does not touch official sample membership.`)
  }
  if (barInfo.totalCorruptLines > 0) {
    attention.push(`${barInfo.totalCorruptLines} corrupt/torn bar-journal line(s) found (capped at ATTENTION — see classifyHealth's bar-corruption rule below).`)
  }
  if (barInfo.days.some(d => d.duplicateBarIdentities.length > 0)) {
    attention.push('duplicate (symbol, barStart) bar rows found in the bar journal.')
  }
  if (barInfo.days.some(d => Object.values(d.causalGapBySymbol).some(Boolean))) {
    attention.push('a >150s causal gap was found between consecutive bars for at least one symbol/day.')
  }
  if (candidateInfo.officialCandidateCount > 0 && barInfo.daysMissingEntirely.length > 0) {
    attention.push(`bar journal file missing entirely for ${barInfo.daysMissingEntirely.length} relevant trading day(s) with official candidates.`)
  }

  if (attention.length > 0) return { status: 'ATTENTION', reasons: attention }
  return { status: 'HEALTHY', reasons: [] }
}

/*
 * ── Bar-journal corruption severity rule (explicit, per task ask) ──────────
 * Bar-journal corruption is CAPPED AT ATTENTION, never INVALID, regardless of
 * how much of the file is corrupt. Rationale: the bar journal is a
 * completeness/resolvability signal ONLY — official candidate/outcome sample
 * MEMBERSHIP is determined solely by the candidate journal + marker
 * (candidateObservedAt vs marker.createdAt). A corrupt bar journal can, at
 * worst, prevent the resolver from ever reaching SCORABLE/CENSORED and push a
 * candidate to DEGRADED or leave it PENDING/stuck — both of which are already
 * handled, visible states this monitor separately surfaces (DEGRADED counts,
 * stuck-candidate detection). It can never retroactively make an already-
 * admitted official candidate's OWN identity/timestamp/membership invalid.
 */
