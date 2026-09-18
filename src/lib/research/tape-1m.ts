/**
 * H4B-PREP — CANONICAL 1-MINUTE RESEARCH TAPE (append-only writer).
 *
 * PURPOSE
 *   Preserve the raw 1-minute bars Companion ALREADY fetched on the canonical
 *   server monitor path (`buildMonitorResult`), so every future H4B candidate can
 *   be reconstructed CAUSALLY — "what bar value had Companion observed by time T?".
 *   This is research evidence, not a strategy and not an execution input.
 *
 * DESIGN CONTRACT (the non-negotiables, mirrored from the H3A funnel philosophy):
 *   - ZERO NEW PROVIDER REQUESTS. This module never fetches anything. It consumes
 *     bars the monitor path already obtained (from `cached('candles1m:…')`).
 *   - PURE SIDE-CHANNEL. Nothing here is ever read back into a universe, ranking,
 *     detector, gate, arbitration or execution decision.
 *   - BEST-EFFORT / FAIL-OPEN. A tape failure logs (rate-limited) and is dropped;
 *     it MUST NEVER throw into the monitor request, block BASE acquisition, add
 *     latency to the hot path, or fabricate success.
 *   - ASYNC / BUFFERED. Bars are enqueued (O(1), no fs) on the request path; a
 *     bounded background writer flushes them. We NEVER fsync per bar on the
 *     monitor critical path. If the queue is full we DROP tape data explicitly and
 *     mark the tape degraded — trading is never blocked to save research data.
 *   - APPEND-ONLY. Historical observations are never rewritten. A later provider
 *     revision of the same bar is preserved as an additional observation, never an
 *     overwrite — so causal (as-of-T) replay can never be poisoned by the future.
 *   - AUDITABLE COMPLETENESS. A file self-documents lost events (tape_gap) and
 *     certifies a clean close (tape_writer_summary). An abrupt process exit leaves
 *     NO terminal summary, so the session is (correctly) classified INCOMPLETE and
 *     can never masquerade as complete.
 *   - SECRET-SAFE. Bars carry no credentials; a defensive scrub drops secret-shaped
 *     keys from any payload before write.
 *
 * Node-only (fs / child_process). NEVER import from a client component.
 */
import { appendFileSync } from 'fs'
import { homedir } from 'os'
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
/** Per-ET-day append-only sink dir. `COMPANION_1M_TAPE_DIR` overrides (tests only). */
export function tapeFile(day: string = etDayKey()): string {
  const dir = process.env.COMPANION_1M_TAPE_DIR || homedir()
  return join(dir, `.companion-1m-tape-${day}.jsonl`)
}
/** Max buffered bar lines before we DROP (never block). ~ one very large sweep's worth.
 *  Read dynamically so a research/test override takes effect without a module reload. */
function maxQueue(): number {
  const v = Number(process.env.COMPANION_1M_TAPE_MAX_QUEUE)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 50_000
}
/** Flush when the queue reaches this depth (amortises appends without unbounded latency). */
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
const ESCALATE_AFTER = 5

// ── Mutable writer state (per Node process / daemon-server run) ──────────────────

const queue: string[] = []
let started = false
let runId: string | null = null
let producerHead: string | null | undefined = undefined  // undefined = not yet resolved
let flushTimer: ReturnType<typeof setInterval> | null = null
let signalsHooked = false
let lastWrittenDay: string | null = null
// Retained references so a test reset (or a re-init) can detach process listeners cleanly
// and never leak them across runs (avoids MaxListenersExceeded).
let beforeExitHandler: (() => void) | null = null
const signalHandlers: Array<{ sig: NodeJS.Signals; handler: () => void }> = []

// Dedup / revision bookkeeping. Key = `${symbol}|${timeframe}|${barTimeSec}`.
const seen = new Map<string, { fingerprint: string; revisionSequence: number }>()

// Completeness counters (research integrity — surfaced in the terminal summary).
let eventsAttempted = 0
let eventsWritten = 0
let identicalDuplicatesSuppressed = 0
let revisionsWritten = 0
let eventsDropped = 0
let writeFailures = 0
let queueOverflows = 0
let degraded = false
let degradedEver = false
let firstFailureAt: string | null = null
let lastFailureAt: string | null = null
let droppedSinceLastOk = 0
let consecutiveFailures = 0

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

