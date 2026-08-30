/**
 * session-equity-path — READ-ONLY nightly intraday portfolio-path review.
 *
 *   npx tsx scripts/session-equity-path.ts 2026-08-28
 *
 * Reconstructs the intraday equity/R path of a FROZEN session from broker-truth fills
 * + 1-minute tapes + frozen paper-trade metadata, and answers: when was the book most
 * profitable, what was peak P&L/R, what was given back to the close, and whether the
 * giveback came from open winners reversing or new post-peak losers.
 *
 * This script has NO order authority. It reads only frozen evidence and the gitignored
 * research cache; it writes only a gitignored JSON artifact + stdout. Nothing here can
 * influence live/paper trading. See src/lib/research/equity-path.ts for the pure core.
 *
 * FROZEN INPUT RULE (fail-closed):
 *   Required, in order:
 *     reviews/prospective-offhigh/<DAY>/snapshot/{MANIFEST.json,paper-trades.json,
 *       paper-events.jsonl,execution-quality.jsonl}
 *     data/research-cache/broker-ledger/broker-ledger-<DAY>.json   (broker truth)
 *     data/research-cache/m1_<SYMBOL>_<DAY>.json                   (1-minute tapes)
 *   A missing snapshot or broker ledger is a hard error — never a silent fallback to
 *   mutable live files or to defective local realized P&L. Set ALLOW_NON_FROZEN=1 to
 *   permit a development run against non-frozen inputs; the report is then stamped
 *   NON_FROZEN_INPUT and a prominent warning is emitted.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import type { Candle } from '@/types'
import { normalizeFmpRows, sha256, type RawFmpRow } from '@/lib/research/phantom-tape'
import {
  buildEquityPath,
  etMinuteTimestamp,
  type BrokerLedger,
  type EquityPathInput,
  type EqQualitySummary,
  type FrozenTradeMeta,
  type ProcessMetrics,
} from '@/lib/research/equity-path'

const REPO = process.cwd()
const SESSION_CLOSE_ET_MINUTE = 16 * 60 // 16:00 ET
const ALLOW_NON_FROZEN = process.env.ALLOW_NON_FROZEN === '1'

function die(msg: string): never {
  console.error(`\n  FATAL: ${msg}\n`)
  process.exit(1)
}

const DAY = process.argv[2]
if (!DAY || !/^\d{4}-\d{2}-\d{2}$/.test(DAY)) die('usage: npx tsx scripts/session-equity-path.ts <YYYY-MM-DD>')

// ── Resolve + verify frozen inputs ────────────────────────────────────────────

const snapDir = join(REPO, 'reviews', 'prospective-offhigh', DAY, 'snapshot')
const ledgerPath = join(REPO, 'data', 'research-cache', 'broker-ledger', `broker-ledger-${DAY}.json`)
const cacheDir = join(REPO, 'data', 'research-cache')

if (!existsSync(snapDir)) {
  if (!ALLOW_NON_FROZEN) die(`frozen snapshot not found: ${snapDir}\n  (set ALLOW_NON_FROZEN=1 for a NON-FROZEN development run)`)
}
if (!existsSync(ledgerPath)) die(`broker-truth ledger not found: ${ledgerPath}\n  (broker fills are authoritative; there is no silent fallback to local P&L)`)

function readJson<T>(p: string): { data: T; sha: string } {
  const raw = readFileSync(p, 'utf8')
  return { data: JSON.parse(raw) as T, sha: sha256(raw) }
}

const warningsPre: string[] = []

// Manifest (provenance + integrity)
interface Manifest {
  day: string
  frozenAtUtc?: string
  producingStrategyHead?: string
  snapshotCheckoutHead?: string
  evaluatorSha?: string
  files?: Array<{ name: string; path: string; sha256: string; rows: number; bytes: number }>
}
let manifest: Manifest | null = null
const manifestPath = join(snapDir, 'MANIFEST.json')
if (existsSync(manifestPath)) manifest = readJson<Manifest>(manifestPath).data
else warningsPre.push(`snapshot MANIFEST.json absent at ${manifestPath}`)

function verifySha(name: string, filePath: string): string {
  const sha = sha256(readFileSync(filePath, 'utf8'))
  const rec = manifest?.files?.find((f) => f.name === name)
  if (rec && rec.sha256 !== sha) warningsPre.push(`INTEGRITY: ${name} sha256 ${sha.slice(0, 12)} != manifest ${rec.sha256.slice(0, 12)} — snapshot drift`)
  return sha
}

// Paper trades → frozen metadata (risk denominator + labels) and exit-reason map
interface FrozenExit { orderId: string | null; reason: string }
interface FrozenPaperTrade {
  setupId: string; symbol: string; setupType: string
  intendedEntry: number; initialStop: number; plannedRisk: number; qty: number
  exits?: FrozenExit[]
}
const paperTradesPath = join(snapDir, 'paper-trades.json')
if (!existsSync(paperTradesPath) && !ALLOW_NON_FROZEN) die(`frozen paper-trades.json not found: ${paperTradesPath}`)
const { data: paperTrades, sha: paperTradesSha } = readJson<FrozenPaperTrade[]>(paperTradesPath)
if (manifest) verifySha('paper-trades', paperTradesPath)

const tradeMeta = new Map<string, FrozenTradeMeta>()
const exitReasons = new Map<string, string>()
for (const pt of paperTrades) {
  tradeMeta.set(pt.setupId, {
    setupId: pt.setupId, symbol: pt.symbol, setupType: pt.setupType,
    intendedEntry: pt.intendedEntry, initialStop: pt.initialStop, plannedRisk: pt.plannedRisk, qty: pt.qty,
  })
  for (const ex of pt.exits ?? []) if (ex.orderId) exitReasons.set(ex.orderId, ex.reason)
}

// Broker ledger (truth)
const { data: ledger, sha: ledgerFileSha } = readJson<BrokerLedger>(ledgerPath)
if (ledger.contentSha256 && manifest) {
  // The ledger self-reports a contentSha256 over its own perTrade payload; surface the file sha too.
}
if (ledger.day !== DAY) warningsPre.push(`broker ledger day ${ledger.day} != requested ${DAY}`)

// Paper events → opening equity + startup gap provenance
const paperEventsPath = join(snapDir, 'paper-events.jsonl')
let openingBrokerEquity: number | null = null
let startupGapSeconds: number | null = null
if (existsSync(paperEventsPath)) {
  if (manifest) verifySha('paper-events', paperEventsPath)
  const lines = readFileSync(paperEventsPath, 'utf8').split('\n').filter(Boolean)
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  const init = parsed.find((e) => e.event === 'init')
  if (init && typeof init.equity === 'number') openingBrokerEquity = init.equity
  // Startup gap (descriptive): startup_reconciliation → init, if both present. Provenance-limited.
  const recon = parsed.find((e) => e.event === 'startup_reconciliation')
  if (recon && init && typeof recon.ts === 'string' && typeof init.ts === 'string') {
    startupGapSeconds = Math.round((Date.parse(init.ts) - Date.parse(recon.ts)) / 1000)
  }
} else if (!ALLOW_NON_FROZEN) {
  warningsPre.push('paper-events.jsonl absent — opening equity UNKNOWN')
}

// caps (maxConcurrentPositions) from the frozen shadow-output — prefer frozen evidence
// over importing a live executor constant, so the axis stays purely frozen-sourced.
let maxConcurrentPositions = 3
const shadowPath = join(snapDir, 'shadow-output.json')
if (existsSync(shadowPath)) {
  const shadow = readJson<{ caps?: { maxConcurrentPositions?: number } }>(shadowPath).data
  if (typeof shadow.caps?.maxConcurrentPositions === 'number') maxConcurrentPositions = shadow.caps.maxConcurrentPositions
} else {
  warningsPre.push('shadow-output.json absent — maxConcurrentPositions defaulted to 3 for availableSlots')
}

// ── Tapes (1-minute) ──────────────────────────────────────────────────────────

const symbols = [...new Set(ledger.perTrade.map((t) => t.symbol))]
const tapes = new Map<string, Candle[]>()
const tapeProvenance: Record<string, unknown> = {}
for (const sym of symbols) {
  const p = join(cacheDir, `m1_${sym}_${DAY}.json`)
  if (!existsSync(p)) { tapeProvenance[sym] = { source: 'missing', bars: 0 }; continue }
  const raw = readFileSync(p, 'utf8')
  const parsed = JSON.parse(raw) as unknown[]
  let bars: Candle[]
  if (Array.isArray(parsed) && parsed.length > 0 && typeof (parsed[0] as { date?: unknown }).date === 'string') {
    bars = normalizeFmpRows(parsed as RawFmpRow[]) // raw FMP cache (ET wall-time strings)
  } else {
    bars = (parsed as Candle[]).slice().sort((a, b) => a.time - b.time) // already-normalized cache
  }
  tapes.set(sym, bars)
  tapeProvenance[sym] = { source: 'cache', bars: bars.length, sha256: sha256(raw).slice(0, 16) }
}

// ── EQ observer data quality (stream the frozen 20MB tape) ────────────────────

let eqSummary: EqQualitySummary | null = null
const eqPath = join(snapDir, 'execution-quality.jsonl')
if (existsSync(eqPath)) {
  if (manifest) verifySha('execution-quality', eqPath)
  const agg: EqQualitySummary = { rows: 0, quoteFreshRows: 0, tradeFreshRows: 0, droppedRows: 0, errorRows: 0 }
  const text = readFileSync(eqPath, 'utf8')
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const line = text.slice(start, i).trim()
      start = i + 1
      if (!line) continue
      let e: Record<string, unknown>
      try { e = JSON.parse(line) } catch { continue }
      if (e.kind !== 'observation') continue
      agg.rows++
      if (e.quoteFresh === true) agg.quoteFreshRows++
      if (e.tradeFresh === true) agg.tradeFreshRows++
      if (e.observationDropped === true) agg.droppedRows++
      if (e.quoteStatus !== 'ok' || e.tradeStatus !== 'ok') agg.errorRows++
    }
  }
  eqSummary = agg
} else {
  warningsPre.push('execution-quality.jsonl absent — EQ data-quality band UNKNOWN')
}

// ── Process metrics (descriptive; existing classification rules remain authoritative) ──

const refTs = ledger.perTrade[0]?.entryFills[0]?.filledAt ?? Date.parse(`${DAY}T12:00:00-04:00`)
const closeMs = etMinuteTimestamp(refTs, SESSION_CLOSE_ET_MINUTE)
let marketCloseToFreezeMinutes: number | null = null
let eodFreezeStatus: ProcessMetrics['eodFreezeStatus'] = 'UNKNOWN'
if (manifest?.frozenAtUtc) {
  marketCloseToFreezeMinutes = Math.round((Date.parse(manifest.frozenAtUtc) - closeMs) / 60000)
  eodFreezeStatus = marketCloseToFreezeMinutes < 60 ? 'ON_TIME' : 'LATE'
}
const processMetrics: ProcessMetrics = { eodFreezeStatus, marketCloseToFreezeMinutes, startupGapSeconds }

// ── Provenance ────────────────────────────────────────────────────────────────

let producerHead: string | null = null
try { producerHead = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim() } catch { /* detached / no git */ }

