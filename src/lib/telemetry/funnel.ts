/**
 * H3A — FULL-FUNNEL OBSERVABILITY (telemetry only).
 *
 * Append-only, sweep-scoped telemetry that makes the market-selection funnel
 * reconstructable end to end: discovery → merge → rank → monitored universe →
 * trigger → EXACT gates → arbitration → execution handoff.
 *
 * DESIGN CONTRACT (H3A):
 *   - PURE SIDE-CHANNEL. Nothing here is ever read back into a universe, ranking,
 *     detector, gate, arbitration or execution decision. It only records.
 *   - BEST-EFFORT / FAIL-OPEN, matching the existing `recordDecision`/`recordArbitration`
 *     philosophy (both are try/catch "audit trail is best-effort"). A telemetry write
 *     failure logs loudly and is dropped; it MUST NOT throw into the market loop, mutate
 *     any decision, create a second execution path, or fabricate success.
 *   - NO NEW MARKET DATA. Callers pass values already computed in memory; this module
 *     never fetches anything.
 *   - SECRET-SAFE. Never pass credentials/account ids; `emit` also scrubs obvious secret
 *     keys defensively (see SECRET_KEY_RE).
 *
 * Node-only (fs). Never import from a client component.
 */
import { appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { etDayKey } from '@/lib/execution/store'

/** Telemetry schema version. Bump on any breaking event-shape change. */
export const FUNNEL_SCHEMA_VERSION = 1

/**
 * Per-ET-day append-only sink. Rotates at ET midnight like the other audit logs.
 * `COMPANION_FUNNEL_DIR` overrides the directory (tests only) — never affects trading.
 */
export function funnelFile(day: string = etDayKey()): string {
  const dir = process.env.COMPANION_FUNNEL_DIR || homedir()
  return join(dir, `.companion-funnel-${day}.jsonl`)
}

export type FunnelEventType =
  | 'sweep_started'
  | 'discovery_observed'
  | 'symbol_merged'
  | 'symbol_ranked'
  | 'universe_decision'
  | 'tracking_floor'      // a raw trigger that failed passesTrackingFloor (was silently dropped pre-H3B)
  | 'strategy_trigger'
  | 'gate_evaluation'
  | 'arbitration_decision'
  | 'execution_handoff'
  | 'telemetry_gap'       // durable marker: N events were lost to write failures then recovered
  | 'funnel_rotated'      // the run crossed ET midnight into the next day's file (links the two files by runId)
  | 'leader_state_observed'    // H3C: compact per-sweep observation for a role-holder (CORE/CHALLENGER)
  | 'leader_state_transition'  // H3C: lifecycle state change
  | 'leader_role_changed'      // H3C: shadow role change (observational only)
  | 'leader_state_persisted'   // H3C: leader state saved to disk
  | 'leader_state_recovered'   // H3C: leader state loaded from disk on restart
  | 'leader_state_degraded'    // H3C: corrupt/crashed/secondary state -> history INCOMPLETE
  | 'leader_state_evicted'     // H3C: a non-expired record dropped under hard capacity pressure (auditable)
  | 'local_structure_observed'  // H4A: compact local-reset geometry snapshot for a symbol (observational)
  | 'local_structure_changed'   // H4A: the symbol's resetState / data-quality status changed since last sweep
  | 'leader_observation_cohort' // H4A.1: per-sweep bounded observational leader cohort (selection + cap + provenance)
  | 'leader_observation_data'   // H4A.1: per-symbol observational data coverage for a cohort member (no bar arrays)
  | 'leader_continuation_state'     // H4B: per-symbol reason-coded shadow funnel state (no candidate produced)
  | 'leader_continuation_candidate' // H4B: a distinct LEADER_CONTINUATION shadow candidate (structural; no bar arrays)

export type GateResult = 'PASS' | 'FAIL' | 'NOT_APPLICABLE'

/** One gate's exact reading. `binding` = did this gate actually stop the setup. */
export interface GateRecord {
  gateId: string
  observedValue: number | string | boolean | null
  ruleValue?: number | string | boolean | null
  result: GateResult
  binding: boolean | 'unknown'
}

/** Shared identity every event carries. Created once per sweep by the daemon. */
export interface SweepContext {
  sweepId: string
  producerHead: string | null
}

/** A monotonic per-process counter so two sweeps in the same ms still differ. */
let sweepSeq = 0
/**
 * Stable, deterministically-unique sweep id: `sweep-<ms>-<seq>-<rand>`.
 * Uniqueness comes from the seq; the rand only disambiguates across processes.
 * Sweep identity NEVER influences any decision — it is a telemetry join key.
 */
export function newSweepId(now: number = Date.now()): string {
  const seq = ++sweepSeq
  const rand = Math.random().toString(36).slice(2, 8)
  return `sweep-${now}-${seq}-${rand}`
}

// ── Failure semantics ────────────────────────────────────────────────────────
// H3A choice = (A) continue trading with DEGRADED observability, never fail closed
// the daemon on a telemetry write. This matches the existing best-effort audit logs
// and the invariant that observability must never threaten trading safety. Repeated
// failures escalate to a single loud error, then go quiet to avoid log spam, but the
// market loop is never blocked or altered.
let consecutiveFailures = 0
let escalated = false
// RESEARCH INTEGRITY: total events lost since the last successful write. On recovery a
// durable `telemetry_gap` marker records this count IN the funnel file, so a later audit
// can tell a complete session from one that silently dropped events. Never reset except
// by a successful gap marker.
let droppedSinceLastOk = 0
let droppedEverThisRun = 0
const ESCALATE_AFTER = 5

// Session-level tallies for the terminal `session_observability_summary` (research only).
let eventsAttempted = 0
let eventsWritten = 0
let sweepStartedCount = 0
let firstSweepId: string | null = null
let lastSweepId: string | null = null
let firstFailureAt: string | null = null
let lastFailureAt: string | null = null
let degradedEver = false
// CROSS-MIDNIGHT ROTATION: the sink rotates by ET day, but a run can span days (the daemon
// idle-loops across midnight). `runId` is one stable id for the whole daemon run; it links
// the per-day file segments so a validator can see a prior file was CONTINUED, not incomplete.
let runId: string | null = null
let lastWrittenDay: string | null = null   // ET day of the last successful write

/** The stable per-run id (minted lazily). Same across every ET-day file this run writes. */
function ensureRunId(now: number): string {
  if (runId === null) runId = `run-${now}-${Math.random().toString(36).slice(2, 8)}`
  return runId
}

/** Mint (if needed) and return the funnel run id, so the daemon can stamp the SweepSnapshot with
 *  the SAME runId its telemetry uses. Pure w.r.t. any decision — just an id. */
export function ensureFunnelRunId(now: number = Date.now()): string {
  return ensureRunId(now)
}

/** TEST ONLY: reset session counters so per-test assertions are deterministic. */
export function __resetFunnelCountersForTest(): void {
  consecutiveFailures = 0; escalated = false; droppedSinceLastOk = 0; droppedEverThisRun = 0
  eventsAttempted = 0; eventsWritten = 0; sweepStartedCount = 0
  firstSweepId = null; lastSweepId = null; firstFailureAt = null; lastFailureAt = null; degradedEver = false
  runId = null; lastWrittenDay = null
}

function onWriteError(err: unknown): void {
  consecutiveFailures++
  droppedSinceLastOk++
  droppedEverThisRun++
  const nowIso = new Date().toISOString()
  if (firstFailureAt === null) firstFailureAt = nowIso
  lastFailureAt = nowIso
  // Loud for the first ESCALATE_AFTER, then rate-limited (every 100th) so a long outage
  // is never fully silent but also never spams — the durable gap marker carries the exact count.
  if (consecutiveFailures <= ESCALATE_AFTER || consecutiveFailures % 100 === 0) {
    console.warn(`[funnel] telemetry write failed (${consecutiveFailures}): ${(err as Error)?.message ?? err}`)
  }
  if (consecutiveFailures === ESCALATE_AFTER && !escalated) {
    escalated = true
    degradedEver = true
    console.error(
      `[funnel] telemetry has failed ${ESCALATE_AFTER} times in a row — CONTINUING TO TRADE with DEGRADED observability. ` +
      `Trading/execution safety is unaffected; only the audit trail is impaired. Investigate ${funnelFile()}.`,
    )
  }
}

/** True after ESCALATE_AFTER consecutive failures — for a health/heartbeat readout. */
export function funnelDegraded(): boolean {
  return consecutiveFailures >= ESCALATE_AFTER
}

/** Total events dropped this daemon run (never resets) — for a session-level readout. */
export function funnelDroppedTotal(): number {
  return droppedEverThisRun
}

// Defensive scrub: never let an accidental secret reach disk. Keys matching this are
// dropped from any object payload before write.
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

/**
 * Emit one funnel event. Stamps schemaVersion + tsUtc + the sweep context; scrubs
 * secret-shaped keys; appends one JSON line. Never throws.
 */
export function emitFunnel(
  ctx: SweepContext,
  eventType: FunnelEventType,
  payload: Record<string, unknown> = {},
  now: number = Date.now(),
): void {
  eventsAttempted++
  if (firstSweepId === null && ctx.sweepId) firstSweepId = ctx.sweepId
  if (ctx.sweepId) lastSweepId = ctx.sweepId
  if (eventType === 'sweep_started') sweepStartedCount++
  try {
    const day = etDayKey(now)
    const file = funnelFile(day)
    // CROSS-ET-MIDNIGHT ROTATION: this run has moved to a new day file. Link the two so a
    // validator classifies the prior file as CONTINUED (not INCOMPLETE): a marker in the OLD
    // file points forward, one in the NEW file points back, both stamped with the run id.
    if (lastWrittenDay !== null && lastWrittenDay !== day) {
      try {
        const base = {
          schemaVersion: FUNNEL_SCHEMA_VERSION, tsUtc: new Date(now).toISOString(),
          sweepId: ctx.sweepId, producerHead: ctx.producerHead ?? null, runId: ensureRunId(now),
          fromDay: lastWrittenDay, toDay: day,
        }
        appendFileSync(funnelFile(lastWrittenDay), JSON.stringify({
          eventType: 'funnel_rotated', ...base, direction: 'continued_in_next_file',
          note: 'daemon run continued across ET midnight into toDay; this file is CONTINUED, not incomplete — the run is certified in toDay by runId',
        }) + '\n')
        appendFileSync(file, JSON.stringify({
          eventType: 'funnel_rotated', ...base, direction: 'continued_from_prev_file',
        }) + '\n')
      } catch { /* linking is best-effort; a failure just leaves the prior file classified INCOMPLETE (conservative) */ }
    }
    const record = {
      eventType,
      schemaVersion: FUNNEL_SCHEMA_VERSION,
      tsUtc: new Date(now).toISOString(),
      sweepId: ctx.sweepId,
      producerHead: ctx.producerHead ?? null,
      ...(scrub(payload) as Record<string, unknown>),
    }
    appendFileSync(file, JSON.stringify(record) + '\n')
    eventsWritten++
    lastWrittenDay = day
    // RESEARCH INTEGRITY: the write just succeeded. If events were lost during a prior
    // outage, persist a durable gap marker so the file self-documents the loss (a later
    // audit reading only the file can then exclude a telemetry-compromised session).
    if (droppedSinceLastOk > 0) {
      const gap = {
        eventType: 'telemetry_gap' as FunnelEventType,
        schemaVersion: FUNNEL_SCHEMA_VERSION,
        tsUtc: new Date(now).toISOString(),
        sweepId: ctx.sweepId,
        producerHead: ctx.producerHead ?? null,
        droppedEvents: droppedSinceLastOk,
        droppedTotalThisRun: droppedEverThisRun,
        note: 'funnel writes failed then recovered — this file is missing droppedEvents records for the preceding window; exclude this session from strict prospective analysis',
      }
      appendFileSync(file, JSON.stringify(gap) + '\n')  // if THIS throws, catch below keeps the counter for the next retry
      droppedSinceLastOk = 0
    }
    consecutiveFailures = 0
    escalated = false
  } catch (err) {
    onWriteError(err)
  }
}

/**
 * Emit a batch of events under one sweep context. Each is independent and best-effort;
 * a single failure never aborts the rest or the caller.
 */
export function emitFunnelBatch(
  ctx: SweepContext,
  events: Array<{ type: FunnelEventType; payload?: Record<string, unknown> }>,
  now: number = Date.now(),
): void {
  for (const e of events) emitFunnel(ctx, e.type, e.payload ?? {}, now)
}

// ── Terminal session summary + completeness (research integrity) ─────────────

/** The terminal record's payload — a self-contained certificate of session completeness. */
export interface SessionObservabilitySummary {
  runId: string | null
  firstSweepId: string | null
  lastSweepId: string | null
  sweepsObserved: number
  eventsAttempted: number
  eventsWritten: number
  droppedTotal: number
  degradedEver: boolean
  firstFailureAt: string | null
  lastFailureAt: string | null
  cleanClose: true
}

/** Snapshot the live session tallies (does not write). */
export function buildSessionSummary(): SessionObservabilitySummary {
  return {
    runId,
    firstSweepId, lastSweepId,
    sweepsObserved: sweepStartedCount,
    eventsAttempted, eventsWritten,
    droppedTotal: droppedEverThisRun,
    degradedEver,
    firstFailureAt, lastFailureAt,
    cleanClose: true,
  }
}

/**
 * Append the terminal `session_observability_summary`. Call on graceful shutdown ONLY.
 * BEST-EFFORT: if the funnel is unwritable through shutdown this throws internally and
 * returns false — the marker is NOT persisted, and its ABSENCE is the (correct) evidence
 * that the file cannot be certified complete. Never throws; never affects execution.
 * Returns whether the summary was actually written.
 */
export function emitSessionSummary(producerHead: string | null, now: number = Date.now()): boolean {
  try {
    const record = {
      eventType: 'session_observability_summary' as const,
      schemaVersion: FUNNEL_SCHEMA_VERSION,
      tsUtc: new Date(now).toISOString(),
      sweepId: lastSweepId,
      producerHead: producerHead ?? null,
      ...buildSessionSummary(),
    }
    appendFileSync(funnelFile(etDayKey(now)), JSON.stringify(record) + '\n')
    return true
  } catch {
    // Do NOT pretend it persisted. The missing terminal marker certifies incompleteness.
    return false
  }
}

export type FunnelCompleteness = 'COMPLETE' | 'DEGRADED_COMPLETE' | 'CONTINUED' | 'INCOMPLETE'

const isContinuedOut = (e: Record<string, unknown>): boolean =>
  e.eventType === 'funnel_rotated' && e.direction === 'continued_in_next_file'

/**
 * PURE research/telemetry helper. Classify ONE session/segment's completeness:
 *   CONTINUED         — the run crossed ET midnight: this file's last closer is a `funnel_rotated`
 *                       continued_in_next_file marker. The run is NOT incomplete — it is certified in the
 *                       next ET-day file (join by `runId`). Use assessRun() to certify the whole run.
 *   INCOMPLETE        — no terminal summary AND no continuation marker (or cleanClose !== true), OR a real
 *                       un-closed run trails the last closer. Absence NEVER means "zero drops".
 *   DEGRADED_COMPLETE — terminal summary present AND (droppedTotal>0 || degradedEver || a telemetry_gap exists).
 *   COMPLETE          — terminal summary present, no drops, never degraded, no gap markers.
 * The LAST closer decides: scanning from the end, the first event that is a summary OR a continued_in_next_file
 * marker. A per-day file with several runs should be split first (splitFunnelSessions).
 */
export function assessFunnelCompleteness(events: Array<Record<string, unknown>>): FunnelCompleteness {
  // Find the last "closer" (summary or continuation-out) and whether real events trail it.
  let closerIdx = -1
  let closerKind: 'summary' | 'continued' | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.eventType === 'session_observability_summary') { closerIdx = i; closerKind = 'summary'; break }
    if (isContinuedOut(e)) { closerIdx = i; closerKind = 'continued'; break }
  }
  if (closerKind === null) return 'INCOMPLETE'
  // A real (non-summary, non-rotation) event after the closer = an un-certified trailing run.
  const trailing = events.slice(closerIdx + 1).some(
    e => e.eventType !== 'session_observability_summary' && e.eventType !== 'funnel_rotated')
  if (trailing) return 'INCOMPLETE'
  if (closerKind === 'continued') return 'CONTINUED'
  const summary = events[closerIdx]
  if (summary.cleanClose !== true) return 'INCOMPLETE'
  const hadGap = events.some(e => e.eventType === 'telemetry_gap')
  const dropped = typeof summary.droppedTotal === 'number' ? summary.droppedTotal : 0
  if (dropped > 0 || summary.degradedEver === true || hadGap) return 'DEGRADED_COMPLETE'
  return 'COMPLETE'
}

