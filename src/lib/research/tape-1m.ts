/**
 * H4B-PREP — CANONICAL 1-MINUTE RESEARCH TAPE (append-only writer).
 *
 * PURPOSE
 *   Preserve the raw 1-minute bars Companion ALREADY fetched on the canonical
 *   server monitor path (`buildMonitorResult`), so every future H4B candidate can
 *   be reconstructed CAUSALLY — "what bar value had Companion observed by time T?".
 *   This is research evidence, not a strategy and not an execution input.
 *
 * DESIGN CONTRACT (the non-negotiables):
 *   - ZERO NEW PROVIDER REQUESTS. This module never fetches anything. It consumes
 *     bars the monitor path already obtained (from `cached('candles1m:…')`).
 *   - PURE SIDE-CHANNEL. Nothing here is ever read back into a universe, ranking,
 *     detector, gate, arbitration or execution decision.
 *   - BEST-EFFORT / FAIL-OPEN. A tape failure logs (rate-limited) and is dropped;
 *     it MUST NEVER throw into the monitor request, block BASE acquisition, add
 *     latency to the hot path, or fabricate success.
 *   - THE EVENT LOOP IS NEVER BLOCKED FOR DISK. The per-bar hot path is a pure
 *     in-memory enqueue (O(1)). Bars are drained by a SINGLE serialized ASYNC
 *     writer (`fs/promises.appendFile`) — never a synchronous append on the request
 *     path or the background timer. A slow/stalled disk delays only the tape's own
 *     async writes, never `/api/monitor` or any other server request. The ONLY
 *     synchronous append is the best-effort final flush during actual process exit,
 *     when serving new BASE traffic is no longer relevant.
 *   - BOUNDED. The in-memory queue is bounded; overflow DROPS tape data explicitly
 *     and marks the tape degraded. There is only ever ONE async write in flight
 *     (a serialized loop), never unbounded concurrent append promises.
 *   - SINGLE WRITER PER TAPE. A research-only O_EXCL lease guarantees exactly one
 *     writer process appends a given day's canonical tape; a second server keeps
 *     serving BASE normally but disables its own tape writer (loud, degraded).
 *   - PROCESS SINGLETON. All writer state lives on a globalThis Symbol, so dev/HMR
 *     module re-evaluation reuses ONE queue / timer / lock / run — never a second.
 *   - APPEND-ONLY. Historical observations are never rewritten. A later provider
 *     revision of the same bar is preserved as an additional observation, never an
 *     overwrite — so causal (as-of-T) replay can never be poisoned by the future.
 *   - AUDITABLE COMPLETENESS. A file self-documents lost events (tape_gap) and
 *     certifies a clean close (tape_writer_summary). An abrupt exit / torn append
 *     leaves the session (correctly) UNCERTIFIED.
 *   - SECRET-SAFE. Bars carry no credentials; a defensive scrub drops secret-shaped
 *     keys from any payload before write.
 *
 * Node-only (fs / fs.promises / child_process). NEVER import from a client component.
 */
import { appendFileSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'fs'
import { appendFile as fspAppendFile } from 'fs/promises'
import { homedir, hostname } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import type { Candle } from '@/types'
import { etDayKey } from '@/lib/execution/store'
import { resolveLocalFeatureConfig, localFeatureConfigHash } from '@/lib/leader/local-structure'

/** Tape record schema version. Bump on any breaking event-shape change. */
export const TAPE_SCHEMA_VERSION = 1

/** Which side of the canonical monitor path produced this bar (never a market-data truth split). */
export type TapeRequestKind = 'BASE' | 'LEADER_OBSERVATION'
/** Whether the observed bar is a settled minute, still forming, or undecidable. */
export type BarStatus = 'CLOSED' | 'IN_PROGRESS' | 'UNKNOWN'
/** Which reference clock decided barStatus — so a forensic reader knows the basis. */
export type StatusBasis = 'receivedAt' | 'observedAt'
/** Provider that produced the candles, when knowable at the canonical boundary. */
export type TapeSource = 'yahoo' | 'fmp' | 'UNKNOWN'

export type TapeEventType =
  | 'bar_observation'
  | 'tape_writer_started'
  | 'tape_gap'                // durable: N tape events were lost to overflow/write failures, then recovered
  | 'tape_writer_degraded'    // the writer entered a degraded state (overflow or repeated write failure)
  | 'tape_writer_recovered'   // the writer recovered from a degraded state
  | 'tape_writer_summary'     // terminal certificate of a clean close
  | 'tape_rotated'            // the run crossed ET midnight into the next day's file (links files by runId)

// ── Configuration (all env overrides are research-only; never affect trading) ────

/** Master off-switch. `COMPANION_1M_TAPE=0` disables the tape entirely (pure no-op). */
function tapeEnabled(): boolean {
  return process.env.COMPANION_1M_TAPE !== '0'
}
function tapeDir(): string {
  return process.env.COMPANION_1M_TAPE_DIR || homedir()
}
/** Per-ET-day append-only sink. `COMPANION_1M_TAPE_DIR` overrides (tests only). */
export function tapeFile(day: string = etDayKey()): string {
  return join(tapeDir(), `.companion-1m-tape-${day}.jsonl`)
}
/** The single-writer lease file (per tape dir). Name avoids the `.companion-1m-tape-` day prefix. */
export function writerLockFile(): string {
  return join(tapeDir(), '.companion-1m-tape.lock')
}
/** Max buffered lines before we DROP (never block). Read dynamically so a test override applies. */
function maxQueue(): number {
  const v = Number(process.env.COMPANION_1M_TAPE_MAX_QUEUE)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 50_000
}
/** Kick the async drain once the queue reaches this depth (amortises appends). */
const FLUSH_BATCH = 512
/** Background flush cadence (ms). The timer is unref'd so it never keeps the process alive. */
const FLUSH_INTERVAL_MS = 1_000
/** Bound the in-memory dedup map so a very long session cannot grow it without limit. */
const MAX_DEDUP_KEYS = (() => {
  const v = Number(process.env.COMPANION_1M_TAPE_MAX_DEDUP)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 250_000
})()
/** Publication-delay allowance: a newest bar is only CLOSED once its minute ended this long ago. */
const PUBLICATION_MARGIN_SEC = 15
const CANDLE_SRC_TTL_MS = 30_000        // mirrors TTL.CANDLES_1M; provenance is only meaningful that long
const MAX_CANDLE_SRC = 2_000
const ESCALATE_AFTER = 5
/** Bounded graceful-shutdown drain budget. We never hang shutdown for the tape. */
function shutdownBudgetMs(): number {
  const v = Number(process.env.COMPANION_1M_TAPE_SHUTDOWN_MS)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2_000
}
/** A bounded delay whose timer never keeps the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((res) => { const t = setTimeout(res, ms); if (typeof t.unref === 'function') t.unref() })
}

// ── Process-singleton state (HMR / dev-reload safe) ──────────────────────────────
// Dev servers re-evaluate modules on HMR. If writer state lived in module-level `let`s,
// a re-eval would create a SECOND queue / timer / signal handler / runId inside ONE
// process. Anchoring all state on a globalThis Symbol means every module instance in
// this process shares ONE writer — one queue, one timer, one lease, one run.
interface CandleSourceProvenance { source: TapeSource; fetchedAt: string; expiresAt: number }
interface TapeState {
  queue: string[]
  seen: Map<string, { ohlcv: string; revisionSequence: number }>
  candleSrc: Map<string, CandleSourceProvenance>
  started: boolean
  disabledByLock: boolean
  ownsLock: boolean
  shuttingDown: boolean
  summaryWritten: boolean
  shutdownPromise: Promise<boolean> | null
  runId: string | null
  producerHead: string | null | undefined
  flushTimer: ReturnType<typeof setInterval> | null
  signalsHooked: boolean
  beforeExitHandler: (() => void) | null
  signalHandlers: Array<{ sig: NodeJS.Signals; handler: () => void }>
  lastWrittenDay: string | null
  draining: boolean
  drainPromise: Promise<void>
  appendImpl: (file: string, text: string) => Promise<void>
  // counters
  eventsAttempted: number
  eventsWritten: number
  identicalDuplicatesSuppressed: number
  revisionsWritten: number
  eventsDropped: number
  writeFailures: number
  asyncWriteFailures: number
  queueOverflows: number
  degraded: boolean
  degradedEver: boolean
  firstFailureAt: string | null
  lastFailureAt: string | null
  droppedSinceLastOk: number
  consecutiveFailures: number
}

const TAPE_STATE = Symbol.for('companion.research.tape1m/v1')
function freshState(): TapeState {
  return {
    queue: [], seen: new Map(), candleSrc: new Map(),
    started: false, disabledByLock: false, ownsLock: false,
    shuttingDown: false, summaryWritten: false, shutdownPromise: null,
    runId: null, producerHead: undefined,
    flushTimer: null, signalsHooked: false, beforeExitHandler: null, signalHandlers: [],
    lastWrittenDay: null, draining: false, drainPromise: Promise.resolve(),
    appendImpl: (file, text) => fspAppendFile(file, text),
    eventsAttempted: 0, eventsWritten: 0, identicalDuplicatesSuppressed: 0, revisionsWritten: 0,
    eventsDropped: 0, writeFailures: 0, asyncWriteFailures: 0, queueOverflows: 0,
    degraded: false, degradedEver: false, firstFailureAt: null, lastFailureAt: null,
    droppedSinceLastOk: 0, consecutiveFailures: 0,
  }
}
function st(): TapeState {
  const g = globalThis as unknown as Record<PropertyKey, unknown>
  if (!g[TAPE_STATE]) g[TAPE_STATE] = freshState()
  return g[TAPE_STATE] as TapeState
}

// ── Small helpers ────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /(key|secret|token|authorization|apikey|password|credential)/i
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) { out[k] = '[REDACTED]'; continue }
      out[k] = scrub(v)
    }
    return out
  }
  return value
}

/** Canonical OHLCV string — the collision-SAFE dedup identity (compared directly, not via hash). */
function ohlcvKey(o: number, h: number, l: number, c: number, v: number): string {
  return `${o}|${h}|${l}|${c}|${v}`
}
/** Deterministic 8-hex fingerprint of a bar's OHLCV (FNV-1a) — storage/provenance only, NOT dedup proof. */
export function barFingerprint(o: number, h: number, l: number, c: number, v: number): string {
  const s = ohlcvKey(o, h, l, c, v)
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { hash ^= s.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Resolve `git HEAD` ONCE per run (best-effort). Never throws; null when indeterminate. */
function resolveProducerHead(): string | null {
  const s = st()
  if (s.producerHead !== undefined) return s.producerHead
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' })
    const out = (r.stdout ?? '').trim()
    s.producerHead = r.status === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null
  } catch {
    s.producerHead = null
  }
  return s.producerHead
}

// ── Source provenance sidecar (STEP 10) ─────────────────────────────────────────
// The canonical 1m fetch (Yahoo → FMP fallback) is cached; on a cache HIT the fetcher
// does not run, so the winning provider is otherwise unknowable at the tape boundary.
// The monitor fetch factory calls `recordCandleSource` on a real fetch; the tape reads
// it back here. Absent/expired → UNKNOWN (never fabricated). Stored in this module's OWN
// bounded map (NOT the shared trading cache), so provider load stays byte-identical.
export function recordCandleSource(symbol: string, source: 'yahoo' | 'fmp', now: number = Date.now()): void {
  try {
    const m = st().candleSrc
    const key = symbol.toUpperCase()
    if (m.size >= MAX_CANDLE_SRC && !m.has(key)) {
      const oldest = m.keys().next().value
      if (oldest !== undefined) m.delete(oldest)
    }
    m.set(key, { source, fetchedAt: new Date(now).toISOString(), expiresAt: now + CANDLE_SRC_TTL_MS })
  } catch { /* provenance is best-effort; never disturb the fetch */ }
}
function readCandleSource(symbol: string, now: number): CandleSourceProvenance | null {
  const m = st().candleSrc
  const key = symbol.toUpperCase()
  const p = m.get(key)
  if (!p) return null
  if (now > p.expiresAt) { m.delete(key); return null }
  return p
}

// ── Single-writer lease (STEP 3) ─────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } // EPERM = alive but not ours
}

/**
 * Acquire the research-only single-writer lease with O_EXCL. Returns true if THIS process
 * may append the canonical tape. On contention it steals only a provably-stale lease (same
 * host, dead pid); otherwise it declines (conservative) and the caller disables its writer.
 * Never throws; a lease it cannot even attempt (e.g. missing dir) does not block research —
 * writes will surface their own failures. `retry` guards the single stale-takeover recursion.
 */
function acquireWriterLock(now: number, retry = true): boolean {
  const path = writerLockFile()
  const s = st()
  try {
    const fd = openSync(path, 'wx') // O_EXCL: fails if the lease already exists
    try {
      writeSync(fd, JSON.stringify({
        runId: s.runId, pid: process.pid, host: hostname(),
        producerHead: s.producerHead ?? null, startedAt: new Date(now).toISOString(),
      }))
    } finally { closeSync(fd) }
    s.ownsLock = true
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') return true // cannot place a lease (e.g. dir missing) → don't block research
    // Lease exists — inspect it.
    try {
      const info = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number; host?: string }
      const sameHost = info.host === hostname()
      const stale = sameHost && typeof info.pid === 'number' && !isProcessAlive(info.pid)
      if (stale && retry) {
        try { unlinkSync(path) } catch { /* best-effort */ }
        return acquireWriterLock(now, false)
      }
    } catch {
      // Unreadable/corrupt lease → treat as owned by an unknown live writer (conservative).
    }
    return false
  }
}
function releaseWriterLock(): void {
  const s = st()
  if (!s.ownsLock) return
  try { unlinkSync(writerLockFile()) } catch { /* best-effort */ }
  s.ownsLock = false
}