/** Deterministic 8-hex fingerprint of a bar's OHLCV (FNV-1a, dep-free) — matches the repo's config-hash idiom. */
export function barFingerprint(o: number, h: number, l: number, c: number, v: number): string {
  const s = `${o}|${h}|${l}|${c}|${v}`
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { hash ^= s.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Resolve `git HEAD` ONCE per run (best-effort). Never throws; null when indeterminate. */
function resolveProducerHead(): string | null {
  if (producerHead !== undefined) return producerHead
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' })
    const out = (r.stdout ?? '').trim()
    producerHead = r.status === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null
  } catch {
    producerHead = null
  }
  return producerHead
}

// ── Source provenance sidecar (STEP 10) ─────────────────────────────────────────
// The canonical 1m fetch (Yahoo → FMP fallback) is cached; on a cache HIT the fetcher
// does not run, so the winning provider is otherwise unknowable at the tape boundary.
// The monitor fetch factory calls `recordCandleSource` on a real fetch; the tape reads
// it back here. When absent (cache populated elsewhere, or expired) we honestly say
// UNKNOWN and never claim a provider.
//
// PARITY: provenance lives in this module's OWN small bounded map — NOT the shared
// trading `cache`. That guarantees the tape adds zero entries/eviction pressure to the
// production cache, so provider acquisition/load stays byte-identical to pre-H4B.
interface CandleSourceProvenance { source: TapeSource; fetchedAt: string; expiresAt: number }
const CANDLE_SRC_TTL_MS = 30_000        // mirrors TTL.CANDLES_1M; provenance is only meaningful that long
const MAX_CANDLE_SRC = 2_000            // bounded — evict oldest under pressure (then source → UNKNOWN, honest)
const candleSrc = new Map<string, CandleSourceProvenance>()
export function recordCandleSource(symbol: string, source: 'yahoo' | 'fmp', now: number = Date.now()): void {
  try {
    const key = symbol.toUpperCase()
    if (candleSrc.size >= MAX_CANDLE_SRC && !candleSrc.has(key)) {
      const oldest = candleSrc.keys().next().value
      if (oldest !== undefined) candleSrc.delete(oldest)
    }
    candleSrc.set(key, { source, fetchedAt: new Date(now).toISOString(), expiresAt: now + CANDLE_SRC_TTL_MS })
  } catch { /* provenance is best-effort; never disturb the fetch */ }
}
function readCandleSource(symbol: string, now: number): CandleSourceProvenance | null {
  const p = candleSrc.get(symbol.toUpperCase())
  if (!p) return null
  if (now > p.expiresAt) { candleSrc.delete(symbol.toUpperCase()); return null }
  return p
}

// ── Failure accounting (fail-open, rate-limited, never blocks) ───────────────────

function onWriteFailure(lostCount: number, err: unknown): void {
  writeFailures++
  eventsDropped += lostCount
  droppedSinceLastOk += lostCount
  consecutiveFailures++
  const nowIso = new Date().toISOString()
  if (firstFailureAt === null) firstFailureAt = nowIso
  lastFailureAt = nowIso
  if (consecutiveFailures <= ESCALATE_AFTER || consecutiveFailures % 100 === 0) {
    console.warn(`[1m-tape] write failed (${consecutiveFailures}), dropped ${lostCount}: ${(err as Error)?.message ?? err}`)
  }
  markDegraded('write_failure')
}

function markDegraded(reason: string): void {
  if (degraded) return
  degraded = true
  degradedEver = true
  // Emit a durable degraded marker directly (rare event, off the per-bar hot path).
  appendRaw({
    eventType: 'tape_writer_degraded',
    reason,
    eventsDropped, queueOverflows, writeFailures,
  })
  console.error(
    `[1m-tape] writer DEGRADED (${reason}) — research tape is dropping data. ` +
    `Trading/BASE is unaffected. Investigate ${tapeFile()}.`,
  )
}

function markRecovered(): void {
  if (!degraded) return
  degraded = false
  consecutiveFailures = 0
  appendRaw({ eventType: 'tape_writer_recovered', eventsDropped, queueOverflows, writeFailures })
}

// ── The write path ───────────────────────────────────────────────────────────

/** Stamp shared identity onto every record. */
function stamp(rec: Record<string, unknown>, now: number): Record<string, unknown> {
  return {
    tapeSchemaVersion: TAPE_SCHEMA_VERSION,
    tsUtc: new Date(now).toISOString(),
    runId,
    producerHead: producerHead ?? null,
    ...(scrub(rec) as Record<string, unknown>),
  }
}

/**
 * Write ONE health/control record directly (rare, off the per-bar hot path). It does NOT
 * flush the buffered bars (that would re-enter flushSync); every record carries tsUtc /
 * observedAtMs, so a forensic reader orders by time, not file position. Best-effort; never throws.
 */
function appendRaw(rec: Record<string, unknown>, now: number = Date.now()): void {
  try {
    const day = etDayKey(now)
    handleRotation(day, now)
    appendFileSync(tapeFile(day), JSON.stringify(stamp(rec, now)) + '\n')
    lastWrittenDay = day
  } catch { /* health markers are best-effort; their ABSENCE is the conservative signal */ }
}

/** Emit cross-ET-midnight continuation markers so a spanning run is CONTINUED, not INCOMPLETE. */
function handleRotation(day: string, now: number): void {
  if (lastWrittenDay === null || lastWrittenDay === day) return
  try {
    const base = {
      tapeSchemaVersion: TAPE_SCHEMA_VERSION, tsUtc: new Date(now).toISOString(),
      runId, producerHead: producerHead ?? null, fromDay: lastWrittenDay, toDay: day,
    }
    appendFileSync(tapeFile(lastWrittenDay), JSON.stringify({
      eventType: 'tape_rotated', ...base, direction: 'continued_in_next_file',
      note: 'run continued across ET midnight into toDay; this file is CONTINUED, not incomplete — certified in toDay by runId',
    }) + '\n')
    appendFileSync(tapeFile(day), JSON.stringify({
      eventType: 'tape_rotated', ...base, direction: 'continued_from_prev_file',
    }) + '\n')
  } catch { /* linking is best-effort; failure just leaves the prior file classified INCOMPLETE (conservative) */ }
}

/**
 * Drain the queued bar lines to disk in ONE append per target day (append ordering
 * preserved; a single appendFileSync is one syscall, so records cannot interleave even
 * under concurrent monitor requests in this single-threaded process). Best-effort.
 */
export function flushSync(now: number = Date.now()): void {
  if (queue.length === 0 && droppedSinceLastOk === 0) return
  const day = etDayKey(now)
  handleRotation(day, now)
  if (queue.length > 0) {
    const batch = queue.splice(0, queue.length)
    try {
      appendFileSync(tapeFile(day), batch.join(''))
      eventsWritten += batch.length
      lastWrittenDay = day
      if (consecutiveFailures > 0 || degraded) markRecovered()
      consecutiveFailures = 0
    } catch (err) {
      // The whole batch is lost (append is all-or-nothing for our accounting). Never re-queue
      // unboundedly against an unwritable disk — record the loss so recovery emits a tape_gap.
      onWriteFailure(batch.length, err)
      return
    }
  }
  // A prior loss window just closed: persist a durable gap marker so the file self-documents it.
  if (droppedSinceLastOk > 0 && lastWrittenDay === day) {
    try {
      appendFileSync(tapeFile(day), JSON.stringify({
        eventType: 'tape_gap',
        tapeSchemaVersion: TAPE_SCHEMA_VERSION, tsUtc: new Date(now).toISOString(),
        runId, producerHead: producerHead ?? null,
        droppedEvents: droppedSinceLastOk, droppedTotalThisRun: eventsDropped,
        note: 'tape writes were lost then recovered — this file is missing droppedEvents bar records for the preceding window; treat this session as DEGRADED',
      }) + '\n')
      droppedSinceLastOk = 0
    } catch { /* keep the counter; the next successful flush retries the marker */ }
  }
}

function ensureStarted(now: number): void {
  if (started) return
  started = true
  runId = `tape-${now}-${Math.random().toString(36).slice(2, 8)}`
  resolveProducerHead()
  // tape_writer_started is the FIRST record of a run (direct; establishes runId + provenance).
  appendRaw({
    eventType: 'tape_writer_started',
    startedAtUtc: new Date(now).toISOString(),
    pid: process.pid,
    schemaVersion: TAPE_SCHEMA_VERSION,
  }, now)
  // Background flush timer, unref'd so it never holds the process open.
  if (flushTimer === null) {
    flushTimer = setInterval(() => { try { flushSync() } catch { /* best-effort */ } }, FLUSH_INTERVAL_MS)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }
  hookExit()
}

/**
 * Best-effort clean close: flush the tail and write the terminal summary. Registered on
 * 'beforeExit' (fires on normal event-loop drain) and on SIGINT/SIGTERM via a re-raise idiom
 * that PRESERVES default termination (we remove our own listener and re-send the signal), so
 * the tape never changes how the process exits. An abrupt SIGKILL/crash writes no summary —
 * which correctly leaves the session INCOMPLETE.
 */
function hookExit(): void {
  if (signalsHooked) return
  signalsHooked = true
  beforeExitHandler = () => { try { emitTapeSummary() } catch { /* best-effort */ } }
  process.once('beforeExit', beforeExitHandler)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      try { emitTapeSummary() } catch { /* best-effort */ }
      process.removeListener(sig, handler)
      // Re-raise so the process terminates exactly as it would have without us.
      try { process.kill(process.pid, sig) } catch { /* if kill fails, do not force-exit; leave lifecycle untouched */ }
    }
    signalHandlers.push({ sig, handler })
    process.on(sig, handler)
  }
}

