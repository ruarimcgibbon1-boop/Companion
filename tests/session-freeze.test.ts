import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { performFreeze, FreezeError, type FreezeSource } from '@/lib/research/session-freeze'
import { sha256Bytes, type ManifestEnv } from '@/lib/research/session-snapshot'

let sandbox: string
beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), 'freeze-')) })
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

const ENV: ManifestEnv = { daemonRuntime: 'UNKNOWN', freezeProcess: { HALT: '1' } }
const HOST = { hostname: 'h', platform: 'darwin', user: 'u', node: 'v0' }

function makeSources(names: Array<[string, string, string]>): FreezeSource[] {
  return names.map(([name, destName, content]) => {
    const srcPath = join(sandbox, `src-${name}`)
    writeFileSync(srcPath, content)
    return { name, srcPath, destName }
  })
}
function prov(over: Partial<Parameters<typeof performFreeze>[0]['provenance']> = {}) {
  return { frozenAtUtc: '2026-08-27T22:00:00Z', producingStrategyHead: 'AAA', snapshotCheckoutHead: 'BBB', evaluatorSha: 'ev', env: ENV, host: HOST, ...over }
}

describe('performFreeze — atomic + fail-closed (Finding 2)', () => {
  it('successful freeze: promotes atomically, chmod 0444, manifest hashes match content', () => {
    const sources = makeSources([['decisions', 'decisions.jsonl', 'd1\nd2\n'], ['trades', 'paper-trades.json', '[]']])
    const destDir = join(sandbox, 'snap')
    const { manifest } = performFreeze({ day: '2026-08-27', sources, destDir, provenance: prov() })

    expect(existsSync(join(destDir, 'MANIFEST.json'))).toBe(true)
    expect(existsSync(join(destDir, 'decisions.jsonl'))).toBe(true)
    const dec = manifest.files.find(f => f.name === 'decisions')!
    expect(dec.rows).toBe(2)
    expect(dec.sha256).toBe(sha256Bytes(Buffer.from('d1\nd2\n')))
    // read-only payload
    expect(statSync(join(destDir, 'decisions.jsonl')).mode & 0o222).toBe(0)
    // no temp dir left behind
    expect(readdirSync(sandbox).some(n => n.includes('.freezing-'))).toBe(false)
  })

  it('missing a required source: throws MISSING_SOURCE and writes nothing', () => {
    const sources = makeSources([['decisions', 'decisions.jsonl', 'd\n']])
    sources.push({ name: 'gone', srcPath: join(sandbox, 'does-not-exist'), destName: 'gone.json' })
    const destDir = join(sandbox, 'snap')
    expect(() => performFreeze({ day: '2026-08-27', sources, destDir, provenance: prov() }))
      .toThrow(FreezeError)
    expect(existsSync(destDir)).toBe(false)
    expect(readdirSync(sandbox).some(n => n.includes('.freezing-'))).toBe(false)
  })

  it('existing snapshot: refuses (SNAPSHOT_EXISTS) and leaves it unchanged', () => {
    const destDir = join(sandbox, 'snap')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'sentinel'), 'original')
    const sources = makeSources([['decisions', 'decisions.jsonl', 'd\n']])
    let err: unknown
    try { performFreeze({ day: '2026-08-27', sources, destDir, provenance: prov() }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(FreezeError)
    expect((err as FreezeError).code).toBe('SNAPSHOT_EXISTS')
    expect(readFileSync(join(destDir, 'sentinel'), 'utf8')).toBe('original') // untouched
  })

  it('injected mid-freeze failure: no partial final snapshot, temp cleaned up', () => {
    const sources = makeSources([['decisions', 'decisions.jsonl', 'd\n']])
    const destDir = join(sandbox, 'snap')
    expect(() => performFreeze({
      day: '2026-08-27', sources, destDir, provenance: prov(),
      onBeforeRename: () => { throw new Error('boom mid-freeze') },
    })).toThrow('boom mid-freeze')
    expect(existsSync(destDir)).toBe(false)
    expect(readdirSync(sandbox).some(n => n.includes('.freezing-'))).toBe(false)
  })
})

describe('performFreeze — honest provenance (Finding 4)', () => {
  it('records producing head A distinctly from checkout head B; never mislabels B as A', () => {
    const sources = makeSources([['decisions', 'decisions.jsonl', 'd\n']])
    const { manifest } = performFreeze({
      day: '2026-08-27', sources, destDir: join(sandbox, 'snap'),
      provenance: prov({ producingStrategyHead: 'AAA_producing', snapshotCheckoutHead: 'BBB_checkout' }),
    })
    expect(manifest.producingStrategyHead).toBe('AAA_producing')
    expect(manifest.snapshotCheckoutHead).toBe('BBB_checkout')
    expect(manifest.producingStrategyHead).not.toBe(manifest.snapshotCheckoutHead)
  })

  it('records explicit UNKNOWN when producing provenance is absent (never invents B)', () => {
    const sources = makeSources([['decisions', 'decisions.jsonl', 'd\n']])
    const { manifest } = performFreeze({
      day: '2026-08-27', sources, destDir: join(sandbox, 'snap'),
      provenance: prov({ producingStrategyHead: 'UNKNOWN', snapshotCheckoutHead: 'BBB_checkout' }),
    })
    expect(manifest.producingStrategyHead).toBe('UNKNOWN')
    expect(manifest.producingStrategyHead).not.toBe('BBB_checkout')
    expect(manifest.env.daemonRuntime).toBe('UNKNOWN')
  })
})
