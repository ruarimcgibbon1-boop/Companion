/**
 * phantom-book.ts — read-only forensic phantom-trade runner.
 *
 * Reconstructs an ET trading day's setup candidates from the daemon's OWN logs,
 * classifies each as accepted / phantom / duplicate / not-simulatable, and resolves
 * every simulatable one through the SAME canonical resolver over FMP 1m tape to
 * produce three books: IDEAL_ACCEPTED, IDEAL_PHANTOM, ACTUAL_EXECUTED.
 *
 * GUARANTEES: places no orders, mutates no strategy state, writes no production log.
 * Reads:  ~/.companion-decisions-<day>.jsonl   (candidate universe + signal geometry)
 *         ~/.companion-paper-trades-<day>.json  (executed set + realized R, by setupId)
 * Writes: only the research tape cache, and (optionally) a report to --out.
 *
 * Attribution is by setupId ONLY — never symbol. Same-day tape is labelled
 * PROVISIONAL (FMP revises the live session); a settled prior day is FINAL.
 *
 *   PHANTOM_DAY=2026-08-19 npx tsx scripts/phantom-book.ts            # settled → FINAL
 *   PHANTOM_DAY=2026-08-20 OFFLINE=1 npx tsx scripts/phantom-book.ts  # today → PROVISIONAL
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { pathToFileURL } from 'url'

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
  resolveWithFlatten,
  tapeState,
  type PhantomRow,
} from '@/lib/research/phantom-book'
import { loadTape, type RawFmpRow } from '@/lib/research/phantom-tape'

const FLATTEN = DEFAULT_EXECUTOR.flattenEtMinute // 15:55 ET — the canonical session boundary
const HOME = homedir()
const SCRATCH = process.env.SCRATCH_DIR || '/private/tmp/claude-501/-Users-elonmusk-Companion/scratchpad'
const CACHE_DIR = process.env.FMP_CACHE_DIR || join(SCRATCH, 'fmp-cache')
const OFFLINE = process.env.OFFLINE === '1'

interface PaperTradeRow { setupId?: string; symbol?: string; realizedPnl?: number; plannedRisk?: number }

function readDecisionRows(day: string): DecisionLogRow[] {
  const file = join(HOME, `.companion-decisions-${day}.jsonl`)
  if (!existsSync(file)) {
    throw new Error(`STOP: no decision log for ${day} at ${file}. Cannot reconstruct the candidate universe.`)
  }
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as DecisionLogRow)
}

/** Executed set + realized-R map, keyed by setupId ONLY. A paper trade without a setupId is a STOP, never a symbol guess. */
function readExecuted(day: string): { ids: Set<string>; actualR: Map<string, number | null> } {
  const file = join(HOME, `.companion-paper-trades-${day}.json`)
  const ids = new Set<string>()
  const actualR = new Map<string, number | null>()
  if (!existsSync(file)) return { ids, actualR }
  const trades = JSON.parse(readFileSync(file, 'utf8')) as PaperTradeRow[]
  for (const t of trades) {
    if (!t.setupId) {
      throw new Error(`STOP: a paper trade for ${day} has no setupId (symbol ${t.symbol ?? '?'}). setupId join is impossible; refusing a symbol fallback.`)
    }
    ids.add(t.setupId)
    actualR.set(t.setupId, t.plannedRisk && t.plannedRisk > 0 ? (t.realizedPnl ?? 0) / t.plannedRisk : null)
  }
  return { ids, actualR }
}

