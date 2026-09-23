/**
 * Prospective discovery-capture journal.
 *
 * ── THE FOUR UNIVERSES (do not collapse into one "the universe") ───────────
 * A prior architecture review found four distinct universes in this codebase:
 *   1. GAINERS ROUTE UNIVERSE   — the ranked rows `/api/gainers` returns
 *      (src/app/api/gainers/route.ts, the `ranked` array, ~line 516).
 *   2. DAEMON EXECUTION UNIVERSE — scripts/alert-daemon.ts's `fetchUniverse()`,
 *      which re-sorts the route's rows by raw `changePct` (discarding the
 *      route's own momentum `rank`) and truncates to `TOP_GAINERS_UNIVERSE`
 *      (15). THIS is what `sweep()` iterates and what drives real alerts.
 *   3. UI UNIVERSE (src/hooks/useScanner.ts) — OUT OF SCOPE here.
 *   4. MIKE UNIVERSE (scripts/mike-scan.ts) — OUT OF SCOPE here.
 *
 * This module captures ONLY the causal path: ROUTE -> DAEMON EXECUTION ->
 * MONITOR -> SETUP -> BASE DECISION. It never touches UI or Mike.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
 * It cannot reconstruct rows the ROUTE ITSELF dropped before the daemon ever
 * saw them (e.g. a symbol Yahoo/FMP/Webull never surfaced at all, or one the
 * route's own filters excluded) — that is a known, structural gap: this
 * observer sees only what `/api/gainers`'s JSON body already contains. No
 * exclusion reason upstream of that boundary is ever invented; it is marked
 * `reasonUnavailable: true` instead.
 *
 * ── PATTERNS REUSED, NOT REINVENTED ──────────────────────────────────────
 * - Day-keyed file path, dedup-by-key, and torn-line handling mirror
 *   src/lib/research/bar-journal.ts's conventions exactly (own git-head
 *   best-effort helper, `{ok:true,...}` / `{ok:false,reason,raw}` parse
 *   result, existsSync-guarded reads that never throw).
 * - Durable writes use a single plain `appendFileSync` per sweep (see
 *   `appendSweepBatch` below) — no queue, no reuse of QUALITY_ONLY's
 *   `JournalWriter` class (an earlier revision did; removed so this module
 *   makes exactly one filesystem append call per sweep instead of one per
 *   enqueued record).
 *
 * PAPER/RESEARCH ONLY. No broker/PaperExecutor/execution import anywhere in
 * this file. Zero network/provider fetches — every input here is data the
 * daemon's sweep already fetched for its own purposes.
 */
import { homedir } from 'os'
import { join } from 'path'
// Namespace import (not a destructured named import) so a test can
// `vi.spyOn(fs, 'appendFileSync')` and actually intercept the call below —
// `import { appendFileSync } from 'fs'` captures the function reference at
// import time under this project's CJS interop, which a later spy on the
// module object would not affect.
import * as fs from 'fs'
import { execSync } from 'child_process'
import { etTradingDay } from '@/lib/research/shadow-journal'

export const UNIVERSE_JOURNAL_SCHEMA_VERSION = 1
export const UNIVERSE_OBSERVER_VERSION = 'universe-capture-v1'

