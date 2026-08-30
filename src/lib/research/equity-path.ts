/**
 * Intraday portfolio equity-path engine — READ-ONLY research/review reconstruction.
 *
 * ─ WHAT THIS IS ──────────────────────────────────────────────────────────────
 * A pure, deterministic reconstruction of the intraday path of a session's
 * portfolio P&L and R, built from THREE frozen inputs:
 *   1. exact BROKER FILLS (the broker-ledger research artifact) — execution truth,
 *   2. 1-minute PRICE TAPES (FMP m1 cache) — the mark for open positions,
 *   3. frozen PAPER-TRADE metadata (intendedEntry / initialStop / plannedRisk /
 *      setupType) — solely for ORIGINAL-RISK normalization and labels.
 *
 * It answers review questions ONLY: when was the book most profitable, what was
 * peak realized+unrealized P&L and peak R, what was given back to the close, and
 * whether the giveback came from open winners reversing or new post-peak losers.
 *
 * ─ WHAT THIS IS NOT ──────────────────────────────────────────────────────────
 * It has NO order authority. It imports NOTHING from the executor/admission/stop
 * pipeline and NOTHING production is allowed to import it. It never reads mutable
 * live state; the thin CLI (scripts/session-equity-path.ts) supplies frozen bytes
 * and fails closed when they are absent. Nothing here feeds a trading decision.
 *
 * ─ TWO LEDGERS KEPT SEPARATE (the non-negotiable) ────────────────────────────
 * Local realized accounting is KNOWN-DEFECTIVE on fragmented fills (it under-books
 * P&L; see PaperTrade reconciliation notes). This engine therefore reconstructs
 * economics EXCLUSIVELY from broker fills via average-cost replay, and never reads
 * PaperTrade.realizedPnl. Frozen paper-trade metadata is used only for the
 * (immutable) original-risk denominator and display labels.
 *
 * ─ R CONVENTION (reused, not reinvented) ─────────────────────────────────────
 * Portfolio R is the SUM of per-trade R, each trade normalized by its own ORIGINAL
 * planned dollar risk `plannedRisk = qty × (intendedEntry − initialStop)` — the
 * exact denominator the broker-ledger's `brokerR` already uses (verified equal to
 * the cent on the 2026-08-28 ledger) and the sum-of-R the shadow harness reports.
 * A trade whose original risk is not a positive finite number contributes UNKNOWN:
 * every R field at a minute where such a trade is active is null, never guessed.
 *
 * ─ NON-LOOKAHEAD / MARK CONVENTION ───────────────────────────────────────────
 * The mark for an open position at instant `t` is the CLOSE of the most recent
 * 1-minute bar whose OPEN time ≤ t (last observed price ≤ t) — the same
 * last-observed-close convention phantom-book uses for its flatten mark. No
 * interpolation, no future bar. If no bar exists at/before t for an OPEN position,
 * that minute's unrealized/total is UNKNOWN (null) and the interval is recorded.
 */
import type { Candle } from '@/types'

const round2 = (v: number) => Math.round(v * 100) / 100
const round4 = (v: number) => Math.round(v * 10000) / 10000

// ── Input schemas (mirrors of the frozen artifacts) ──────────────────────────

/** One broker-side fill, oldest-first within a trade. Mirrors the broker-ledger artifact. */
export interface LedgerFill {
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  filledAt: number            // ms epoch — broker truth for WHEN
  orderId: string | null
  clientOrderId?: string | null
}

/** One reconciled trade in the broker-truth ledger (alpaca activities FILL replay). */
export interface LedgerTrade {
  tradeId: string
  setupId: string
  symbol: string
  entryFills: LedgerFill[]
  exitFills: LedgerFill[]
  entryQty: number
  exitQty: number
  entryVwap: number
  exitVwap: number
  brokerPnl: number
  brokerR: number | null
  residualQty: number
  flags: string[]
}

export interface BrokerLedger {
  day: string
  source: string
  retrievalComplete: boolean
  perTrade: LedgerTrade[]
  contentSha256?: string
  generatedAtUtc?: string
}

/**
 * The immutable slice of a frozen PaperTrade this engine may read: original geometry
 * for the risk denominator and labels ONLY. Never realized P&L (defective locally).
 */
export interface FrozenTradeMeta {
  setupId: string
  symbol: string
  setupType: string
  intendedEntry: number
  initialStop: number
  /** qty × (intendedEntry − initialStop) — the canonical original dollar risk. */
  plannedRisk: number
  qty: number
}

/** Local exit-leg reason, joined by broker orderId to classify a fill's event type. */
export interface ExitReasonHint {
  orderId: string | null
  reason: string
}

/** Optional pre-aggregated EQ-observer data-quality counts (script streams the 20MB tape). */
export interface EqQualitySummary {
  rows: number
  quoteFreshRows: number
  tradeFreshRows: number
  droppedRows: number
  /** rows whose quoteStatus or tradeStatus was not 'ok' (error/aborted/stale-status). */
  errorRows: number
}

/** Provenance passed straight through to the report; the engine computes nothing here. */
export interface EquityPathProvenance {
  producerHead: string | null
  input: Record<string, unknown>
  brokerLedger: Record<string, unknown>
  tape: Record<string, unknown>
  /** true + a prominent warning when a non-frozen override was used for development. */
  nonFrozenInput?: boolean
}

/** Descriptive review-only EOD process metrics (computed by the script from provenance). */
export interface ProcessMetrics {
  eodFreezeStatus: 'ON_TIME' | 'LATE' | 'FAILED' | 'UNKNOWN'
  marketCloseToFreezeMinutes: number | null
  startupGapSeconds: number | null
}