// ── Failure accounting (fail-open, rate-limited, never blocks) ───────────────────

function onWriteFailure(lostCount: number, err: unknown, isAsync: boolean): void {
  const s = st()
  s.writeFailures++
  if (isAsync) s.asyncWriteFailures++
  s.eventsDropped += lostCount
  s.droppedSinceLastOk += lostCount
  s.consecutiveFailures++
  const nowIso = new Date().toISOString()
  if (s.firstFailureAt === null) s.firstFailureAt = nowIso
  s.lastFailureAt = nowIso
  if (s.consecutiveFailures <= ESCALATE_AFTER || s.consecutiveFailures % 100 === 0) {
    console.warn(`[1m-tape] write failed (${s.consecutiveFailures}), dropped ${lostCount}: ${(err as Error)?.message ?? err}`)
  }
  markDegraded('write_failure')
}

/** Enter degraded state (once per episode) and enqueue a durable marker. Never writes synchronously. */
function markDegraded(reason: string): void {
  const s = st()
  if (s.degraded) return
  s.degraded = true
  s.degradedEver = true
  enqueueControl({ eventType: 'tape_writer_degraded', reason, eventsDropped: s.eventsDropped, queueOverflows: s.queueOverflows, writeFailures: s.writeFailures })
  console.error(
    `[1m-tape] writer DEGRADED (${reason}) — research tape is dropping data. ` +
    `Trading/BASE is unaffected. Investigate ${tapeFile()}.`,
  )
}
function markRecovered(): void {
  const s = st()
  if (!s.degraded) return
  s.degraded = false
  s.consecutiveFailures = 0
  enqueueControl({ eventType: 'tape_writer_recovered', eventsDropped: s.eventsDropped, queueOverflows: s.queueOverflows, writeFailures: s.writeFailures })
}

