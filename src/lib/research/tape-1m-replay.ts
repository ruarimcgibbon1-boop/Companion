/**
 * H4B-PREP — CANONICAL 1-MINUTE RESEARCH TAPE (pure reader / causal replay).
 *
 * These helpers are PURE (no fs, no network, no side effects). They take the parsed
 * event stream of one or more tape files and answer the load-bearing H4B question:
 *
 *     "What bar value had Companion observed by time T?"
 *
 * NO-LOOKAHEAD CONTRACT (STEP 12): a bar revision observed at 13:05 must NEVER change
 * what a replay AS OF 13:03 returns. Every reconstruction is filtered by
 * `observedAtMs <= asOfMs`, so the future can never leak into the past.
 *
 * A small impure loader (`readTapeFile`) is provided for convenience; it tolerates a
 * torn/partial trailing line (counts it as malformed and skips it) so a crash mid-append
 * can never crash the reader.
 */
import { readFileSync } from 'fs'
import type { Candle } from '@/types'
import type { TapeEventType, BarStatus, TapeRequestKind, TapeSource } from './tape-1m'

/** One parsed tape event (loose — forensic readers accept unknown/extra fields). */
export interface TapeEvent {
  eventType: TapeEventType | string
  [k: string]: unknown
}

/** A parsed bar_observation with the fields replay relies on. */
export interface BarObservation extends TapeEvent {
  eventType: 'bar_observation'
  symbol: string
  timeframe: string
  barTimeSec: number
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  barStatus: BarStatus
  barFingerprint: string
  revisionSequence: number
  observedAtMs: number
  observedAt: string
  receivedAt: string | null
  source: TapeSource
  requestKind: TapeRequestKind
}

/** One ordered non-empty line of a tape file: a parsed event, or a malformed/torn line. */
export interface TapeEntry { ok: boolean; event?: TapeEvent; raw: string }

/** Parse-integrity metadata — completeness certification MUST consume this, not just print it. */
export interface TapeParseResult {
  events: TapeEvent[]          // parsed events, in order (malformed lines excluded)
  entries: TapeEntry[]         // EVERY non-empty line in order, ok or not (for position-aware certification)
  malformed: number            // count of malformed/torn lines
  malformedTrailing: boolean   // the LAST non-empty line was malformed (classic crash-mid-append signature)
}

/**
 * Parse JSONL text. A malformed/torn line (e.g. a partial final append) is recorded as a
 * `{ ok: false }` entry, skipped from `events`, and counted. Ordering is preserved so a
 * later certification step can tell WHERE the damage is (e.g. after the last clean summary).
 */
export function parseTape(text: string): TapeParseResult {
  const events: TapeEvent[] = []
  const entries: TapeEntry[] = []
  let malformed = 0
  let malformedTrailing = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const e = JSON.parse(t)
      if (e && typeof e === 'object') { events.push(e as TapeEvent); entries.push({ ok: true, event: e as TapeEvent, raw: t }); malformedTrailing = false }
      else { malformed++; entries.push({ ok: false, raw: t }); malformedTrailing = true }
    } catch {
      malformed++; entries.push({ ok: false, raw: t }); malformedTrailing = true
    }
  }
  return { events, entries, malformed, malformedTrailing }
}

/** Impure convenience loader: read + parse one tape file. Missing file → empty. */
export function readTapeFile(path: string): TapeParseResult {
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch { return { events: [], entries: [], malformed: 0, malformedTrailing: false } }
  return parseTape(text)
}

/** Only the bar observations, in stream order. */
export function barObservations(events: TapeEvent[]): BarObservation[] {
  return events.filter(
    (e): e is BarObservation =>
      e.eventType === 'bar_observation' &&
      typeof (e as BarObservation).symbol === 'string' &&
      typeof (e as BarObservation).barTimeSec === 'number' &&
      typeof (e as BarObservation).observedAtMs === 'number',
  )
}

/**
 * The single latest observation of ONE bar (symbol + barTimeSec) that Companion had
 * recorded AS OF `asOfMs`. Among observations with `observedAtMs <= asOfMs`, the one
 * with the greatest `observedAtMs` wins (ties broken by the greater `revisionSequence`,
 * then later stream position). Returns null if the bar was not yet observed by then.
 *
 * This is the causal primitive: a future revision (observedAtMs > asOfMs) is invisible.
 */
