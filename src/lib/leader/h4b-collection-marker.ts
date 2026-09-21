/**
 * H4B — official collection-start marker (research bookkeeping ONLY).
 *
 * An immutable, create-exclusive marker that fixes the exact causal boundary between PRE-OFFICIAL
 * events and OFFICIAL h4b-epoch-1 collection. It has NO strategy effect, makes NO provider calls, and
 * grants NO execution access — it only writes/reads a small JSON file the analysis path consults.
 *
 * Immutability: created with O_EXCL; a second start REFUSES rather than overwrite/reset the official
 * start time. Absence of a marker can never be read as "collection started".
 */
import { openSync, writeSync, closeSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface CollectionStartMarker {
  status: 'RUNNING'
  startedAtUtc: string
  experimentSpecVersion: string
  experimentConfigHash: string
  experimentEpoch: string
  decisionPolicyVersion: string
  decisionPolicyHash: string
  producerHead: string | null
  branch: string | null
}

/** Marker directory. `COMPANION_H4B_DIR` overrides (tests only); default `~/.companion-h4b`. */
export function h4bDir(): string {
  return process.env.COMPANION_H4B_DIR || join(homedir(), '.companion-h4b')
}
export function collectionMarkerPath(epoch: string): string {
  return join(h4bDir(), `${epoch}.collection-start.json`)
}

/** Read the marker for `epoch`, or null if it does not exist / is unreadable. */
export function readCollectionMarker(epoch: string): CollectionStartMarker | null {
  const p = collectionMarkerPath(epoch)
  if (!existsSync(p)) return null
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as CollectionStartMarker
    return m && m.status === 'RUNNING' && typeof m.startedAtUtc === 'string' ? m : null
  } catch {
    return null
  }
}

export type CreateMarkerResult =
  | { ok: true; marker: CollectionStartMarker; path: string }
  | { ok: false; reason: 'ALREADY_EXISTS' | 'WRITE_FAILED'; path: string; existing?: CollectionStartMarker | null; error?: string }

/**
 * Create the official start marker EXCLUSIVELY. Refuses (ok:false, ALREADY_EXISTS) if one already
 * exists — the official start time is never silently overwritten or reset. Never throws.
 */
export function createCollectionMarker(input: Omit<CollectionStartMarker, 'status'>): CreateMarkerResult {
  const epoch = input.experimentEpoch
  const path = collectionMarkerPath(epoch)
  const marker: CollectionStartMarker = { status: 'RUNNING', ...input }
  try {
    mkdirSync(h4bDir(), { recursive: true })
    let fd: number
    try {
      fd = openSync(path, 'wx')   // O_EXCL — fails if the marker already exists
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: false, reason: 'ALREADY_EXISTS', path, existing: readCollectionMarker(epoch) }
      }
      return { ok: false, reason: 'WRITE_FAILED', path, error: (e as Error).message }
    }
    try { writeSync(fd, JSON.stringify(marker, null, 2)) } finally { closeSync(fd) }
    return { ok: true, marker, path }
  } catch (e) {
    return { ok: false, reason: 'WRITE_FAILED', path, error: (e as Error).message }
  }
}

// ── Event classification against the official boundary ───────────────────────────

export type OfficialClassification = 'OFFICIAL' | 'PRE_OFFICIAL' | 'HASH_MISMATCH' | 'EPOCH_MISMATCH' | 'NO_MARKER'

/**
 * Classify one candidate event against the official marker. NO_MARKER means official collection has
 * NOT started (the caller must not claim otherwise). Wrong hash/epoch are rejected, never mixed in.
 */
export function classifyOfficial(
  marker: CollectionStartMarker | null,
  event: { candidateObservedAt: string; experimentConfigHash?: string; experimentEpoch?: string },
): OfficialClassification {
  if (!marker) return 'NO_MARKER'
  if (event.experimentEpoch != null && event.experimentEpoch !== marker.experimentEpoch) return 'EPOCH_MISMATCH'
  if (event.experimentConfigHash != null && event.experimentConfigHash !== marker.experimentConfigHash) return 'HASH_MISMATCH'
  const t = Date.parse(event.candidateObservedAt)
  const start = Date.parse(marker.startedAtUtc)
  if (!Number.isFinite(t) || !Number.isFinite(start)) return 'PRE_OFFICIAL'
  return t >= start ? 'OFFICIAL' : 'PRE_OFFICIAL'
}
