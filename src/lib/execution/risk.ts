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
import type { SessionType } from '@/lib/market-hours'
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
  /**
   * Premarket's OWN slice of the daily loss budget, as a fraction of starting
   * equity. Without this, premarket can spend the entire day's allowance before
   * the market opens — which is exactly what happened on 2026-08-10: all nine
   * fills were premarket (06:34-08:19) and the daily limit tripped at 09:21, NINE
   * MINUTES before the open, locking out STKH and AUUD (both 09:31, both ran hard).
   *
   * The 20-day replay says that budget was in the wrong session anyway:
   *   open 09:30-10:00   33 signals  +0.541R/trade  +17.9R
   *   midday             68          +0.086R         +5.9R
   *   premarket          50          +0.068R         +3.4R
   * The first half hour carries the book at ~8x premarket's per-trade edge. So
   * premarket gets a quarter of the daily budget and the rest is reserved for the
   * session that actually pays.
   */
  premarketLossLimitFraction: number
  /** Premarket's slice of the daily trade count, for the same reason. */
  maxPremarketTrades: number
}

export const DEFAULT_RISK: RiskConfig = {
  maxConcurrentPositions: 3,
  maxOpenRiskFraction: 0.015,
  dailyLossLimitFraction: 0.02,
  maxTradesPerDay: 10,
  maxPositionsPerSymbol: 1,
  premarketLossLimitFraction: 0.005,   // a quarter of the 2% day budget
  maxPremarketTrades: 3,
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
  /**
   * The session we are about to trade INTO. Passed in rather than read from a
   * clock so this module stays pure and the same limits can be replayed.
   */
  session: SessionType
  /**
   * Startup exposure reconciliation flag (Phase 1). True when the broker reported
   * positive exposure the executor could not confidently represent with a loaded
   * active local trade, OR the position query itself failed. Unknown broker exposure
   * must NEVER count as flat, so while this is true all new entries fail closed.
   * Optional so existing callers/tests default to false (resolved).
   */
  reconciliationUnresolved?: boolean
}

/** Trades whose ENTRY filled in premarket — the ones that spend the premarket budget. */
export function premarketTrades(trades: PaperTrade[]): PaperTrade[] {
  return trades.filter(t => t.entrySession === 'premarket')
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

  // STARTUP EXPOSURE FAIL-CLOSED (Phase 1). Positive broker exposure that no loaded
  // active local trade represents (or a failed startup position query) is unresolved
  // risk. It must never read as flat, so block ALL new entries until it is resolved.
  // Existing positions keep being managed; only NEW exposure is refused.
  if (state.reconciliationUnresolved) {
    return { allowed: false, reason: 'startup_reconciliation_unresolved', terminal: true }
  }

  // DEFENCE IN DEPTH: an open position with non-positive planned risk is an invariant
  // violation (a post-fill stop inversion that escaped the fill-boundary guard). Its risk
  // must NEVER read as zero — that would understate openRisk and permit additional risk.
  // Fail closed: refuse new entries until it is unwound.
  const invalidRisk = state.openTrades.find(t => !(t.plannedRisk > 0))
  if (invalidRisk) {
    return {
      allowed: false,
      terminal: true,
      reason: `invalid open-position risk (${invalidRisk.symbol} plannedRisk ${invalidRisk.plannedRisk}) — fail closed`,
    }
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

  // Premarket's own budget. NOT terminal: exhausting it stands premarket down but
  // leaves the day's remaining allowance intact for 09:30 onward, which is the
  // whole point — on 2026-08-10 premarket spent the lot and the open got nothing.
  if (state.session === 'premarket') {
    const pmClosed = premarketTrades(state.closedToday)
    const pmRealized = realizedPnlToday(pmClosed)
    const pmLimit = -Math.abs(state.startingEquity * config.premarketLossLimitFraction)
    if (pmRealized <= pmLimit) {
      return {
        allowed: false,
        terminal: false,
        reason: `premarket loss budget spent: ${pmRealized.toFixed(2)} ≤ ${pmLimit.toFixed(2)} (day budget intact for the open)`,
      }
    }
    const pmCount = pmClosed.length + premarketTrades(state.openTrades).length
    if (pmCount >= config.maxPremarketTrades) {
      return {
        allowed: false,
        terminal: false,
        reason: `max premarket trades reached (${config.maxPremarketTrades})`,
      }
    }
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