export function latestObservationAsOf(
  events: TapeEvent[], symbol: string, barTimeSec: number, asOfMs: number,
): BarObservation | null {
  const sym = symbol.toUpperCase()
  let best: BarObservation | null = null
  let bestIdx = -1
  const obs = barObservations(events)
  for (let i = 0; i < obs.length; i++) {
    const e = obs[i]
    if (e.symbol.toUpperCase() !== sym || e.barTimeSec !== barTimeSec) continue
    if (e.observedAtMs > asOfMs) continue   // NO LOOKAHEAD
    if (best === null) { best = e; bestIdx = i; continue }
    if (
      e.observedAtMs > best.observedAtMs ||
      (e.observedAtMs === best.observedAtMs && e.revisionSequence > best.revisionSequence) ||
      (e.observedAtMs === best.observedAtMs && e.revisionSequence === best.revisionSequence && i > bestIdx)
    ) { best = e; bestIdx = i }
  }
  return best
}

/**
 * Reconstruct the 1m series for `symbol` exactly AS Companion KNEW IT at `asOfMs`:
 * for each distinct bar minute observed by then, the latest observation as of that time,
 * sorted ascending by bar time. A bar first observed after `asOfMs` is absent; a bar
 * revised after `asOfMs` shows its earlier (as-of) value. This is the causal input for H4B.
 *
 * Bars whose OHLC is null (recorded but data-quality flagged) are omitted from the
 * reconstructed Candle[] — the raw observation is still in the tape for forensic reads.
 */
export function barsAsKnownAt(events: TapeEvent[], symbol: string, asOfMs: number): Candle[] {
  const sym = symbol.toUpperCase()
  const byBar = new Map<number, BarObservation>()
  for (const e of barObservations(events)) {
    if (e.symbol.toUpperCase() !== sym) continue
    if (e.observedAtMs > asOfMs) continue   // NO LOOKAHEAD
    const cur = byBar.get(e.barTimeSec)
    if (
      !cur ||
      e.observedAtMs > cur.observedAtMs ||
      (e.observedAtMs === cur.observedAtMs && e.revisionSequence > cur.revisionSequence)
    ) byBar.set(e.barTimeSec, e)
  }
  const out: Candle[] = []
  for (const [barTimeSec, e] of byBar) {
    if (e.open == null || e.high == null || e.low == null || e.close == null) continue
    out.push({ time: barTimeSec, open: e.open, high: e.high, low: e.low, close: e.close, volume: e.volume ?? 0 })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

/** Every distinct observation of one bar, oldest→newest (the full revision history). */
export function revisionHistory(
  events: TapeEvent[], symbol: string, barTimeSec: number,
): BarObservation[] {
  const sym = symbol.toUpperCase()
  return barObservations(events)
    .filter(e => e.symbol.toUpperCase() === sym && e.barTimeSec === barTimeSec)
    .sort((a, b) =>
      a.observedAtMs - b.observedAtMs || a.revisionSequence - b.revisionSequence)
}

// ── Completeness classification (mirrors the H3A funnel model) ────────────────────

export type TapeCompleteness = 'COMPLETE' | 'DEGRADED_COMPLETE' | 'CONTINUED' | 'INCOMPLETE'

const isContinuedOut = (e: TapeEvent): boolean =>
  e.eventType === 'tape_rotated' && (e as { direction?: string }).direction === 'continued_in_next_file'

/**
 * Classify ONE session/segment's completeness:
 *   CONTINUED         — the run crossed ET midnight: the last closer is a `tape_rotated`
 *                       continued_in_next_file marker (certified in the next day's file by runId).
 *   INCOMPLETE        — no terminal summary AND no continuation marker (or cleanClose !== true),
 *                       OR a real event trails the last closer. Absence NEVER means "zero drops".
 *   DEGRADED_COMPLETE — terminal summary present AND (drops/failures/overflows/degradedEver, or a
 *                       tape_gap / tape_writer_degraded marker exists).
 *   COMPLETE          — terminal summary present, no drops, never degraded, no gap/degraded markers.
 * The LAST closer decides (scan from the end: first event that is a summary OR a continued_in_next_file).
 * A per-day file with several runs should be split first (splitTapeSessions).
 *
 * `integrity` (optional) folds torn/malformed-line evidence into the verdict — pass it from
 * parseTape so a damaged file is NEVER certified COMPLETE. See `assessTapeFile` for the
 * position-aware, file-level entry point that supplies it automatically.
 */
export function assessTapeCompleteness(
  events: TapeEvent[],
  integrity?: { malformedAfterLastCloser?: boolean; malformedInCertifiedRegion?: boolean },
): TapeCompleteness {
  let closerIdx = -1
  let closerKind: 'summary' | 'continued' | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.eventType === 'tape_writer_summary') { closerIdx = i; closerKind = 'summary'; break }
    if (isContinuedOut(e)) { closerIdx = i; closerKind = 'continued'; break }
  }
  if (closerKind === null) return 'INCOMPLETE'
  // Unexplained bytes after the last certification (e.g. a torn record from a NEW run that died)
  // mean an earlier clean summary can NOT certify the file.
  if (integrity?.malformedAfterLastCloser) return 'INCOMPLETE'
  const trailing = events.slice(closerIdx + 1).some(
    e => e.eventType !== 'tape_writer_summary' && e.eventType !== 'tape_rotated')
  if (trailing) return 'INCOMPLETE'
  if (closerKind === 'continued') return 'CONTINUED'
  const summary = events[closerIdx] as Record<string, unknown>
  if (summary.cleanClose !== true) return 'INCOMPLETE'
  const hadGap = events.some(e => e.eventType === 'tape_gap' || e.eventType === 'tape_writer_degraded')
  const dropped = typeof summary.eventsDropped === 'number' ? summary.eventsDropped : 0
  const failures = typeof summary.writeFailures === 'number' ? summary.writeFailures : 0
  const overflows = typeof summary.queueOverflows === 'number' ? summary.queueOverflows : 0
  const asyncFailures = typeof summary.asyncWriteFailures === 'number' ? summary.asyncWriteFailures : 0
  // A malformed line inside the certified region = a known-lost line → at best DEGRADED.
  if (dropped > 0 || failures > 0 || overflows > 0 || asyncFailures > 0 || summary.degradedEver === true ||
      hadGap || integrity?.malformedInCertifiedRegion) {
    return 'DEGRADED_COMPLETE'
  }
  return 'COMPLETE'
}