const input: EquityPathInput = {
  sessionDate: DAY,
  ledger,
  tradeMeta,
  tapes,
  exitReasons,
  config: { sessionCloseEtMinute: SESSION_CLOSE_ET_MINUTE, maxConcurrentPositions, openingBrokerEquity },
  eqSummary,
  processMetrics,
  provenance: {
    producerHead,
    nonFrozenInput: ALLOW_NON_FROZEN && !existsSync(manifestPath),
    input: {
      snapshotDir: snapDir,
      frozenAtUtc: manifest?.frozenAtUtc ?? null,
      producingStrategyHead: manifest?.producingStrategyHead ?? null,
      evaluatorSha: manifest?.evaluatorSha ?? null,
      paperTradesSha256: paperTradesSha,
    },
    brokerLedger: {
      path: ledgerPath,
      source: ledger.source,
      retrievalComplete: ledger.retrievalComplete,
      contentSha256: ledger.contentSha256 ?? null,
      fileSha256: ledgerFileSha,
    },
    tape: tapeProvenance,
  },
}

const report = buildEquityPath(input)
report.warnings = [...warningsPre, ...report.warnings]

// ── Write machine-readable artifact (gitignored research cache) ───────────────

const outDir = join(cacheDir, 'equity-path')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, `equity-path-${DAY}.json`)
writeFileSync(outPath, JSON.stringify(report, null, 2))