export interface EquityPathInput {
  sessionDate: string                       // ET trading day, YYYY-MM-DD
  ledger: BrokerLedger
  /** by setupId — original-risk + labels. A ledger trade with no meta ⇒ risk UNKNOWN. */
  tradeMeta: Map<string, FrozenTradeMeta>
  /** by symbol — normalized 1-minute Candle[] (unix-sec bar OPEN times). */
  tapes: Map<string, Candle[]>
  /** by broker orderId — local exit reason, for event-type classification only. */
  exitReasons?: Map<string, string>
  config: {
    /** 16:00 ET, in minutes-of-day (960). End of the reconstruction axis. */
    sessionCloseEtMinute: number
    /** Concurrency cap for availableSlots (from the frozen shadow-output caps). */
    maxConcurrentPositions: number
    openingBrokerEquity: number | null
  }
  eqSummary?: EqQualitySummary | null
  processMetrics?: ProcessMetrics | null
  provenance: EquityPathProvenance
}

// ── Output schema ─────────────────────────────────────────────────────────────

export const EQUITY_PATH_SCHEMA_VERSION = 'equity-path/v1'

/** One point on the deterministic per-minute axis. null ⇒ UNKNOWN (never guessed). */
export interface PathSample {
  timestamp: number
  etTime: string
  realizedDollarPnl: number
  unrealizedDollarPnl: number | null
  totalDollarPnl: number | null
  realizedR: number | null
  unrealizedR: number | null
  totalR: number | null
  openPositions: number
  availableSlots: number
}

export type GivebackClass =
  | 'NO_MEANINGFUL_GIVEBACK'
  | 'OPEN_WINNER_REVERSAL'
  | 'POST_PEAK_NEW_LOSSES'
  | 'MIXED_GIVEBACK'
  | 'UNKNOWN'

export interface PortfolioSummary {
  openingBrokerEquity: number | null
  everPositive: boolean
  /**
   * PEAK SEMANTICS — read this before quoting a peak.
   * `peakBasis` is always 'minute_close_replay'. The peak is the MAXIMUM VALUE OBSERVED
   * ON THE DETERMINISTIC 1-MINUTE CLOSE-MARK REPLAY (open positions marked at the last
   * observed 1-minute bar CLOSE ≤ t). It is NOT the true intraminute portfolio maximum:
   * a within-minute swing between bar close samples is unobservable at this resolution
   * and is deliberately never reconstructed. Treat `peakTotal*`/`peakTimestamp` as
   * "best point seen on the minute-close path", not as an equity high-water mark.
   */
  peakBasis: 'minute_close_replay'
  peakTotalDollarPnl: number | null
  peakTotalR: number | null
  peakTimestamp: number | null
  peakEtTime: string | null
  realizedDollarAtPeak: number | null
  unrealizedDollarAtPeak: number | null
  realizedRAtPeak: number | null
  unrealizedRAtPeak: number | null
  openPositionsAtPeak: number | null
  availableSlotsAtPeak: number | null
  finalBrokerDollarPnl: number | null
  finalBrokerR: number | null
  peakToCloseGivebackDollar: number | null
  peakToCloseGivebackR: number | null
  givebackPctOfPeak: number | null
}

/**
 * Peak-to-close giveback decomposed by trade group, relative to the PORTFOLIO PEAK
 * INSTANT (`peakTimestamp`, minute-close basis). BY CONSTRUCTION the three components
 * sum to `totalGivebackDollar` (= peakTotalDollar − finalBrokerDollar) to within
 * rounding, and `otherOrUnknownContribution` absorbs the rounding residual.
 *
 *   prePeakOpenTradeGiveback  — Σ over trades OPEN at the portfolio peak (entered ≤ peak
 *     AND holding shares at the peak minute) of
 *       (value_at_PORTFOLIO_peak_instant  −  final_broker_contribution).
 *     value_at_peak = that trade's realized-so-far + unrealized-at-peak, the unrealized
 *     marked at the peak minute's close. This is the trade's value AT THE PORTFOLIO PEAK
 *     — NOT its own individual MFE, and NOT its value at its own trade-level peak.
 *   postPeakNewTradeGiveback  — Σ over trades ENTERED AFTER the peak of
 *       (0  −  final_broker_contribution)   (their value at the peak instant is 0).
 *   otherOrUnknownContribution — totalGiveback − the two above. Trades fully closed
 *     before the peak contribute 0 (equal value at peak and close); this field is
 *     therefore just the rounding residual unless an input was UNKNOWN.
 */
export interface GivebackAttribution {
  classification: GivebackClass
  totalGivebackDollar: number | null
  prePeakOpenTradeGiveback: number | null
  postPeakNewTradeGiveback: number | null
  otherOrUnknownContribution: number | null
  prePeakOpenTradeCount: number
  postPeakNewTradeCount: number
  postPeakNewTradePnl: number | null
  /** The transparent, review-only bands used — documented, never a strategy rule. */
  bands: { minMeaningfulR: number; dominanceFraction: number }
}

