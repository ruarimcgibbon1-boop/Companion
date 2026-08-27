/**
 * Session drift verifier (C1.2) — READ-ONLY.
 *
 * Compares each live ~/.companion artifact against its frozen snapshot copy and
 * classifies drift:
 *   CLEAN                    identical
 *   POST_FREEZE_APPEND_DRIFT snapshot is an exact byte-prefix of live (append-only)
 *   NON_PREFIX_DRIFT         live diverges within the frozen region → escalate
 *   MISSING_LIVE             live file gone
 * Exit code is nonzero if ANY file is NON_PREFIX_DRIFT or MISSING_LIVE.
 *
 * The appended tail is summarized as pipeline metadata (rows, ts range, symbols,
 * verdict/session label counts) only — never performance.
 *
 *   npx tsx scripts/session-verify.ts 2026-08-27
 *   npx tsx scripts/session-verify.ts 2026-08-27 --snapshot reviews/prospective-offhigh/2026-08-27/snapshot
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { classifyDrift, summarizeJsonlTail, type SessionManifest } from '@/lib/research/session-snapshot'

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

  // name → live path (mirror of session-freeze's source map).
  const livePath: Record<string, string> = {
    'decisions': join(H, `.companion-decisions-${day}.jsonl`),
    'paper-events': join(H, `.companion-paper-events-${day}.jsonl`),
    'paper-trades': join(H, `.companion-paper-trades-${day}.json`),
    'execution-quality': join(H, `.companion-execution-quality-${day}.jsonl`),
    'shadow-output': join(repo, 'data', 'research-cache', 'shadow-offhigh', `${day}.json`),
  }

  console.log(`\nSession verify — ${day}  (snapshot: ${snapDir})`)
  let escalate = false
  for (const mf of manifest.files) {
    const snapFile = join(snapDir, mf.path.replace(/^snapshot\//, ''))
    const snap = readFileSync(snapFile)
    const lp = livePath[mf.name]
    const live = lp && existsSync(lp) ? readFileSync(lp) : null
    const r = classifyDrift(mf.name, snap, live)
    if (r.driftClass === 'NON_PREFIX_DRIFT' || r.driftClass === 'MISSING_LIVE') escalate = true

    let line = `  ${mf.name.padEnd(18)} ${r.driftClass}`
    if (r.driftClass === 'POST_FREEZE_APPEND_DRIFT' && r.appended) {
      line += `  (+${r.appended.rows} rows / +${r.appended.bytes} bytes appended; frozen prefix intact)`
    }
    console.log(line)
    if (r.driftClass === 'POST_FREEZE_APPEND_DRIFT' && r.appended && (mf.name === 'decisions' || mf.name === 'paper-events')) {
      const s = summarizeJsonlTail(r.appended.tailText)
      console.log(`      tail metadata: ${s.rows} rows  ts ${s.firstTs ?? '—'} → ${s.lastTs ?? '—'}`)
      console.log(`      symbols: ${s.symbols.join(', ') || '—'}`)
      console.log(`      verdicts: ${JSON.stringify(s.verdictCounts)}  sessions: ${JSON.stringify(s.sessionCounts)}`)
    }
  }
  console.log(escalate ? '\n  RESULT: DRIFT REQUIRES ATTENTION (non-prefix or missing)\n' : '\n  RESULT: snapshot integrity OK (clean or benign append-only)\n')
  process.exit(escalate ? 1 : 0)
}

main()
