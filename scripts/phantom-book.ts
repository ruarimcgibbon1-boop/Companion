/**
 * phantom-book.ts — read-only forensic phantom-trade runner.
 *
 * Reconstructs an ET trading day's setup candidates from the daemon's OWN logs,
 * classifies each (accepted / phantom / dup / post-flatten / not-simulatable), and
 * resolves every simulatable one through the SAME canonical resolver over FMP 1m
 * tape to produce three books: IDEAL_ACCEPTED, IDEAL_PHANTOM, ACTUAL_EXECUTED.
 *
 * RESEARCH HYGIENE:
 *  - IMMUTABLE SNAPSHOT: each input file (decisions, executor events, paper trades)
 *    is read EXACTLY ONCE at start and hashed; the report runs on that frozen
 *    in-memory snapshot and never re-reads a growing production log.
 *  - Attribution is by setupId ONLY, never symbol. An accepted (opened) trade is
 *    labelled ACCEPTED regardless of a later dup/veto re-log.
 *  - Signals fired at/after 15:55 ET are STRUCTURALLY_UNTRADEABLE_POST_FLATTEN:
 *    visible in the raw table, excluded from phantom count / no-fill rate / R books.
 *  - Same-day tape is PROVISIONAL; a settled prior day is FINAL.
 *
 * GUARANTEES: places no orders, mutates no strategy state, writes no production log.
 *
 *   PHANTOM_DAY=2026-08-20 OFFLINE=1 npx tsx scripts/phantom-book.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'
import { execSync } from 'child_process'

import { DEFAULT_EXECUTOR } from '@/lib/execution/executor'
import { getIntradayCandles } from '@/lib/fmp-client'
import {
  buildShadowCandidates,
  etTradingDay,
  rejectionLayer,
  type DecisionLogRow,
  type ShadowCandidate,
} from '@/lib/research/shadow-journal'
import {
  buildBooks,
  classifyCandidate,
  operativeLayerOf,
  requiredTapeFailures,
  resolveWithFlatten,
  tapeState,
  type BookSummary,
  type PhantomRow,
} from '@/lib/research/phantom-book'
import { loadTape, sha256, type RawFmpRow, type TapeResult } from '@/lib/research/phantom-tape'

const FLATTEN = DEFAULT_EXECUTOR.flattenEtMinute // 15:55 ET — the canonical session boundary
const HOME = homedir()
const SCRATCH = process.env.SCRATCH_DIR || '/private/tmp/claude-501/-Users-elonmusk-Companion/scratchpad'
const CACHE_DIR = process.env.FMP_CACHE_DIR || join(SCRATCH, 'fmp-cache')
const OFFLINE = process.env.OFFLINE === '1'

interface PaperTradeRow { setupId?: string; symbol?: string; realizedPnl?: number; plannedRisk?: number }

/** One immutable read of a source file: exact bytes hashed, parsed rows retained. */
interface Source<T> { path: string; exists: boolean; count: number; hash: string; rows: T[] }

function readSourceLines<T>(path: string, required: boolean): Source<T> {
  if (!existsSync(path)) {
    if (required) throw new Error(`STOP: required source missing: ${path}`)
    return { path, exists: false, count: 0, hash: 'absent', rows: [] }
  }
  const text = readFileSync(path, 'utf8')
  const rows = text.trim() ? text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []
  return { path, exists: true, count: rows.length, hash: sha256(text), rows }
}

function readSourceJson<T>(path: string): Source<T> {
  if (!existsSync(path)) return { path, exists: false, count: 0, hash: 'absent', rows: [] }
  const text = readFileSync(path, 'utf8')
  const rows = JSON.parse(text) as T[]
  return { path, exists: true, count: rows.length, hash: sha256(text), rows }
}

interface Snapshot {
  day: string
  takenAt: string
  commit: string
  decisions: Source<DecisionLogRow>
  events: Source<Record<string, unknown>>
  trades: Source<PaperTradeRow>
}

/** Read every input ONCE, hash it, and freeze it for the whole report. */
function freezeSnapshot(day: string): Snapshot {
  let commit = 'unknown'
  try { commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() } catch { /* not a git checkout */ }
  return {
    day,
    takenAt: new Date().toISOString(),
    commit,
    decisions: readSourceLines<DecisionLogRow>(join(HOME, `.companion-decisions-${day}.jsonl`), true),
    events: readSourceLines<Record<string, unknown>>(join(HOME, `.companion-paper-events-${day}.jsonl`), false),
    trades: readSourceJson<PaperTradeRow>(join(HOME, `.companion-paper-trades-${day}.json`)),
  }
}