/**
 * Certify a WHOLE daemon run that may span several ET-day files. Pass the concatenated event
 * streams of every file that shares this run (chained by the `funnel_rotated`/`runId` markers,
 * in day order). The interior continuation markers are ignored; the verdict is the run's real
 * terminal state: COMPLETE / DEGRADED_COMPLETE, or INCOMPLETE/CONTINUED if it never closed.
 * PURE; research/telemetry-only.
 */
export function assessRun(concatenatedEventsInDayOrder: Array<Record<string, unknown>>): FunnelCompleteness {
  return assessFunnelCompleteness(concatenatedEventsInDayOrder)
}

/**
 * Split a per-day funnel file (which may hold SEVERAL daemon runs — restarts append to the same ET-day file)
 * into per-run segments. Each segment ends at its terminal session_observability_summary; a trailing segment
 * with no summary is an in-progress or aborted run. Map assessFunnelCompleteness over the result to certify
 * each run independently. PURE; research/telemetry-only.
 */
export function splitFunnelSessions(events: Array<Record<string, unknown>>): Array<Array<Record<string, unknown>>> {
  const sessions: Array<Array<Record<string, unknown>>> = []
  let cur: Array<Record<string, unknown>> = []
  for (const e of events) {
    cur.push(e)
    // A segment closes at a terminal summary OR a continued_in_next_file marker (the run moved
    // to the next ET-day file). Either way the segment in THIS file has ended.
    if (e.eventType === 'session_observability_summary' || isContinuedOut(e)) { sessions.push(cur); cur = [] }
  }
  if (cur.length > 0) sessions.push(cur)   // trailing un-summarized (aborted/in-progress) run
  return sessions
}
