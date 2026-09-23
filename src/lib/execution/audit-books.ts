/**
 * Canonical forward-book accounting — three books, one source of truth.
 *
 * The execution-attribution work computed these ad hoc; this module fixes their
 * definitions so every future report agrees. Pure and side-effect-free.
 *
 *   1. ACCOUNT book   — every broker-realized trade, external/manual exits INCLUDED.
 *                       This is the cash truth of the paper account.
 *   2. STRATEGY book  — only trades Companion both opened AND closed by its own
 *                       logic. Manual/external exits (dashboard flatten, broker
 *                       liquidation — EL/FSM/FIGR) are SEPARATED out, because their
 *                       result is not attributable to the strategy.
 *   3. IDEAL-STOP book — an OPTIMISTIC UPPER BOUND: strategy trades repriced as if
 *                       every stop filled exactly at its intended level. This is a
 *                       ceiling, NOT a claim of achievable fills — real stops slip.
 *
 * The gap ACCOUNT→STRATEGY isolates external interference; STRATEGY→IDEAL isolates
 * execution slippage; whatever remains in IDEAL is the strategy's own signal edge.
 */

export interface AuditTradeInput {
  day: string
  symbol: string
  setup: string
  /** Broker-realized R (realized $ ÷ planned risk). */
  actualR: number
  /** R if every exit had filled at its intended level (stop at the stop, T1/T2 at targets). Null when not reconstructable without guessing. */
  idealR: number | null
  /** True when the exit was NOT strategy-generated (manual dashboard flatten, broker liquidation, etc.). */
  externalExit: boolean
  /** Reconciliation status carried through for transparency. */
  reconciliation?: string
}

export interface BookSummary {
  n: number
  netR: number
  avgR: number | null
  medianR: number | null
  winRatePct: number | null
}

export interface CanonicalBooks {
  account: BookSummary
  strategy: BookSummary
  idealStopUpperBound: BookSummary
  /** Trades excluded from the strategy book because their exit was external. */
  externalTrades: AuditTradeInput[]
  /** Strategy trades whose ideal R could not be reconstructed (excluded from the ideal book only). */
  idealUnreconstructable: AuditTradeInput[]
  executionCostR: number | null   // strategy.netR − idealStop.netR (what slippage cost), when the ideal book covers the same set
}

function summarize(rs: number[]): BookSummary {
  if (rs.length === 0) return { n: 0, netR: 0, avgR: null, medianR: null, winRatePct: null }
  const sorted = rs.slice().sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
  const wins = rs.filter(r => r > 0).length
  return {
    n: rs.length,
    netR: rs.reduce((s, r) => s + r, 0),
    avgR: rs.reduce((s, r) => s + r, 0) / rs.length,
    medianR: median,
    winRatePct: (wins / rs.length) * 100,
  }
}

export function canonicalBooks(trades: AuditTradeInput[]): CanonicalBooks {
  const account = summarize(trades.map(t => t.actualR))

  const strategyTrades = trades.filter(t => !t.externalExit)
  const externalTrades = trades.filter(t => t.externalExit)
  const strategy = summarize(strategyTrades.map(t => t.actualR))

  // Ideal book covers only strategy trades whose ideal R is reconstructable.
  const idealReconstructable = strategyTrades.filter(t => t.idealR != null)
  const idealUnreconstructable = strategyTrades.filter(t => t.idealR == null)
  const idealStopUpperBound = summarize(idealReconstructable.map(t => t.idealR as number))

  // Execution cost is only meaningful across an identical trade set.
  const executionCostR = idealUnreconstructable.length === 0
    ? strategy.netR - idealStopUpperBound.netR
    : null

  return { account, strategy, idealStopUpperBound, externalTrades, idealUnreconstructable, executionCostR }
}
