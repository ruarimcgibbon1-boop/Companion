/**
 * Generic passive 1-minute research bar journal.
 *
 * ── WHY THIS EXISTS (Phase 1 data-plane trace, summarized here; full trace in
 *    the preregistration PDF) ──────────────────────────────────────────────
 * The canonical live 1m candle feed already exists server-side: buildMonitorResult
 * (src/lib/monitor.ts) fetches it once per symbol under the shared in-process
 * cache key `candles1m:<symbol>` (src/lib/cache.ts), and that SAME cache key is
 * also read by src/app/api/gainers/route.ts, src/lib/snapshot.ts, and
 * scripts/mike-scan.ts — i.e. bars are already being fetched for production
 * purposes well before this module ever runs.
 *
 * That cache is a singleton living inside the Next.js server process's memory
 * (`src/lib/cache.ts`'s `export const cache = new Cache()`). scripts/alert-
 * daemon.ts — and any future standalone resolver process — is a SEPARATE OS
 * process that talks to the server only over HTTP (`fetch(BASE + '/api/monitor')`);
 * it has no access to that process's memory. There is also no existing
 * persistent (on-disk) 1m bar artifact anywhere in this codebase (verified by
 * search: no candle store, parquet file, sqlite table, or bar-specific JSONL
 * log exists prior to this file).
 *
 * So per the task's source priority: (1) no reusable in-memory cache reachable
 * cross-process, (2) no existing persistent artifact, therefore (3) applies —
 * the smallest passive tap at the point canonical bars already exist. This
 * module IS that tap's storage layer; the one-line call site is in
 * src/lib/monitor.ts's buildMonitorResult(), immediately after `intraday` is
 * resolved from the shared cache (see the comment there). It never fetches
 * anything itself — `mirrorBars()` takes the caller's already-fetched
 * `Candle[]` and is a pure disk-append. ZERO incremental provider requests.
 *
 * ── CLOSED vs IN-PROGRESS (causality) ───────────────────────────────────────
 * A provider's most recent bar in any given fetch can still be revised — this
 * codebase already documents FMP's same-day intraday tape as PROVISIONAL (see
 * src/lib/research/phantom-book.ts's `tapeState()`). This module never invents
 * certainty it doesn't have: a bar is mirrored to disk ONLY once there is
 * positive causal evidence it is no longer the newest/forming bar:
 *   (a) a STRICTLY LATER bar already exists in the SAME fetched array (the
 *       provider itself has moved its "current" pointer forward past it), OR
 *   (b) enough wall-clock time (`BAR_CLOSE_SAFETY_MS`, 1.5x a bar's duration)
 *       has elapsed since the bar's open that its one-minute window has
 *       definitively passed — this also covers the LAST bar of a session,
 *       which (a) alone would never mirror (no later bar ever supersedes it).
 * Once written, a bar record is immutable: this module de-dupes by
 * (symbol, barStart) and never re-observes/rewrites a barStart it has already
 * persisted, even if the provider's backend value for that minute is later
 * revised. That is deliberate — the experiment scores candidates on what was
 * causally knowable at observation time, never on a later-revised "true"
 * value (see outcome.ts's causal-boundary convention, which this feeds).
 *
 * Only 1m bars are recorded, per the task's scope. PAPER/RESEARCH ONLY: no
 * broker/PaperExecutor import anywhere in this file; a mirror/read failure
 * here must never affect production (every public function fails open).
 *
 * ── ASYNC I/O (non-blocking monitor path) ──────────────────────────────────
 * `mirrorBars()` is a SYNCHRONOUS function (matches its existing call site in
 * monitor.ts's buildMonitorResult() — no signature/call-site change needed),
 * but it performs ZERO synchronous filesystem I/O. Every eligible bar found
 * in one call is serialized into a single NDJSON payload string and handed
 * to an internal, module-level, serialized async write queue
 * (`fs/promises`' `appendFile`) — one `appendFile` call per `mirrorBars()`
 * invocation, not one per bar. `mirrorBars()` itself never awaits that
 * write; it returns to the caller (buildMonitorResult) the instant the
 * payload is enqueued, so the live `/api/monitor` request path is never
 * blocked on disk, regardless of disk latency.
 *
 * Concurrency: all enqueued writes — from any number of concurrent
 * mirrorBars() calls, for any symbols/paths — are threaded through ONE
 * process-wide promise chain (`writeChain`), so at most one `appendFile` is
 * in flight at a time and payloads are flushed to disk in the exact order
 * they were enqueued. This is deliberate: Node does not guarantee
 * `fs.promises.appendFile` is atomic against a concurrent append on every
 * platform/size, so correctness here relies on our own serialization, not
 * on OS-level atomicity.
 *
 * Backpressure: the queue is bounded by `MAX_QUEUE_BYTES` (see below). If a
 * new batch would push total queued-but-not-yet-flushed bytes over that
 * bound (disk falling behind), the batch is DROPPED — never buffered
 * unboundedly, never allowed to block the caller. A drop is always
 * observable: `degradationSignal()` logs a `RESEARCH_WRITE_DEGRADED` line
 * and increments an in-memory counter (`__getBarJournalQueueStats()`).
 * Dropped bars are still marked in the per-process dedupe set (`written`) so
 * they are not endlessly re-attempted on every subsequent sweep while disk
 * remains slow — the resolver's existing DEGRADED/CENSORED completeness
 * rules pick up the resulting gap; this file does not change those rules.
 *
 * A write's rejection (e.g. ENOENT, EACCES) is caught inside the chain
 * itself, logged via the same degradation signal, and never rethrown —
 * so there is no unhandled promise rejection anywhere in this path, and a
 * research write failure can never propagate into BASE.
 *
 * Shutdown: this module lives in the Next.js server process (not
 * scripts/alert-daemon.ts, a separate OS process) and intentionally has NO
 * shutdown/flush hook wired into production. Production availability
 * outranks research completeness for this research-only path: an abrupt
 * server death can lose whatever is still queued, and that loss simply
 * surfaces later as DEGRADED/CENSORED through the resolver's existing
 * completeness rules (unchanged) — exactly like any other unobserved bar
 * gap. Building shutdown-hook machinery to avoid that would reintroduce a
 * production dependency on a research concern, which this task explicitly
 * avoids.
 */