// ── Serialization ──────────────────────────────────────────────────────────────

function stamp(rec: Record<string, unknown>, now: number): string {
  const s = st()
  return JSON.stringify({
    tapeSchemaVersion: TAPE_SCHEMA_VERSION,
    tsUtc: new Date(now).toISOString(),
    runId: s.runId,
    producerHead: s.producerHead ?? null,
    ...(scrub(rec) as Record<string, unknown>),
  }) + '\n'
}

/** Enqueue a bar line, subject to the bound (may DROP on overflow). */
function enqueue(line: string): void {
  const s = st()
  s.eventsAttempted++
  if (s.queue.length >= maxQueue()) {
    s.eventsDropped++
    s.queueOverflows++
    s.droppedSinceLastOk++
    markDegraded('queue_overflow')
    return
  }
  s.queue.push(line)
}
/** Enqueue a rare control marker. NOT subject to the bound — a degraded/gap marker must never
 *  itself be dropped by overflow. Control events are naturally few, so this stays bounded. */
function enqueueControl(rec: Record<string, unknown>, now: number = Date.now()): void {
  st().queue.push(stamp(rec, now))
}

// ── Async serialized writer (the runtime path — never blocks the event loop) ──────

/** Kick the single serialized async drain if one is not already running. */
function scheduleDrain(): void {
  const s = st()
  if (s.disabledByLock || s.draining) return
  s.draining = true
  s.drainPromise = drainLoop().finally(() => { s.draining = false })
}

async function rotateIfNeededAsync(day: string, now: number): Promise<void> {
  const s = st()
  if (s.lastWrittenDay === null || s.lastWrittenDay === day) return
  const base = { runId: s.runId, producerHead: s.producerHead ?? null, fromDay: s.lastWrittenDay, toDay: day }
  await s.appendImpl(tapeFile(s.lastWrittenDay), stamp({ eventType: 'tape_rotated', ...base, direction: 'continued_in_next_file', note: 'run continued across ET midnight into toDay; this file is CONTINUED, not incomplete — certified in toDay by runId' }, now))
  await s.appendImpl(tapeFile(day), stamp({ eventType: 'tape_rotated', ...base, direction: 'continued_from_prev_file' }, now))
}

