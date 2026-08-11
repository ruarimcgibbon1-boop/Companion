/**
 * Risk governor — the last gate before money (paper money, for now) moves.
 *
 * The buy-log gate stack limits how many *signals* fire. This limits how much
 * *exposure* they can create, which is a different question: three simultaneous
 * A-grade signals all pass every signal gate and would still be a concentrated
 * bet on one premarket tape. Everything here is pure and deterministic so the
 * same limits can be replayed over a backtest.
 *
 * Deliberately conservative defaults. Paper trading is for measuring whether the
 * edge survives real fills — not for finding out how big the account can get.
 */
import type { PaperTrade } from './types'

export interface RiskConfig {
  /** Positions held at once. Concentration limit, not a capital limit. */
  maxConcurrentPositions: number
  /** Sum of planned risk across open trades, as a fraction of equity. */
  maxOpenRiskFraction: number
  /** Realized loss for the day that stops all new entries, as a fraction of starting equity. */
  dailyLossLimitFraction: number
  /** Circuit breaker on a runaway loop placing orders it shouldn't. */
  maxTradesPerDay: number
  /** No pyramiding — one live position per symbol. */
  maxPositionsPerSymbol: number
}

export const DEFAULT_RISK: RiskConfig = {
  maxConcurrentPositions: 3,
  maxOpenRiskFraction: 0.015,
  dailyLossLimitFraction: 0.02,
  maxTradesPerDay: 10,
  maxPositionsPerSymbol: 1,
}

export interface RiskState {
  equity: number
  /** Equity at the first sweep of the day — the denominator for the daily loss limit. */
  startingEquity: number
  /** Broker-level halt (account_blocked / trading_blocked). */
  brokerBlocked: boolean
  openTrades: PaperTrade[]
  /** Trades closed today, for realized P&L and the daily count. */
  closedToday: PaperTrade[]
  /** Operator kill switch — halt file present or HALT=1. */
  halted: boolean
}

export type RiskDecision =
  | { allowed: true }
  | { allowed: false; reason: string; /** true when the whole day is done, not just this trade */ terminal: boolean }

/** Realized P&L for the day across closed trades. Fills only — nothing modelled. */
export function realizedPnlToday(closed: PaperTrade[]): number {
  return closed.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0)
}

/** Total dollars at risk across positions currently held or working. */
export function openRisk(open: PaperTrade[]): number {
  return open.reduce((sum, t) => sum + t.plannedRisk, 0)
}

/**
 * May we open a new position in `symbol` risking `plannedRisk` dollars?
 *
 * Order matters: terminal conditions (halt, daily loss) are checked before
 * per-trade ones so the caller can stop sweeping entirely rather than re-asking
 * for every candidate.
 */
export function canOpenPosition(
  symbol: string,
  plannedRisk: number,
  state: RiskState,
  config: RiskConfig = DEFAULT_RISK,
): RiskDecision {
  if (state.halted) {
    return { allowed: false, reason: 'operator kill switch engaged', terminal: true }
  }
  if (state.brokerBlocked) {
    return { allowed: false, reason: 'broker reports the account blocked', terminal: true }
  }

  const realized = realizedPnlToday(state.closedToday)
  const lossLimit = -Math.abs(state.startingEquity * config.dailyLossLimitFraction)
  if (realized <= lossLimit) {
    return {
      allowed: false,
      terminal: true,
      reason: `daily loss limit hit: ${realized.toFixed(2)} ≤ ${lossLimit.toFixed(2)}`,
    }
  }

  const tradesToday = state.closedToday.length + state.openTrades.length
  if (tradesToday >= config.maxTradesPerDay) {
    return { allowed: false, terminal: true, reason: `max trades/day reached (${config.maxTradesPerDay})` }
  }

  if (state.openTrades.length >= config.maxConcurrentPositions) {
    return { allowed: false, terminal: false, reason: `max concurrent positions (${config.maxConcurrentPositions})` }
  }

  const inSymbol = state.openTrades.filter(t => t.symbol === symbol).length
  if (inSymbol >= config.maxPositionsPerSymbol) {
    return { allowed: false, terminal: false, reason: `already holding ${symbol}` }
  }

  const projectedRisk = openRisk(state.openTrades) + plannedRisk
  const riskCeiling = state.equity * config.maxOpenRiskFraction
  if (projectedRisk > riskCeiling) {
    return {
      allowed: false,
      terminal: false,
      reason: `open risk ${projectedRisk.toFixed(0)} would exceed ceiling ${riskCeiling.toFixed(0)}`,
    }
  }

  return { allowed: true }
}