/** Detach all process listeners this writer registered (used on reset / re-init). */
function unhookExit(): void {
  if (beforeExitHandler) { process.removeListener('beforeExit', beforeExitHandler); beforeExitHandler = null }
  for (const { sig, handler } of signalHandlers) process.removeListener(sig, handler)
  signalHandlers.length = 0
  signalsHooked = false
}

// ── Bar-status classification (STEP 4) ──────────────────────────────────────────

/**
 * Classify an observed 1m bar. A bar earlier than the newest is CLOSED (a strictly newer
 * bar exists — stronger evidence than wall clock). The newest bar is CLOSED only once its
 * minute ended more than PUBLICATION_MARGIN_SEC ago by the REFERENCE clock (receivedAt when
 * known, else observedAt) — never "CLOSED because its timestamp is before wall clock".
 */
export function classifyBarStatus(
  barTimeSec: number, maxTimeSec: number, refMs: number,
): BarStatus {
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
 * BEST-EFFORT: any failure is swallowed — the monitor path is never affected.
 */
export function recordBarObservations(input: {
  symbol: string
  candles: Candle[]
  requestKind: TapeRequestKind
  session?: string
  now?: number
}): void {
  if (!tapeEnabled()) return
  const candles = input.candles
  if (!candles || candles.length === 0) return
  const now = input.now ?? Date.now()
  try {
    ensureStarted(now)
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
      const fp = barFingerprint(o, h, l, cl, v)
      const prior = seen.get(key)

      let revisionSequence: number
      if (!prior) {
        revisionSequence = 0
      } else if (prior.fingerprint === fp) {
        identicalDuplicatesSuppressed++   // exact repeat — the tape already knows this value
        continue
      } else {
        revisionSequence = prior.revisionSequence + 1
        revisionsWritten++
      }

      // Honest data-quality flags (never silently drop evidence).
      const priceFinite = [o, h, l, cl].every(Number.isFinite)
      const priceValid = priceFinite && o > 0 && h > 0 && l > 0 && cl > 0 && h >= l
      const volumeMissing = !Number.isFinite(v)
      const dataQuality = !priceFinite ? 'NON_FINITE_PRICE'
        : !priceValid ? 'INVALID_PRICE'
        : volumeMissing ? 'MISSING_VOLUME'
        : 'OK'

      const rec: Record<string, unknown> = {
        eventType: 'bar_observation',
        symbol: sym,
        timeframe: '1m',
        barTimeSec,
        barTimestamp: new Date(barTimeSec * 1000).toISOString(),
        open: Number.isFinite(o) ? o : null,
        high: Number.isFinite(h) ? h : null,
        low: Number.isFinite(l) ? l : null,
        close: Number.isFinite(cl) ? cl : null,
        volume: volumeMissing ? null : v,
        barStatus: classifyBarStatus(barTimeSec, maxTimeSec, refMs),
        statusBasis,
        barFingerprint: fp,
        revisionSequence,
        observedAt,
        observedAtMs: now,
        receivedAt,
        source,
        requestKind: input.requestKind,
        session: input.session ?? null,
        localFeatureConfigVersion: cfgVersion,
        localFeatureConfigHash: cfgHash,
        dataQuality,
      }

      enqueue(JSON.stringify(stamp(rec, now)) + '\n')
      // Bound the dedup map (insertion-order eviction). A re-observation of an evicted key
      // would be written again as fresh — over-recording, never a destructive overwrite.
      if (seen.size >= MAX_DEDUP_KEYS) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      seen.set(key, { fingerprint: fp, revisionSequence })
    }

    if (queue.length >= FLUSH_BATCH) flushSync(now)
  } catch (err) {
    // The hot path must never throw. Count it, mark degraded once, move on.
    console.warn(`[1m-tape] recordBarObservations(${input.symbol}) failed:`, (err as Error)?.message ?? err)
    markDegraded('enqueue_error')
  }
}

