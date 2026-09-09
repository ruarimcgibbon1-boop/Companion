/**
 * Atomic, fail-closed session freeze (Finding 2) — orchestration over fs.
 *
 * Invariants:
 *   • verify ALL required sources exist before writing anything;
 *   • refuse to overwrite an existing snapshot (never mutate it);
 *   • stage into a sibling temp dir, hash/verify there, chmod 0444;
 *   • atomically rename temp → final;
 *   • on ANY failure, remove only the temp dir — no partial final snapshot.
 *
 * Read-only w.r.t. the source artifacts (copies bytes; never writes them). Pure of
 * the executor/daemon. The `onBeforeRename` hook exists solely so tests can inject
 * a mid-freeze failure and assert no partial final snapshot survives.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync } from 'fs'
import { dirname } from 'path'
import { join } from 'path'

import {
  fileStats, buildManifest, type ManifestFile, type ManifestEnv, type SessionManifest,
} from '@/lib/research/session-snapshot'

export class FreezeError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'FreezeError' }
}

export interface FreezeSource {
  name: string
  srcPath: string
  /** File name within the snapshot dir, e.g. `decisions.jsonl`. */
  destName: string
}

export interface FreezeProvenance {
  frozenAtUtc: string
  producingStrategyHead: string
  snapshotCheckoutHead: string
  evaluatorSha: string
  env: ManifestEnv
  host: { hostname: string; platform: string; user: string; node: string }
}

export interface FreezeResult { destDir: string; manifest: SessionManifest }

export function performFreeze(opts: {
  day: string
  sources: FreezeSource[]
  destDir: string
  provenance: FreezeProvenance
  onBeforeRename?: () => void
}): FreezeResult {
  const { day, sources, destDir, provenance } = opts

  // 1. All sources must exist before ANYTHING is written.
  const missing = sources.filter(s => !existsSync(s.srcPath)).map(s => `${s.name} (${s.srcPath})`)
  if (missing.length) throw new FreezeError(`missing required source(s): ${missing.join(', ')}`, 'MISSING_SOURCE')

  // 2. Refuse to overwrite an existing snapshot.
  if (existsSync(destDir)) throw new FreezeError(`snapshot already exists, refusing to overwrite: ${destDir}`, 'SNAPSHOT_EXISTS')

  // 3. Stage into a sibling temp dir (same filesystem → atomic rename).
  const tmpDir = `${destDir}.freezing-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dirname(destDir), { recursive: true })
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })

    const files: ManifestFile[] = []
    for (const s of sources) {
      const content = readFileSync(s.srcPath)          // read source bytes
      const dest = join(tmpDir, s.destName)
      writeFileSync(dest, content)                     // stage
      const readBack = readFileSync(dest)              // 5. verify the staged copy
      if (!readBack.equals(content)) throw new FreezeError(`staged copy differs for ${s.name}`, 'STAGE_VERIFY')
      files.push(fileStats(s.name, `snapshot/${s.destName}`, readBack))
    }

    // Test hook: inject a mid-freeze failure after staging, before rename.
    opts.onBeforeRename?.()

    const manifest = buildManifest({
      day,
      frozenAtUtc: provenance.frozenAtUtc,
      producingStrategyHead: provenance.producingStrategyHead,
      snapshotCheckoutHead: provenance.snapshotCheckoutHead,
      evaluatorSha: provenance.evaluatorSha,
      env: provenance.env,
      host: provenance.host,
      files,
    })
    writeFileSync(join(tmpDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2))

    // 7. chmod snapshot payload + manifest read-only.
    for (const s of sources) chmodSync(join(tmpDir, s.destName), 0o444)
    chmodSync(join(tmpDir, 'MANIFEST.json'), 0o444)

    // 8. Atomic promotion.
    renameSync(tmpDir, destDir)
    return { destDir, manifest }
  } catch (e) {
    // 9. Clean up ONLY the temp dir; leave any existing final snapshot untouched.
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
    throw e
  }
}