// ── Human-readable nightly summary ────────────────────────────────────────────

const d = (v: number | null, dp = 2) => (v == null ? 'UNKNOWN' : v.toFixed(dp))
const R = (v: number | null) => (v == null ? 'UNKNOWN' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)
const ps = report.portfolioSummary
const ga = report.givebackAttribution

console.log(`\n═══ INTRADAY EQUITY PATH — ${DAY} ${report.nonFrozenInput ? '⚠ NON_FROZEN_INPUT' : '(frozen)'} ═══`)
console.log(`producerHead ${report.producerHead?.slice(0, 12) ?? 'n/a'} · strategyHead ${(manifest?.producingStrategyHead ?? 'n/a').slice(0, 12)} · schema ${report.schemaVersion}`)

console.log(`\n── A. SESSION SUMMARY ──`)
console.log(`  axis ${report.coverage.axisStartEtTime ?? '—'} → ${report.coverage.axisEndEtTime} ET  (${report.coverage.minutes} min, ${report.coverage.minutesUnknownUnrealized} UNKNOWN-unreal)`)
console.log(`  openingBrokerEquity ${d(ps.openingBrokerEquity)} · trades ${report.tradeMetrics.length} · tapes ${symbols.length - report.coverage.tapeSymbolsMissing.length}/${symbols.length} present`)
console.log(`  everyTradeHasValidRisk ${report.coverage.everyTradeHasValidRisk} · ledgerResidualOpenQty ${report.coverage.ledgerResidualOpenQty} · ledgerComplete ${report.coverage.brokerLedgerComplete}`)