async function drainLoop(): Promise<void> {
  const s = st()
  while (s.queue.length > 0) {
    const now = Date.now()
    const day = etDayKey(now)
    let batch: string[] = []
    try {
      await rotateIfNeededAsync(day, now)
      batch = s.queue.splice(0, s.queue.length)
      await s.appendImpl(tapeFile(day), batch.join(''))
      s.eventsWritten += batch.length
      batch = []
      s.lastWrittenDay = day
      if (s.degraded) markRecovered()          // enqueues a recovered marker → written next iteration
      s.consecutiveFailures = 0
      if (s.droppedSinceLastOk > 0) {
        const dropped = s.droppedSinceLastOk
        s.droppedSinceLastOk = 0
        enqueueControl({ eventType: 'tape_gap', droppedEvents: dropped, droppedTotalThisRun: s.eventsDropped, note: 'tape writes were lost then recovered — this file is missing droppedEvents bar records for the preceding window; treat this session as DEGRADED' }, now)
      }
    } catch (err) {
      // ONLY the batch we just spliced is lost (accounted). Items enqueued during the await stay
      // for a later attempt. Break so we don't hot-loop an unwritable disk; the 1s timer retries.
      onWriteFailure(batch.length, err, true)
      break
    }
  }
}

// ── Synchronous drain — ONLY for tests and the process-exit final flush ──────────

/**
 * Synchronous best-effort drain. On the runtime request/timer path we NEVER call this
 * (that is the async drainLoop's job). It exists for (a) graceful process exit, when
 * serving new BASE traffic is no longer relevant, and (b) deterministic tests.
 */
export function flushSync(now: number = Date.now()): void {
  const s = st()
  if (s.disabledByLock) { s.queue.length = 0; return }
  if (s.queue.length === 0 && s.droppedSinceLastOk === 0) return
  const day = etDayKey(now)
  let batch: string[] = []
  try {
    rotateIfNeededSync(day, now)
    if (s.queue.length > 0) {
      batch = s.queue.splice(0, s.queue.length)
      appendFileSync(tapeFile(day), batch.join(''))
      s.eventsWritten += batch.length
      batch = []
      s.lastWrittenDay = day
      if (s.degraded) markRecovered()
      s.consecutiveFailures = 0
    }
    if (s.droppedSinceLastOk > 0 && s.lastWrittenDay === day) {
      const dropped = s.droppedSinceLastOk
      appendFileSync(tapeFile(day), stamp({ eventType: 'tape_gap', droppedEvents: dropped, droppedTotalThisRun: s.eventsDropped, note: 'tape writes were lost then recovered — missing droppedEvents bar records; treat this session as DEGRADED' }, now))
      s.droppedSinceLastOk = 0
    }
    // A recovery/gap marker enqueued above (via markRecovered/enqueueControl) must also land.
    if (s.queue.length > 0) {
      const tail = s.queue.splice(0, s.queue.length)
      appendFileSync(tapeFile(day), tail.join(''))
      s.eventsWritten += tail.length
    }
  } catch (err) {
    onWriteFailure(batch.length, err, false)  // only the un-written bar batch is counted lost
  }
}
function rotateIfNeededSync(day: string, now: number): void {
  const s = st()
  if (s.lastWrittenDay === null || s.lastWrittenDay === day) return
  const base = { runId: s.runId, producerHead: s.producerHead ?? null, fromDay: s.lastWrittenDay, toDay: day }
  appendFileSync(tapeFile(s.lastWrittenDay), stamp({ eventType: 'tape_rotated', ...base, direction: 'continued_in_next_file', note: 'run continued across ET midnight into toDay; this file is CONTINUED, not incomplete — certified in toDay by runId' }, now))
  appendFileSync(tapeFile(day), stamp({ eventType: 'tape_rotated', ...base, direction: 'continued_from_prev_file' }, now))
}

// ── Startup / lifecycle ──────────────────────────────────────────────────────────

function ensureStarted(now: number): boolean {
  const s = st()
  if (s.started) return !s.disabledByLock
  s.started = true
  s.runId = `tape-${now}-${Math.random().toString(36).slice(2, 8)}`
  resolveProducerHead()
  // Single-writer lease: acquire before writing anything. A second writer disables itself.
  if (!acquireWriterLock(now)) {
    s.disabledByLock = true
    console.error(
      `[1m-tape] another writer already owns ${writerLockFile()} — this process will NOT write the ` +
      `canonical tape (research writer DISABLED). BASE/trading is unaffected.`,
    )
    return false
  }
  // tape_writer_started is the FIRST record of a run (enqueued; async-drained like everything else).
  enqueueControl({ eventType: 'tape_writer_started', startedAtUtc: new Date(now).toISOString(), pid: process.pid, host: hostname(), schemaVersion: TAPE_SCHEMA_VERSION }, now)
  if (s.flushTimer === null) {
    s.flushTimer = setInterval(() => { try { scheduleDrain() } catch { /* best-effort */ } }, FLUSH_INTERVAL_MS)
    if (typeof s.flushTimer.unref === 'function') s.flushTimer.unref()
  }
  hookExit()
  return true
}

