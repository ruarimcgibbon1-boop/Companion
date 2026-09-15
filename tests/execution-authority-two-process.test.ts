/**
 * Two-process execution-authority race — a REAL process-boundary test (P0-F section G).
 *
 * Two independent Node child processes race to acquire the SAME authority marker in a temp
 * directory. The invariant: exactly ONE succeeds. This proves the mutual exclusion holds
 * across an actual process boundary (atomic O_EXCL), not merely within one interpreter.
 * Offline: no Alpaca, no network — just fs + child_process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CHILD = join(process.cwd(), 'tests/harness/authority-acquire-child.ts')
const AUTHORITY_MODULE = join(process.cwd(), 'src/lib/execution/authority.ts')

function runChild(lockPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [CHILD, lockPath, AUTHORITY_MODULE], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', d => { out += String(d) })
    p.stderr.on('data', d => { err += String(d) })
    p.on('error', reject)
    p.on('close', () => {
      const trimmed = out.trim()
      if (trimmed.startsWith('ERROR:')) reject(new Error(trimmed + ' | stderr: ' + err))
      else resolve(trimmed)
    })
  })
}

describe('two-process authority race', () => {
  let dir: string
  let lockPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auth2p-'))
    lockPath = join(dir, '.companion-execution-authority.lock')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('exactly one of two racing processes acquires authority', async () => {
    // Launch both without awaiting the first, so they genuinely contend for the marker.
    const [a, b] = await Promise.all([runChild(lockPath), runChild(lockPath)])
    const results = [a, b]

    expect(results.filter(r => r === 'ACQUIRED')).toHaveLength(1)
    expect(results.filter(r => r === 'DENIED')).toHaveLength(1)
    expect(existsSync(lockPath)).toBe(true)   // the winner left its marker behind
  }, 20_000)

  it('a third process is denied while the marker persists', async () => {
    const first = await runChild(lockPath)
    expect(first).toBe('ACQUIRED')
    const second = await runChild(lockPath)
    expect(second).toBe('DENIED')             // fail closed against the persisted marker
  }, 20_000)
})