import { appendFile } from 'fs/promises'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import type { Candle } from '@/types'
import { etTradingDay } from '@/lib/research/shadow-journal'

/**
 * Hard bound on total bytes currently enqueued (payloads handed to
 * `appendFile` but not yet flushed to disk). A typical NDJSON bar row is
 * ~150-230 bytes, so 2 MiB is roughly 9,000-13,000 pending bar rows —
 * generous slack for a multi-minute disk stall across the whole scanner
 * universe (dozens of symbols x ~1 bar/60s each) while still being a small,
 * fixed amount of memory on a research-only path. Chosen deliberately small
 * relative to available server memory rather than tuned against a specific
 * failure; if disk falls behind further than this, dropping is preferred
 * over unbounded growth (see module doc).
 */
const MAX_QUEUE_BYTES = 2 * 1024 * 1024

let queuedBytes = 0
let writeChain: Promise<void> = Promise.resolve()
let droppedBatchCount = 0
let droppedBarCount = 0
let writeFailureCount = 0

/**
 * Best-effort, non-throwing degradation signal. Never allowed to affect
 * control flow — if console.warn itself throws (unlikely, but this module
 * fails open by construction everywhere), it is swallowed.
 */
function degradationSignal(reason: string, extra?: Record<string, unknown>): void {
  try {
    console.warn(
      `[bar-journal] RESEARCH_WRITE_DEGRADED reason=${reason} droppedBatches=${droppedBatchCount} droppedBars=${droppedBarCount} writeFailures=${writeFailureCount} queuedBytes=${queuedBytes}`,
      extra ?? {},
    )
  } catch { /* never throw from a degradation signal */ }
}

/**
 * Test/observability-only snapshot of the async write queue's state. Not
 * used by any production code path.
 */
export function __getBarJournalQueueStats(): {
  queuedBytes: number
  droppedBatchCount: number
  droppedBarCount: number
  writeFailureCount: number
} {
  return { queuedBytes, droppedBatchCount, droppedBarCount, writeFailureCount }
}

/** Test-only escape hatch: resets the async write queue's counters/backlog
 *  bookkeeping between isolated test cases (does not touch on-disk state). */