/**
 * Best-effort clean close: flush the tail synchronously (exit only) and write the terminal
 * summary. On SIGINT/SIGTERM we re-raise via a remove-self idiom that PRESERVES Next's own
 * default shutdown; we never call process.exit. An abrupt SIGKILL/crash writes no summary —
 * correctly leaving the session INCOMPLETE.
 */
function hookExit(): void {
  const s = st()
  if (s.signalsHooked) return
  s.signalsHooked = true
  // Normal exit: the loop is draining/empty; run the (idempotent) bounded shutdown once. The
  // `shuttingDown` guard prevents a repeated beforeExit loop; the summary is written at most once.
  s.beforeExitHandler = () => { if (!s.shuttingDown) void shutdownTape() }
  process.on('beforeExit', s.beforeExitHandler)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      // Await the BOUNDED graceful drain BEFORE re-raising, so an in-flight async append is given
      // a chance to become durable and no clean summary is written over an outstanding batch.
      void shutdownTape().finally(() => {
        process.removeListener(sig, handler)
        try { process.kill(process.pid, sig) } catch { /* leave lifecycle untouched if re-raise fails */ }
      })
    }
    s.signalHandlers.push({ sig, handler })
    process.on(sig, handler)
  }
}
function unhookExit(): void {
  const s = st()
  if (s.beforeExitHandler) { process.removeListener('beforeExit', s.beforeExitHandler); s.beforeExitHandler = null }
  for (const { sig, handler } of s.signalHandlers) process.removeListener(sig, handler)
  s.signalHandlers = []
  s.signalsHooked = false
}

// ── Bar-status classification (STEP 4) ──────────────────────────────────────────

/**
 * Classify an observed 1m bar. A bar earlier than the newest is CLOSED (a strictly newer
 * bar exists — stronger evidence than wall clock). The newest bar is CLOSED only once its
 * minute ended more than PUBLICATION_MARGIN_SEC ago by the REFERENCE clock (receivedAt when
 * known, else observedAt) — never "CLOSED because its timestamp is before wall clock".
 */
export function classifyBarStatus(barTimeSec: number, maxTimeSec: number, refMs: number): BarStatus {
  const barEndSec = barTimeSec + 60
  const refSec = refMs / 1000
  if (barTimeSec < maxTimeSec) return 'CLOSED'
  if (refSec >= barEndSec + PUBLICATION_MARGIN_SEC) return 'CLOSED'
  if (refSec >= barTimeSec) return 'IN_PROGRESS'
  return 'UNKNOWN'
}

// ── The enqueue API (the per-bar hot path — O(1), no fs) ─────────────────────────

/**
 * Record the already-fetched canonical 1m bars for one symbol. Enqueues one
 * `bar_observation` per NEW or REVISED bar (identical repeats are suppressed and counted).
 * BEST-EFFORT: any failure is swallowed; the monitor path is never affected, and the disk
 * is never touched synchronously here (draining is async).
 */
