/**
 * Session drift verifier (C1.2, corrected per Finding 3) — READ-ONLY.
 *
 * FIRST validates every snapshot file against MANIFEST (bytes/rows/sha256). A
 * snapshot file that disagrees with its manifest is SNAPSHOT_INTEGRITY_FAILURE and
 * exits nonzero immediately — a corrupted snapshot is never used as a drift
 * baseline. Only if the snapshot is self-consistent does it classify live drift:
 *   CLEAN / POST_FREEZE_APPEND_DRIFT / NON_PREFIX_DRIFT / MISSING_LIVE.
 * Appended tails are summarized as pipeline metadata only (never performance).
 *
 *   npx tsx scripts/session-verify.ts 2026-08-27
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { classifyDrift, verifyManifestFile, summarizeJsonlTail, type SessionManifest } from '@/lib/research/session-snapshot'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main() {
  const day = process.argv[2]
  if (!day || day.startsWith('--')) { console.error('usage: tsx scripts/session-verify.ts <ET-day> [--snapshot <dir>]'); process.exit(2) }
  const repo = process.cwd()
  const H = homedir()
  const snapDir = arg('--snapshot') ?? join(repo, 'reviews', 'prospective-offhigh', day, 'snapshot')
  const manifestPath = join(snapDir, 'MANIFEST.json')
  if (!existsSync(manifestPath)) { console.error(`no manifest at ${manifestPath} — run session-freeze first`); process.exit(2) }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SessionManifest

  console.log(`\nSession verify — ${day}  (snapshot: ${snapDir})`)
  console.log(`  producingStrategyHead=${manifest.producingStrategyHead}  checkout=${manifest.snapshotCheckoutHead}`)

  // Finding 3: verify the snapshot against its own manifest BEFORE any live compare.
  let integrityFailed = false
  for (const mf of manifest.files) {
    const snapFile = join(snapDir, mf.path.replace(/^snapshot\//, ''))
    const content = existsSync(snapFile) ? readFileSync(snapFile) : null
    const v = verifyManifestFile(mf, content)
    if (!v.ok) { integrityFailed = true; console.error(`  ${mf.name.padEnd(18)} SNAPSHOT_INTEGRITY_FAILURE — ${v.reason}`) }
  }
  if (integrityFailed) {
    console.error('\n  RESULT: SNAPSHOT_INTEGRITY_FAILURE — snapshot cannot be used as a drift baseline\n')
    process.exit(1)
  }
  console.log('  snapshot integrity: OK (all files match manifest)')

  const livePath: Record<string, string> = {
    'decisions': join(H, `.companion-decisions-${day}.jsonl`),
    'paper-events': join(H, `.companion-paper-events-${day}.jsonl`),
    'paper-trades': join(H, `.companion-paper-trades-${day}.json`),
    'execution-quality': join(H, `.companion-execution-quality-${day}.jsonl`),
    'shadow-output': join(repo, 'data', 'research-cache', 'shadow-offhigh', `${day}.json`),
  }

  let escalate = false
  for (const mf of manifest.files) {
    const snap = readFileSync(join(snapDir, mf.path.replace(/^snapshot\//, '')))
    const lp = livePath[mf.name]
    const live = lp && existsSync(lp) ? readFileSync(lp) : null
    const r = classifyDrift(mf.name, snap, live)
    if (r.driftClass === 'NON_PREFIX_DRIFT' || r.driftClass === 'MISSING_LIVE') escalate = true

    let line = `  ${mf.name.padEnd(18)} ${r.driftClass}`
    if (r.driftClass === 'POST_FREEZE_APPEND_DRIFT' && r.appended) line += `  (+${r.appended.rows} rows / +${r.appended.bytes} bytes; frozen prefix intact)`
    console.log(line)
    if (r.driftClass === 'POST_FREEZE_APPEND_DRIFT' && r.appended && (mf.name === 'decisions' || mf.name === 'paper-events')) {
      const s = summarizeJsonlTail(r.appended.tailText)
      console.log(`      tail metadata: ${s.rows} rows  ts ${s.firstTs ?? '—'} → ${s.lastTs ?? '—'}  symbols: ${s.symbols.join(', ') || '—'}`)
      console.log(`      verdicts: ${JSON.stringify(s.verdictCounts)}  sessions: ${JSON.stringify(s.sessionCounts)}`)
    }
  }
  console.log(escalate ? '\n  RESULT: DRIFT REQUIRES ATTENTION (non-prefix or missing)\n' : '\n  RESULT: snapshot integrity OK; live drift clean or benign append-only\n')
  process.exit(escalate ? 1 : 0)
}

main()
