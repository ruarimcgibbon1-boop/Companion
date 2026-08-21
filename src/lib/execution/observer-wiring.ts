/**
 * Passive observer wiring — the seam between the daemon and the execution-quality
 * observer. Kept out of the daemon script (which runs on import) so it is unit
 * testable at the smallest boundary, and so the daemon's own control flow is
 * touched as little as possible.
 *
 * NOTHING here can influence a trading decision. It reads the executor's OPEN
 * positions and an independent market feed, and writes ONLY the execution-quality
 * timeline. The returned ObserverLoop runs on its own cadence, never the position
 * loop's; the executor never references it.
 */
import type { PaperTrade } from './types'
import type { MarketDataSource, ObserveContext, ExecutionQualityObservation } from './market-observer'
import { ExecutionObserver } from './market-observer'
import { ObserverLoop, type ObserverLoopDeps } from './observer-loop'
import { appendExecutionQuality } from './execution-quality'
import { getSessionType } from '../market-hours'

/** The minimal read-only view of the executor the observer needs — its open trades. */
export interface HeldPositionSource {
  openTrades(): PaperTrade[]
}

/**
 * Build the observe-context list from the executor's OPEN trades only. When flat,
 * this is empty, so the loop makes no market-data calls (requirement: don't observe
 * symbols that aren't held). `executionPath` reflects how the position is currently
 * protected: a resting broker stop (RTH) vs the polled loop (premarket/afterhours).
 */
export function heldObserveContexts(
  src: HeldPositionSource,
  session: () => string = () => getSessionType(),
): ObserveContext[] {
  return src.openTrades().map(t => ({
    tradeId: t.id,
    setupId: t.setupId,
    symbol: t.symbol,
    session: session(),
    stopPrice: t.currentStop,
    executionPath: t.protectiveStopOrderId ? 'broker_stop' : 'polled',
  }))
}

export interface ObserverWiringOpts {
  cadenceMs?: number
  timeoutMs?: number
  session?: () => string
  /** Where each observation row is written — defaults to the append-only timeline. */
  record?: (row: ExecutionQualityObservation) => void
  /** Injected timers, for deterministic tests. Defaults to real setInterval/setTimeout. */
  deps?: ObserverLoopDeps
}

/**
 * Construct (but do not start) a passive ObserverLoop over the executor's open
 * positions, sampling `source`. The caller starts/stops it in the daemon lifecycle.
 */
export function makeObserverLoop(
  src: HeldPositionSource,
  source: MarketDataSource,
  opts: ObserverWiringOpts = {},
): ObserverLoop {
  const record = opts.record ?? ((row: ExecutionQualityObservation) => appendExecutionQuality({ kind: 'observation', ...row }))
  // Freshness threshold: default 120 s (see ExecutionObserver), overridable for a soak via EQ_MAX_STALE_MS.
  const maxStaleMs = Number(process.env.EQ_MAX_STALE_MS) || undefined
  const observer = new ExecutionObserver(source, record, undefined, maxStaleMs)
  return new ObserverLoop(
    observer,
    () => heldObserveContexts(src, opts.session),
    { cadenceMs: opts.cadenceMs ?? 2_000, timeoutMs: opts.timeoutMs ?? 1_500 },
    opts.deps,
  )
}