async function resolveRows(candidates: ShadowCandidate[], executedIds: Set<string>, actualR: Map<string, number | null>): Promise<PhantomRow[]> {
  const tapeBySymbol = new Map<string, Awaited<ReturnType<typeof loadTape>>>()
  const rows: PhantomRow[] = []
  for (const c of candidates) {
    const klass = classifyCandidate(c, executedIds)
    if (!tapeBySymbol.has(c.symbol)) {
      tapeBySymbol.set(
        c.symbol,
        await loadTape({
          symbol: c.symbol,
          day: c.etTradingDay,
          offline: OFFLINE,
          cacheDir: CACHE_DIR,
          fetchRows: () => getIntradayCandles(c.symbol, '1min') as Promise<RawFmpRow[]>,
        }),
      )
    }
    const tape = tapeBySymbol.get(c.symbol)!
    const outcome = resolveWithFlatten(c, tape.bars, FLATTEN)
    rows.push({ candidate: c, klass, outcome, actualR: actualR.get(c.setupId) ?? null, hasTarget: c.targets.length > 0 })
  }
  return rows
}

function fmtBook(name: string, b: { n: number; netR: number; avgR: number | null; medianR: number | null; winRatePct: number | null }): string {
  return `${name.padEnd(16)} n=${String(b.n).padStart(3)}  netR=${b.netR.toFixed(1).padStart(7)}  avgR=${(b.avgR ?? 0).toFixed(2).padStart(6)}  medR=${(b.medianR ?? 0).toFixed(2).padStart(6)}  win=${(b.winRatePct ?? 0).toFixed(0)}%`
}

function report(day: string, rows: PhantomRow[], state: string): string {
  const books = buildBooks(rows)
  const L: string[] = []
  L.push(`# PHANTOM BOOK — ${day}   [${state} TAPE]`)
  if (state === 'PROVISIONAL') L.push(`!! PROVISIONAL: same-day FMP tape may still revise. Re-run on the settled day for the canonical/FINAL book.`)
  L.push('')
  L.push(`candidates=${rows.length}  accepted=${books.counts.accepted}  phantomPrimary=${books.counts.phantomPrimary}  phantomDup=${books.counts.phantomDup}  notSimulatable=${books.counts.notSimulatable}  noFill=${books.counts.noFill}  targetMissing=${books.counts.targetMissing}`)
  L.push('')
  L.push('## Books')
  L.push(fmtBook('IDEAL_ACCEPTED', books.idealAccepted))
  L.push(fmtBook('IDEAL_PHANTOM', books.idealPhantom))
  L.push(fmtBook('ACTUAL_EXECUTED', books.actualExecuted))
  L.push(fmtBook('  ↳ tgt-missing', books.idealTargetMissing) + '   (subgroup: no-target candidates, resolvable only to stop/flatten)')
  L.push('')
  L.push('PRIMARY gate-quality:   IDEAL_ACCEPTED vs IDEAL_PHANTOM')
  L.push('Execution-quality:      IDEAL_ACCEPTED vs ACTUAL_EXECUTED')
  L.push('')
  L.push('## Candidate table (raw — includes dup_cooldown, excluded from aggregates above)')
  L.push('setupId | symbol | setup | class | layer | entry | stop | tgt? | result | R | MFE% | MAE% | mark')
  for (const r of rows) {
    const o = r.outcome
    L.push(
      [
        r.candidate.setupId,
        r.candidate.symbol,
        r.candidate.setup,
        r.klass,
        rejectionLayer(r.candidate.terminalVerdict),
        r.candidate.entryRef ?? '—',
        r.candidate.stop ?? '—',
        r.hasTarget ? 'Y' : 'N',
        o.result,
        o.hypotheticalR ?? '—',
        o.mfePct ?? '—',
        o.maePct ?? '—',
        o.markSource,
      ].join(' | '),
    )
  }
  return L.join('\n')
}

async function main() {
  const day = process.env.PHANTOM_DAY || etTradingDay(Date.now())
  const state = tapeState(day)
  const candidates = buildShadowCandidates(readDecisionRows(day))
  const { ids, actualR } = readExecuted(day)
  const rows = await resolveRows(candidates, ids, actualR)
  const text = report(day, rows, state)
  console.log(text)
  const out = process.env.OUT
  if (out) {
    writeFileSync(out, text)
    console.log(`\n(report written to ${out})`)
  }
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e))
    process.exit(1)
  })
}
