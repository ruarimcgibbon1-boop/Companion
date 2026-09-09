/**
 * Immutable session snapshot — pure core for the freeze/verify tooling.
 *
 * READ-ONLY: builds manifests and classifies drift over file *content* passed in
 * by the shell. No fs, no daemon, no executor. The shell (scripts/session-freeze,
 * scripts/session-verify) does the reading/writing/chmod; this module only decides
 * row/byte/sha and the drift class.
 *
 * Drift semantics (Session-3 finding A):
 *   CLEAN                    live bytes identical to the frozen snapshot
 *   POST_FREEZE_APPEND_DRIFT snapshot is an exact byte-PREFIX of live (append-only)
 *   NON_PREFIX_DRIFT         live diverges within the frozen region (rewrite → escalate)
 *   MISSING_LIVE             the live file is gone
 */
import { createHash } from 'crypto'

/**
 * SHA-256 over EXACT BYTES (Finding 6). An immutable snapshot must hash bytes, not
 * a decoded string. For the ASCII/UTF-8 Session-3 artifacts this equals the prior
 * utf8-string hash (so `826b136c…` is unchanged), but it is now correct for any
 * byte content.
 */
export function sha256Bytes(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface ManifestFile {
  name: string
  path: string
  rows: number
  bytes: number
  sha256: string
}

/** Runtime env we can prove vs. env we merely observed at freeze time (Finding 4). */
export interface ManifestEnv {
  /** The daemon's actual runtime flags — 'UNKNOWN' unless proven from an artifact. */
  daemonRuntime: Record<string, string | undefined> | 'UNKNOWN'
  /** The freeze process's own env — explicitly NOT the daemon's. */
  freezeProcess: Record<string, string | undefined>
}

export interface SessionManifest {
  day: string
  frozenAtUtc: string
  /**
   * The strategy commit that PRODUCED the session (operator-supplied and validated),
   * or 'UNKNOWN'. Never silently inferred from the freeze checkout (Finding 4).
   */
  producingStrategyHead: string
  /** git HEAD of the working tree at freeze time — may differ from the producer. */
  snapshotCheckoutHead: string
  evaluatorSha: string
  env: ManifestEnv
  host: { hostname: string; platform: string; user: string; node: string }
  files: ManifestFile[]
}

/** Non-empty line count — the row convention used across the review artifacts. */
export function countRows(content: Buffer | string): number {
  const text = typeof content === 'string' ? content : content.toString('utf8')
  let n = 0
  for (const line of text.split('\n')) if (line.trim() !== '') n++
  return n
}

export function fileStats(name: string, path: string, content: Buffer): ManifestFile {
  return {
    name,
    path,
    rows: countRows(content),
    bytes: content.length,
    sha256: sha256Bytes(content),
  }
}

export interface BuildManifestArgs {
  day: string
  frozenAtUtc: string
  producingStrategyHead: string
  snapshotCheckoutHead: string
  evaluatorSha: string
  env: ManifestEnv
  host: { hostname: string; platform: string; user: string; node: string }
  files: ManifestFile[]
}

export function buildManifest(a: BuildManifestArgs): SessionManifest {
  return {
    day: a.day,
    frozenAtUtc: a.frozenAtUtc,
    producingStrategyHead: a.producingStrategyHead,
    snapshotCheckoutHead: a.snapshotCheckoutHead,
    evaluatorSha: a.evaluatorSha,
    env: a.env,
    host: a.host,
    files: a.files,
  }
}

/**
 * Verify one snapshot file against its manifest entry (Finding 3): bytes, rows,
 * and byte-sha must all match, or the snapshot itself is compromised and must NOT
 * be used as a drift baseline.
 */
export function verifyManifestFile(mf: ManifestFile, content: Buffer | null): { ok: boolean; reason: string | null } {
  if (content == null) return { ok: false, reason: 'snapshot file missing' }
  if (content.length !== mf.bytes) return { ok: false, reason: `bytes ${content.length} ≠ manifest ${mf.bytes}` }
  const rows = countRows(content)
  if (rows !== mf.rows) return { ok: false, reason: `rows ${rows} ≠ manifest ${mf.rows}` }
  const sha = sha256Bytes(content)
  if (sha !== mf.sha256) return { ok: false, reason: `sha256 ${sha.slice(0, 12)}… ≠ manifest ${mf.sha256.slice(0, 12)}…` }
  return { ok: true, reason: null }
}

export type DriftClass = 'CLEAN' | 'POST_FREEZE_APPEND_DRIFT' | 'NON_PREFIX_DRIFT' | 'MISSING_LIVE'

export interface DriftResult {
  name: string
  driftClass: DriftClass
  snapshotBytes: number
  liveBytes: number | null
  /** Present only for POST_FREEZE_APPEND_DRIFT — metadata about the appended tail. */
  appended?: { bytes: number; rows: number; tailText: string }
}

/** True iff `whole` begins with exactly the bytes of `prefix`. */
export function isBytePrefix(prefix: Buffer, whole: Buffer): boolean {
  if (prefix.length > whole.length) return false
  return whole.subarray(0, prefix.length).equals(prefix)
}

/**
 * Classify one file's live content against its frozen snapshot. Pure and total:
 * a missing live file is MISSING_LIVE, never a throw.
 */
export function classifyDrift(name: string, snapshot: Buffer, live: Buffer | null): DriftResult {
  if (live == null) {
    return { name, driftClass: 'MISSING_LIVE', snapshotBytes: snapshot.length, liveBytes: null }
  }
  if (live.length === snapshot.length && live.equals(snapshot)) {
    return { name, driftClass: 'CLEAN', snapshotBytes: snapshot.length, liveBytes: live.length }
  }
  if (isBytePrefix(snapshot, live)) {
    const tail = live.subarray(snapshot.length)
    const tailText = tail.toString('utf8')
    return {
      name,
      driftClass: 'POST_FREEZE_APPEND_DRIFT',
      snapshotBytes: snapshot.length,
      liveBytes: live.length,
      appended: { bytes: tail.length, rows: countRows(tailText), tailText },
    }
  }
  return { name, driftClass: 'NON_PREFIX_DRIFT', snapshotBytes: snapshot.length, liveBytes: live.length }
}

/**
 * Metadata-only summary of an appended JSONL tail. Deliberately reports pipeline
 * identity (timestamps, symbols, verdict labels) and NOT performance — no P&L, no
 * R, no win/loss. Verdict/session are admission-pipeline states, not outcomes.
 */
export interface TailSummary {
  rows: number
  firstTs: string | null
  lastTs: string | null
  symbols: string[]
  verdictCounts: Record<string, number>
  sessionCounts: Record<string, number>
}

export function summarizeJsonlTail(tailText: string): TailSummary {
  const rows = tailText.split('\n').map(l => l.trim()).filter(Boolean)
  const symbols = new Set<string>()
  const verdictCounts: Record<string, number> = {}
  const sessionCounts: Record<string, number> = {}
  let firstTs: string | null = null
  let lastTs: string | null = null
  for (const line of rows) {
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue }
    if (typeof d.ts === 'string') {
      if (firstTs == null) firstTs = d.ts
      lastTs = d.ts
    }
    if (typeof d.symbol === 'string') symbols.add(d.symbol)
    if (typeof d.verdict === 'string') verdictCounts[d.verdict] = (verdictCounts[d.verdict] ?? 0) + 1
    if (typeof d.session === 'string') sessionCounts[d.session] = (sessionCounts[d.session] ?? 0) + 1
  }
  return { rows: rows.length, firstTs, lastTs, symbols: [...symbols].sort(), verdictCounts, sessionCounts }
}
