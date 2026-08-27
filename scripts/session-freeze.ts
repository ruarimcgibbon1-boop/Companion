/**
 * Immutable session snapshot (C1.1) — READ-ONLY (does NOT touch the daemon).
 *
 * At review time, copy the day's five artifacts byte-for-byte into a dated,
 * read-only snapshot directory and write MANIFEST.json (path/rows/bytes/sha256 per
 * file, plus strategy HEAD, evaluator SHA, env identity, host identity, frozenAtUtc).
 * Reviews then cite the snapshot, never the live ~/.companion files.
 *
 * This implementation deliberately does NOT stop or alter the daemon (that is the
 * separate, deferred C1.3). It only reads and copies.
 *
 *   npx tsx scripts/session-freeze.ts 2026-08-27
 *   npx tsx scripts/session-freeze.ts 2026-08-27 --out reviews/prospective-offhigh/2026-08-27/snapshot
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir, hostname, platform, userInfo } from 'os'
import { execFileSync } from 'child_process'

import { fileStats, buildManifest, type ManifestFile } from '@/lib/research/session-snapshot'
import { sha256 } from '@/lib/research/phantom-tape'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function gitHead(repo: string): string {
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  catch { return 'unknown' }
}

function main() {
  const day = process.argv[2]
  if (!day || day.startsWith('--')) { console.error('usage: tsx scripts/session-freeze.ts <ET-day> [--out <dir>]'); process.exit(2) }
  const repo = process.cwd()
  const H = homedir()
  const outDir = arg('--out') ?? join(repo, 'reviews', 'prospective-offhigh', day, 'snapshot')

  // name → live source path. Shadow output lives in the repo cache, not home.
  const sources: Array<{ name: string; path: string }> = [
    { name: 'decisions', path: join(H, `.companion-decisions-${day}.jsonl`) },
    { name: 'paper-events', path: join(H, `.companion-paper-events-${day}.jsonl`) },
    { name: 'paper-trades', path: join(H, `.companion-paper-trades-${day}.json`) },
    { name: 'execution-quality', path: join(H, `.companion-execution-quality-${day}.jsonl`) },
    { name: 'shadow-output', path: join(repo, 'data', 'research-cache', 'shadow-offhigh', `${day}.json`) },
  ]

  mkdirSync(outDir, { recursive: true })
  const files: ManifestFile[] = []
  const missing: string[] = []
  for (const s of sources) {
    if (!existsSync(s.path)) { missing.push(`${s.name} (${s.path})`); continue }
    const content = readFileSync(s.path)
    const ext = s.path.endsWith('.jsonl') ? '.jsonl' : '.json'
    const destName = `${s.name}${ext}`
    const dest = join(outDir, destName)
    writeFileSync(dest, content)         // byte-exact copy
    chmodSync(dest, 0o444)               // immutable (read-only)
    files.push(fileStats(s.name, `snapshot/${destName}`, content))
  }

  const evaluatorPath = join(repo, 'scripts', 'shadow-validate.ts')
  const evaluatorSha = existsSync(evaluatorPath) ? sha256(readFileSync(evaluatorPath, 'utf8')) : 'unknown'

  const manifest = buildManifest({
    day,
    frozenAtUtc: new Date().toISOString(),
    strategyHead: gitHead(repo),
    evaluatorSha,
    env: {
      PAPER_TRADE: process.env.PAPER_TRADE, DRY_RUN: process.env.DRY_RUN,
      HALT: process.env.HALT, EXEC_OBSERVER: process.env.EXEC_OBSERVER,
      ALPACA_BASE_URL: process.env.ALPACA_BASE_URL,
    },
    host: { hostname: hostname(), platform: platform(), user: userInfo().username, node: process.version },
    files,
  })

  const manifestPath = join(outDir, 'MANIFEST.json')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  chmodSync(manifestPath, 0o444)

  console.log(`\nSession freeze — ${day}`)
  for (const f of files) console.log(`  ${f.name.padEnd(18)} rows=${String(f.rows).padStart(6)}  bytes=${String(f.bytes).padStart(9)}  ${f.sha256}`)
  if (missing.length) console.log(`  MISSING: ${missing.join(', ')}`)
  console.log(`  strategyHead=${manifest.strategyHead}`)
  console.log(`  evaluatorSha=${manifest.evaluatorSha}`)
  console.log(`  host=${manifest.host.user}@${manifest.host.hostname} (${manifest.host.platform}, node ${manifest.host.node})`)
  console.log(`  snapshot: ${outDir}  (files chmod 0444)\n`)
  if (missing.length) process.exitCode = 1
}

main()
