/**
 * Deterministic signal-tape acquisition (C3.1) — READ-ONLY / REVIEW DIAGNOSTIC.
 *
 * Enumerates every relevant signal instance for an ET day (filled, aborted,
 * capacity-blocked, off-high removed, replacement candidate) from the frozen
 * decisions snapshot + shadow output, then ensures a 1-minute tape (through 16:00
 * ET) exists for each unique symbol, writing a provenance sidecar
 * (source / fetchedAt / sha256 / rows) next to each tape.
 *
 * This NEVER feeds trading, admission, thresholds, or the frozen PASS/FAIL — it
 * only makes the review's post-signal excursion diagnostic reproducible.
 *
 *   npx tsx scripts/acquire-signal-tapes.ts 2026-08-27
 *   OFFLINE=1 npx tsx scripts/acquire-signal-tapes.ts 2026-08-27   # report coverage, no fetch
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { enumerateInstances } from '@/lib/research/signal-instances'
import { sha256 } from '@/lib/research/phantom-tape'

const REPO = process.cwd()
const CACHE = join(REPO, 'data', 'research-cache')
const H = homedir()

function readJson<T>(path: string, fallback: T): T {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback } catch { return fallback }
}
function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return {} } })
}
function apiKey(): string | null {
  try { const m = readFileSync(join(REPO, '.env.local'), 'utf8').match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/); return m ? m[1] : null }
  catch { return null }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Prefer a frozen snapshot copy if present, else the live file. */
function pick(day: string, name: string, ext: string, liveName: string): string {
  const snap = join(REPO, 'reviews', 'prospective-offhigh', day, 'snapshot', `${name}${ext}`)
  return existsSync(snap) ? snap : join(H, liveName)
}

async function fetchTape(symbol: string, day: string, key: string): Promise<unknown[] | null> {
  const url = `https://financialmodelingprep.com/stable/historical-chart/1min?symbol=${symbol}&from=${day}&to=${day}&extended=true&apikey=${key}`
  for (let a = 0; a < 6; a++) {
    try {
      const res = await fetch(url)
      if (res.ok) { const j = await res.json(); return Array.isArray(j) ? j : null }
      if (res.status !== 429 && res.status < 500) return null
    } catch { /* retry */ }
    await sleep(1500 * (a + 1))
  }
  return null
}

async function main() {
  const day = process.argv[2]
  if (!day || day.startsWith('--')) { console.error('usage: tsx scripts/acquire-signal-tapes.ts <ET-day>'); process.exit(2) }
  const offline = process.env.OFFLINE === '1'

  const decisions = readJsonl(pick(day, 'decisions', '.jsonl', `.companion-decisions-${day}.jsonl`))
  const trades = readJson<Array<Record<string, unknown>>>(pick(day, 'paper-trades', '.json', `.companion-paper-trades-${day}.json`), [])
  const events = readJsonl(pick(day, 'paper-events', '.jsonl', `.companion-paper-events-${day}.jsonl`))
  const shadow = readJson<Record<string, unknown>>(join(CACHE, 'shadow-offhigh', `${day}.json`), {})

  const en = enumerateInstances({ trades, events, shadow: shadow as never, decisions })

  console.log(`\nSignal-tape acquisition — ${day}`)
  console.log(`  core instances: ${en.coreInstanceCount}  (core unique symbols: ${en.coreUniqueSymbols.length})`)
  console.log(`  all instances: ${en.instances.length}  (all unique symbols: ${en.allUniqueSymbols.length})`)
  const byClass: Record<string, number> = {}
  for (const i of en.instances) byClass[i.primaryClass] = (byClass[i.primaryClass] ?? 0) + 1
  console.log(`  by class: ${JSON.stringify(byClass)}  offHighRemoved: ${en.instances.filter(i => i.offHighRemoved).map(i => i.setupId).join(',') || '—'}`)

  const key = apiKey()
  mkdirSync(CACHE, { recursive: true })
  let have = 0
  const symbols = en.allUniqueSymbols // acquire for every relevant symbol
  for (const sym of symbols) {
    const tapeFile = join(CACHE, `m1_${sym}_${day}.json`)
    const provFile = join(CACHE, `m1_${sym}_${day}.provenance.json`)
    let source = 'missing'
    let rows = 0
    let hash: string | null = null

    if (existsSync(tapeFile)) {
      const content = readFileSync(tapeFile, 'utf8')
      let parsed: unknown = []
      try { parsed = JSON.parse(content) } catch { parsed = [] }
      rows = Array.isArray(parsed) ? parsed.length : 0
      if (rows > 0) { source = 'cache-existing'; hash = sha256(content); have++ }
      else source = 'empty_cache'
    } else if (!offline && key) {
      const fetched = await fetchTape(sym, day, key)
      if (fetched && fetched.length > 0) {
        const content = JSON.stringify(fetched)
        writeFileSync(tapeFile, content)
        rows = fetched.length; source = 'network'; hash = sha256(content); have++
      } else source = 'fetch_failed'
    } else source = offline ? 'offline_skip' : 'no_api_key'

    const provenance = { symbol: sym, day, source, rows, sha256: hash, fetchedAt: new Date().toISOString(), through: '16:00 ET', provider: 'fmp/1min/extended' }
    writeFileSync(provFile, JSON.stringify(provenance, null, 2))
    const inCore = en.coreUniqueSymbols.includes(sym) ? ' [core]' : ''
    console.log(`  ${sym.padEnd(6)} ${source.padEnd(14)} rows=${String(rows).padStart(4)}  ${hash ? hash.slice(0, 16) + '…' : '—'}${inCore}`)
  }

  const coreHave = en.coreUniqueSymbols.filter(s => existsSync(join(CACHE, `m1_${s}_${day}.json`)) && JSON.parse(readFileSync(join(CACHE, `m1_${s}_${day}.json`), 'utf8')).length > 0).length
  console.log(`\n  coverage: core symbols ${coreHave}/${en.coreUniqueSymbols.length}  ·  all symbols ${have}/${symbols.length}`)
  console.log(`  (diagnostic only — not fed into trading or frozen PASS/FAIL)\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
