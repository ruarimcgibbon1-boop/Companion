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
  | 'strategy_trigger'
  | 'gate_evaluation'
  | 'arbitration_decision'
  | 'execution_handoff'

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
const ESCALATE_AFTER = 5

function onWriteError(err: unknown): void {
  consecutiveFailures++
  if (consecutiveFailures <= ESCALATE_AFTER) {
    console.warn(`[funnel] telemetry write failed (${consecutiveFailures}): ${(err as Error)?.message ?? err}`)
  }
  if (consecutiveFailures === ESCALATE_AFTER && !escalated) {
    escalated = true
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
  try {
    const record = {
      eventType,
      schemaVersion: FUNNEL_SCHEMA_VERSION,
      tsUtc: new Date(now).toISOString(),
      sweepId: ctx.sweepId,
      producerHead: ctx.producerHead ?? null,
      ...(scrub(payload) as Record<string, unknown>),
    }
    appendFileSync(funnelFile(etDayKey(now)), JSON.stringify(record) + '\n')
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
