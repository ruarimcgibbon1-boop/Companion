/**
 * Immutable session snapshot (C1.1, corrected per Findings 2 & 4) — READ-ONLY.
 * Does NOT touch the daemon.
 *
 * Atomic + fail-closed: verifies all sources exist, refuses to overwrite an
 * existing snapshot, stages into a temp dir, hashes/chmods there, then atomically
 * renames into place. On any failure nothing partial survives.
 *
 * Provenance is honest (Finding 4): the strategy commit that PRODUCED the session
 * must be supplied explicitly (`--producing-head <sha>` or PRODUCING_STRATEGY_HEAD)
 * and is validated as a real commit; it is never inferred from the freeze checkout.
 * The checkout HEAD is recorded separately. Daemon runtime env is UNKNOWN unless
 * proven — the freeze process's own env is recorded distinctly.
 *
 *   npx tsx scripts/session-freeze.ts 2026-08-27 --producing-head eead9b2
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir, hostname, platform, userInfo } from 'os'
import { execFileSync } from 'child_process'

import { sha256Bytes, type ManifestEnv } from '@/lib/research/session-snapshot'
import { performFreeze, FreezeError, type FreezeSource } from '@/lib/research/session-freeze'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function gitRevParse(repo: string, ref: string): string | null {
  try { return execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim() } catch { return null }
}
function isRealCommit(repo: string, sha: string): boolean {
  try { execFileSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }); return true } catch { return false }
}

function main() {
  const day = process.argv[2]
  if (!day || day.startsWith('--')) { console.error('usage: tsx scripts/session-freeze.ts <ET-day> --producing-head <sha> [--out <dir>]'); process.exit(2) }
  const repo = process.cwd()
  const H = homedir()
  const destDir = arg('--out') ?? join(repo, 'reviews', 'prospective-offhigh', day, 'snapshot')

  // Finding 4: producing strategy HEAD is explicit + validated, never inferred.
  const producingRaw = arg('--producing-head') ?? process.env.PRODUCING_STRATEGY_HEAD ?? null
  let producingStrategyHead = 'UNKNOWN'
  if (producingRaw) {
    if (!isRealCommit(repo, producingRaw)) { console.error(`--producing-head "${producingRaw}" is not a real commit — refusing`); process.exit(2) }
    producingStrategyHead = gitRevParse(repo, producingRaw) ?? producingRaw
  } else {
    console.warn('  ! NON_PROVEN_PROVENANCE: no --producing-head given; recording producingStrategyHead=UNKNOWN')
  }
  const snapshotCheckoutHead = gitRevParse(repo, 'HEAD') ?? 'unknown'

  const sources: FreezeSource[] = [
    { name: 'decisions', srcPath: join(H, `.companion-decisions-${day}.jsonl`), destName: 'decisions.jsonl' },
    { name: 'paper-events', srcPath: join(H, `.companion-paper-events-${day}.jsonl`), destName: 'paper-events.jsonl' },
    { name: 'paper-trades', srcPath: join(H, `.companion-paper-trades-${day}.json`), destName: 'paper-trades.json' },
    { name: 'execution-quality', srcPath: join(H, `.companion-execution-quality-${day}.jsonl`), destName: 'execution-quality.jsonl' },
    { name: 'shadow-output', srcPath: join(repo, 'data', 'research-cache', 'shadow-offhigh', `${day}.json`), destName: 'shadow-output.json' },
  ]

  const evaluatorPath = join(repo, 'scripts', 'shadow-validate.ts')
  const evaluatorSha = existsSync(evaluatorPath) ? sha256Bytes(readFileSync(evaluatorPath)) : 'unknown'

  // Finding 4: daemon runtime env is UNKNOWN unless proven; the freeze process's
  // own env is recorded separately and never mislabeled as the daemon's.
  const env: ManifestEnv = {
    daemonRuntime: 'UNKNOWN',
    freezeProcess: {
      PAPER_TRADE: process.env.PAPER_TRADE, DRY_RUN: process.env.DRY_RUN,
      HALT: process.env.HALT, EXEC_OBSERVER: process.env.EXEC_OBSERVER,
      ALPACA_BASE_URL: process.env.ALPACA_BASE_URL,
    },
  }

  try {
    const { manifest } = performFreeze({
      day, sources, destDir,
      provenance: {
        frozenAtUtc: new Date().toISOString(),
        producingStrategyHead, snapshotCheckoutHead, evaluatorSha, env,
        host: { hostname: hostname(), platform: platform(), user: userInfo().username, node: process.version },
      },
    })
    console.log(`\nSession freeze — ${day}`)
    for (const f of manifest.files) console.log(`  ${f.name.padEnd(18)} rows=${String(f.rows).padStart(6)}  bytes=${String(f.bytes).padStart(9)}  ${f.sha256}`)
    console.log(`  producingStrategyHead=${manifest.producingStrategyHead}`)
    console.log(`  snapshotCheckoutHead =${manifest.snapshotCheckoutHead}`)
    console.log(`  evaluatorSha=${manifest.evaluatorSha}`)
    console.log(`  daemonRuntimeEnv=${manifest.env.daemonRuntime === 'UNKNOWN' ? 'UNKNOWN' : JSON.stringify(manifest.env.daemonRuntime)}`)
    console.log(`  host=${manifest.host.user}@${manifest.host.hostname} (${manifest.host.platform}, node ${manifest.host.node})`)
    console.log(`  snapshot: ${destDir}  (files chmod 0444, atomically promoted)\n`)
  } catch (e) {
    if (e instanceof FreezeError) { console.error(`FREEZE REFUSED [${e.code}]: ${e.message}`); process.exit(1) }
    throw e
  }
}

main()