export function recordBarObservations(input: {
  symbol: string
  candles: Candle[]
  requestKind: TapeRequestKind
  session?: string
  now?: number
}): void {
  if (!tapeEnabled()) return
  if (st().shuttingDown) return // shutdown started: stop accepting new tape events
  const candles = input.candles
  if (!candles || candles.length === 0) return
  const now = input.now ?? Date.now()
  try {
    if (!ensureStarted(now)) return // disabled (lease held elsewhere) → pure no-op
    const s = st()
    const sym = input.symbol.toUpperCase()
    const prov = readCandleSource(sym, now)
    const source: TapeSource = prov?.source ?? 'UNKNOWN'
    const receivedAt = prov?.fetchedAt ?? null
    const receivedAtMs = receivedAt ? Date.parse(receivedAt) : NaN
    const refMs = Number.isFinite(receivedAtMs) ? receivedAtMs : now
    const statusBasis: StatusBasis = Number.isFinite(receivedAtMs) ? 'receivedAt' : 'observedAt'
    const cfg = resolveLocalFeatureConfig()
    const cfgVersion = cfg.version
    const cfgHash = localFeatureConfigHash(cfg)
    const observedAt = new Date(now).toISOString()

    let maxTimeSec = -Infinity
    for (const c of candles) if (c.time > maxTimeSec) maxTimeSec = c.time

    for (const c of candles) {
      const barTimeSec = c.time
      const o = c.open, h = c.high, l = c.low, cl = c.close, v = c.volume
      const key = `${sym}|1m|${barTimeSec}`
      const ohlcv = ohlcvKey(o, h, l, cl, v)     // collision-SAFE dedup identity
      const fp = barFingerprint(o, h, l, cl, v)  // stored fingerprint (provenance only)
      const prior = s.seen.get(key)

      let revisionSequence: number
      if (!prior) {
        revisionSequence = 0
      } else if (prior.ohlcv === ohlcv) {
        s.identicalDuplicatesSuppressed++        // exact repeat — proven equal by canonical string, not a hash
        continue
      } else {
        revisionSequence = prior.revisionSequence + 1
        s.revisionsWritten++
      }

      const priceFinite = [o, h, l, cl].every(Number.isFinite)
      const priceValid = priceFinite && o > 0 && h > 0 && l > 0 && cl > 0 && h >= l
      const volumeMissing = !Number.isFinite(v)
      const dataQuality = !priceFinite ? 'NON_FINITE_PRICE' : !priceValid ? 'INVALID_PRICE' : volumeMissing ? 'MISSING_VOLUME' : 'OK'

      enqueue(stamp({
        eventType: 'bar_observation',
        symbol: sym, timeframe: '1m',
        barTimeSec, barTimestamp: new Date(barTimeSec * 1000).toISOString(),
        open: Number.isFinite(o) ? o : null, high: Number.isFinite(h) ? h : null,
        low: Number.isFinite(l) ? l : null, close: Number.isFinite(cl) ? cl : null,
        volume: volumeMissing ? null : v,
        barStatus: classifyBarStatus(barTimeSec, maxTimeSec, refMs), statusBasis,
        barFingerprint: fp, revisionSequence,
        observedAt, observedAtMs: now, receivedAt, source,
        requestKind: input.requestKind, session: input.session ?? null,
        localFeatureConfigVersion: cfgVersion, localFeatureConfigHash: cfgHash,
        dataQuality,
      }, now))

      if (s.seen.size >= MAX_DEDUP_KEYS) {
        const oldest = s.seen.keys().next().value
        if (oldest !== undefined) s.seen.delete(oldest)
      }
      s.seen.set(key, { ohlcv, revisionSequence })
    }

    // Kick the ASYNC drain when the buffer is worth writing. Never a synchronous append here.
    if (s.queue.length >= FLUSH_BATCH) scheduleDrain()
  } catch (err) {
    console.warn(`[1m-tape] recordBarObservations(${input.symbol}) failed:`, (err as Error)?.message ?? err)
    markDegraded('enqueue_error')
  }
}

// ── Terminal summary (research-integrity certificate) ────────────────────────────

export interface TapeSessionSummary {
  runId: string | null
  eventsAttempted: number
  eventsWritten: number
  identicalDuplicatesSuppressed: number
  revisionsWritten: number
  eventsDropped: number
  writeFailures: number
  asyncWriteFailures: number
  queueOverflows: number
  degradedEver: boolean
  firstFailureAt: string | null
  lastFailureAt: string | null
  cleanClose: true
}
export function buildTapeSummary(): TapeSessionSummary {
  const s = st()
  return {
    runId: s.runId,
    eventsAttempted: s.eventsAttempted, eventsWritten: s.eventsWritten,
    identicalDuplicatesSuppressed: s.identicalDuplicatesSuppressed, revisionsWritten: s.revisionsWritten,
    eventsDropped: s.eventsDropped, writeFailures: s.writeFailures, asyncWriteFailures: s.asyncWriteFailures,
    queueOverflows: s.queueOverflows, degradedEver: s.degradedEver,
    firstFailureAt: s.firstFailureAt, lastFailureAt: s.lastFailureAt, cleanClose: true,
  }
}

/**
 * Append the terminal `tape_writer_summary` — the SYNCHRONOUS clean-close path (tests + the
 * fully-drained branch of graceful shutdown). It certifies a clean close ONLY when durability
 * is guaranteed synchronously:
 *   - refuses if an async append is IN FLIGHT (`draining`) — a summary must never precede an
 *     outstanding batch (shutdown must await the drain first via `shutdownTape`);
 *   - refuses if the queue is still non-empty after its own sync flush (undrained data);
 *   - refuses to write a second summary (no duplicate).
 * On durable success it releases the writer lease and returns true. On refusal it returns false
 * and does NOT release the lease (writes have not settled) — absence of the marker correctly
 * certifies incompleteness. Never throws.
 */