/** Executed set + realized-R map, keyed by setupId ONLY. A paper trade without a setupId is a STOP, never a symbol guess. */
function executedFrom(trades: PaperTradeRow[]): { ids: Set<string>; actualR: Map<string, number | null> } {
  const ids = new Set<string>()
  const actualR = new Map<string, number | null>()
  for (const t of trades) {
    if (!t.setupId) throw new Error(`STOP: a paper trade has no setupId (symbol ${t.symbol ?? '?'}); refusing a symbol fallback.`)
    ids.add(t.setupId)
    actualR.set(t.setupId, t.plannedRisk && t.plannedRisk > 0 ? (t.realizedPnl ?? 0) / t.plannedRisk : null)
  }
  return { ids, actualR }
}

async function resolveRows(
  candidates: ShadowCandidate[],
  executedIds: Set<string>,
  actualR: Map<string, number | null>,
): Promise<{ rows: PhantomRow[]; tapeBySymbol: Map<string, TapeResult>; tapeHash: string; loaded: string[]; missing: string[] }> {
  const tapeBySymbol = new Map<string, TapeResult>()
  const rows: PhantomRow[] = []
  const tapeDigests: string[] = []
  for (const c of candidates) {
    if (!tapeBySymbol.has(c.symbol)) {
      const t = await loadTape({
        symbol: c.symbol,
        day: c.etTradingDay,
        offline: OFFLINE,
        cacheDir: CACHE_DIR,
        fetchRows: () => getIntradayCandles(c.symbol, '1min') as Promise<RawFmpRow[]>,
      })
      tapeBySymbol.set(c.symbol, t)
      tapeDigests.push(`${c.symbol}:${t.source}:${sha256(JSON.stringify(t.bars))}`)
    }
    const tape = tapeBySymbol.get(c.symbol)!
    const klass = classifyCandidate(c, executedIds, FLATTEN)
    const outcome = resolveWithFlatten(c, tape.bars, FLATTEN)
    rows.push({ candidate: c, klass, outcome, actualR: actualR.get(c.setupId) ?? null, hasTarget: c.targets.length > 0 })
  }
  const entries = [...tapeBySymbol.entries()]
  const ok = (s: string) => s === 'cache' || s === 'network'
  return {
    rows,
    tapeBySymbol,
    tapeHash: sha256(tapeDigests.sort().join('|')),
    loaded: entries.filter(([, t]) => ok(t.source)).map(([s]) => s),
    missing: entries.filter(([, t]) => !ok(t.source)).map(([s, t]) => `${s}(${t.source})`),
  }
}

const fmtBook = (name: string, b: BookSummary): string =>
  `${name.padEnd(24)} n=${String(b.n).padStart(3)}  netR=${b.netR.toFixed(1).padStart(7)}  meanR=${(b.avgR ?? 0).toFixed(2).padStart(6)}  medR=${(b.medianR ?? 0).toFixed(2).padStart(6)}  win=${(b.winRatePct ?? 0).toFixed(0)}%`