// ── git provenance (self-contained, mirrors bar-journal.ts's own helper) ────
// Deliberately NOT importing quality-only/spec.ts's `Provenance`/
// `buildProvenance` — that type carries QUALITY_ONLY-specific fields
// (specVersion/epoch/configHash/decisionPolicyHash) that mean nothing for
// this capture, and fabricating values for them would violate "never
// invent a field the data doesn't support".
let cachedGitHead: string | null = null
let cachedGitBranch: string | null = null
function gitHeadBestEffort(): string {
  if (cachedGitHead != null) return cachedGitHead
  try { cachedGitHead = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { cachedGitHead = 'unknown' }
  return cachedGitHead
}
function gitBranchBestEffort(): string {
  if (cachedGitBranch != null) return cachedGitBranch
  try { cachedGitBranch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { cachedGitBranch = 'unknown' }
  return cachedGitBranch
}

/** Test-only escape hatch so a test can pin git head/branch without a real
 *  repo lookup. Never used by production code. */
export function __setGitProvenanceForTests(head: string | null, branch: string | null): void {
  cachedGitHead = head
  cachedGitBranch = branch
}

// ── Route/daemon-layer input (already-fetched JSON; no new fetches) ────────

/** One row exactly as `/api/gainers` already returned it, reduced to the
 *  discovery-relevant fields this capture layer records. Built by widening
 *  `fetchUniverse()`'s return type in scripts/alert-daemon.ts — the route's
 *  JSON body already contains all of these; the daemon previously discarded
 *  everything but `symbol`. */
export interface RouteUniverseRow {
  symbol: string
  /** The route's own final position — `ScannerRow.rank`, a real, literal
   *  field the route returns (src/types/index.ts, `ScannerRow.rank: number`)
   *  after its momentum re-rank — NOT the daemon's re-sort. Null only if a
   *  given row is missing it at runtime (defensive; the type is
   *  non-optional). The name `routeRank` is a direct, accurate
   *  correspondence to a field the route actually supplies. */
  routeRank: number | null
  /** The route's actual ranking/sort metric — `ScannerRow.momentumScore`
   *  (src/lib/momentum-rank.ts's `readMomentum().score`). Named
   *  `routeMomentumScore` here to preserve direct correspondence with the
   *  runtime field name; never called "routeScore" (a generic name the route
   *  does not use for anything). */
  routeMomentumScore: number | null
  changePct: number | null
  price: number | null
  volume: number | null
  relativeVolume: number | null
}

// ── Journal record kinds (append-only NDJSON) ───────────────────────────────

interface JournalCommon {
  schemaVersion: number
  observerVersion: string
  producerGitHead: string
  producerGitBranch: string
  etTradingDay: string
  sweepId: string
  sweepObservedAt: number
}

export interface SweepEnvelope extends JournalCommon {
  recordType: 'sweep_envelope'
  /** The route response's own `timestamp` field, if present. */
  routeComputedAt: number | null
  /** How stale the route response was relative to when THIS sweep observed
   *  it (`sweepObservedAt - routeComputedAt`). A single per-sweep causal
   *  fact — never an aggregate/statistical rollup. Null when the route
   *  didn't report a timestamp. */
  snapshotAgeMs: number | null
  /** How many SymbolRecords this sweep is about to write — lets a reader
   *  detect a torn/incomplete sweep by comparing against rows actually
   *  found for this sweepId. */
  expectedSymbolRowCount: number
}

export type BaseDecision = 'TAKE' | 'VETO' | 'NO_TRIGGER' | 'UNAVAILABLE'

export interface SymbolRecord extends JournalCommon {
  recordType: 'symbol_record'
  symbol: string
  // ── ROUTE LAYER ────────────────────────────────────────────────────────
  routeRank: number | null
  routeMomentumScore: number | null
  changePct: number | null
  price: number | null
  volume: number | null
  relativeVolume: number | null
  // ── DAEMON LAYER ───────────────────────────────────────────────────────
  /** Position after the daemon's OWN re-sort/truncation; null when the
   *  symbol did not survive into the daemon's kept set. */
  daemonRank: number | null
  inDaemonExecutionUniverse: boolean
  /** The configured cutoff (e.g. 15), for self-documentation. */
  daemonTopN: number
  /** What the daemon actually sorts by, as an observed fact — see
   *  `DAEMON_SORT_METRIC` below. This module does not change that behavior. */
  daemonSortMetric: string
  // ── MONITOR LAYER ──────────────────────────────────────────────────────
  monitorRequested: boolean
  monitorResultAvailable: boolean
  // ── SETUP LAYER ────────────────────────────────────────────────────────
  setupTriggered: boolean
  setupId: string | null
  // ── BASE LAYER ─────────────────────────────────────────────────────────
  baseDecision: BaseDecision
  /** The verbatim classifyBuy() verdict string when one exists (e.g.
   *  'logged' | 'veto' | 'session' | 'volume' | 'standDown' | 'capped' |
   *  'dup') — never invented. `baseDecision` above is the coarse 4-value
   *  bucket the schema requires; this preserves the underlying fact
   *  losslessly rather than discarding it to fit the bucket. */
  baseVerdictRaw: string | null
  /** True whenever an upstream inclusion/exclusion fact cannot be causally
   *  known from data this daemon actually has (route never returned the
   *  symbol into scope for the layer in question, or the daemon truncated
   *  it before monitor/setup could ever run). */
  reasonUnavailable: boolean
}

export type UniverseJournalRecord = SweepEnvelope | SymbolRecord

/**
 * Documented OBSERVED FACT about the daemon's current behavior (not a design
 * decision made by this module): `fetchUniverse()` in scripts/alert-daemon.ts
 * re-sorts by raw `changePct`, descending, with NO explicit secondary/
 * tie-break key. `Array.prototype.sort` is stable in Node (V8, guaranteed
 * since ES2019), so exact `changePct` ties are broken by whatever order the
 * route's own `rows` array (already momentum-ranked) happened to hand them
 * in — an artifact of sort stability, not an intentional tie-break rule.
 */
export const DAEMON_SORT_METRIC = 'changePct (raw, descending) — no explicit tie-break; ties resolved only by Array.prototype.sort stability over the route\'s prior order'

// ── Day-keyed path convention (mirrors bar-journal.ts / shadow-journal.ts) ──

export function universeJournalPath(day: string): string {
  return join(homedir(), `.companion-universe-capture-${day}.ndjson`)
}

// ── Building one sweep's records (pure — caller supplies already-fetched data) ──

export interface BuildSweepArgs {
  now: number
  sweepId: string
  routeComputedAt: number | null
  /** EVERY row the route returned this sweep, not just the daemon's kept
   *  top-N — required so Layer-B analysis (route returned it, daemon
   *  dropped it) is reconstructable after the fact. */
  routeRows: RouteUniverseRow[]
  /** The symbols the daemon actually kept after its own re-sort/truncation,
   *  in that kept order (index 0 = daemon rank 1). */
  daemonSymbols: string[]
  daemonTopN: number
  /** Symbols actually POSTed to /api/monitor this sweep. */
  monitorRequestedSymbols: string[]
  /** Symbols a MonitorResult object actually came back for (present in the
   *  /api/monitor response), independent of whether that result carried an
   *  internal `error` field. */
  monitorResultSymbols: string[]
}

export function buildSweepRecords(args: BuildSweepArgs): { envelope: SweepEnvelope; recordsBySymbol: Map<string, SymbolRecord> } {
  const { now, sweepId, routeComputedAt, routeRows, daemonSymbols, daemonTopN, monitorRequestedSymbols, monitorResultSymbols } = args
  const day = etTradingDay(now)
  const daemonSet = new Set(daemonSymbols)
  const requestedSet = new Set(monitorRequestedSymbols)
  const availableSet = new Set(monitorResultSymbols)

  const common: JournalCommon = {
    schemaVersion: UNIVERSE_JOURNAL_SCHEMA_VERSION,
    observerVersion: UNIVERSE_OBSERVER_VERSION,
    producerGitHead: gitHeadBestEffort(),
    producerGitBranch: gitBranchBestEffort(),
    etTradingDay: day,
    sweepId,
    sweepObservedAt: now,
  }

  const envelope: SweepEnvelope = {
    ...common,
    recordType: 'sweep_envelope',
    routeComputedAt,
    snapshotAgeMs: routeComputedAt != null ? now - routeComputedAt : null,
    expectedSymbolRowCount: routeRows.length,
  }

  const daemonRankBySymbol = new Map<string, number>()
  daemonSymbols.forEach((s, i) => daemonRankBySymbol.set(s, i + 1))

  const recordsBySymbol = new Map<string, SymbolRecord>()
  for (const row of routeRows) {
    const inDaemon = daemonSet.has(row.symbol)
    const monitorRequested = requestedSet.has(row.symbol)
    const monitorResultAvailable = availableSet.has(row.symbol)
    // A symbol never reaching the daemon universe, or reaching it but never
    // getting a monitor result back, means SETUP/BASE facts are causally
    // unknowable here — mark UNAVAILABLE rather than guessing NO_TRIGGER.
    const unavailable = !inDaemon || !monitorResultAvailable
    recordsBySymbol.set(row.symbol, {
      ...common,
      recordType: 'symbol_record',
      symbol: row.symbol,
      routeRank: row.routeRank,
      routeMomentumScore: row.routeMomentumScore,
      changePct: row.changePct,
      price: row.price,
      volume: row.volume,
      relativeVolume: row.relativeVolume,
      daemonRank: daemonRankBySymbol.get(row.symbol) ?? null,
      inDaemonExecutionUniverse: inDaemon,
      daemonTopN,
      daemonSortMetric: DAEMON_SORT_METRIC,
      monitorRequested,
      monitorResultAvailable,
      setupTriggered: false,
      setupId: null,
      baseDecision: unavailable ? 'UNAVAILABLE' : 'NO_TRIGGER',
      baseVerdictRaw: null,
      reasonUnavailable: unavailable,
    })
  }
  return { envelope, recordsBySymbol }
}

/**
 * Mutates a symbol's already-built record in place with SETUP/BASE-layer
 * facts discovered later in the same sweep's trigger loop (classifyBuy's
 * verdict is already computed by the caller — this never recomputes it).
 * Only ever called for a symbol whose setup ACTUALLY triggered this sweep,
 * so nothing here is invented.
 *
 * A symbol can carry more than one triggered setup in a single sweep; if any
 * of them was actually taken ('logged'), that is recorded as the symbol's
 * baseDecision even if an earlier setup on the same symbol this sweep was
 * vetoed — "was anything on this symbol taken this sweep" is the more
 * decision-relevant fact, and this is a documented simplification (one
 * SymbolRecord per symbol per sweep, not one per setup).
 */
export function attachSetupDecision(record: SymbolRecord, setupId: string, verdict: string): void {
  record.setupTriggered = true
  record.setupId = setupId
  record.baseVerdictRaw = verdict
  const decided: BaseDecision = verdict === 'logged' ? 'TAKE' : 'VETO'
  if (record.baseDecision !== 'TAKE') record.baseDecision = decided
  record.reasonUnavailable = false
}

// ── Durable append: exactly ONE appendFileSync per sweep ────────────────────

/**
 * Writes one sweep's envelope + all its symbol records with exactly ONE
 * `appendFileSync` call, regardless of how many symbols this sweep saw.
 *
 * Earlier revision reused QUALITY_ONLY's `JournalWriter` class (a
 * queue-push + async-drain writer) via a structural type cast. That gave
 * durable per-sweep writes, but at the cost of one `appendFileSync` PER
 * ENQUEUED RECORD (an envelope plus N symbol rows = N+1 filesystem append
 * syscalls per sweep) and a lifetime in-memory queue this module has no
 * actual need for — this capture never batches across sweeps, so there is
 * nothing for a queue to usefully hold. Serializing the whole sweep
 * (envelope + every symbol record) into ONE newline-joined NDJSON payload
 * and issuing ONE synchronous `appendFileSync` for it is simpler, cheaper,
 * and — critically — makes "this sweep's write either fully happened or
 * fully didn't" the natural unit of failure, rather than "N+1 independent
 * writes that could each independently fail mid-sweep." `JournalWriter` is
 * no longer imported by this file.
 *
 * Durability/failure semantics unchanged from before: this call is
 * synchronous (returns only after the data has been handed to the OS via
 * `appendFileSync`, no lifetime async queue), and a write failure (e.g. disk
 * full, permission error) propagates as a normal thrown exception — the
 * CALLER (scripts/alert-daemon.ts's `sweep()`) wraps this call in try/catch
 * so a capture-layer write failure can never alter BASE/execution behavior;
 * this function does not swallow its own errors, so that boundary catch
 * actually sees them rather than silently losing the failure.
 *
 * No fsync: matches this repo's existing research-journal convention
 * (bar-journal.ts, quality-only/persistence.ts) of a plain buffered
 * `appendFileSync` — nothing in this codebase's production conventions
 * requires fsync-per-write for research-only data, and one OS-buffered
 * append syscall per sweep is sufficient for this design's durability goal
 * (survive a clean process exit; a hard OS/power failure mid-write is
 * exactly the torn-line case `parseUniverseLine`/`sweepCompleteness` already
 * detect and never silently repair).
 *
 * `writeFn` is an injectable seam (same pattern as this codebase's
 * `PriceFetcher`/`GitRunner` injection elsewhere) defaulting to the real
 * `fs.appendFileSync` in every production call site — it exists ONLY so a
 * test can prove "exactly one call" and "a write failure propagates as a
 * normal thrown error" directly and reliably, without needing to mock
 * Node's built-in `fs` module (which proved unreliable to intercept via
 * `vi.spyOn` under this project's module transform for a plain named/
 * namespace import of a Node builtin).
 */
export function appendSweepBatch(
  envelope: SweepEnvelope,
  records: SymbolRecord[],
  writeFn: (path: string, data: string) => void = fs.appendFileSync,
): { recordCount: number } {
  const path = universeJournalPath(envelope.etTradingDay)
  const payload = [envelope as UniverseJournalRecord, ...records].map(r => JSON.stringify(r)).join('\n') + '\n'
  writeFn(path, payload)
  return { recordCount: records.length + 1 }
}

// ── Read side: parsing, corruption handling ─────────────────────────────────

export type ParsedUniverseLine =
  | { ok: true; record: UniverseJournalRecord }
  | { ok: false; reason: 'empty' | 'malformed_json' | 'missing_required_field' | 'torn_line'; raw: string }

const REQUIRED_COMMON_FIELDS = [
  'schemaVersion', 'observerVersion', 'producerGitHead', 'producerGitBranch',
  'etTradingDay', 'sweepId', 'sweepObservedAt', 'recordType',
] as const

/** Parse one journal line. FAILS CONSERVATIVELY, same convention as
 *  persistence.ts's `parseJournalLine` / bar-journal.ts's `parseBarLine`: a
 *  malformed or torn line (process died mid-write) is never silently
 *  dropped or coerced — it comes back as an explicit `ok:false` record. */
export function parseUniverseLine(raw: string): ParsedUniverseLine {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty', raw }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: trimmed.endsWith('}') ? 'malformed_json' : 'torn_line', raw }
  }
  if (obj == null || typeof obj !== 'object') return { ok: false, reason: 'malformed_json', raw }
  for (const f of REQUIRED_COMMON_FIELDS) {
    if (!(f in (obj as Record<string, unknown>))) return { ok: false, reason: 'missing_required_field', raw }
  }
  const rt = (obj as Record<string, unknown>).recordType
  if (rt !== 'sweep_envelope' && rt !== 'symbol_record') return { ok: false, reason: 'missing_required_field', raw }
  return { ok: true, record: obj as UniverseJournalRecord }
}