export interface TradeMetric {
  ticker: string
  setupId: string
  setupType: string | null
  entryTime: number | null
  entryEtTime: string | null
  terminalExitTime: number | null
  terminalExitEtTime: string | null
  brokerRealizedPnl: number
  brokerRealizedR: number | null
  originalDollarRisk: number | null
  maxUnrealizedDollarBeforeExit: number | null
  maxUnrealizedRBeforeExit: number | null
  timeOfMFE: number | null
  timeOfMFEEt: string | null
  minUnrealizedDollarBeforeExit: number | null
  minUnrealizedRBeforeExit: number | null
  timeOfMAE: number | null
  timeOfMAEEt: string | null
  // Loser-focused:
  isLoser: boolean
  didTradeBecomeGreen: boolean | null
  maxGreenRBeforeStop: number | null
  minutesFromMFEToExit: number | null
  gaveBackMoreThan0_5R: boolean | null
  gaveBackMoreThan1R: boolean | null
  gaveBackMoreThan2R: boolean | null
  // Winner-focused:
  captureEfficiency: number | null
  mfeToExitGivebackR: number | null
  enteredAfterPeak: boolean | null
  openAtPeak: boolean | null
}

export type EventType =
  | 'ENTRY_FILL' | 'PARTIAL_ENTRY'
  | 'T1_EXIT' | 'PARTIAL_EXIT' | 'STOP_EXIT' | 'FINAL_EXIT'
  | 'EOD_FLATTEN' | 'OTHER_FILL'

export interface TimelineEvent {
  timestamp: number
  etTime: string
  eventType: EventType
  reason: string | null
  ticker: string
  setupId: string
  qtyDelta: number
  price: number
  realizedPnlAfterEvent: number
  unrealizedPnlAfterEvent: number | null
  totalPnlAfterEvent: number | null
  portfolioRAfterEvent: number | null
  openPositions: number
  availableSlots: number
}

export interface Coverage {
  axisStartTimestamp: number | null
  axisStartEtTime: string | null
  axisEndTimestamp: number
  axisEndEtTime: string
  minutes: number
  minutesUnknownUnrealized: number
  unknownIntervals: Array<{ startEt: string; endEt: string; minutes: number }>
  tapeSymbolsMissing: string[]
  everyTradeHasValidRisk: boolean
  ledgerResidualOpenQty: number
  brokerLedgerComplete: boolean
}

export interface EquityPathReport {
  schemaVersion: string
  sessionDate: string
  producerHead: string | null
  inputProvenance: Record<string, unknown>
  brokerLedgerProvenance: Record<string, unknown>
  tapeProvenance: Record<string, unknown>
  nonFrozenInput: boolean
  coverage: Coverage
  portfolioSummary: PortfolioSummary
  givebackAttribution: GivebackAttribution
  tradeMetrics: TradeMetric[]
  events: TimelineEvent[]
  path: PathSample[]
  dataQuality: {
    eq: (EqQualitySummary & { quoteFreshRate: number | null; tradeFreshRate: number | null; band: 'GOOD' | 'DEGRADED' | 'POOR' | 'UNKNOWN' }) | null
    bandsDoc: string
  }
  processMetrics: ProcessMetrics
  warnings: string[]
  unknowns: string[]
}

// ── Review-only descriptive bands (documented; NOT strategy truth) ────────────

/** Giveback below this |R| is descriptively "not meaningful". Review-only band. */
export const GIVEBACK_MIN_R = 0.25
/** One group must own ≥ this share of the giveback to be called dominant. Review-only band. */
export const GIVEBACK_DOMINANCE_FRACTION = 0.7
const EPS = 1e-6

// ── ET helpers (pure) ─────────────────────────────────────────────────────────

const ET_HHMM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
})
/** "HH:MM" ET wall-clock for a ms instant. '24:00' from the formatter normalizes to '00:00'. */
export function etHHMMStr(ms: number): string {
  const s = ET_HHMM.format(ms)
  return s === '24:00' ? '00:00' : s
}

// ── Per-trade broker-fill replay (average cost) ──────────────────────────────

interface Fill { ts: number; side: 'buy' | 'sell'; qty: number; price: number; orderId: string | null }

interface TradeReplay {
  setupId: string
  symbol: string
  setupType: string | null
  fills: Fill[]
  firstEntryTs: number | null
  terminalExitTs: number | null
  originalDollarRisk: number | null   // null ⇒ invalid/unknown risk
  brokerPnl: number
  brokerR: number | null
  residualQty: number
  tape: Candle[]                       // sorted ascending by time
}

/** Position (qty, average cost, realized $) after every fill with filledAt ≤ ts. */
function positionAt(t: TradeReplay, ts: number): { qty: number; avgCost: number; realized: number } {
  let qty = 0, cost = 0, realized = 0
  for (const f of t.fills) {
    if (f.ts > ts) break
    if (f.side === 'buy') {
      cost = qty + f.qty > 0 ? (cost * qty + f.price * f.qty) / (qty + f.qty) : 0
      qty += f.qty
    } else {
      realized += (f.price - cost) * f.qty
      qty -= f.qty
    }
  }
  return { qty, avgCost: cost, realized }
}

/** Max share count held at any point up to and including barCloseTs (for intrabar excursion). */
function peakQtyByBarClose(t: TradeReplay, barCloseTs: number): number {
  let qty = 0, peak = 0
  for (const f of t.fills) {
    if (f.ts > barCloseTs) break
    qty += f.side === 'buy' ? f.qty : -f.qty
    if (qty > peak) peak = qty
  }
  return peak
}

/** Last observed close ≤ ts (non-lookahead mark). null when no bar exists at/before ts. */
function markAt(tape: Candle[], ts: number): number | null {
  let mark: number | null = null
  for (const b of tape) {
    if (b.time * 1000 <= ts) mark = b.close
    else break
  }
  return mark
}

