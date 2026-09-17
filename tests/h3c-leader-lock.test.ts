/**
 * H3C — single-writer ownership (red-team §5). Only one process may persist the leader-state file at a
 * time; a second daemon runs as SECONDARY (no persistence) and never affects trading. Stale-lease
 * recovery is conservative (dead holder only) and moves the old lease aside rather than deleting it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireLeaderWriterLock, leaderLockFile } from '../src/lib/leader/leader-lock'

const DEAD_PID = 2_000_000_000   // far above any real pid on these platforms → provably not alive

describe('H3C leader-state single-writer lease', () => {
  let dir: string
  const info = (over: Partial<{ pid: number; runId: string }> = {}) => ({ pid: over.pid ?? process.pid, runId: over.runId ?? 'run-me', producerHead: 'h', startedAt: 'x' })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'leaderlock-')); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  it('first writer acquires the lease', () => {
    const l = acquireLeaderWriterLock(info(), console.warn, dir)
    expect(l.acquired).toBe(true); expect(l.reason).toBe('acquired')
    expect(existsSync(leaderLockFile(dir))).toBe(true)
  })

  it('a second writer cannot persist while a LIVE holder owns the lease (runs SECONDARY)', () => {
    // Live holder = our own live pid but a DIFFERENT run; the newcomer is a different (would-be) process.
    writeFileSync(leaderLockFile(dir), JSON.stringify({ pid: process.pid, runId: 'run-A', producerHead: 'h', startedAt: 'x' }))
    const l = acquireLeaderWriterLock(info({ pid: DEAD_PID, runId: 'run-B' }), console.warn, dir)
    expect(l.acquired).toBe(false); expect(l.reason).toBe('owned_by_live_process')
    expect(l.owner?.runId).toBe('run-A')
  })

  it('release removes only our OWN lease; a fresh writer can then acquire', () => {
    const l1 = acquireLeaderWriterLock(info({ runId: 'A' }), console.warn, dir)
    expect(l1.acquired).toBe(true)
    l1.release()
    expect(existsSync(leaderLockFile(dir))).toBe(false)
    const l2 = acquireLeaderWriterLock(info({ runId: 'C' }), console.warn, dir)
    expect(l2.acquired).toBe(true)
  })

  it('a SECONDARY release() is a no-op (never deletes the live holder’s lease)', () => {
    writeFileSync(leaderLockFile(dir), JSON.stringify({ pid: process.pid, runId: 'run-A', producerHead: 'h', startedAt: 'x' }))
    const l = acquireLeaderWriterLock(info({ pid: DEAD_PID, runId: 'run-B' }), console.warn, dir)
    expect(l.acquired).toBe(false)
    expect(() => l.release()).not.toThrow()
    expect(existsSync(leaderLockFile(dir))).toBe(true)          // live holder’s lease untouched
  })

  it('a STALE lease (dead holder) is conservatively recovered — moved aside, not deleted', () => {
    writeFileSync(leaderLockFile(dir), JSON.stringify({ pid: DEAD_PID, runId: 'old', producerHead: 'h', startedAt: 'x' }))
    const l = acquireLeaderWriterLock(info({ runId: 'new' }), console.warn, dir)
    expect(l.acquired).toBe(true); expect(l.reason).toBe('recovered_stale_dead_holder')
    expect(readdirSync(dir).some(f => f.includes('.stale-'))).toBe(true)   // old lease preserved for forensics
  })

  it('never throws on a garbage lease; fails safe to a recoverable/secondary outcome', () => {
    writeFileSync(leaderLockFile(dir), 'not json')
    expect(() => acquireLeaderWriterLock(info(), console.warn, dir)).not.toThrow()
  })
})
