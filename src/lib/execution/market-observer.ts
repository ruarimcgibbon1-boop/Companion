/**
 * PASSIVE execution-quality observer — an independent, READ-ONLY market-data
 * witness for open positions. It answers "when did we FIRST OBSERVE the market
 * cross our stop, on a feed independent of production, and how did that compare to
 * when production acted?"
 *
 * ZERO EXECUTION AUTHORITY, BY CONSTRUCTION. Everything here can only READ market
 * data and WRITE to the append-only execution-quality timeline. No order method,
 * no exit trigger, no mutation of any PaperTrade. Driven by its OWN loop
 * (observer-loop.ts), never the executor's tick; its result is for logging only.
 *
 * SEMANTICS — never overclaim:
 *   • A sample showing bid/trade ≤ stop is the EARLIEST WE OBSERVED a breach ON
 *     THIS FEED (Alpaca IEX — a single venue, not consolidated SIP). It is NOT the
 *     true market breach. Fields say `observed…`, never `firstBreach`/`trueBreach`.
 *   • BID and TRADE evidence are kept SEPARATE (executable bid vs last print) and
 *     never collapsed into one "breach" number.
 *   • A cancelled/timed-out sample is `observationDropped` and asserts NO breach.
 *
 * CANCELLATION: `observe` accepts an AbortSignal, propagated to the data source and
 * its fetch, so the loop can guarantee at most ONE physically active request per
 * symbol — a timed-out request is aborted end-to-end, not merely forgotten.
 */

export interface MarketQuote {
  symbol: string
  bidPrice: number | null
  askPrice: number | null
  sourceTs: number | null      // the feed's own timestamp for this quote (ms epoch), if exposed
}
export interface MarketTrade {
  symbol: string
  price: number | null
  sourceTs: number | null
}

export interface FetchOpts { signal?: AbortSignal }

/**
 * Per-leg fetch outcome, so research can tell three cases apart that used to look
 * identical (all-null fields):
 *   • 'ok'      — the request completed; its value may be a real price OR a genuine
 *                 null (the leg simply had no value, e.g. no recent trade).
 *   • 'error'   — the request FAILED (transport/parse). No value obtained.
 *   • 'aborted' — the request was cancelled (timeout/close) or never attempted.
 */
export type LegStatus = 'ok' | 'error' | 'aborted'

/**
 * A read-only market-data feed. Deliberately NARROW: no order entry/cancel/mutate,
 * so an observer built on it structurally cannot affect execution. `consolidated`
 * states whether this is full-market SIP truth (false for a single venue like IEX).
 */
export interface MarketDataSource {
  readonly name: string
  readonly consolidated: boolean
  latestQuote(symbol: string, opts?: FetchOpts): Promise<MarketQuote | null>
  latestTrade(symbol: string, opts?: FetchOpts): Promise<MarketTrade | null>
}

export interface ObserveContext {
  tradeId: string
  setupId?: string | null
  symbol: string
  session: string
  stopPrice: number
  executionPath: 'broker_stop' | 'polled' | 'unknown'
  monitorPrice?: number | null
  monitorRequestStartTs?: number | null
  monitorResponseTs?: number | null
  monitorQuoteTs?: number | null
}

/** One row of the execution-quality timeline. Missing/unsupported fields stay null → "unknown". */
export interface ExecutionQualityObservation {
  observedAt: string
  tradeId: string
  setupId: string | null
  symbol: string
  session: string
  stopPrice: number
  executionPath: 'broker_stop' | 'polled' | 'unknown'

  // ── Independent (observer) evidence — a SINGLE-VENUE feed, not SIP ────────
  observedFeed: string
  feedConsolidated: boolean
  /** Per-leg request outcome — distinguishes a genuine empty value from a transport failure. */
  quoteStatus: LegStatus
  tradeStatus: LegStatus
  observedTradePrice: number | null
  observedTradeTs: number | null
  observedBid: number | null
  observedAsk: number | null
  observedQuoteTs: number | null
  /** Executable-price evidence: bid ≤ stop (a long exits at the bid). Null when no quote → unknown. */
  observedBidAtOrBelowStop: boolean | null
  /** Last-trade evidence: trade ≤ stop. Null when no trade → unknown. Kept SEPARATE from bid evidence. */
  observedTradeAtOrBelowStop: boolean | null
  /** Convenience OR of the two above — for readers that want "any breach on this feed", never for causal claims. */
  observedBreach: boolean
  /** The sample was cancelled/timed out / feed unreachable → observed fields unknown, breach not asserted. */
  observationDropped: boolean