export function __resetBarJournalQueueForTests(): void {
  queuedBytes = 0
  droppedBatchCount = 0
  droppedBarCount = 0
  writeFailureCount = 0
  writeChain = Promise.resolve()
}

/**
 * Resolves once every write enqueued so far has settled (flushed or
 * dropped/failed). TEST-ONLY: production code never awaits this — it exists
 * so tests can deterministically observe on-disk state after a mirrorBars()
 * call without reintroducing a synchronous write or a timing-based sleep.
 */
export function __flushBarJournalWritesForTests(): Promise<void> {
  return writeChain
}

/**
 * Enqueues one already-serialized NDJSON payload (one or more bar lines,
 * each already newline-terminated) for a single path. Enforces the queue's
 * byte bound and serializes all writes — across all paths/symbols — through
 * one promise chain so concurrent mirrorBars() calls can never interleave or
 * corrupt output. Never throws; never leaves an unhandled rejection.
 */
function enqueueAppend(path: string, payload: string, barCount: number): void {
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (queuedBytes + bytes > MAX_QUEUE_BYTES) {
    droppedBatchCount++
    droppedBarCount += barCount
    degradationSignal('queue_overflow', { path, attemptedBytes: bytes })
    return
  }
  queuedBytes += bytes
  writeChain = writeChain
    .then(() => appendFile(path, payload, 'utf8'))
    .catch((e: unknown) => {
      writeFailureCount++
      degradationSignal('write_failed', { path, error: e instanceof Error ? e.message : String(e) })
    })
    .finally(() => {
      queuedBytes -= bytes
    })
}

/** 1.5x a 1-minute bar's duration — a conservative safety margin before we
 *  trust wall-clock time alone (with no superseding sibling bar) to mean a
 *  bar's window has closed. */
const BAR_CLOSE_SAFETY_MS = 90_000

export interface ResearchBar {
  symbol: string
  timeframe: '1m'
  barStart: number   // ms — bar OPEN time (matches Candle.time * 1000)
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** Always 'closed' — see module doc: in-progress/forming bars are never
   *  persisted at all (not written-then-updated), so every record on disk is
   *  unambiguously a settled observation. */
  state: 'closed'
  observedAt: number   // ms — wall-clock time this record was mirrored
  source: string
  producerGitHead: string
  etTradingDay: string
}

export function barJournalPath(day: string): string {
  return join(homedir(), `.companion-research-bars-${day}.ndjson`)
}

let cachedGitHead: string | null = null
function gitHeadBestEffort(): string {
  if (cachedGitHead != null) return cachedGitHead
  try {
    cachedGitHead = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    cachedGitHead = 'unknown'
  }
  return cachedGitHead
}

// Per-process de-dup: never re-emit a bar this process has already written to
// disk. A restart may re-emit an already-persisted bar again after a crash —
// harmless (append-only; readers dedupe by (symbol,barStart), keeping the
// FIRST occurrence — the same "earliest observation wins" rule used
// throughout this experiment).
const written = new Set<string>()

/**
 * Best-effort, fire-and-forget, NEVER THROWS. Mirrors already-fetched 1m
 * candles to the on-disk research bar journal. Zero incremental provider
 * requests — `candles` must be bars the caller already has in hand.
 */
export function mirrorBars(
  symbol: string,
  candles: Candle[],
  source: string,
  nowMs: number = Date.now(),
  pathOverride?: string,
): void {
  try {
    if (!candles || candles.length === 0) return
    const sorted = [...candles].sort((a, b) => a.time - b.time)
    const maxTime = sorted[sorted.length - 1].time
    // Batch ALL newly-eligible rows from this single call, grouped by target
    // path (normally exactly one — a single ET trading day — but grouped
    // defensively in case a call ever straddles a day boundary), then issue
    // exactly one enqueueAppend() per path: one async write op per
    // mirrorBars() call, not one per bar.
    const batches = new Map<string, { lines: string[]; keys: string[] }>()
    for (const c of sorted) {
      if (!Number.isFinite(c.time) || !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close)) continue
      const barStart = c.time * 1000
      const key = `${symbol}:${barStart}`
      if (written.has(key)) continue
      const hasNewerSibling = c.time < maxTime
      const wallClockClosed = nowMs - barStart >= BAR_CLOSE_SAFETY_MS
      if (!hasNewerSibling && !wallClockClosed) continue // still the forming bar — too early to trust
      const day = etTradingDay(barStart)
      const row: ResearchBar = {
        symbol, timeframe: '1m', barStart,
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0,
        state: 'closed', observedAt: nowMs, source,
        producerGitHead: gitHeadBestEffort(), etTradingDay: day,
      }
      const path = pathOverride ?? barJournalPath(day)
      let batch = batches.get(path)
      if (!batch) { batch = { lines: [], keys: [] }; batches.set(path, batch) }
      batch.lines.push(`${JSON.stringify(row)}\n`)
      batch.keys.push(key)
      // Mark as written synchronously (not after the async flush) so a
      // second mirrorBars() call arriving before this write settles can
      // never enqueue a duplicate — the dedupe set, unlike the on-disk
      // journal, reflects "already handed to the writer", which is the
      // correctness property this per-process guard needs.
      written.add(key)
    }
    for (const [path, batch] of batches) {
      if (batch.lines.length === 0) continue
      enqueueAppend(path, batch.lines.join(''), batch.lines.length)
    }
  } catch {
    /* fail open — a mirror failure must never affect production */
  }
}