function buildReplays(input: EquityPathInput): TradeReplay[] {
  return input.ledger.perTrade.map((lt) => {
    const meta = input.tradeMeta.get(lt.setupId)
    const risk = meta && Number.isFinite(meta.plannedRisk) && meta.plannedRisk > 0 ? meta.plannedRisk : null
    const fills: Fill[] = [
      ...lt.entryFills.map((f) => ({ ts: f.filledAt, side: 'buy' as const, qty: f.qty, price: f.price, orderId: f.orderId })),
      ...lt.exitFills.map((f) => ({ ts: f.filledAt, side: 'sell' as const, qty: f.qty, price: f.price, orderId: f.orderId })),
    ].sort((a, b) => a.ts - b.ts || (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1))
    const entryTimes = lt.entryFills.map((f) => f.filledAt)
    const exitTimes = lt.exitFills.map((f) => f.filledAt)
    const tape = (input.tapes.get(lt.symbol) ?? []).slice().sort((a, b) => a.time - b.time)
    return {
      setupId: lt.setupId,
      symbol: lt.symbol,
      setupType: input.tradeMeta.get(lt.setupId)?.setupType ?? null,
      fills,
      firstEntryTs: entryTimes.length ? Math.min(...entryTimes) : null,
      terminalExitTs: exitTimes.length ? Math.max(...exitTimes) : null,
      originalDollarRisk: risk,
      brokerPnl: lt.brokerPnl,
      brokerR: lt.brokerR,
      residualQty: lt.residualQty,
      tape,
    }
  })
}

// ── Portfolio state at an instant ────────────────────────────────────────────

interface PortfolioState {
  realizedDollar: number
  unrealizedDollar: number | null
  totalDollar: number | null
  realizedR: number | null
  unrealizedR: number | null
  totalR: number | null
  openPositions: number
}

/**
 * Aggregate portfolio state at `ts`. Realized $ is always defined (fills are truth).
 * Unrealized/total go UNKNOWN (null) if any OPEN position lacks a mark ≤ ts. R fields
 * go UNKNOWN if any trade active by `ts` has invalid original risk (fail closed).
 */
function stateAt(replays: TradeReplay[], ts: number): PortfolioState {
  let realizedDollar = 0
  let unrealizedDollar = 0
  let realizedR = 0
  let unrealizedR = 0
  let openPositions = 0
  let unrealUnknown = false
  let rUnknown = false

  for (const t of replays) {
    const active = t.firstEntryTs != null && t.firstEntryTs <= ts
    if (!active) continue
    const pos = positionAt(t, ts)
    realizedDollar += pos.realized
    const risk = t.originalDollarRisk
    if (risk == null) rUnknown = true
    else realizedR += pos.realized / risk

    if (pos.qty > EPS) {
      openPositions++
      const mark = markAt(t.tape, ts)
      if (mark == null) {
        unrealUnknown = true
      } else {
        const u = (mark - pos.avgCost) * pos.qty
        unrealizedDollar += u
        if (risk != null) unrealizedR += u / risk
      }
    }
  }

  const unreal = unrealUnknown ? null : round2(unrealizedDollar)
  return {
    realizedDollar: round2(realizedDollar),
    unrealizedDollar: unreal,
    totalDollar: unreal == null ? null : round2(realizedDollar + unrealizedDollar),
    realizedR: rUnknown ? null : round4(realizedR),
    unrealizedR: rUnknown || unrealUnknown ? null : round4(unrealizedR),
    totalR: rUnknown || unrealUnknown ? null : round4(realizedR + unrealizedR),
    openPositions,
  }
}

// ── Trade-level MFE / MAE before exit (bar granularity) ──────────────────────

interface Excursion {
  mfeDollar: number | null; mfeTs: number | null
  maeDollar: number | null; maeTs: number | null
}

/**
 * Favorable/adverse excursion over the holding window [firstEntry, terminalExit],
 * measured against the running average cost at each 1-minute bar. The share count
 * for a bar is the PEAK qty held through that bar's close (so a bar in which the
 * position was opened counts the full position against that bar's range) — a
 * transparent, documented intrabar convention, since sub-bar fill ordering is
 * unobservable. UNKNOWN (null) when the window has no covering bars and no fill.
 */
function excursion(t: TradeReplay): Excursion {
  if (t.firstEntryTs == null || t.terminalExitTs == null) return { mfeDollar: null, mfeTs: null, maeDollar: null, maeTs: null }
  const startMin = Math.floor(t.firstEntryTs / 60000) * 60000
  const endMs = t.terminalExitTs
  let mfe = -Infinity, mfeTs: number | null = null
  let mae = Infinity, maeTs: number | null = null
  for (const bar of t.tape) {
    const barOpen = bar.time * 1000
    if (barOpen < startMin) continue
    if (barOpen > endMs) break
    const barClose = barOpen + 60000
    const qty = peakQtyByBarClose(t, Math.min(barClose - 1, endMs))
    if (qty <= EPS) continue
    const avgCost = positionAt(t, Math.min(barClose - 1, endMs)).avgCost
    const hi = (bar.high - avgCost) * qty
    const lo = (bar.low - avgCost) * qty
    if (hi > mfe) { mfe = hi; mfeTs = barOpen }
    if (lo < mae) { mae = lo; maeTs = barOpen }
  }
  if (mfeTs == null) {
    // No covering bar (e.g. sub-minute round trip with a tape gap): fall back to the
    // realized round-trip on the fills themselves — never leave a filled trade blank.
    const entryPx = t.fills.find((f) => f.side === 'buy')?.price
    const qty = peakQtyByBarClose(t, endMs)
    if (entryPx != null && qty > EPS) {
      let best = -Infinity, worst = Infinity
      for (const f of t.fills) {
        const v = (f.price - entryPx) * qty
        if (v > best) best = v
        if (v < worst) worst = v
      }
      return { mfeDollar: round2(best), mfeTs: t.firstEntryTs, maeDollar: round2(worst), maeTs: t.firstEntryTs }
    }
    return { mfeDollar: null, mfeTs: null, maeDollar: null, maeTs: null }
  }
  return { mfeDollar: round2(mfe), mfeTs, maeDollar: round2(mae), maeTs }
}

