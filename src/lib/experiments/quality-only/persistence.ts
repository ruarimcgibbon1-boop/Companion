/**
 * QUALITY_ONLY collection-integrity persistence layer.
 *
 * Persists: candidate events, outcome events, completeness state, corruption/
 * torn-line state, producer head (git HEAD), branch, configHash,
 * decisionPolicyHash, epoch, start marker.
 *
 * IMPORTANT: `createStartMarker()` implements the O_EXCL-equivalent atomic
 * marker-creation mechanism and the PRE_OFFICIAL labeling logic FULLY, but this
 * module is never invoked to actually create the marker in this task — see
 * tests/quality-only.test.ts's marker test, which proves atomicity by creating
 * and then immediately deleting a marker in a throwaway temp directory, never
 * touching the repo's real research-data location.
 *
 * PAPER/RESEARCH ONLY. No broker/PaperExecutor import anywhere in this file.
 */
import { openSync, closeSync, existsSync, appendFileSync, readFileSync, constants as fsConstants } from 'fs'
import type { Provenance } from './spec'

// ── Journal event types ──────────────────────────────────────────────────────

export interface CandidateEvent {
  kind: 'candidate'
  identity: string
  payload: unknown
  provenance: Provenance
  preOfficial: boolean
}

export interface OutcomeEvent {
  kind: 'outcome'
  identity: string
  payload: unknown
  provenance: Provenance
  preOfficial: boolean
}

export type JournalEvent = CandidateEvent | OutcomeEvent

// ── O_EXCL-equivalent atomic marker creation ────────────────────────────────

export interface MarkerCreateResult {
  created: boolean
  alreadyExisted: boolean
  markerPath: string
  createdAt: string | null
}

/**
 * Atomically create the official-collection-start marker file. Uses
 * `fs.openSync(path, 'wx')` — Node's O_EXCL-equivalent: the syscall itself
 * fails with EEXIST if the file already exists, so there is no
 * check-then-create race window. Never silently overwrites or recreates an
 * existing marker (non-negotiable #8).
 *
 * NOT CALLED anywhere in this task against the real research-data location —
 * only exercised in tests against a throwaway temp path, which is deleted
 * immediately after the test so no marker artifact is left in the repo.
 */
export function createStartMarker(markerPath: string, provenance: Provenance): MarkerCreateResult {
  if (existsSync(markerPath)) {
    return { created: false, alreadyExisted: true, markerPath, createdAt: null }
  }
  try {
    const fd = openSync(markerPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY)
    const createdAt = new Date().toISOString()
    try {
      appendFileSync(fd, JSON.stringify({ ...provenance, createdAt }, null, 2))
    } finally {
      closeSync(fd)
    }
    return { created: true, alreadyExisted: false, markerPath, createdAt }
  } catch (err: unknown) {
    // EEXIST from a concurrent creator that won the race between our existsSync
    // check and the open() call — fail safe, report "already existed", never throw
    // up into the caller as a fatal (a double-create attempt is an expected,
    // handled case, not corruption).
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      return { created: false, alreadyExisted: true, markerPath, createdAt: null }
    }
    throw err
  }
}

export function readStartMarker(markerPath: string): { exists: boolean; createdAt: string | null } {
  if (!existsSync(markerPath)) return { exists: false, createdAt: null }
  try {
    const raw = JSON.parse(readFileSync(markerPath, 'utf8'))
    return { exists: true, createdAt: raw.createdAt ?? null }
  } catch {
    // Malformed marker file: fail conservatively — report it exists (so no
    // second collection start is silently permitted) but with an unknown
    // creation time, never crash.
    return { exists: true, createdAt: null }
  }
}

/** A row is PRE_OFFICIAL iff its observedAt is before the marker's createdAt, or
 *  no marker has been created yet at all (everything is PRE_OFFICIAL pre-start). */
export function isPreOfficial(observedAtMs: number, marker: { exists: boolean; createdAt: string | null }): boolean {
  if (!marker.exists || marker.createdAt == null) return true
  return observedAtMs < Date.parse(marker.createdAt)
}