  // ── Production (/api/monitor) evidence, passed through ────────────────────
  monitorPrice: number | null
  monitorRequestStartTs: number | null
  monitorResponseTs: number | null
  monitorQuoteTs: number | null

  effectivePollIntervalMs: number | null   // measured wall-clock cadence, not the configured 3s
}

export type ObservationRecorder = (row: ExecutionQualityObservation) => void

export class ExecutionObserver {
  private readonly lastObservedAt = new Map<string, number>()

  constructor(
    private readonly source: MarketDataSource,
    private readonly record: ObservationRecorder,
    private readonly now: () => number = () => Date.now(),
  ) {}

  forget(tradeId: string): void { this.lastObservedAt.delete(tradeId) }

  async observe(ctx: ObserveContext, opts?: { dropped?: boolean; signal?: AbortSignal }): Promise<ExecutionQualityObservation> {
    const wall = this.now()
    const prev = this.lastObservedAt.get(ctx.tradeId) ?? null
    this.lastObservedAt.set(ctx.tradeId, wall)

    // Each leg is fetched independently and its OUTCOME recorded, so a failed
    // transport ('error') is never confused with a successful-but-empty read ('ok'
    // + null). An abort is 'aborted'. A leg not attempted (whole sample dropped) is
    // 'aborted' too.
    const runLeg = async <T>(fn: () => Promise<T | null>): Promise<{ status: LegStatus; value: T | null }> => {
      if (opts?.dropped) return { status: 'aborted', value: null }
      try { return { status: 'ok', value: await fn() } }
      catch (e) {
        const aborted = (opts?.signal?.aborted ?? false) || (e instanceof Error && e.name === 'AbortError')
        return { status: aborted ? 'aborted' : 'error', value: null }
      }
    }
    const q = await runLeg(() => this.source.latestQuote(ctx.symbol, { signal: opts?.signal }))
    const tr = await runLeg(() => this.source.latestTrade(ctx.symbol, { signal: opts?.signal }))
    const quoteStatus = q.status, tradeStatus = tr.status
    const quote = q.value, trade = tr.value

    // DROPPED = no usable market evidence obtained: explicitly dropped, or NEITHER
    // leg completed (both errored/aborted). A partial (one leg 'ok') is NOT dropped,
    // and a clean-but-empty sample (both 'ok', values null) is NOT dropped — so a
    // total transport failure can never be mistaken for a clean observation.
    const dropped = !!opts?.dropped || !(quoteStatus === 'ok' || tradeStatus === 'ok')

    const bid = quote?.bidPrice ?? null
    const tradePrice = trade?.price ?? null
    const bidAtOrBelow = bid == null ? null : bid <= ctx.stopPrice
    const tradeAtOrBelow = tradePrice == null ? null : tradePrice <= ctx.stopPrice
    const observedBreach = !dropped && (bidAtOrBelow === true || tradeAtOrBelow === true)

    const row: ExecutionQualityObservation = {
      observedAt: new Date(wall).toISOString(),
      tradeId: ctx.tradeId,
      setupId: ctx.setupId ?? null,
      symbol: ctx.symbol,
      session: ctx.session,
      stopPrice: ctx.stopPrice,
      executionPath: ctx.executionPath,
      observedFeed: this.source.name,
      feedConsolidated: this.source.consolidated,
      quoteStatus,
      tradeStatus,
      observedTradePrice: tradePrice,
      observedTradeTs: dropped ? null : trade?.sourceTs ?? null,
      observedBid: bid,
      observedAsk: dropped ? null : quote?.askPrice ?? null,
      observedQuoteTs: dropped ? null : quote?.sourceTs ?? null,
      observedBidAtOrBelowStop: bidAtOrBelow,
      observedTradeAtOrBelowStop: tradeAtOrBelow,
      observedBreach,
      observationDropped: dropped,
      monitorPrice: ctx.monitorPrice ?? null,
      monitorRequestStartTs: ctx.monitorRequestStartTs ?? null,
      monitorResponseTs: ctx.monitorResponseTs ?? null,
      monitorQuoteTs: ctx.monitorQuoteTs ?? null,
      effectivePollIntervalMs: prev == null ? null : wall - prev,
    }
    try { this.record(row) } catch { /* best-effort */ }
    return row
  }
}