function enqueue(line: string): void {
  eventsAttempted++
  if (queue.length >= maxQueue()) {
    // Queue full: DROP explicitly (never block trading to save research data).
    eventsDropped++
    queueOverflows++
    droppedSinceLastOk++
    markDegraded('queue_overflow')
    return
  }
  queue.push(line)
  if (degraded && queueOverflows === 0 && writeFailures === 0) markRecovered()
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
  queueOverflows: number
  degradedEver: boolean
  firstFailureAt: string | null
  lastFailureAt: string | null
  cleanClose: true
}

export function buildTapeSummary(): TapeSessionSummary {
  return {
    runId,
    eventsAttempted, eventsWritten,
    identicalDuplicatesSuppressed, revisionsWritten,
    eventsDropped, writeFailures, queueOverflows,
    degradedEver, firstFailureAt, lastFailureAt,
    cleanClose: true,
  }
}

/**
 * Append the terminal `tape_writer_summary`. Call on graceful shutdown ONLY. Flushes the
 * tail first. Returns whether the summary was actually persisted. If the sink is unwritable
 * through shutdown this returns false and the marker is ABSENT — that absence is the (correct)
 * evidence the file cannot be certified complete. Never throws.
 */
export function emitTapeSummary(now: number = Date.now()): boolean {
  if (!started) return false
  try {
    flushSync(now)
    const day = etDayKey(now)
    handleRotation(day, now)
    const record = {
      eventType: 'tape_writer_summary' as const,
      tapeSchemaVersion: TAPE_SCHEMA_VERSION,
      tsUtc: new Date(now).toISOString(),
      producerHead: producerHead ?? null,
      ...buildTapeSummary(),
    }
    appendFileSync(tapeFile(day), JSON.stringify(record) + '\n')
    lastWrittenDay = day
    return true
  } catch {
    return false
  }
}

// ── Health readouts (for a heartbeat / diagnostics; never a decision input) ──────

export function tapeDegraded(): boolean { return degraded }
export function tapeDroppedTotal(): number { return eventsDropped }
export function tapeQueueDepth(): number { return queue.length }

// ── Test-only reset ──────────────────────────────────────────────────────────

/** TEST ONLY: reset all writer state so per-test assertions are deterministic. */
export function __resetTapeForTest(): void {
  queue.length = 0
  seen.clear()
  candleSrc.clear()
  started = false
  runId = null
  producerHead = undefined
  if (flushTimer !== null) { clearInterval(flushTimer); flushTimer = null }
  unhookExit()
  lastWrittenDay = null
  eventsAttempted = 0; eventsWritten = 0
  identicalDuplicatesSuppressed = 0; revisionsWritten = 0
  eventsDropped = 0; writeFailures = 0; queueOverflows = 0
  degraded = false; degradedEver = false
  firstFailureAt = null; lastFailureAt = null
  droppedSinceLastOk = 0; consecutiveFailures = 0
}
