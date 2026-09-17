/**
 * H3C — leader-state persistence (Node-only). Atomic write (temp -> fsync -> rename), validated load,
 * quarantine-on-corrupt, and CRASH-AWARE recovery classification. NEVER blocks execution: a
 * persistence failure degrades research completeness, it does not stop the daemon. No provider I/O;
 * no executor reference.
 *
 * Research-integrity (red-team §1/§6/§7): atomic JSON validity does NOT prove a checkpoint is
 * semantically current. A checkpoint records WHY it was written (`saveReason`). Only a clean-terminal
 * checkpoint (SHUTDOWN or ONCE) proves the prior run ended gracefully; a PERIODIC checkpoint left on
 * disk means the prior process crashed after it (up to LEADER_PERSIST_EVERY sweeps of post-checkpoint
 * history are unaccounted for) and MUST NOT masquerade as complete. Producer-head / config-hash change
 * keeps the raw facts but marks derived history incomplete. We never fabricate missing sweeps.
 */
import { writeFileSync, renameSync, readFileSync, existsSync, openSync, fsyncSync, closeSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { LeaderStateMap } from './leader-state'

export const LEADER_STATE_SCHEMA_VERSION = 1

// WHY a checkpoint was written — the marker that distinguishes a clean terminal state from a crashed
// periodic one. SHUTDOWN = graceful signal shutdown; ONCE = a completed single-shot run; PERIODIC = a
// mid-run heartbeat (NOT proof the run ended cleanly).
export type SaveReason = 'PERIODIC' | 'SHUTDOWN' | 'ONCE'

// Honest recovery classification (never overclaims completeness).
export type RecoveryStatus =
  | 'FRESH_UNKNOWN'         // no prior file — a first run legitimately has no history, but earlier-in-day history is UNKNOWN, not proven-absent
  | 'RECOVERED_COMPLETE'    // clean-terminal checkpoint, same producer + config — history is trustworthy
  | 'RECOVERED_DEGRADED'    // periodic/crashed checkpoint, or producer/config change — facts kept, derived history INCOMPLETE
  | 'DEGRADED_CORRUPT'      // parse/schema failure — quarantined, started fresh

export function leaderStateFile(dir: string = process.env.COMPANION_LEADER_DIR || homedir()): string {
  return join(dir, '.companion-leader-state.json')
}

export interface LeaderStateFile {
  schemaVersion: number
  producerHead: string | null
  savedAt: string
  tradingDay: string
  saveReason: SaveReason
  runId: string | null
  lastSweepId: string | null
  checkpointSeq: number
  leaderConfigVersion: string | null
  leaderConfigHash: string | null
  records: LeaderStateMap
}

export interface SaveArgs {
  records: LeaderStateMap
  producerHead: string | null
  tradingDay: string
  saveReason: SaveReason
  runId?: string | null
  lastSweepId?: string | null
  checkpointSeq?: number
  configVersion?: string | null
  configHash?: string | null
  log?: (...a: unknown[]) => void
  dir?: string
}

export interface LoadArgs {
  producerHead: string | null
  configHash?: string | null      // current effective config fingerprint — a mismatch degrades derived history
  log?: (...a: unknown[]) => void
  dir?: string
}

export interface LoadResult {
  records: LeaderStateMap
  loadedFromDisk: boolean
  degraded: boolean               // corrupt/schema only (kept for back-compat; use recoveryStatus for the full picture)
  reason: string | null
  producerHeadChanged: boolean
  configChanged: boolean
  recoveryStatus: RecoveryStatus
  historyComplete: boolean        // TRUE only for a proven clean-terminal recovery with matching producer + config
  savedReason: SaveReason | null
  lastSweepId: string | null
  savedAt: string | null
  recordCount: number
}

function isValid(o: unknown): o is LeaderStateFile {
  if (!o || typeof o !== 'object') return false
  const f = o as Record<string, unknown>
  return f.schemaVersion === LEADER_STATE_SCHEMA_VERSION && typeof f.savedAt === 'string'
    && typeof f.tradingDay === 'string' && f.records != null && typeof f.records === 'object'
}

/**
 * Load leader state with honest, crash-aware classification:
 *  - missing file            -> FRESH_UNKNOWN (fresh, NOT degraded; but history is UNKNOWN, never claimed complete)
 *  - corrupt/schema mismatch -> DEGRADED_CORRUPT (quarantine bad file, warn loudly, start fresh)
 *  - PERIODIC checkpoint     -> RECOVERED_DEGRADED (the prior run crashed after it — post-checkpoint sweeps are lost)
 *  - producer/config change  -> RECOVERED_DEGRADED (raw facts kept; derived lifecycle/role provenance is stale)
 *  - SHUTDOWN/ONCE, same env -> RECOVERED_COMPLETE (trustworthy)
 * Records carried under any non-complete recovery are flagged `historyComplete=false`. No sweeps are fabricated.
 */
export function loadLeaderState(a: LoadArgs): LoadResult {
  const log = a.log ?? console.warn
  const path = leaderStateFile(a.dir)
  const nulls = { producerHeadChanged: false, configChanged: false, savedReason: null as SaveReason | null, lastSweepId: null, savedAt: null as string | null, recordCount: 0 }

  if (!existsSync(path)) {
    return { records: {}, loadedFromDisk: false, degraded: false, reason: 'no_prior_file', recoveryStatus: 'FRESH_UNKNOWN', historyComplete: false, ...nulls }
  }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch (e) {
    quarantine(path, log, `parse_error: ${(e as Error).message}`)
    return { records: {}, loadedFromDisk: false, degraded: true, reason: 'corrupt_parse', recoveryStatus: 'DEGRADED_CORRUPT', historyComplete: false, ...nulls }
  }
  if (!isValid(parsed)) {
    quarantine(path, log, 'schema_or_shape_invalid')
    return { records: {}, loadedFromDisk: false, degraded: true, reason: 'schema_mismatch', recoveryStatus: 'DEGRADED_CORRUPT', historyComplete: false, ...nulls }
  }

  const f = parsed as LeaderStateFile
  const savedReason: SaveReason | null =
    f.saveReason === 'PERIODIC' || f.saveReason === 'SHUTDOWN' || f.saveReason === 'ONCE' ? f.saveReason : null
  const cleanTerminal = savedReason === 'SHUTDOWN' || savedReason === 'ONCE'
  const producerHeadChanged = a.producerHead != null && f.producerHead != null && a.producerHead !== f.producerHead
  const configChanged = a.configHash != null && f.leaderConfigHash != null && a.configHash !== f.leaderConfigHash

  let recoveryStatus: RecoveryStatus
  let reason: string | null
  if (!cleanTerminal) {
    // A PERIODIC (or unknown) checkpoint left on disk = the prior process did NOT shut down gracefully.
    recoveryStatus = 'RECOVERED_DEGRADED'
    reason = savedReason === 'PERIODIC' ? 'periodic_checkpoint_from_unclean_prior_run' : 'unknown_save_reason'
  } else if (producerHeadChanged) {
    recoveryStatus = 'RECOVERED_DEGRADED'; reason = 'producer_head_changed'
  } else if (configChanged) {
    recoveryStatus = 'RECOVERED_DEGRADED'; reason = 'config_changed'
  } else {
    recoveryStatus = 'RECOVERED_COMPLETE'; reason = null
  }

  const historyComplete = recoveryStatus === 'RECOVERED_COMPLETE'
  const records = f.records
  // Preserve the raw historical FACTS but mark derived provenance incomplete when recovery is degraded —
  // a later reappearance must never masquerade as clean continuity.
  if (!historyComplete) for (const r of Object.values(records)) r.historyComplete = false

  if (recoveryStatus === 'RECOVERED_DEGRADED') {
    log(`[leader-state] recovered ${Object.keys(records).length} records but history is INCOMPLETE (${reason}) — derived lifecycle/role flagged; no sweeps fabricated`)
  }
  return {
    records, loadedFromDisk: true, degraded: false, reason, producerHeadChanged, configChanged,
    recoveryStatus, historyComplete, savedReason, lastSweepId: f.lastSweepId ?? null, savedAt: f.savedAt ?? null,
    recordCount: Object.keys(records).length,
  }
}

function quarantine(path: string, log: (...a: unknown[]) => void, reason: string): void {
  try {
    const dest = `${path}.corrupt-${Date.now()}`
    renameSync(path, dest)
    log(`[leader-state] CORRUPT/invalid state file (${reason}) — quarantined to ${dest}; starting FRESH observational state (history INCOMPLETE)`)
  } catch (e) {
    log(`[leader-state] could not quarantine corrupt state file (${reason}): ${(e as Error).message}; starting fresh`)
  }
}

/**
 * Atomic save: write a temp file, fsync it, then rename over the target — so a crash mid-write can
 * never leave partial JSON in the real file. The checkpoint records WHY it was written (`saveReason`)
 * so a restart can tell a clean terminal state from a crashed periodic one. Best-effort: a failure
 * logs and returns false; it never throws into the daemon loop.
 */
export function saveLeaderState(a: SaveArgs): boolean {
  const log = a.log ?? console.warn
  const path = leaderStateFile(a.dir)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const payload: LeaderStateFile = {
    schemaVersion: LEADER_STATE_SCHEMA_VERSION, producerHead: a.producerHead, savedAt: new Date().toISOString(),
    tradingDay: a.tradingDay, saveReason: a.saveReason, runId: a.runId ?? null, lastSweepId: a.lastSweepId ?? null,
    checkpointSeq: a.checkpointSeq ?? 0, leaderConfigVersion: a.configVersion ?? null, leaderConfigHash: a.configHash ?? null,
    records: a.records,
  }
  try {
    const json = JSON.stringify(payload)
    writeFileSync(tmp, json)
    try { const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd) } catch { /* fsync best-effort */ }
    renameSync(tmp, path)   // atomic on a local FS
    return true
  } catch (e) {
    log(`[leader-state] save failed (research persistence only; execution unaffected): ${(e as Error).message}`)
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    return false
  }
}