export interface LoadedUniverseJournal {
  envelopes: SweepEnvelope[]
  symbolRecords: SymbolRecord[]
  corrupt: ParsedUniverseLine[]
}

/**
 * Reads + parses one day's journal. Dedupes by `sweepId` (envelopes) / by
 * `sweepId:symbol` (symbol records) — EARLIEST occurrence in file order
 * wins, matching the "earliest observation wins" convention used throughout
 * this codebase's research journals (bar-journal.ts, resolver.ts). Missing
 * file -> empty result; never throws.
 */
export function loadUniverseJournal(day: string, pathOverride?: string): LoadedUniverseJournal {
  const path = pathOverride ?? universeJournalPath(day)
  if (!fs.existsSync(path)) return { envelopes: [], symbolRecords: [], corrupt: [] }
  let raw: string
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch {
    return { envelopes: [], symbolRecords: [], corrupt: [] }
  }

  const seenEnvelopeSweeps = new Set<string>()
  const seenSymbolKeys = new Set<string>()
  const envelopes: SweepEnvelope[] = []
  const symbolRecords: SymbolRecord[] = []
  const corrupt: ParsedUniverseLine[] = []

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = parseUniverseLine(line)
    if (!parsed.ok) { corrupt.push(parsed); continue }
    const rec = parsed.record
    if (rec.recordType === 'sweep_envelope') {
      if (seenEnvelopeSweeps.has(rec.sweepId)) continue
      seenEnvelopeSweeps.add(rec.sweepId)
      envelopes.push(rec)
    } else {
      const key = `${rec.sweepId}:${rec.symbol}`
      if (seenSymbolKeys.has(key)) continue
      seenSymbolKeys.add(key)
      symbolRecords.push(rec)
    }
  }
  return { envelopes, symbolRecords, corrupt }
}

