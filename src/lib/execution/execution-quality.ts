/**
 * Execution-quality timeline: persistence + honest latency derivation.
 *
 * Two record kinds share one append-only stream, discriminated by `kind`:
 *   • `observation` — a passive market witness reading (from ExecutionObserver)
 *   • `exit`        — the production exit lifecycle (decision → submit → ack → fill)
 * Correlated by `tradeId`, they let us reconstruct, per exit, WHEN the market was
 * first independently seen through the stop vs when production acted vs when the
 * fill landed — and attribute the price cost to each stage.
 *
 * DERIVATION HONESTY (the correction that motivated this build): the distance from
 * the intended stop to the first observed sub-stop price is NOT "breach→detection
 * latency". It is a SUM of (1) genuine market/liquidity gap through the stop,
 * (2) poll-cadence latency, and (3) feed staleness. This module keeps those
 * separate and returns `null` (unknown) for any component the available data
 * cannot support. It never invents a true-breach timestamp.
 */
import { readFileSync, appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { etDayKey } from './store'
import type { ExecutionQualityObservation } from './market-observer'

export interface ExecutionExitRecord {
  kind: 'exit'
  recordedAt: string
  tradeId: string
  setupId: string | null
  symbol: string
  session: string
  stopPrice: number
  exitType: string                 // 'stop' | 't1' | 't2' | 'time' | 'external' | ...
  executionPath: 'broker_stop' | 'polled' | 'unknown'
  // Lifecycle timestamps (ms epoch); any may be null when the path doesn't expose it.
  decisionTs: number | null        // production observed the trigger condition
  decisionPrice: number | null     // price production saw at decision (null for a broker-native stop fill)
  submitTs: number | null
  ackTs: number | null             // broker acknowledged the order
  fillTs: number | null
  fillPrice: number | null
  fillQty: number | null
  plannedR: number | null
  realizedR: number | null
}

export type ExecutionQualityRow =
  | ({ kind: 'observation' } & ExecutionQualityObservation)
  | ExecutionExitRecord

// ── Persistence (append-only, ET-day-scoped, mirrors the events log) ──────────

export function executionQualityFile(day = etDayKey()): string {
  return join(homedir(), `.companion-execution-quality-${day}.jsonl`)
}

export function appendExecutionQuality(row: ExecutionQualityRow, day = etDayKey()): void {
  try {
    appendFileSync(executionQualityFile(day), JSON.stringify(row) + '\n')
  } catch {
    /* instrumentation is best-effort — never let it disturb the trade loop */
  }
}

export function readExecutionQuality(day = etDayKey()): ExecutionQualityRow[] {
  const f = executionQualityFile(day)
  if (!existsSync(f)) return []
  const out: ExecutionQualityRow[] = []
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* skip a torn line */ }
  }
  return out
}

// ── Effective polling cadence (measured, not assumed) ─────────────────────────

export interface CadenceStats {
  tradeId: string
  samples: number
  minMs: number | null
  medianMs: number | null
  maxMs: number | null
}

/**
 * Actual observed cadence per trade, from the intervals the observer stamped.
 * This deliberately measures reality: the configured 3s is the REQUESTED cadence,
 * but a slow `/api/monitor` round-trip or event-loop pressure makes the EFFECTIVE
 * interval longer — and that difference is itself a latency source.
 */
