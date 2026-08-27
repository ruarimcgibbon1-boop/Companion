/**
 * Deterministic signal-tape acquisition (C3.1, corrected per Finding 5) —
 * READ-ONLY / REVIEW DIAGNOSTIC.
 *
 * FAILS CLOSED TO FROZEN INPUTS: by default it reads decisions/events/trades/shadow
 * ONLY from the immutable session snapshot; a missing snapshot (or snapshot file)
 * aborts nonzero with no live fallback. `--allow-live-inputs` opts into reading the
 * mutable live files and prints a strong NON_FROZEN_INPUT warning.
 *
 * Tape provenance is honest: an existing tape with a matching sidecar is
 * `cache-verified` (fetchedAt preserved); a tape with no sidecar is
 * `cache-existing-legacy` with fetchedAt=null (never invented); a tape whose bytes
 * disagree with its sidecar hash fails closed (refetch only when explicitly online).
 * `observedAt` (this run) is distinct from `fetchedAt` (provider pull time).
 *
 * NEVER feeds trading, admission, thresholds, or the frozen PASS/FAIL.
 *
 *   npx tsx scripts/acquire-signal-tapes.ts 2026-08-27
 *   OFFLINE=1 npx tsx scripts/acquire-signal-tapes.ts 2026-08-27
 *   npx tsx scripts/acquire-signal-tapes.ts 2026-08-27 --allow-live-inputs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { enumerateInstances } from '@/lib/research/signal-instances'
import { classifyTape, type TapeSidecar } from '@/lib/research/tape-provenance'
import { sha256Bytes } from '@/lib/research/session-snapshot'

const REPO = process.cwd()
const CACHE = join(REPO, 'data', 'research-cache')
const H = homedir()

const hasFlag = (f: string) => process.argv.includes(f)
function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
}
function apiKey(): string | null {
  try { const m = readFileSync(join(REPO, '.env.local'), 'utf8').match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/); return m ? m[1] : null } catch { return null }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function fetchTape(symbol: string, day: string, key: string): Promise<unknown[] | null> {
  const url = `https://financialmodelingprep.com/stable/historical-chart/1min?symbol=${symbol}&from=${day}&to=${day}&extended=true&apikey=${key}`
  for (let a = 0; a < 6; a++) {
    try { const res = await fetch(url); if (res.ok) { const j = await res.json(); return Array.isArray(j) ? j : null }; if (res.status !== 429 && res.status < 500) return null } catch { /* retry */ }
    await sleep(1500 * (a + 1))
  }
  return null
}