/** Test-only escape hatch: clears the per-process de-dup set so a test can
 *  re-mirror the same symbol/barStart pair (e.g. across isolated cases).
 *  Also resets the async write queue's counters/backlog bookkeeping, since
 *  test cases in practice always want a clean slate on both. */
export function __resetMirrorDedupForTests(): void {
  written.clear()
  __resetBarJournalQueueForTests()
}

// ── Read side ────────────────────────────────────────────────────────────

export type ParsedBarLine =
  | { ok: true; bar: ResearchBar }
  | { ok: false; reason: 'empty' | 'malformed_json' | 'missing_required_field' | 'torn_line'; raw: string }

const REQUIRED_BAR_FIELDS = [
  'symbol', 'timeframe', 'barStart', 'open', 'high', 'low', 'close', 'volume',
  'state', 'observedAt', 'source', 'etTradingDay',
] as const

/**
 * Parse one journal line. FAILS CONSERVATIVELY — a malformed or torn line
 * (process died mid-write) is never silently dropped or coerced; it comes
 * back as an explicit `ok:false` record the caller must account for.
 */
export function parseBarLine(raw: string): ParsedBarLine {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty', raw }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: trimmed.endsWith('}') ? 'malformed_json' : 'torn_line', raw }
  }
  if (obj == null || typeof obj !== 'object') return { ok: false, reason: 'malformed_json', raw }
  for (const f of REQUIRED_BAR_FIELDS) {
    if (!(f in (obj as Record<string, unknown>))) return { ok: false, reason: 'missing_required_field', raw }
  }
  return { ok: true, bar: obj as ResearchBar }
}

export interface LoadedBars {
  bars: ResearchBar[]
  corrupt: ParsedBarLine[]
}

/**
 * Read + parse one trading day's bar journal for one symbol, deduping by
 * barStart and keeping the FIRST occurrence (earliest observation wins, same
 * convention used throughout this experiment) — a later duplicate write of
 * the same barStart (e.g. after a process restart) is silently reconciled,
 * never treated as corruption. Missing file -> empty result, never throws.
 */
export function loadResearchBars(day: string, symbol: string, pathOverride?: string): LoadedBars {
  const path = pathOverride ?? barJournalPath(day)
  if (!existsSync(path)) return { bars: [], corrupt: [] }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { bars: [], corrupt: [] }
  }
  const seen = new Map<number, ResearchBar>()
  const corrupt: ParsedBarLine[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = parseBarLine(line)
    if (!parsed.ok) { corrupt.push(parsed); continue }
    if (parsed.bar.symbol !== symbol) continue
    if (!seen.has(parsed.bar.barStart)) seen.set(parsed.bar.barStart, parsed.bar)
  }
  const bars = [...seen.values()].sort((a, b) => a.barStart - b.barStart)
  return { bars, corrupt }
}

/** Projects research bars back into the plain `Candle[]` shape outcome.ts's
 *  scoreQualityOnlyOutcome() already consumes — no new candle shape is
 *  introduced into the scoring path. */
export function toCandleArray(bars: ResearchBar[]): Candle[] {
  return bars.map(b => ({ time: b.barStart / 1000, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))
}
