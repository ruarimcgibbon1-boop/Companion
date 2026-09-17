/**
 * H3C — single-writer ownership for the observational leader-state file (red-team §5).
 *
 * Two daemon processes writing the same state file is "last-writer-wins": each loads state A, applies
 * different sweeps, and writes A' then A'' — silently LOSING updates even though the JSON stays valid.
 * Execution authority does not by itself guarantee a single leader-state writer (a second daemon can run
 * observation-only, without execution authority, and still persist leader state). This is a lightweight
 * O_EXCL lease so only one process persists the file at a time.
 *
 * RESEARCH-ONLY, NEVER affects trading: failing to acquire the lease does not stop or slow the daemon.
 * A secondary daemon simply runs WITHOUT persisting leader state and flags degraded observability. This
 * is NOT a second execution authority and shares nothing with the executor's lock. Stale-lease recovery
 * is explicit and conservative: we take over only when the prior holder's pid is provably not alive, and
 * we move the stale lease aside (never silently delete it).
 */
import { openSync, writeSync, closeSync, readFileSync, existsSync, renameSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function leaderLockFile(dir: string = process.env.COMPANION_LEADER_DIR || homedir()): string {
  return join(dir, '.companion-leader-state.lock')
}

export interface LeaderLockInfo { pid: number; runId: string | null; producerHead: string | null; startedAt: string }

export interface LeaderLock {
  acquired: boolean
  owner: LeaderLockInfo | null    // self when acquired; the blocking live holder when not
  reason: string
  release: () => void
}

const noop = () => {}

/** True if `pid` is a live process. EPERM means alive but not ours; ESRCH means gone. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

function writeLease(path: string, info: LeaderLockInfo): void {
  const fd = openSync(path, 'wx')   // O_EXCL|O_CREAT — fails if the file already exists
  try { writeSync(fd, JSON.stringify(info)) } finally { closeSync(fd) }
}

function makeReleaser(path: string, info: LeaderLockInfo): () => void {
  return () => {
    try {
      if (!existsSync(path)) return
      const cur = JSON.parse(readFileSync(path, 'utf8')) as LeaderLockInfo
      if (cur.pid === info.pid && cur.runId === info.runId) unlinkSync(path)   // only ever release our OWN lease
    } catch { /* release must never throw */ }
  }
}

/**
 * Try to become the sole leader-state writer. On success, returns `acquired:true` with a `release()`
 * that removes only our own lease. On a live conflicting holder, returns `acquired:false` (run secondary).
 * On a provably-dead / unreadable holder, conservatively takes over (moving the stale lease aside).
 * Any unexpected error fails SAFE to secondary — it never throws into the caller.
 */
export function acquireLeaderWriterLock(
  info: LeaderLockInfo, log: (...a: unknown[]) => void = console.warn, dir?: string,
): LeaderLock {
  const path = leaderLockFile(dir)
  try {
    writeLease(path, info)
    return { acquired: true, owner: info, reason: 'acquired', release: makeReleaser(path, info) }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      log(`[leader-lock] could not acquire writer lease (${(e as Error).message}) — running as SECONDARY (no leader-state persistence; trading unaffected)`)
      return { acquired: false, owner: null, reason: 'acquire_error', release: noop }
    }
  }

  // Lease exists — inspect the holder.
  let holder: LeaderLockInfo | null = null
  try { holder = JSON.parse(readFileSync(path, 'utf8')) as LeaderLockInfo } catch { holder = null }

  if (holder && holder.pid !== info.pid && pidAlive(holder.pid)) {
    log(`[leader-lock] leader-state writer already owned by LIVE pid ${holder.pid} (run ${holder.runId ?? '?'}) — running as SECONDARY (no leader-state persistence; trading unaffected)`)
    return { acquired: false, owner: holder, reason: 'owned_by_live_process', release: noop }
  }

  // Holder is provably dead, unreadable, or our own stale pid → CONSERVATIVE takeover: move the stale
  // lease aside (never silently delete) and re-acquire. Loudly logged.
  try {
    const aside = `${path}.stale-${Date.now()}`
    renameSync(path, aside)
    log(`[leader-lock] STALE writer lease (holder pid ${holder?.pid ?? 'unknown'} not alive) moved to ${aside} — taking over as writer`)
    writeLease(path, info)
    return { acquired: true, owner: info, reason: holder ? 'recovered_stale_dead_holder' : 'recovered_unreadable_lease', release: makeReleaser(path, info) }
  } catch (e) {
    log(`[leader-lock] stale-lease recovery failed (${(e as Error).message}) — running as SECONDARY (no leader-state persistence; trading unaffected)`)
    return { acquired: false, owner: holder, reason: 'recovery_failed', release: noop }
  }
}