async function main() {
  const day = process.argv[2]
  if (!day || day.startsWith('--')) { console.error('usage: tsx scripts/acquire-signal-tapes.ts <ET-day> [--allow-live-inputs]'); process.exit(2) }
  const offline = process.env.OFFLINE === '1'
  const allowLive = hasFlag('--allow-live-inputs')
  const snapDir = join(REPO, 'reviews', 'prospective-offhigh', day, 'snapshot')

  // Finding 5: fail closed to frozen inputs unless --allow-live-inputs.
  let decisions: Array<Record<string, unknown>>, trades: Array<Record<string, unknown>>, events: Array<Record<string, unknown>>, shadow: Record<string, unknown>
  if (allowLive) {
    console.warn('  !! NON_FROZEN_INPUT: reading MUTABLE live files (--allow-live-inputs). Not for prospective review.')
    decisions = readJsonl(join(H, `.companion-decisions-${day}.jsonl`))
    trades = JSON.parse(readFileSync(join(H, `.companion-paper-trades-${day}.json`), 'utf8'))
    events = readJsonl(join(H, `.companion-paper-events-${day}.jsonl`))
    shadow = JSON.parse(readFileSync(join(CACHE, 'shadow-offhigh', `${day}.json`), 'utf8'))
  } else {
    const req = ['decisions.jsonl', 'paper-trades.json', 'paper-events.jsonl', 'shadow-output.json']
    const missing = req.filter(f => !existsSync(join(snapDir, f)))
    if (missing.length) { console.error(`FAIL CLOSED: missing frozen snapshot input(s): ${missing.join(', ')} in ${snapDir}\n  run session-freeze first, or pass --allow-live-inputs (non-frozen).`); process.exit(1) }
    decisions = readJsonl(join(snapDir, 'decisions.jsonl'))
    trades = JSON.parse(readFileSync(join(snapDir, 'paper-trades.json'), 'utf8'))
    events = readJsonl(join(snapDir, 'paper-events.jsonl'))
    shadow = JSON.parse(readFileSync(join(snapDir, 'shadow-output.json'), 'utf8'))
  }

  const en = enumerateInstances({ trades, events, shadow: shadow as never, decisions })
  console.log(`\nSignal-tape acquisition — ${day}  (inputs: ${allowLive ? 'LIVE (non-frozen)' : 'frozen snapshot'})`)
  console.log(`  core instances: ${en.coreInstanceCount}  core unique symbols: ${en.coreUniqueSymbols.length}  all symbols: ${en.allUniqueSymbols.length}`)

  const key = apiKey()
  const online = !offline && !!key
  mkdirSync(CACHE, { recursive: true })
  let failClosed = false
  let coreHave = 0

  for (const sym of en.allUniqueSymbols) {
    const tapeFile = join(CACHE, `m1_${sym}_${day}.json`)
    const provFile = join(CACHE, `m1_${sym}_${day}.provenance.json`)
    const present = existsSync(tapeFile)
    let rows = 0, tapeSha: string | null = null
    if (present) {
      const buf = readFileSync(tapeFile)
      tapeSha = sha256Bytes(buf)
      try { const arr = JSON.parse(buf.toString('utf8')); rows = Array.isArray(arr) ? arr.length : 0 } catch { rows = 0 }
    }
    const sidecar: TapeSidecar | null = existsSync(provFile) ? (JSON.parse(readFileSync(provFile, 'utf8')) as TapeSidecar) : null
    let c = classifyTape({ tapePresent: present, rows, tapeSha256: tapeSha, sidecar, online })

    let source = c.source as string
    let fetchedAt = c.fetchedAt

    if ((c.action === 'fetch' || c.action === 'refetch') && online) {
      const fetched = await fetchTape(sym, day, key!)
      if (fetched && fetched.length > 0) {
        const content = JSON.stringify(fetched)
        writeFileSync(tapeFile, content)
        rows = fetched.length; tapeSha = sha256Bytes(content); fetchedAt = new Date().toISOString(); source = 'network'
        c = { ...c, action: 'use' }
      } else source = 'fetch_failed'
    } else if (c.action === 'fail_closed') {
      failClosed = true
    }

    const isCore = en.coreUniqueSymbols.includes(sym)
    const usable = (c.action === 'use' || source === 'network') && rows > 0
    if (isCore && usable) coreHave++

    const provenance = {
      symbol: sym, day, source, rows, sha256: tapeSha,
      fetchedAt: source === 'network' ? fetchedAt : (c.source === 'cache-existing-legacy' ? null : fetchedAt),
      observedAt: new Date().toISOString(),
      provider: 'fmp/1min/extended', through: '16:00 ET',
      action: c.action, note: c.note,
    }
    writeFileSync(provFile, JSON.stringify(provenance, null, 2))
    console.log(`  ${sym.padEnd(6)} ${source.padEnd(22)} rows=${String(rows).padStart(4)} fetchedAt=${provenance.fetchedAt ?? 'null'} ${tapeSha ? tapeSha.slice(0, 12) + '…' : '—'}${isCore ? ' [core]' : ''}${c.action === 'fail_closed' ? '  FAIL_CLOSED' : ''}`)
  }

  console.log(`\n  coverage: core symbols ${coreHave}/${en.coreUniqueSymbols.length}  ·  all symbols enumerated ${en.allUniqueSymbols.length}`)
  console.log(`  (diagnostic only — not fed into trading or frozen PASS/FAIL)\n`)
  if (failClosed) { console.error('  RESULT: one or more tapes FAILED CLOSED (provenance mismatch, offline). Re-run online to refetch.'); process.exit(1) }
}

main().catch(e => { console.error(e); process.exit(1) })