// ── Giveback attribution ──────────────────────────────────────────────────────

export function classifyGiveback(
  totalGiveback: number | null,
  givebackR: number | null,
  prePeakOpenGiveback: number | null,
  postPeakNewGiveback: number | null,
  minMeaningfulR = GIVEBACK_MIN_R,
  dominance = GIVEBACK_DOMINANCE_FRACTION,
): GivebackClass {
  if (totalGiveback == null || givebackR == null || prePeakOpenGiveback == null || postPeakNewGiveback == null) return 'UNKNOWN'
  if (Math.abs(givebackR) < minMeaningfulR) return 'NO_MEANINGFUL_GIVEBACK'
  if (totalGiveback <= EPS) return 'NO_MEANINGFUL_GIVEBACK'
  const fPre = prePeakOpenGiveback / totalGiveback
  const fPost = postPeakNewGiveback / totalGiveback
  if (fPost >= dominance && fPre < 1 - dominance) return 'POST_PEAK_NEW_LOSSES'
  if (fPre >= dominance && fPost < 1 - dominance) return 'OPEN_WINNER_REVERSAL'
  return 'MIXED_GIVEBACK'
}

// ── EQ data-quality band (descriptive, review-only) ──────────────────────────

export const EQ_BANDS_DOC =
  'Review-only descriptive bands (NOT strategy thresholds): GOOD = quoteFresh≥0.90 AND ' +
  'tradeFresh≥0.90 AND 0 dropped AND 0 error/aborted rows; POOR = freshRate<0.50 OR any ' +
  'error/aborted rows; DEGRADED = anything between; UNKNOWN = no rows.'

export function eqBand(eq: EqQualitySummary | null | undefined): 'GOOD' | 'DEGRADED' | 'POOR' | 'UNKNOWN' {
  if (!eq || eq.rows === 0) return 'UNKNOWN'
  const qf = eq.quoteFreshRows / eq.rows
  const tf = eq.tradeFreshRows / eq.rows
  if (qf < 0.5 || tf < 0.5 || eq.errorRows > 0) return 'POOR'
  if (qf >= 0.9 && tf >= 0.9 && eq.droppedRows === 0 && eq.errorRows === 0) return 'GOOD'
  return 'DEGRADED'
}

// ── Event-type classification ─────────────────────────────────────────────────

function classifyExitEvent(reason: string | null, leavesResidual: boolean): EventType {
  const r = (reason ?? '').toLowerCase()
  if (r.includes('stop')) return 'STOP_EXIT'
  if (r === 't1' || r.includes('t1')) return 'T1_EXIT'
  if (r === 'time' || r.includes('flatten') || r.includes('eod')) return 'EOD_FLATTEN'
  if (r === 'external' || r === '') return 'OTHER_FILL'
  if (r === 't2' || r.includes('t2') || r.includes('final')) return 'FINAL_EXIT'
  return leavesResidual ? 'PARTIAL_EXIT' : 'FINAL_EXIT'
}

// ── Main engine ────────────────────────────────────────────────────────────────