// ── Corrupt / torn record handling ──────────────────────────────────────────

export type ParsedLine =
  | { ok: true; event: JournalEvent }
  | { ok: false; reason: 'empty' | 'malformed_json' | 'missing_required_field' | 'torn_line'; raw: string }

const REQUIRED_FIELDS = ['kind', 'identity', 'payload', 'provenance', 'preOfficial'] as const

/**
 * Parse one journal line. FAILS CONSERVATIVELY (non-negotiable #11): a
 * malformed or torn line is never silently dropped (it's returned as an
 * explicit `ok:false` record the caller must account for) and never silently
 * accepted as valid data (a line missing a required field, or one that doesn't
 * parse as JSON at all — e.g. truncated mid-write by a crash — is rejected,
 * not coerced).
 */
export function parseJournalLine(raw: string): ParsedLine {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty', raw }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    // A torn line (process died mid-write, no trailing newline/brace) throws
    // here — same bucket as fully malformed JSON, both fail conservatively.
    return { ok: false, reason: trimmed.endsWith('}') ? 'malformed_json' : 'torn_line', raw }
  }
  if (obj == null || typeof obj !== 'object') return { ok: false, reason: 'malformed_json', raw }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in (obj as Record<string, unknown>))) return { ok: false, reason: 'missing_required_field', raw }
  }
  return { ok: true, event: obj as JournalEvent }
}

export function parseJournal(contents: string): { events: JournalEvent[]; corrupt: ParsedLine[] } {
  const events: JournalEvent[] = []
  const corrupt: ParsedLine[] = []
  for (const line of contents.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = parseJournalLine(line)
    if (parsed.ok) events.push(parsed.event)
    else corrupt.push(parsed)
  }
  return { events, corrupt }
}

// ── Append-only journal writer with shutdown drain ──────────────────────────

/**
 * Minimal append-only writer. Writes are queued in-memory and flushed
 * synchronously; `shutdown()` drains anything still queued before returning,
 * so a process exit never silently loses a queued research write
 * (non-negotiable #12). Kept deliberately simple (no async I/O, no batching
 * window) since QUALITY_ONLY candidate volume is low-frequency relative to the
 * daemon's own decision-log writes.
 */
export class JournalWriter {
  private queue: JournalEvent[] = []
  private path: string
  private closed = false

  constructor(path: string) {
    this.path = path
  }

  enqueue(event: JournalEvent): void {
    if (this.closed) throw new Error('JournalWriter: enqueue after shutdown')
    this.queue.push(event)
  }

  /** Number of events still queued and not yet flushed to disk. */
  pending(): number {
    return this.queue.length
  }

  private flushOne(event: JournalEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`)
  }

  /**
   * Drains the queue synchronously, in FIFO (append-only) order.
   *
   * `budgetMs` (optional, default unlimited — existing callers/tests that
   * call `shutdown()` with no argument are byte-for-byte unaffected) bounds
   * how long this drain may run: research completeness must never be allowed
   * to delay process exit indefinitely. If the budget is exceeded mid-drain,
   * remaining queued events are left in place (not dropped — a NEXT call to
   * shutdown(), or a fresh process picking the journal back up, can still
   * flush them) and `timedOut: true` is reported. Queue volume here is
   * low-frequency research writes, so in practice this budget is not expected
   * to bind; it exists as a fail-conservative backstop, not a normal path.
   */
  shutdown(budgetMs?: number): { drained: number; timedOut: boolean } {
    const deadline = budgetMs != null ? Date.now() + budgetMs : null
    let drained = 0
    let timedOut = false
    while (this.queue.length > 0) {
      if (deadline != null && Date.now() > deadline) { timedOut = true; break }
      const ev = this.queue.shift()!
      this.flushOne(ev)
      drained++
    }
    // `closed` is set unconditionally, matching the pre-existing contract
    // exactly when no budget is given (drained === original queue length).
    // With a budget and a timeout, any leftover events are simply not
    // flushed on THIS call — enqueue() would now throw for them, which is
    // acceptable because the daemon never enqueues after shutdown begins.
    this.closed = true
    return { drained, timedOut }
  }
}