export function emitTapeSummary(now: number = Date.now()): boolean {
  const s = st()
  if (!s.started || s.disabledByLock || s.summaryWritten) return false
  if (s.draining) return false // an async batch is outstanding — cannot certify clean synchronously
  try {
    flushSync(now)
    if (s.queue.length > 0) return false // could not fully drain — do NOT certify clean
    const day = etDayKey(now)
    rotateIfNeededSync(day, now)
    appendFileSync(tapeFile(day), stamp({ eventType: 'tape_writer_summary', ...buildTapeSummary() }, now))
    s.lastWrittenDay = day
    s.summaryWritten = true
    releaseWriterLock() // lease released ONLY after writes have settled + summary is durable
    return true
  } catch {
    return false // not settled → keep the lease (stale-takeover covers the next run)
  }
}

/**
 * Graceful shutdown (the ASYNC path used by beforeExit / SIGINT / SIGTERM). The filesystem op is
 * asynchronous, so a clean summary must NEVER be written while an async append batch is in flight
 * or queued-but-not-durable. Sequence:
 *   1. stop accepting new tape events;
 *   2. BOUNDED-await any in-flight drain + remaining queue (never hang shutdown for the tape);
 *   3. if FULLY drained (nothing in flight, queue empty) → write the clean summary (releases lease);
 *   4. otherwise account the undrained data as lost, mark degraded, and DO NOT certify clean —
 *      an absent/unclean summary yields INCOMPLETE (research truth > cosmetic clean shutdown).
 * Idempotent (returns the same promise). Never throws.
 */
export function shutdownTape(now: number = Date.now(), timeoutMs: number = shutdownBudgetMs()): Promise<boolean> {
  const s = st()
  if (s.shutdownPromise) return s.shutdownPromise
  s.shutdownPromise = (async () => {
    if (!s.started || s.disabledByLock) { s.shuttingDown = true; return false }
    s.shuttingDown = true // stop accepting new events
    const deadline = Date.now() + Math.max(0, timeoutMs)
    try {
      while (s.draining || s.queue.length > 0) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        scheduleDrain()
        await Promise.race([s.drainPromise, delay(remaining)])
      }
    } catch { /* best-effort */ }
    if (!s.draining && s.queue.length === 0) {
      // Fully drained and durable → safe to certify clean.
      return emitTapeSummary(now)
    }
    // Bounded drain expired with data still in flight/queued → do NOT certify clean.
    const lost = s.queue.length
    if (lost > 0) { s.eventsDropped += lost; s.droppedSinceLastOk += lost; s.queue.length = 0 }
    markDegraded('shutdown_timeout')
    // Keep the lease UNreleased: writes did not settle, so stale-takeover (dead pid) covers the
    // next run rather than releasing while a stuck append may still touch the file.
    return false
  })()
  return s.shutdownPromise
}

// ── Health readouts (for a heartbeat / diagnostics; never a decision input) ──────

export function tapeDegraded(): boolean { return st().degraded }
export function tapeDroppedTotal(): number { return st().eventsDropped }
export function tapeQueueDepth(): number { return st().queue.length }
export function tapeFlushInFlight(): boolean { return st().draining }
export function tapeAsyncWriteFailures(): number { return st().asyncWriteFailures }
export function tapeDisabledByLock(): boolean { return st().disabledByLock }

// ── Test-only hooks ──────────────────────────────────────────────────────────

/** TEST ONLY: reset all writer state (releases the lease + detaches process listeners). */
export function __resetTapeForTest(): void {
  const s = st()
  if (s.flushTimer !== null) { clearInterval(s.flushTimer); s.flushTimer = null }
  unhookExit()
  releaseWriterLock()
  const g = globalThis as unknown as Record<PropertyKey, unknown>
  g[TAPE_STATE] = freshState()
}
/** TEST ONLY: kick the async drain. */
export function __kickDrainForTest(): void { scheduleDrain() }
/** TEST ONLY: await the async drain to completion (drains everything currently queued). */
export async function __drainTapeForTest(): Promise<void> {
  scheduleDrain()
  // Loop until the queue is empty and no drain is mid-flight.
  // The drain may re-enqueue control markers (recovered/gap), so re-check after awaiting.
  for (let i = 0; i < 1000; i++) {
    await st().drainPromise
    if (!st().draining && st().queue.length === 0) return
    scheduleDrain()
  }
}
/** TEST ONLY: inject a custom async append implementation (e.g. a gated/slow disk). */
export function __setAppendImplForTest(fn: (file: string, text: string) => Promise<void>): void {
  st().appendImpl = fn
}