export function buildEquityPath(input: EquityPathInput): EquityPathReport {
  const warnings: string[] = []
  const unknowns: string[] = []
  const replays = buildReplays(input)

  // Coverage: risk validity, missing tapes, ledger completeness.
  const everyTradeHasValidRisk = replays.every((t) => t.originalDollarRisk != null)
  if (!everyTradeHasValidRisk) {
    for (const t of replays) if (t.originalDollarRisk == null) unknowns.push(`invalid/absent original risk for ${t.setupId} — R contributions UNKNOWN`)
  }
  const tapeSymbolsMissing = [...new Set(replays.filter((t) => t.tape.length === 0).map((t) => t.symbol))]
  for (const s of tapeSymbolsMissing) warnings.push(`no 1-minute tape for ${s} — open-position marks UNKNOWN while it is held`)
  const ledgerResidualOpenQty = replays.reduce((s, t) => s + Math.max(0, t.residualQty), 0)
  if (ledgerResidualOpenQty > 0) warnings.push(`broker ledger reports ${ledgerResidualOpenQty} residual open shares at freeze — final marks include a tape close`)
  if (!input.ledger.retrievalComplete) warnings.push('broker ledger retrievalComplete=false — fills may be incomplete')
  if (input.provenance.nonFrozenInput) warnings.push('NON_FROZEN_INPUT — reconstruction used a mutable/live input override; results are NOT frozen-evidence grade')

  // ── Deterministic minute axis: first entry fill → 16:00 ET ──
  const entryTimes = replays.map((t) => t.firstEntryTs).filter((v): v is number => v != null)
  const axisStartTs = entryTimes.length ? Math.floor(Math.min(...entryTimes) / 60000) * 60000 : null
  // 16:00 ET: derive from the day's fills so we stay on the correct ET calendar day
  // without re-parsing strings. sessionCloseEtMinute anchors the wall-clock minute.
  const refTs = axisStartTs ?? (input.ledger.perTrade[0]?.entryFills[0]?.filledAt ?? Date.now())
  const axisEndTs = etMinuteTimestamp(refTs, input.config.sessionCloseEtMinute)

  const maxConc = input.config.maxConcurrentPositions
  const slotsOf = (open: number) => Math.max(0, maxConc - open)

  const path: PathSample[] = []
  let minutesUnknownUnrealized = 0
  const unknownIntervals: Array<{ startEt: string; endEt: string; minutes: number }> = []
  let curUnknownStart: number | null = null
  let lastMinuteTs = axisEndTs

  if (axisStartTs != null) {
    for (let m = axisStartTs; m <= axisEndTs; m += 60000) {
      const st = stateAt(replays, m)
      path.push({
        timestamp: m,
        etTime: etHHMMStr(m),
        realizedDollarPnl: st.realizedDollar,
        unrealizedDollarPnl: st.unrealizedDollar,
        totalDollarPnl: st.totalDollar,
        realizedR: st.realizedR,
        unrealizedR: st.unrealizedR,
        totalR: st.totalR,
        openPositions: st.openPositions,
        availableSlots: slotsOf(st.openPositions),
      })
      if (st.openPositions > 0 && st.unrealizedDollar == null) {
        minutesUnknownUnrealized++
        if (curUnknownStart == null) curUnknownStart = m
      } else if (curUnknownStart != null) {
        unknownIntervals.push({ startEt: etHHMMStr(curUnknownStart), endEt: etHHMMStr(m - 60000), minutes: Math.round((m - curUnknownStart) / 60000) })
        curUnknownStart = null
      }
      lastMinuteTs = m
    }
    if (curUnknownStart != null) {
      unknownIntervals.push({ startEt: etHHMMStr(curUnknownStart), endEt: etHHMMStr(lastMinuteTs), minutes: Math.round((lastMinuteTs - curUnknownStart) / 60000) + 1 })
    }
  } else {
    warnings.push('no broker entry fills in ledger — empty session path')
  }

  // ── Peak (max value OBSERVED on the deterministic minute-close replay) ──
  // This is peakBasis 'minute_close_replay': the best point on the per-minute path,
  // NOT the true intraminute portfolio maximum (within-minute swings between bar-close
  // marks are unobservable at this resolution and are never synthesized).
  let peak: PathSample | null = null
  for (const s of path) {
    if (s.totalDollarPnl == null) continue
    if (peak == null || s.totalDollarPnl > (peak.totalDollarPnl as number)) peak = s
  }
  const everPositive = peak != null && (peak.totalDollarPnl as number) > EPS

  // ── Final broker-truth state (at 16:00 ET) ──
  const finalState = axisStartTs != null ? stateAt(replays, axisEndTs) : null
  const finalDollar = finalState?.totalDollar ?? null
  const finalR = finalState?.totalR ?? null
  // Cross-check vs the ledger's own broker P&L/R (accounting-integrity guard).
  const ledgerSumPnl = round2(replays.reduce((s, t) => s + t.brokerPnl, 0))
  const ledgerSumR = replays.every((t) => t.brokerR != null) ? round4(replays.reduce((s, t) => s + (t.brokerR as number), 0)) : null
  if (finalDollar != null && ledgerResidualOpenQty === 0 && Math.abs(finalDollar - ledgerSumPnl) > 0.5) {
    warnings.push(`reconstructed final $${finalDollar} disagrees with ledger sum $${ledgerSumPnl} by >$0.50 — investigate fill replay`)
  }

  const giveDollar = peak != null && finalDollar != null ? round2((peak.totalDollarPnl as number) - finalDollar) : null
  const giveR = peak != null && peak.totalR != null && finalR != null ? round4((peak.totalR as number) - finalR) : null
  const givebackPct = peak != null && giveDollar != null && Math.abs(peak.totalDollarPnl as number) > EPS
    ? round4(giveDollar / Math.abs(peak.totalDollarPnl as number))
    : null

  const portfolioSummary: PortfolioSummary = {
    openingBrokerEquity: input.config.openingBrokerEquity,
    everPositive,
    peakBasis: 'minute_close_replay',
    peakTotalDollarPnl: peak?.totalDollarPnl ?? null,
    peakTotalR: peak?.totalR ?? null,
    peakTimestamp: peak?.timestamp ?? null,
    peakEtTime: peak?.etTime ?? null,
    realizedDollarAtPeak: peak?.realizedDollarPnl ?? null,
    unrealizedDollarAtPeak: peak?.unrealizedDollarPnl ?? null,
    realizedRAtPeak: peak?.realizedR ?? null,
    unrealizedRAtPeak: peak?.unrealizedR ?? null,
    openPositionsAtPeak: peak?.openPositions ?? null,
    availableSlotsAtPeak: peak != null ? slotsOf(peak.openPositions) : null,
    finalBrokerDollarPnl: finalDollar,
    finalBrokerR: finalR,
    peakToCloseGivebackDollar: giveDollar,
    peakToCloseGivebackR: giveR,
    givebackPctOfPeak: givebackPct,
  }

  // ── Giveback attribution (relative to the peak instant) ──
  const attribution = buildAttribution(replays, peak, finalDollar, giveDollar, giveR)

  // ── Trade-level metrics ──
  const tradeMetrics: TradeMetric[] = replays.map((t) => {
    const ex = excursion(t)
    const risk = t.originalDollarRisk
    const mfeR = ex.mfeDollar != null && risk != null ? round4(ex.mfeDollar / risk) : null
    const maeR = ex.maeDollar != null && risk != null ? round4(ex.maeDollar / risk) : null
    const brokerR = t.brokerR
    const isLoser = t.brokerPnl < -EPS
    const green = ex.mfeDollar != null ? ex.mfeDollar > EPS : null
    const givebackR = mfeR != null && brokerR != null ? round4(mfeR - brokerR) : null
    const openAtPeak = peak != null && t.firstEntryTs != null
      ? t.firstEntryTs <= peak.timestamp && positionAt(t, peak.timestamp).qty > EPS
      : null
    const enteredAfterPeak = peak != null && t.firstEntryTs != null ? t.firstEntryTs > peak.timestamp : null
    return {
      ticker: t.symbol,
      setupId: t.setupId,
      setupType: t.setupType,
      entryTime: t.firstEntryTs,
      entryEtTime: t.firstEntryTs != null ? etHHMMStr(t.firstEntryTs) : null,
      terminalExitTime: t.terminalExitTs,
      terminalExitEtTime: t.terminalExitTs != null ? etHHMMStr(t.terminalExitTs) : null,
      brokerRealizedPnl: round2(t.brokerPnl),
      brokerRealizedR: brokerR != null ? round4(brokerR) : null,
      originalDollarRisk: risk,
      maxUnrealizedDollarBeforeExit: ex.mfeDollar,
      maxUnrealizedRBeforeExit: mfeR,
      timeOfMFE: ex.mfeTs,
      timeOfMFEEt: ex.mfeTs != null ? etHHMMStr(ex.mfeTs) : null,
      minUnrealizedDollarBeforeExit: ex.maeDollar,
      minUnrealizedRBeforeExit: maeR,
      timeOfMAE: ex.maeTs,
      timeOfMAEEt: ex.maeTs != null ? etHHMMStr(ex.maeTs) : null,
      isLoser,
      didTradeBecomeGreen: isLoser ? green : null,
      maxGreenRBeforeStop: isLoser && mfeR != null ? round4(Math.max(0, mfeR)) : null,
      minutesFromMFEToExit: ex.mfeTs != null && t.terminalExitTs != null ? Math.round((t.terminalExitTs - ex.mfeTs) / 60000) : null,
      gaveBackMoreThan0_5R: isLoser && givebackR != null ? givebackR > 0.5 : null,
      gaveBackMoreThan1R: isLoser && givebackR != null ? givebackR > 1 : null,
      gaveBackMoreThan2R: isLoser && givebackR != null ? givebackR > 2 : null,
      captureEfficiency: mfeR != null && mfeR > EPS && brokerR != null ? round4(brokerR / mfeR) : null,
      mfeToExitGivebackR: givebackR,
      enteredAfterPeak,
      openAtPeak,
    }
  })

  // ── Event timeline (broker fills, portfolio state after each) ──
  const events = buildTimeline(replays, input.exitReasons, maxConc)

  // ── Data quality + process metrics ──
  const eqOut = input.eqSummary
    ? {
        ...input.eqSummary,
        quoteFreshRate: input.eqSummary.rows ? round4(input.eqSummary.quoteFreshRows / input.eqSummary.rows) : null,
        tradeFreshRate: input.eqSummary.rows ? round4(input.eqSummary.tradeFreshRows / input.eqSummary.rows) : null,
        band: eqBand(input.eqSummary),
      }
    : null

  const coverage: Coverage = {
    axisStartTimestamp: axisStartTs,
    axisStartEtTime: axisStartTs != null ? etHHMMStr(axisStartTs) : null,
    axisEndTimestamp: axisEndTs,
    axisEndEtTime: etHHMMStr(axisEndTs),
    minutes: path.length,
    minutesUnknownUnrealized,
    unknownIntervals,
    tapeSymbolsMissing,
    everyTradeHasValidRisk,
    ledgerResidualOpenQty,
    brokerLedgerComplete: input.ledger.retrievalComplete,
  }

  return {
    schemaVersion: EQUITY_PATH_SCHEMA_VERSION,
    sessionDate: input.sessionDate,
    producerHead: input.provenance.producerHead,
    inputProvenance: input.provenance.input,
    brokerLedgerProvenance: { ...input.provenance.brokerLedger, ledgerSumBrokerPnl: ledgerSumPnl, ledgerSumBrokerR: ledgerSumR },
    tapeProvenance: input.provenance.tape,
    nonFrozenInput: input.provenance.nonFrozenInput === true,
    coverage,
    portfolioSummary,
    givebackAttribution: attribution,
    tradeMetrics,
    events,
    path,
    dataQuality: { eq: eqOut, bandsDoc: EQ_BANDS_DOC },
    processMetrics: input.processMetrics ?? { eodFreezeStatus: 'UNKNOWN', marketCloseToFreezeMinutes: null, startupGapSeconds: null },
    warnings,
    unknowns,
  }
}

