/**
 * Observer loop — the passive execution-quality witness's OWN lifecycle, wholly
 * independent of the executor's 3-second tick.
 *
 * Why not `await executor.tick(); void observer.observe(...)`: that only ever
 * samples AFTER production has already decided/filled, so it can never be a
 * pre-decision witness. This loop runs on its own cadence so an independent sample
 * can land BEFORE production's next poll sees the breach.
 *
 * Hard guarantees (all tested):
 *   • zero order authority — it only drives ExecutionObserver, which can only read
 *     market data and append to the timeline;
 *   • the executor never references or awaits this loop; a hang/failure here cannot
 *     delay or alter any exit;
 *   • at most ONE in-flight observation per symbol; if a sample is still running at
 *     the next cadence it is SKIPPED, never queued;
 *   • every observation is bounded by a timeout → a hung feed frees the slot and
 *     records a `dropped` (unknown) sample rather than fabricating a breach;
 *   • explicit start()/stop(); positions that close unsubscribe safely, and an
 *     in-flight sample for a closed position is allowed to settle harmlessly;
 *   • network usage is measurable via counters.
 *
 * All timing is injected so tests are deterministic (no real clocks).
 */
import type { ExecutionObserver, ObserveContext } from './market-observer'

export interface ObserverLoopStats {
  rounds: number
  dispatched: number
  completed: number
  timedOut: number
  skippedInFlight: number
  errors: number
  unsubscribed: number
}

export interface ObserverLoopDeps {
  now?: () => number
  /** Schedule a one-shot timer; returns a cancel fn. Injected so tests control timeouts. */
  setTimer?: (cb: () => void, ms: number) => () => void
  /** Interval scheduler for start(); injected so tests avoid real intervals. */
  setLoop?: (cb: () => void, ms: number) => () => void
}

export class ObserverLoop {
  private readonly inFlight = new Set<string>()   // by symbol — the one-per-symbol guard
  private readonly tracked = new Map<string, string>()  // symbol → tradeId currently observed
  private readonly controllers = new Set<AbortController>()  // live requests, so stop() can abort them
  private cancelLoop: (() => void) | null = null
  private stopped = false
  private readonly setTimer: (cb: () => void, ms: number) => () => void
  private readonly setLoop: (cb: () => void, ms: number) => () => void
  readonly stats: ObserverLoopStats = {
    rounds: 0, dispatched: 0, completed: 0, timedOut: 0, skippedInFlight: 0, errors: 0, unsubscribed: 0,
  }

  constructor(
    private readonly observer: ExecutionObserver,
    /** The positions to witness right now — the loop reads this fresh each round, so closes drop out naturally. */
    private readonly heldContexts: () => ObserveContext[],
    private readonly opts: { cadenceMs: number; timeoutMs: number } = { cadenceMs: 3000, timeoutMs: 1500 },
    deps: ObserverLoopDeps = {},
  ) {
    this.setTimer = deps.setTimer ?? ((cb, ms) => { const h = setTimeout(cb, ms); return () => clearTimeout(h) })
    this.setLoop = deps.setLoop ?? ((cb, ms) => { const h = setInterval(cb, ms); return () => clearInterval(h) })
  }

  /** Begin sampling on the loop's own cadence. Idempotent. */
  start(): void {
    if (this.cancelLoop || this.stopped) return
    this.cancelLoop = this.setLoop(() => { void this.runRound() }, this.opts.cadenceMs)
  }

  /**
   * Stop sampling cleanly: clear the interval, abort every in-flight request (so no
   * dangling fetch outlives shutdown), and refuse further dispatches. Idempotent.
   */
  stop(): void {
    this.stopped = true
    if (this.cancelLoop) { this.cancelLoop(); this.cancelLoop = null }
    for (const c of this.controllers) c.abort()
    // Each aborted request settles and clears itself from `controllers`/`inFlight`.
  }

  /**
   * One cadence round. Dispatches a bounded observation for each held symbol not
   * already in flight, unsubscribes symbols that have closed, and returns
   * immediately — it never awaits the dispatches, so it cannot back-pressure.
   */
  async runRound(): Promise<void> {
    if (this.stopped) return
    this.stats.rounds++
    const held = this.heldContexts()
    const heldSymbols = new Set(held.map(c => c.symbol))

    // Unsubscribe positions that have closed since last round.
    for (const [symbol, tradeId] of [...this.tracked]) {
      if (!heldSymbols.has(symbol)) {
        this.tracked.delete(symbol)
        this.observer.forget(tradeId)
        this.stats.unsubscribed++
        // An in-flight sample for this symbol is left to settle; it clears its own flag.
      }
    }

    for (const ctx of held) {
      this.tracked.set(ctx.symbol, ctx.tradeId)
      if (this.inFlight.has(ctx.symbol)) { this.stats.skippedInFlight++; continue }  // skip, never queue
      this.dispatch(ctx)
    }
  }

  /**
   * Fire one bounded, read-only observation. Not awaited by runRound.
   *
   * TRUE single-in-flight guarantee: the symbol lock is released ONLY when the
   * original `observe` promise settles — never merely when the timeout fires. On
   * timeout we `abort()` the request end-to-end (loop → observer → source → fetch),
   * which makes the original promise settle promptly; the lock is freed in its
   * `finally`. So at most one PHYSICAL request per symbol can be active at a time,
   * even if the network hangs until aborted.
   */
  private dispatch(ctx: ObserveContext): void {
    const symbol = ctx.symbol
    this.inFlight.add(symbol)
    this.stats.dispatched++
    const controller = new AbortController()
    this.controllers.add(controller)
    let timedOut = false
    const cancelTimeout = this.setTimer(() => {
      timedOut = true
      this.stats.timedOut++
      controller.abort()   // stop the underlying request; do NOT release the lock here
    }, this.opts.timeoutMs)

    this.observer.observe(ctx, { signal: controller.signal })
      .then(() => { if (!timedOut) this.stats.completed++ })
      .catch(() => { this.stats.errors++ })
      .finally(() => {
        cancelTimeout()
        this.controllers.delete(controller)
        this.inFlight.delete(symbol)   // released only now — after the real request has settled
      })
  }

  /** Test/observability helper: symbols currently mid-observation. */
  inFlightSymbols(): string[] { return [...this.inFlight] }
}