export function effectivePollingCadence(rows: ExecutionQualityRow[]): CadenceStats[] {
  const byTrade = new Map<string, number[]>()
  for (const r of rows) {
    if (r.kind !== 'observation') continue
    if (r.effectivePollIntervalMs == null) continue
    const arr = byTrade.get(r.tradeId) ?? []
    arr.push(r.effectivePollIntervalMs)
    byTrade.set(r.tradeId, arr)
  }
  const median = (a: number[]) => {
    const s = a.slice().sort((x, y) => x - y)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  return [...byTrade.entries()].map(([tradeId, ms]) => ({
    tradeId,
    samples: ms.length,
    minMs: ms.length ? Math.min(...ms) : null,
    medianMs: ms.length ? median(ms) : null,
    maxMs: ms.length ? Math.max(...ms) : null,
  }))
}

// ── Latency attribution (null = unknown; never fabricated) ────────────────────

export interface LatencyAttribution {
  /** How far below the stop production's OWN price already sat at detection (%). Combined gap+cadence+staleness — NOT pure market gap. */
  productionGapAtDetectionPct: number | null
  /** Disagreement between the observing feed and production at the correlated moment (%). A proxy for feed divergence/staleness. */
  feedDivergencePct: number | null
  /** Age of the production quote when production acted (ms), if the monitor source timestamp is exposed. Else unknown. */
  monitorQuoteAgeMs: number | null
  // BID and TRADE breach evidence kept SEPARATE — never collapsed. Both are
  // feed-limited LOWER BOUNDS on true latency (single-venue IEX, not SIP), never
  // proof of the true market breach.
  /** Earliest observed EXECUTABLE-bid (bid ≤ stop) sighting, and its price. */
  earliestObservedBidAtOrBelowStopTs: number | null
  earliestObservedBid: number | null
  /** Earliest observed LAST-TRADE (trade ≤ stop) sighting, and its price. */
  earliestObservedTradeAtOrBelowStopTs: number | null
  earliestObservedTradePrice: number | null
  /** decisionTs − earliest bid-breach ts (ms), lower bound. Null if no bid breach. */
  bidBreachToDetectionMs: number | null
  /** decisionTs − earliest trade-breach ts (ms), lower bound. Null if no trade breach. */
  tradeBreachToDetectionMs: number | null
  /** False when breach evidence came from a non-consolidated (non-SIP) feed — not full-market truth. */
  observedBreachIsConsolidated: boolean | null
  detectionToSubmitMs: number | null
  submitToAckMs: number | null
  ackToFillMs: number | null
  submitToFillMs: number | null
  /** Notes on which components are unknown and why — so a reader never mistakes null for zero. */
  unknowns: string[]
}

/**
 * Attribute an exit's latency across stages, correlating it with the observation
 * stream for the same trade. Pure. Every component is `null` unless the data
 * genuinely supports it, and `unknowns` explains each gap.
 */
export function deriveLatencies(
  exit: ExecutionExitRecord,
  observations: ExecutionQualityObservation[],
): LatencyAttribution {
  const unknowns: string[] = []
  const mine = observations.filter(o => o.tradeId === exit.tradeId)

  // Production gap at detection: how far below the stop production's price was when it decided.
  const productionGapAtDetectionPct = exit.decisionPrice != null && exit.stopPrice > 0
    ? ((exit.decisionPrice - exit.stopPrice) / exit.stopPrice) * 100
    : null
  if (productionGapAtDetectionPct == null) {
    unknowns.push('productionGapAtDetectionPct: no decisionPrice (broker-native stop fills without an observed decision price)')
  }

  // Earliest OBSERVED sub-stop sightings — BID and TRADE evidence kept SEPARATE.
  const bidBreach = mine
    .filter(o => o.observedBidAtOrBelowStop === true && !o.observationDropped && o.observedQuoteTs != null)
    .sort((a, b) => a.observedQuoteTs! - b.observedQuoteTs!)[0] ?? null
  const tradeBreach = mine
    .filter(o => o.observedTradeAtOrBelowStop === true && !o.observationDropped && o.observedTradeTs != null)
    .sort((a, b) => a.observedTradeTs! - b.observedTradeTs!)[0] ?? null

  const earliestObservedBidAtOrBelowStopTs = bidBreach?.observedQuoteTs ?? null
  const earliestObservedBid = bidBreach?.observedBid ?? null
  const earliestObservedTradeAtOrBelowStopTs = tradeBreach?.observedTradeTs ?? null
  const earliestObservedTradePrice = tradeBreach?.observedTradePrice ?? null
  const observedBreachIsConsolidated = (bidBreach ?? tradeBreach)?.feedConsolidated ?? null

  const bidBreachToDetectionMs = bidBreach?.observedQuoteTs != null && exit.decisionTs != null
    ? exit.decisionTs - bidBreach.observedQuoteTs : null
  const tradeBreachToDetectionMs = tradeBreach?.observedTradeTs != null && exit.decisionTs != null
    ? exit.decisionTs - tradeBreach.observedTradeTs : null
  if (bidBreachToDetectionMs == null) unknowns.push('bidBreachToDetectionMs: no executable-bid breach with a source timestamp correlated to this exit')
  if (tradeBreachToDetectionMs == null) unknowns.push('tradeBreachToDetectionMs: no last-trade breach with a source timestamp correlated to this exit')
  if (observedBreachIsConsolidated === false) unknowns.push('observed breach is single-venue (non-SIP IEX) — both breach latencies are LOWER BOUNDS, not the true market breach')

  // Feed divergence + monitor quote age, from the observation nearest the decision.
  let feedDivergencePct: number | null = null
  let monitorQuoteAgeMs: number | null = null
  const nearDecision = exit.decisionTs != null
    ? mine.slice().sort((a, b) =>
        Math.abs(Date.parse(a.observedAt) - exit.decisionTs!) - Math.abs(Date.parse(b.observedAt) - exit.decisionTs!))[0] ?? null
    : null
  if (nearDecision?.observedTradePrice != null && nearDecision.monitorPrice != null && nearDecision.monitorPrice > 0) {
    feedDivergencePct = ((nearDecision.observedTradePrice - nearDecision.monitorPrice) / nearDecision.monitorPrice) * 100
  } else {
    unknowns.push('feedDivergencePct: no correlated observation carrying both an observed trade price and the monitor price')
  }
  if (nearDecision?.monitorQuoteTs != null && nearDecision.monitorResponseTs != null) {
    monitorQuoteAgeMs = nearDecision.monitorResponseTs - nearDecision.monitorQuoteTs
  } else {
    unknowns.push('monitorQuoteAgeMs: /api/monitor does not expose its source quote timestamp, so feed staleness is unmeasurable here')
  }

  const detectionToSubmitMs = exit.decisionTs != null && exit.submitTs != null ? exit.submitTs - exit.decisionTs : null
  if (detectionToSubmitMs == null) unknowns.push('detectionToSubmitMs: missing decisionTs or submitTs')
  const submitToAckMs = exit.submitTs != null && exit.ackTs != null ? exit.ackTs - exit.submitTs : null
  if (submitToAckMs == null) unknowns.push('submitToAckMs: broker acknowledgement timestamp not captured')
  const ackToFillMs = exit.ackTs != null && exit.fillTs != null ? exit.fillTs - exit.ackTs : null
  const submitToFillMs = exit.submitTs != null && exit.fillTs != null ? exit.fillTs - exit.submitTs : null
  if (submitToFillMs == null) unknowns.push('submitToFillMs: missing submitTs or fillTs')

  return {
    productionGapAtDetectionPct,
    feedDivergencePct,
    monitorQuoteAgeMs,
    earliestObservedBidAtOrBelowStopTs,
    earliestObservedBid,
    earliestObservedTradeAtOrBelowStopTs,
    earliestObservedTradePrice,
    bidBreachToDetectionMs,
    tradeBreachToDetectionMs,
    observedBreachIsConsolidated,
    detectionToSubmitMs,
    submitToAckMs,
    ackToFillMs,
    submitToFillMs,
    unknowns,
  }
}

// ── Read-only Alpaca market-data source (independent of the trading path) ─────

import type { MarketDataSource, MarketQuote, MarketTrade, FetchOpts } from './market-observer'

/**
 * Read-only witness over Alpaca's market-data API (data.alpaca.markets), which is
 * a DIFFERENT host from the trading API — it cannot place or cancel an order even
 * in principle. Prefers the latest quote (executable bid/ask) and also fetches the
 * latest trade. Any failure returns null so the observer degrades to `unknown`.
 */
export class AlpacaMarketData implements MarketDataSource {
  readonly name: string
  /** IEX (or any single venue) is NOT consolidated SIP truth. Only true for a SIP subscription. */
  readonly consolidated: boolean
  private readonly base: string
  private readonly headers: Record<string, string>
  private readonly feed: string
  private readonly timeoutMs: number

  constructor(keyId = process.env.ALPACA_KEY_ID, secretKey = process.env.ALPACA_SECRET_KEY, opts?: { baseUrl?: string; feed?: string; timeoutMs?: number }) {
    if (!keyId || !secretKey) throw new Error('AlpacaMarketData: ALPACA_KEY_ID / ALPACA_SECRET_KEY required')
    this.base = (opts?.baseUrl ?? 'https://data.alpaca.markets').replace(/\/$/, '')
    this.feed = opts?.feed ?? 'iex'
    this.consolidated = this.feed === 'sip'
    this.name = `alpaca-${this.feed}`
    this.timeoutMs = opts?.timeoutMs ?? 1200
    this.headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey }
  }

  private async get(path: string, external?: AbortSignal): Promise<Record<string, unknown> | null> {
    // Bounded read: an unreachable/slow feed must resolve to null quickly so the
    // observer records a `dropped` (unknown) sample rather than hanging the loop.
    // Aborts on EITHER the caller's signal (loop timeout) OR the internal deadline.
    const ctrl = new AbortController()
    const onExternal = () => ctrl.abort()
    if (external) { if (external.aborted) ctrl.abort(); else external.addEventListener('abort', onExternal, { once: true }) }
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.base}${path}`, { headers: this.headers, signal: ctrl.signal })
      if (!res.ok) return null
      return await res.json() as Record<string, unknown>
    } catch { return null } finally {
      clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternal)
    }
  }

  async latestQuote(symbol: string, opts?: FetchOpts): Promise<MarketQuote | null> {
    const j = await this.get(`/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=${this.feed}`, opts?.signal)
    const q = j?.quote as Record<string, unknown> | undefined
    if (!q) return null
    const bp = typeof q.bp === 'number' ? q.bp : null
    const ap = typeof q.ap === 'number' ? q.ap : null
    return { symbol, bidPrice: bp && bp > 0 ? bp : null, askPrice: ap && ap > 0 ? ap : null, sourceTs: q.t ? Date.parse(String(q.t)) : null }
  }

  async latestTrade(symbol: string, opts?: FetchOpts): Promise<MarketTrade | null> {
    const j = await this.get(`/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=${this.feed}`, opts?.signal)
    const t = j?.trade as Record<string, unknown> | undefined
    if (!t) return null
    const p = typeof t.p === 'number' ? t.p : null
    return { symbol, price: p && p > 0 ? p : null, sourceTs: t.t ? Date.parse(String(t.t)) : null }
  }
}
