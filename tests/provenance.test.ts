import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

import {
  resolveProvenance,
  decideProducer,
  enforceProducerProvenance,
  overrideEnabled,
  defaultGitRunner,
  type GitRunner,
} from '@/lib/execution/provenance'
import { loadEnvLocal } from '@/lib/execution/env'

// ---- fake GitRunner: program responses by the leading git subcommand ----
type Resp = { status: number | null; stdout: string; stderr: string }
function fakeGit(map: {
  insideWorkTree?: Resp
  head?: Resp
  branch?: Resp
  diff?: Resp
  diffCached?: Resp
}): GitRunner {
  const R = (status: number | null, stdout = '', stderr = ''): Resp => ({ status, stdout, stderr })
  return (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return map.insideWorkTree ?? R(0, 'true')
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return map.head ?? R(0, 'a'.repeat(40))
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return map.branch ?? R(0, 'main')
    if (args[0] === 'diff' && args[1] === '--quiet') return map.diff ?? R(0)
    if (args[0] === 'diff' && args[1] === '--cached') return map.diffCached ?? R(0)
    return R(1, '', `unexpected git args: ${args.join(' ')}`)
  }
}
const SHA = 'b27b50bb8f0a9c0e466f0fcca72695fc4f1c8333'
const dirty = { diff: { status: 1, stdout: '', stderr: '' } as Resp }

describe('producer provenance — decision logic (fake git)', () => {
  it('TEST 1 — clean tree → ALLOW, dirtyTracked=false', () => {
    const prov = resolveProvenance(fakeGit({ head: { status: 0, stdout: SHA, stderr: '' } }))
    expect(prov.provenanceResolved).toBe(true)
    expect(prov.producerDirtyTracked).toBe(false)
    expect(prov.producerHead).toBe(SHA)
    expect(prov.producerBranch).toBe('main')
    expect(decideProducer(prov).allowed).toBe(true)
  })

  it('TEST 3 — tracked UNSTAGED modification → REFUSE', () => {
    const prov = resolveProvenance(fakeGit(dirty))
    expect(prov.producerDirtyTracked).toBe(true)
    expect(decideProducer(prov).allowed).toBe(false)
  })

  it('TEST 4 — tracked STAGED modification → REFUSE', () => {
    const prov = resolveProvenance(fakeGit({ diffCached: { status: 1, stdout: '', stderr: '' } }))
    expect(prov.producerDirtyTracked).toBe(true)
    expect(decideProducer(prov).allowed).toBe(false)
  })

  it('TEST 6 — override=true on dirty tree → ALLOW, override recorded', () => {
    const prov = resolveProvenance(fakeGit(dirty), { override: true })
    expect(prov.producerDirtyTracked).toBe(true)
    expect(prov.producerDirtyOverride).toBe(true)
    expect(decideProducer(prov).allowed).toBe(true)
  })

  it('TEST 7 — overrideEnabled() only accepts exact "1"', () => {
    expect(overrideEnabled({ ALLOW_DIRTY_PRODUCER: 'yes' })).toBe(false)
    expect(overrideEnabled({ ALLOW_DIRTY_PRODUCER: 'true' })).toBe(false)
    expect(overrideEnabled({ ALLOW_DIRTY_PRODUCER: '' })).toBe(false)
    expect(overrideEnabled({})).toBe(false)
    expect(overrideEnabled({ ALLOW_DIRTY_PRODUCER: '1' })).toBe(true)
    // malformed value → override not enabled → dirty still refused
    const prov = resolveProvenance(fakeGit(dirty), { override: overrideEnabled({ ALLOW_DIRTY_PRODUCER: 'yes' }) })
    expect(decideProducer(prov).allowed).toBe(false)
  })

  it('TEST 8 — not a git repository → REFUSE, unresolved', () => {
    const prov = resolveProvenance(fakeGit({ insideWorkTree: { status: 128, stdout: '', stderr: 'fatal: not a git repository' } }))
    expect(prov.provenanceResolved).toBe(false)
    expect(decideProducer(prov).allowed).toBe(false)
  })

  it('TEST 9 — HEAD failure → REFUSE, unresolved', () => {
    const prov = resolveProvenance(fakeGit({ head: { status: 128, stdout: '', stderr: 'fatal: bad HEAD' } }))
    expect(prov.provenanceResolved).toBe(false)
    expect(decideProducer(prov).allowed).toBe(false)
  })

  it('git executable unavailable (spawn error → status null) → REFUSE', () => {
    const git: GitRunner = () => ({ status: null, stdout: '', stderr: 'Error: spawn git ENOENT' })
    const prov = resolveProvenance(git)
    expect(prov.provenanceResolved).toBe(false)
    expect(decideProducer(prov).allowed).toBe(false)
  })

  it('cleanliness query errors (status 129) → REFUSE, unresolved', () => {
    const prov = resolveProvenance(fakeGit({ diff: { status: 129, stdout: '', stderr: 'error' } }))
    expect(prov.provenanceResolved).toBe(false)
    expect(decideProducer(prov).allowed).toBe(false)
  })

  it('detached HEAD but clean → ALLOW, branch=DETACHED', () => {
    const prov = resolveProvenance(fakeGit({
      head: { status: 0, stdout: SHA, stderr: '' },
      branch: { status: 0, stdout: 'HEAD', stderr: '' },
    }))
    expect(prov.producerBranch).toBe('DETACHED')
    expect(prov.producerDirtyTracked).toBe(false)
    expect(decideProducer(prov).allowed).toBe(true)
  })
})