function buildAttribution(
  replays: TradeReplay[],
  peak: PathSample | null,
  finalDollar: number | null,
  giveDollar: number | null,
  giveR: number | null,
): GivebackAttribution {
  const bands = { minMeaningfulR: GIVEBACK_MIN_R, dominanceFraction: GIVEBACK_DOMINANCE_FRACTION }
  if (peak == null || finalDollar == null || giveDollar == null) {
    return {
      classification: 'UNKNOWN',
      totalGivebackDollar: giveDollar,
      prePeakOpenTradeGiveback: null,
      postPeakNewTradeGiveback: null,
      otherOrUnknownContribution: null,
      prePeakOpenTradeCount: 0,
      postPeakNewTradeCount: 0,
      postPeakNewTradePnl: null,
      bands,
    }
  }
  const peakTs = peak.timestamp
  let prePeakOpenGiveback = 0
  let postPeakNewGiveback = 0
  let postPeakNewPnl = 0
  let prePeakOpenCount = 0
  let postPeakNewCount = 0
  let attributionUnknown = false

  for (const t of replays) {
    const finalVal = t.brokerPnl // terminal broker truth (residual handled at portfolio level)
    if (t.firstEntryTs == null) continue
    if (t.firstEntryTs > peakTs) {
      postPeakNewCount++
      postPeakNewPnl += finalVal
      postPeakNewGiveback += 0 - finalVal
    } else {
      const pos = positionAt(t, peakTs)
      if (pos.qty > EPS) {
        prePeakOpenCount++
        const mark = markAt(t.tape, peakTs)
        if (mark == null) { attributionUnknown = true; continue }
        const valAtPeak = pos.realized + (mark - pos.avgCost) * pos.qty
        prePeakOpenGiveback += valAtPeak - finalVal
      }
      // else: fully realized before the peak — contributes equally to peak and close (0 giveback).
    }
  }

  if (attributionUnknown) {
    return {
      classification: 'UNKNOWN',
      totalGivebackDollar: round2(giveDollar),
      prePeakOpenTradeGiveback: null,
      postPeakNewTradeGiveback: null,
      otherOrUnknownContribution: null,
      prePeakOpenTradeCount: prePeakOpenCount,
      postPeakNewTradeCount: postPeakNewCount,
      postPeakNewTradePnl: round2(postPeakNewPnl),
      bands,
    }
  }

  const other = round2(giveDollar - prePeakOpenGiveback - postPeakNewGiveback)
  return {
    classification: classifyGiveback(giveDollar, giveR, prePeakOpenGiveback, postPeakNewGiveback),
    totalGivebackDollar: round2(giveDollar),
    prePeakOpenTradeGiveback: round2(prePeakOpenGiveback),
    postPeakNewTradeGiveback: round2(postPeakNewGiveback),
    otherOrUnknownContribution: other,
    prePeakOpenTradeCount: prePeakOpenCount,
    postPeakNewTradeCount: postPeakNewCount,
    postPeakNewTradePnl: round2(postPeakNewPnl),
    bands,
  }
}

