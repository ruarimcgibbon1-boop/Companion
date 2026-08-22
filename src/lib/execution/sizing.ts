/**
 * Position sizing — pure, so it can be unit-tested and reused by the backtest.
 *
 * Fixed fractional risk: every trade risks the same slice of equity, and the
 * stop distance decides the share count. That is the only sizing rule that makes
 * a win-rate/expectancy study meaningful — under fixed share counts a wide-stop
 * loser can erase ten tight-stop winners and the stats tell you nothing.
 *
 * Three caps sit on top, each of which binds regularly on this strategy:
 *   • notional  — a very tight stop otherwise implies an absurd position
 *   • buying power — never submit what the account can't cover
 *   • participation — a share count that's a big fraction of actual volume will
 *     not fill at these prices in the real world. The paper broker will happily
 *     pretend it did; capping here keeps paper honest about size.
 */

export interface SizingInputs {
  equity: number
  buyingPower: number
  /** The fill the signal assumed (BuySignalRecord.entryHigh). */
  entry: number
  stop: number
  /** Shares traded this session, if known. Omit/null to skip the participation cap. */
  sessionVolume?: number | null
}

export interface SizingConfig {
  /** Fraction of equity risked per trade if the stop fills exactly. */
  riskFraction: number
  /** Hard ceiling on position value as a fraction of equity. */
  maxNotionalFraction: number
  /** Max share count as a fraction of session volume. */
  maxParticipation: number
  /** Refuse stops wider than this % of entry — the risk model stops meaning anything. */
  maxStopDistancePct: number
}

export const DEFAULT_SIZING: SizingConfig = {
  riskFraction: 0.005,        // 0.5% of equity per trade
  maxNotionalFraction: 0.20,  // no single position over 20% of the account
  maxParticipation: 0.01,     // no more than 1% of session volume
  maxStopDistancePct: 15,
}

export interface SizingResult {
  qty: number
  /** Dollars at risk at this size: qty × (entry − stop). */
  plannedRisk: number
  /** Which constraint set the final number — logged so undersized fills are explicable. */
  boundBy: 'risk' | 'notional' | 'buying_power' | 'participation' | 'none'
  /** Populated only when qty is 0. */
  reason?: string
}

export function sizePosition(inputs: SizingInputs, config: SizingConfig = DEFAULT_SIZING): SizingResult {
  const { equity, buyingPower, entry, stop, sessionVolume } = inputs
  const zero = (reason: string): SizingResult => ({ qty: 0, plannedRisk: 0, boundBy: 'none', reason })

  if (!(entry > 0)) return zero('non-positive entry price')
  if (!(equity > 0)) return zero('no account equity')
  const stopDistance = entry - stop
  if (!(stopDistance > 0)) return zero(`stop ${stop} is not below entry ${entry}`)

  const stopDistancePct = (stopDistance / entry) * 100
  if (stopDistancePct > config.maxStopDistancePct) {
    return zero(`stop ${stopDistancePct.toFixed(1)}% away exceeds max ${config.maxStopDistancePct}%`)
  }

  const riskBudget = equity * config.riskFraction
  const byRisk = Math.floor(riskBudget / stopDistance)

  const byNotional = Math.floor((equity * config.maxNotionalFraction) / entry)
  const byBuyingPower = Math.floor(Math.max(buyingPower, 0) / entry)
  const byParticipation = sessionVolume != null && sessionVolume > 0
    ? Math.floor(sessionVolume * config.maxParticipation)
    : Infinity

  const qty = Math.min(byRisk, byNotional, byBuyingPower, byParticipation)
  if (qty < 1) {
    if (byBuyingPower < 1) return zero('insufficient buying power for one share')
    if (byParticipation < 1) return zero('session volume too thin to participate')
    return zero('risk budget too small for one share at this stop distance')
  }

  // Report the binding constraint, cheapest comparison last-wins style.
  let boundBy: SizingResult['boundBy'] = 'risk'
  if (qty === byNotional && byNotional < byRisk) boundBy = 'notional'
  if (qty === byBuyingPower && byBuyingPower < byRisk) boundBy = 'buying_power'
  if (qty === byParticipation && byParticipation < byRisk) boundBy = 'participation'

  return { qty, plannedRisk: qty * stopDistance, boundBy }
}

/**
 * Marketable limit price for an entry: the most we'll pay to get filled.
 *
 * Signals fire on `triggeredRaw`, i.e. price is already at or through the level,
 * so a market order chases whatever the book offers — on a thin premarket gapper
 * that is exactly how a backtested +0.5% becomes a realized −1%. A capped limit
 * converts "bad fill" into "no fill", which is the trade you want: a missed
 * entry costs nothing and is measurable, a terrible fill costs money and hides.
 */
export function entryLimitPrice(intendedEntry: number, slipTolerancePct: number): number {
  return intendedEntry * (1 + slipTolerancePct / 100)
}

/** Mirror of the above on the way out: cross the spread, but only so far. */
export function exitLimitPrice(triggerPrice: number, slipTolerancePct: number): number {
  return triggerPrice * (1 - slipTolerancePct / 100)
}