/**
 * Is a given sweep COMPLETE (actual symbol-record count matches the
 * envelope's own declared expectation) or torn/partial? A sweep whose
 * envelope line itself never made it to disk (or was corrupt) cannot be
 * judged at all and is reported as `envelopeFound: false` rather than
 * guessed at either way.
 */
export function sweepCompleteness(day: string, sweepId: string, pathOverride?: string): {
  envelopeFound: boolean; expected: number | null; actual: number; complete: boolean
} {
  const { envelopes, symbolRecords } = loadUniverseJournal(day, pathOverride)
  const envelope = envelopes.find(e => e.sweepId === sweepId)
  const actual = symbolRecords.filter(r => r.sweepId === sweepId).length
  if (!envelope) return { envelopeFound: false, expected: null, actual, complete: false }
  return { envelopeFound: true, expected: envelope.expectedSymbolRowCount, actual, complete: actual === envelope.expectedSymbolRowCount }
}

// ── Restart-safe re-derivation ───────────────────────────────────────────

export interface SymbolDayState {
  symbol: string
  firstSeenAt: number | null
  lastSeenAt: number | null
  firstEnteredDaemonUniverseAt: number | null
  /** The symbol's routeRank/daemonRank as of the sweep BEFORE the most
   *  recently processed one it appeared in (null if this is the first
   *  sweep it was ever seen in). */
  previousRouteRank: number | null
  previousDaemonRank: number | null
  /**
   * The first sweep, in causal (append) order, that observed this symbol
   * ABSENT from the route's response having been previously seen. This is a
   * READ-TIME INFERENCE about the sweep that noticed the absence — absence
   * is only ever knowable at the NEXT sweep that fails to see the symbol,
   * never at the moment it actually left. There is deliberately NO
   * `exitedUniverseAt` field anywhere in this schema: that would imply an
   * exact causal exit instant this data cannot support.
   */
  firstAbsentObservedAt: number | null
  /** The first sweep, after a `firstAbsentObservedAt`, where the symbol was
   *  observed present again. Null if never absent, or absent and not yet
   *  seen again. */
  reenteredAt: number | null
}