console.log(`\n── B. PEAK-TO-CLOSE ──`)
console.log(`  peakBasis ${ps.peakBasis} — max on the 1-minute close-mark replay; NOT the true intraminute maximum`)
console.log(`  everPositive ${ps.everPositive}`)
console.log(`  PEAK total  ${d(ps.peakTotalDollarPnl)}  ${R(ps.peakTotalR)}  @ ${ps.peakEtTime ?? '—'}  (realized ${d(ps.realizedDollarAtPeak)} / unreal ${d(ps.unrealizedDollarAtPeak)} · open ${ps.openPositionsAtPeak ?? '—'} · slots ${ps.availableSlotsAtPeak ?? '—'})`)
console.log(`  FINAL broker ${d(ps.finalBrokerDollarPnl)}  ${R(ps.finalBrokerR)}`)
console.log(`  GIVEBACK    ${d(ps.peakToCloseGivebackDollar)}  ${R(ps.peakToCloseGivebackR)}  (${ps.givebackPctOfPeak == null ? 'UNKNOWN' : (ps.givebackPctOfPeak * 100).toFixed(0) + '% of peak'})`)

console.log(`\n── C. GIVEBACK ATTRIBUTION ──`)
console.log(`  CLASSIFICATION: ${ga.classification}   (bands: meaningful≥${ga.bands.minMeaningfulR}R, dominance≥${(ga.bands.dominanceFraction * 100).toFixed(0)}%)`)
console.log(`  pre-peak open-trade giveback  ${d(ga.prePeakOpenTradeGiveback)}  (${ga.prePeakOpenTradeCount} trades)`)
console.log(`  post-peak new-trade giveback  ${d(ga.postPeakNewTradeGiveback)}  (${ga.postPeakNewTradeCount} trades, P&L ${d(ga.postPeakNewTradePnl)})`)
console.log(`  other/unknown                 ${d(ga.otherOrUnknownContribution)}`)