function buildTimeline(
  replays: TradeReplay[],
  exitReasons: Map<string, string> | undefined,
  maxConc: number,
): TimelineEvent[] {
  interface Ev { ts: number; type: 'entry' | 'exit'; t: TradeReplay; fill: Fill; leavesResidual: boolean; reason: string | null }
  const raw: Ev[] = []
  for (const t of replays) {
    const entryCount = t.fills.filter((f) => f.side === 'buy').length
    for (const f of t.fills) {
      if (f.side === 'buy') {
        raw.push({ ts: f.ts, type: 'entry', t, fill: f, leavesResidual: false, reason: entryCount > 1 ? 'partial_entry' : 'entry' })
      } else {
        const reason = (f.orderId && exitReasons?.get(f.orderId)) ?? (f.orderId == null ? 'external' : null)
        raw.push({ ts: f.ts, type: 'exit', t, fill: f, leavesResidual: false, reason })
      }
    }
  }
  raw.sort((a, b) => a.ts - b.ts || (a.type === b.type ? 0 : a.type === 'entry' ? -1 : 1))

  // Second pass: compute leavesResidual per exit (residual qty for that trade after this fill).
  const soldByTrade = new Map<string, number>()
  const entryTotal = new Map<string, number>()
  for (const t of replays) entryTotal.set(t.setupId, t.fills.filter((f) => f.side === 'buy').reduce((s, f) => s + f.qty, 0))

  const out: TimelineEvent[] = []
  for (const ev of raw) {
    const st = stateAt(replays, ev.ts)
    let type: EventType
    if (ev.type === 'entry') {
      type = ev.reason === 'partial_entry' ? 'PARTIAL_ENTRY' : 'ENTRY_FILL'
    } else {
      const sold = (soldByTrade.get(ev.t.setupId) ?? 0) + ev.fill.qty
      soldByTrade.set(ev.t.setupId, sold)
      const leavesResidual = sold + EPS < (entryTotal.get(ev.t.setupId) ?? 0)
      type = classifyExitEvent(ev.reason, leavesResidual)
    }
    out.push({
      timestamp: ev.ts,
      etTime: etHHMMStr(ev.ts),
      eventType: type,
      reason: ev.reason,
      ticker: ev.t.symbol,
      setupId: ev.t.setupId,
      qtyDelta: ev.type === 'entry' ? ev.fill.qty : -ev.fill.qty,
      price: ev.fill.price,
      realizedPnlAfterEvent: st.realizedDollar,
      unrealizedPnlAfterEvent: st.unrealizedDollar,
      totalPnlAfterEvent: st.totalDollar,
      portfolioRAfterEvent: st.totalR,
      openPositions: st.openPositions,
      availableSlots: Math.max(0, maxConc - st.openPositions),
    })
  }
  return out
}

/**
 * The ms timestamp of ET wall-clock minute `etMinute` on the same ET calendar day as
 * `refTs`. Pure and DST-correct: it snaps `refTs` to ET midnight by subtracting its
 * own ET minute-of-day, then adds the target minute (both offsets measured through the
 * ET formatter, so no fixed UTC offset is assumed).
 */
export function etMinuteTimestamp(refTs: number, etMinute: number): number {
  const refMin = etMinutesOfDayLocal(refTs)
  const refMinuteFloor = Math.floor(refTs / 60000) * 60000
  return refMinuteFloor + (etMinute - refMin) * 60000
}

function etMinutesOfDayLocal(ms: number): number {
  const [h, m] = etHHMMStr(ms).split(':').map(Number)
  return h * 60 + m
}
