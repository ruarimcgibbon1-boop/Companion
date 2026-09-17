/**
 * H3C — leader-state persistence (Node-only). Atomic write (temp -> rename), validated load,
 * quarantine-on-corrupt. NEVER blocks execution: a persistence failure degrades research
 * completeness, it does not stop the daemon. No provider I/O; no executor reference.
 */
import { writeFileSync, renameSync, readFileSync, existsSync, openSync, fsyncSync, closeSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { LeaderStateMap } from './leader-state'

export const LEADER_STATE_SCHEMA_VERSION = 1

export function leaderStateFile(dir: string = process.env.COMPANION_LEADER_DIR || homedir()): string {
  return join(dir, '.companion-leader-state.json')
}

export interface LeaderStateFile {
  schemaVersion: number
  producerHead: string | null
  savedAt: string
  tradingDay: string
  records: LeaderStateMap
}

export interface LoadResult {
  records: LeaderStateMap
  loadedFromDisk: boolean
  degraded: boolean          // corrupt/mismatch -> started fresh; research history is INCOMPLETE
  reason: string | null
  producerHeadChanged: boolean
}

function isValid(o: unknown): o is LeaderStateFile {
  if (!o || typeof o !== 'object') return false
  const f = o as Record<string, unknown>
  return f.schemaVersion === LEADER_STATE_SCHEMA_VERSION && typeof f.savedAt === 'string'
    && typeof f.tradingDay === 'string' && f.records != null && typeof f.records === 'object'
}

/**
 * Load leader state. On missing file -> fresh, not degraded (a first run legitimately has no history).
 * On corrupt/invalid -> quarantine the bad file (rename to .corrupt-<ts>), warn loudly, start FRESH and
 * mark degraded. On a producer-head change -> keep history but flag it (conservative).
 */
export function loadLeaderState(
  producerHead: string | null,
  log: (...a: unknown[]) => void = console.warn,
  dir?: string,
): LoadResult {
  const path = leaderStateFile(dir)
  if (!existsSync(path)) return { records: {}, loadedFromDisk: false, degraded: false, reason: 'no_prior_file', producerHeadChanged: false }
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch (e) {
    quarantine(path, log, `parse_error: ${(e as Error).message}`)
    return { records: {}, loadedFromDisk: false, degraded: true, reason: 'corrupt_parse', producerHeadChanged: false }
  }
  if (!isValid(parsed)) {
    quarantine(path, log, 'schema_or_shape_invalid')
    return { records: {}, loadedFromDisk: false, degraded: true, reason: 'schema_mismatch', producerHeadChanged: false }
  }
  const f = parsed as LeaderStateFile
  const producerHeadChanged = producerHead != null && f.producerHead != null && producerHead !== f.producerHead
  // Conservative: keep history across a producer-head change but flag it (does not fabricate continuity).
  return { records: f.records, loadedFromDisk: true, degraded: false, reason: producerHeadChanged ? 'producer_head_changed' : null, producerHeadChanged }
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
 * never leave partial JSON in the real file. Best-effort: a failure logs and returns false; it never
 * throws into the daemon loop.
 */
export function saveLeaderState(
  records: LeaderStateMap, producerHead: string | null, tradingDay: string,
  log: (...a: unknown[]) => void = console.warn, dir?: string,
): boolean {
  const path = leaderStateFile(dir)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const payload: LeaderStateFile = { schemaVersion: LEADER_STATE_SCHEMA_VERSION, producerHead, savedAt: new Date().toISOString(), tradingDay, records }
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
