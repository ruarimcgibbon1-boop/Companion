/**
 * PROCESS-EXCLUSIVE PAPER EXECUTION AUTHORITY — a real mutual-exclusion lease.
 *
 * Producer provenance (provenance.ts) proves the SOURCE is clean; it is NOT a lease and
 * cannot stop two clean producers from running against the same paper account (P0-001).
 * This module is the missing lease: exactly one process may hold execution authority for
 * the paper account at a time.
 *
 * Mechanism: an ATOMIC exclusive-create of a marker file. `openSync(path, 'wx')` is
 * O_CREAT|O_EXCL — on a local filesystem the kernel guarantees that of any number of
 * racing creators, exactly one succeeds and the rest get EEXIST. That is the whole
 * invariant; everything else here is metadata and policy.
 *
 * FAIL-CLOSED POLICY (deliberate):
 *   - If the marker already exists, we REFUSE. We do NOT inspect the holder's PID and
 *     steal a "dead-looking" marker. An uncleanly terminated producer may have left
 *     working broker orders or open exposure; automatically stealing its authority would
 *     let a second producer trade on top of that unreconciled state. A stale marker must
 *     block automatic authority until an explicit human/recovery step proves it safe.
 *   - The marker is released ONLY by a clean shutdown that has reconciled exposure
 *     (see PaperExecutor.shutdown). An unresolved shutdown intentionally leaves it behind.
 *
 * Metadata is non-secret only (pid/host/time/commit/branch/mode). NEVER write credentials.
 *
 * Node-only (fs). Never import from a client component.
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'

export const AUTHORITY_FILE = '.companion-execution-authority.lock'

/** Default marker path: an execution-owned file in the user's home. `dir` is injectable for tests. */
export function authorityLockPath(dir: string = homedir()): string {
  return join(dir, AUTHORITY_FILE)
}

/** Non-secret identity of the authority holder, persisted in the marker for audit/diagnosis. */
export interface AuthorityMetadata {
  pid: number
  hostname: string
  startedAtUtc: string
  producerHead: string | null
  branch: string | null
  /** e.g. 'PAPER_TRADE' or 'DRY_RUN' — never a credential. */
  mode: string
}

export interface ExecutionAuthority {
  /** True only when THIS call created the marker. */
  acquired: boolean
  path: string
  /** Our metadata when acquired, else null. */
  metadata: AuthorityMetadata | null
  /** The current holder's metadata when denied (best-effort parse), else null. */
  existing: AuthorityMetadata | null
  /** Human-readable refusal reason when denied, else null. */
  reason: string | null
  /** Release the lease. No-op unless acquired; only removes a marker still identified as ours. */
  release(): void
}

const DENIED = (path: string, existing: AuthorityMetadata | null, reason: string): ExecutionAuthority => ({
  acquired: false, path, metadata: null, existing, reason, release: () => {},
})

function readMarker(path: string): AuthorityMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object') return parsed as AuthorityMetadata
    return null
  } catch {
    return null
  }
}

/**
 * Attempt to acquire execution authority. Atomic and fail-closed.
 *   - success  → { acquired:true, release() }
 *   - existing → { acquired:false, existing } (NEVER stolen, even if it looks stale)
 *   - error    → { acquired:false, reason }
 */
export function acquireExecutionAuthority(
  meta: AuthorityMetadata,
  opts: { lockPath?: string } = {},
): ExecutionAuthority {
  const path = opts.lockPath ?? authorityLockPath()

  let fd: number
  try {
    fd = openSync(path, 'wx') // O_CREAT | O_EXCL | O_WRONLY — atomic; EEXIST if a holder exists
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err && err.code === 'EEXIST') {
      // FAIL CLOSED — a holder exists. Do not inspect liveness and do not steal.
      return DENIED(path, readMarker(path), 'execution authority already held (marker exists)')
    }
    return DENIED(path, null, `execution authority acquire failed: ${err?.message ?? String(e)}`)
  }

  try {
    writeSync(fd, JSON.stringify(meta, null, 2))
  } finally {
    closeSync(fd)
  }

  let released = false
  return {
    acquired: true,
    path,
    metadata: meta,
    existing: null,
    reason: null,
    release: () => {
      if (released) return
      released = true
      // Only remove a marker that is still identifiably OURS, so a released-then-reacquired
      // lease held by another process is never deleted out from under it.
      const cur = readMarker(path)
      if (cur && cur.pid === meta.pid && cur.startedAtUtc === meta.startedAtUtc) {
        try { unlinkSync(path) } catch { /* already gone — fine */ }
      } else if (cur == null) {
        try { unlinkSync(path) } catch { /* already gone — fine */ }
      }
    },
  }
}

/** Read the current holder's metadata without attempting to acquire. Null if no marker. */
export function readAuthorityMarker(opts: { lockPath?: string } = {}): AuthorityMetadata | null {
  return readMarker(opts.lockPath ?? authorityLockPath())
}

/** Build non-secret metadata for a marker. Never include credentials. */
export function makeAuthorityMetadata(input: {
  producerHead?: string | null
  branch?: string | null
  mode: string
  now?: () => Date
}): AuthorityMetadata {
  const now = input.now ?? (() => new Date())
  return {
    pid: process.pid,
    hostname: hostname(),
    startedAtUtc: now().toISOString(),
    producerHead: input.producerHead ?? null,
    branch: input.branch ?? null,
    mode: input.mode,
  }
}