/**
 * File-level completeness that CONSUMES parse-integrity (torn/malformed lines). This is the
 * authoritative entry point for certifying a tape file on disk:
 *   - a malformed line AFTER the last clean closer → INCOMPLETE (unexplained bytes; a new run
 *     began and died without certification — an earlier clean summary must not certify it);
 *   - a malformed line WITHIN the certified region → at best DEGRADED_COMPLETE (a known-lost line
 *     means the exact historical event stream is not fully known);
 *   - otherwise the ordinary event-based verdict.
 * PURE.
 */
export function assessTapeFile(text: string): { completeness: TapeCompleteness; integrity: TapeParseResult } {
  const parsed = parseTape(text)
  // Position of the last closer among ALL entries (ok + malformed), in file order.
  let lastCloserEntryIdx = -1
  for (let i = parsed.entries.length - 1; i >= 0; i--) {
    const e = parsed.entries[i]
    if (!e.ok || !e.event) continue
    if (e.event.eventType === 'tape_writer_summary' || isContinuedOut(e.event)) { lastCloserEntryIdx = i; break }
  }
  let malformedAfterLastCloser = false
  let malformedInCertifiedRegion = false
  for (let i = 0; i < parsed.entries.length; i++) {
    if (parsed.entries[i].ok) continue
    if (lastCloserEntryIdx >= 0 && i > lastCloserEntryIdx) malformedAfterLastCloser = true
    else malformedInCertifiedRegion = true
  }
  const completeness = assessTapeCompleteness(parsed.events, { malformedAfterLastCloser, malformedInCertifiedRegion })
  return { completeness, integrity: parsed }
}

/**
 * Split a per-day tape file (which may hold SEVERAL runs — restarts append to the same ET-day
 * file) into per-run segments. Each segment ends at its terminal summary OR a continued_in_next_file
 * marker; a trailing un-closed segment is an in-progress/aborted run. PURE.
 */
export function splitTapeSessions(events: TapeEvent[]): TapeEvent[][] {
  const sessions: TapeEvent[][] = []
  let cur: TapeEvent[] = []
  for (const e of events) {
    cur.push(e)
    if (e.eventType === 'tape_writer_summary' || isContinuedOut(e)) { sessions.push(cur); cur = [] }
  }
  if (cur.length > 0) sessions.push(cur)
  return sessions
}

/**
 * Certify a WHOLE run that may span several ET-day files. Pass the concatenated event streams
 * of every file that shares this run (chained by tape_rotated / runId, in day order). Interior
 * continuation markers are ignored; the verdict is the run's real terminal state. PURE.
 */
export function assessTapeRun(concatenatedEventsInDayOrder: TapeEvent[]): TapeCompleteness {
  return assessTapeCompleteness(concatenatedEventsInDayOrder)
}