describe('producer provenance — enforcement + ordering', () => {
  it('TEST 11 — dirty + requireAuthority → exit(1) BEFORE authority', () => {
    let exited: number | null = null
    const logs: string[] = []
    enforceProducerProvenance({
      requireAuthority: true, override: false, git: fakeGit(dirty),
      log: (...a) => logs.push(a.join(' ')), exit: (c) => { exited = c },
    })
    expect(exited).toBe(1)
    expect(logs.join('\n')).toContain('EXECUTION AUTHORITY REFUSED')
  })

  it('dirty + requireAuthority=false → NO exit (authority not requested)', () => {
    let exited: number | null = null
    enforceProducerProvenance({
      requireAuthority: false, override: false, git: fakeGit(dirty),
      log: () => {}, exit: (c) => { exited = c },
    })
    expect(exited).toBeNull()
  })

  it('override on dirty tree → loud WARNING, no exit', () => {
    let exited: number | null = null
    const logs: string[] = []
    const prov = enforceProducerProvenance({
      requireAuthority: true, override: true, git: fakeGit(dirty),
      log: (...a) => logs.push(a.join(' ')), exit: (c) => { exited = c },
    })
    expect(exited).toBeNull()
    expect(prov.producerDirtyOverride).toBe(true)
    expect(logs.join('\n')).toContain('WARNING')
  })

  it('TEST 10 — clean startup provenance has exact SHA/branch/flags', () => {
    let exited: number | null = null
    const prov = enforceProducerProvenance({
      requireAuthority: true, override: false,
      git: fakeGit({ head: { status: 0, stdout: SHA, stderr: '' } }),
      log: () => {}, exit: (c) => { exited = c },
    })
    expect(exited).toBeNull()
    expect(prov).toMatchObject({
      producerHead: SHA, producerBranch: 'main',
      producerDirtyTracked: false, producerDirtyOverride: false, provenanceResolved: true,
    })
    expect(typeof prov.startedAtUtc).toBe('string')
  })
})