function report(snap: Snapshot, rows: PhantomRow[], tape: { hash: string; loaded: string[]; missing: string[] }, state: string): string {
  const books = buildBooks(rows)
  const L: string[] = []
  L.push(`# PHANTOM BOOK — ${snap.day}   [${state} TAPE]`)
  if (state === 'PROVISIONAL') L.push(`!! PROVISIONAL: same-day FMP tape may still revise. Re-run on the settled day for the FINAL book.`)
  L.push('')
  L.push('## Frozen input snapshot')
  L.push(`runner commit : ${snap.commit}`)
  L.push(`snapshot at   : ${snap.takenAt}`)
  L.push(`decisions     : ${snap.decisions.count} rows  sha256 ${snap.decisions.hash}`)
  L.push(`executor evts : ${snap.events.count} rows  sha256 ${snap.events.hash}`)
  L.push(`paper trades  : ${snap.trades.count} rows  sha256 ${snap.trades.hash}`)
  L.push(`tape (${tape.loaded.length} sym) : sha256 ${tape.hash}${tape.missing.length ? `  MISSING: ${tape.missing.join(',')}` : ''}`)
  L.push('')
  L.push('## Population')
  L.push(`candidates=${rows.length}  accepted=${books.counts.accepted}  phantomPrimary=${books.counts.phantomPrimary}  comparablePhantom=${books.counts.comparablePhantom}  phantomDup=${books.counts.phantomDup}  postFlatten=${books.counts.postFlatten}  notSimulatable=${books.counts.notSimulatable}`)
  L.push(`no-fill (of phantomPrimary only)=${books.counts.noFill}  targetMissing=${books.counts.targetMissing}`)
  L.push('')
  L.push('## Books — ALL ENTERED')
  L.push(fmtBook('IDEAL_ACCEPTED', books.idealAccepted))
  L.push(fmtBook('IDEAL_PHANTOM', books.idealPhantom))
  L.push(fmtBook('ACTUAL_EXECUTED', books.actualExecuted))
  L.push('')
  L.push('## Books — COMPARABLE (target-present geometry only)')
  L.push(fmtBook('IDEAL_ACCEPTED_cmp', books.idealAcceptedComparable))
  L.push(fmtBook('IDEAL_PHANTOM_cmp', books.idealPhantomComparable))
  L.push(fmtBook('  ↳ target-missing', books.idealTargetMissing) + '   (excluded from _cmp; resolvable only to stop/flatten)')
  L.push('')
  L.push('PRIMARY gate-quality:   IDEAL_ACCEPTED vs IDEAL_PHANTOM  (and the _cmp cut)')
  L.push('Execution-quality:      IDEAL_ACCEPTED vs ACTUAL_EXECUTED  (lifecycle/tape, NOT slippage)')
  L.push('')
  L.push('## Raw candidate table (post_flatten + dup shown, excluded from aggregates)')
  L.push('setupId | symbol | setup | class | opLayer | latestLayer | everAcc | entry | stop | tgt? | result | R | MFE% | MAE% | mark')
  for (const r of rows) {
    const o = r.outcome
    L.push([
      r.candidate.setupId, r.candidate.symbol, r.candidate.setup, r.klass,
      operativeLayerOf(r.klass, r.candidate.terminalVerdict),
      rejectionLayer(r.candidate.terminalVerdict),
      r.candidate.everAccepted ? 'Y' : 'N',
      r.candidate.entryRef ?? '—', r.candidate.stop ?? '—', r.hasTarget ? 'Y' : 'N',
      o.result, o.hypotheticalR ?? '—', o.mfePct ?? '—', o.maePct ?? '—', o.markSource,
    ].join(' | '))
  }
  return L.join('\n')
}

function reportDataIncomplete(snap: Snapshot, day: string, failures: ReturnType<typeof requiredTapeFailures>): string {
  const L: string[] = []
  L.push(`# PHANTOM BOOK — ${day}`)
  L.push('')
  L.push('PHANTOM BOOK VERDICT: DATA_INCOMPLETE')
  L.push('')
  L.push('Required market tape is missing for a symbol that feeds a headline book, so the')
  L.push('gate-quality aggregates (IDEAL_ACCEPTED / IDEAL_PHANTOM) are REFUSED. This is the')
  L.push('fail-closed guard against a transient FMP failure masquerading as an empty book.')
  L.push('')
  L.push('symbol | required-by | reason | cache/network status | PHANTOM_DAY bar count')
  for (const f of failures) L.push(`${f.symbol} | ${f.klass} | ${f.reason} | ${f.status} | ${f.targetDayBars}`)
  L.push('')
  L.push(`runner commit ${snap.commit} · decisions ${snap.decisions.count} rows (${snap.decisions.hash.slice(0, 12)}…) · snapshot ${snap.takenAt}`)
  L.push('')
  L.push('No headline R aggregates were produced. Refetch the required tape (settled day) and re-run.')
  return L.join('\n')
}

async function main() {
  const day = process.env.PHANTOM_DAY || etTradingDay(Date.now())
  const snap = freezeSnapshot(day)
  const state = tapeState(day)
  const candidates = buildShadowCandidates(snap.decisions.rows) // frozen snapshot only
  const { ids, actualR } = executedFrom(snap.trades.rows)
  const { rows, tapeBySymbol, tapeHash, loaded, missing } = await resolveRows(candidates, ids, actualR)

  // FAIL CLOSED: never emit IDEAL_ACCEPTED n=0 / IDEAL_PHANTOM n=0 as a "valid" book
  // when a required symbol's tape is missing or has zero bars for the requested day.
  const failures = requiredTapeFailures(rows, tapeBySymbol)
  if (failures.length > 0) {
    const text = reportDataIncomplete(snap, day, failures)
    console.log(text)
    const out = process.env.OUT
    if (out) writeFileSync(out, text)
    process.exitCode = 2
    return
  }

  const text = report(snap, rows, { hash: tapeHash, loaded, missing }, state)
  console.log(text)
  const out = process.env.OUT
  if (out) { writeFileSync(out, text); console.log(`\n(report written to ${out})`) }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1) })
}