/**
 * Re-derives per-symbol state for one ET trading day PURELY from that day's
 * journal file — the restart-safe pattern used elsewhere in this repo
 * (bar-journal.ts's dedup-by-barStart read, the QUALITY_ONLY resolver's
 * re-derivation from its own journal) rather than fragile in-memory-only
 * state. Pure function of file contents: calling this twice against the
 * same file yields byte-identical results (same-day-restart determinism).
 */
export function deriveUniverseDayState(day: string, pathOverride?: string): Map<string, SymbolDayState> {
  const { envelopes, symbolRecords } = loadUniverseJournal(day, pathOverride)

  // Sweep ordering is causal (sweepObservedAt), not file order (which is
  // already append order in practice, but we don't rely on that). A
  // symbolRecord whose own envelope line was itself corrupt/missing is
  // still included, ordered by its own sweepObservedAt.
  const sweepOrder = new Map<string, number>()
  for (const e of envelopes) sweepOrder.set(e.sweepId, e.sweepObservedAt)
  const bySweep = new Map<string, SymbolRecord[]>()
  for (const r of symbolRecords) {
    if (!sweepOrder.has(r.sweepId)) sweepOrder.set(r.sweepId, r.sweepObservedAt)
    if (!bySweep.has(r.sweepId)) bySweep.set(r.sweepId, [])
    bySweep.get(r.sweepId)!.push(r)
  }
  const orderedSweepIds = [...sweepOrder.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)

  const state = new Map<string, SymbolDayState>()
  let presentLastSweep = new Set<string>()

  for (const sweepId of orderedSweepIds) {
    const records = bySweep.get(sweepId) ?? []
    const observedAt = sweepOrder.get(sweepId)!
    const presentThisSweep = new Set(records.map(r => r.symbol))

    for (const r of records) {
      let s = state.get(r.symbol)
      if (!s) {
        s = {
          symbol: r.symbol, firstSeenAt: observedAt, lastSeenAt: observedAt,
          firstEnteredDaemonUniverseAt: null, previousRouteRank: null, previousDaemonRank: null,
          firstAbsentObservedAt: null, reenteredAt: null,
        }
        state.set(r.symbol, s)
      } else if (s.firstAbsentObservedAt != null && s.reenteredAt == null) {
        // Was previously marked absent, and is seen again now — a re-entry,
        // caused only by THIS sweep's observation (no future info used).
        s.reenteredAt = observedAt
      }
      s.lastSeenAt = observedAt
      if (r.inDaemonExecutionUniverse && s.firstEnteredDaemonUniverseAt == null) {
        s.firstEnteredDaemonUniverseAt = observedAt
      }
    }

    // Absence detection: a symbol present as of the previously processed
    // sweep but missing from this one is, AT THIS SWEEP, first observed
    // absent — never backdated to the last sweep it was actually seen in.
    for (const sym of presentLastSweep) {
      if (presentThisSweep.has(sym)) continue
      const s = state.get(sym)
      if (s && s.firstAbsentObservedAt == null) s.firstAbsentObservedAt = observedAt
    }

    presentLastSweep = presentThisSweep
  }

  // previousRouteRank/previousDaemonRank: a second forward pass, since they
  // depend on the PRIOR sweep's rank for the same symbol.
  const lastRouteRank = new Map<string, number | null>()
  const lastDaemonRank = new Map<string, number | null>()
  for (const sweepId of orderedSweepIds) {
    for (const r of bySweep.get(sweepId) ?? []) {
      const s = state.get(r.symbol)!
      s.previousRouteRank = lastRouteRank.has(r.symbol) ? lastRouteRank.get(r.symbol)! : null
      s.previousDaemonRank = lastDaemonRank.has(r.symbol) ? lastDaemonRank.get(r.symbol)! : null
      lastRouteRank.set(r.symbol, r.routeRank)
      lastDaemonRank.set(r.symbol, r.daemonRank)
    }
  }

  return state
}