describe('producer provenance — .env.local override persistence (Q3)', () => {
  it('override MUST come from launch env, not .env.local — REFUSE when only .env.local sets it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envlocal-'))
    const envFile = join(dir, '.env.local')
    writeFileSync(envFile, 'ALLOW_DIRTY_PRODUCER=1\nPAPER_TRADE=1\n')
    const savedAllow = process.env.ALLOW_DIRTY_PRODUCER
    const savedPaper = process.env.PAPER_TRADE
    delete process.env.ALLOW_DIRTY_PRODUCER // launch env does NOT provide it
    delete process.env.PAPER_TRADE
    try {
      // Daemon captures the override from the INHERITED env, BEFORE loadEnvLocal:
      const launchOverride = overrideEnabled(process.env) // false
      loadEnvLocal(envFile)                                // now populates process.env from the file
      // The vector is real: .env.local DID set the value into process.env…
      expect(process.env.ALLOW_DIRTY_PRODUCER).toBe('1')
      // …but the captured launch override is false, and that is what the guard uses.
      expect(launchOverride).toBe(false)
      let exited: number | null = null
      enforceProducerProvenance({
        requireAuthority: true, override: launchOverride, git: fakeGit(dirty),
        log: () => {}, exit: (c) => { exited = c },
      })
      expect(exited).toBe(1) // REFUSE despite .env.local containing the override
    } finally {
      if (savedAllow === undefined) delete process.env.ALLOW_DIRTY_PRODUCER; else process.env.ALLOW_DIRTY_PRODUCER = savedAllow
      if (savedPaper === undefined) delete process.env.PAPER_TRADE; else process.env.PAPER_TRADE = savedPaper
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('explicit launch-time override enables it on a dirty tree → ALLOW + audit', () => {
    // Simulates `ALLOW_DIRTY_PRODUCER=1 npx tsx ...`: value present in the inherited env.
    const launchOverride = overrideEnabled({ ALLOW_DIRTY_PRODUCER: '1' }) // true
    let exited: number | null = null
    const logs: string[] = []
    const prov = enforceProducerProvenance({
      requireAuthority: true, override: launchOverride, git: fakeGit(dirty),
      log: (...a) => logs.push(a.join(' ')), exit: (c) => { exited = c },
    })
    expect(exited).toBeNull()
    expect(prov.producerDirtyTracked).toBe(true)
    expect(prov.producerDirtyOverride).toBe(true)
    expect(logs.join('\n')).toContain('WARNING')
  })
})

// ---- real isolated temp git repos: exercise defaultGitRunner end-to-end ----
function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@t.t')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'src.ts'), 'export const x = 1\n')
  git(dir, 'add', 'src.ts')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

describe('producer provenance — real temp repos (defaultGitRunner)', () => {
  it('clean tracked tree → ALLOW', () => {
    const dir = makeRepo()
    try {
      const prov = resolveProvenance(defaultGitRunner(dir))
      expect(prov.provenanceResolved).toBe(true)
      expect(prov.producerDirtyTracked).toBe(false)
      expect(decideProducer(prov).allowed).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('TEST 2 — untracked file only → ALLOW, dirtyTracked=false', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'reviews-note.md'), 'evidence\n') // untracked
      const prov = resolveProvenance(defaultGitRunner(dir))
      expect(prov.producerDirtyTracked).toBe(false)
      expect(decideProducer(prov).allowed).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('TEST 5 — tracked modified + untracked file → REFUSE', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'src.ts'), 'export const x = 2\n') // tracked mod
      writeFileSync(join(dir, 'reviews-note.md'), 'evidence\n')   // untracked
      const prov = resolveProvenance(defaultGitRunner(dir))
      expect(prov.producerDirtyTracked).toBe(true)
      expect(decideProducer(prov).allowed).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('staged-only modification → REFUSE', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'src.ts'), 'export const x = 3\n')
      git(dir, 'add', 'src.ts')
      const prov = resolveProvenance(defaultGitRunner(dir))
      expect(prov.producerDirtyTracked).toBe(true)
      expect(decideProducer(prov).allowed).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('deleted tracked file → REFUSE', () => {
    const dir = makeRepo()
    try {
      rmSync(join(dir, 'src.ts'))
      const prov = resolveProvenance(defaultGitRunner(dir))
      expect(prov.producerDirtyTracked).toBe(true)
      expect(decideProducer(prov).allowed).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('not a git repo (temp dir, no init) → REFUSE, unresolved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nogit-'))
    try {
      const prov = resolveProvenance(defaultGitRunner(dir))
      expect(prov.provenanceResolved).toBe(false)
      expect(decideProducer(prov).allowed).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