console.log(`\n── D. TRADE-LEVEL MFE-BEFORE-EXIT ──`)
console.log(`  ${'TKR'.padEnd(6)}${'setup'.padEnd(20)}${'entry'.padEnd(7)}${'exit'.padEnd(7)}${'brokerR'.padStart(9)}${'MFE_R'.padStart(8)}${'MFE@'.padStart(7)}${'green'.padStart(7)}${'gaveBk'.padStart(8)}`)
for (const t of report.tradeMetrics) {
  const gb = t.mfeToExitGivebackR
  console.log(
    `  ${t.ticker.padEnd(6)}${(t.setupType ?? '').slice(0, 19).padEnd(20)}${(t.entryEtTime ?? '—').padEnd(7)}${(t.terminalExitEtTime ?? '—').padEnd(7)}` +
    `${(t.brokerRealizedR == null ? '—' : t.brokerRealizedR.toFixed(3)).padStart(9)}${(t.maxUnrealizedRBeforeExit == null ? '—' : t.maxUnrealizedRBeforeExit.toFixed(3)).padStart(8)}` +
    `${(t.timeOfMFEEt ?? '—').padStart(7)}${(t.didTradeBecomeGreen == null ? (t.isLoser ? '?' : 'n/a') : t.didTradeBecomeGreen ? 'YES' : 'no').padStart(7)}${(gb == null ? '—' : gb.toFixed(2) + 'R').padStart(8)}`,
  )
}

console.log(`\n── E. EVENT TIMELINE (${report.events.length}) ──`)
for (const e of report.events) {
  console.log(
    `  ${e.etTime}  ${e.eventType.padEnd(13)} ${e.ticker.padEnd(6)} q${(e.qtyDelta > 0 ? '+' : '') + e.qtyDelta}`.padEnd(48) +
    `@${e.price}  tot ${e.totalPnlAfterEvent == null ? 'UNK' : e.totalPnlAfterEvent.toFixed(0)}  ${e.portfolioRAfterEvent == null ? 'UNK' : e.portfolioRAfterEvent.toFixed(2) + 'R'}  open ${e.openPositions}/${maxConcurrentPositions}`,
  )
}

console.log(`\n── F. DATA QUALITY / PROCESS ──`)
if (report.dataQuality.eq) {
  const eq = report.dataQuality.eq
  console.log(`  EQ band ${eq.band}  rows ${eq.rows}  quoteFresh ${eq.quoteFreshRate == null ? '—' : (eq.quoteFreshRate * 100).toFixed(1) + '%'}  tradeFresh ${eq.tradeFreshRate == null ? '—' : (eq.tradeFreshRate * 100).toFixed(1) + '%'}  dropped ${eq.droppedRows}  err ${eq.errorRows}`)
} else console.log('  EQ band UNKNOWN (no observer tape)')
const mcf = processMetrics.marketCloseToFreezeMinutes
const mcfStr = mcf == null ? 'UNKNOWN' : `${mcf} min (${Math.floor(mcf / 60)}h ${mcf % 60}m)`
console.log(`  eodFreezeStatus ${processMetrics.eodFreezeStatus}  marketCloseToFreeze ${mcfStr}  startupGap ${processMetrics.startupGapSeconds == null ? 'UNKNOWN' : processMetrics.startupGapSeconds + ' s'}`)

if (report.warnings.length) {
  console.log(`\n── WARNINGS (${report.warnings.length}) ──`)
  for (const w of report.warnings) console.log(`  ⚠ ${w}`)
}
if (report.unknowns.length) {
  console.log(`\n── UNKNOWNS (${report.unknowns.length}) ──`)
  for (const u of report.unknowns) console.log(`  ? ${u}`)
}

console.log(`\n  → artifact: ${outPath}\n`)
