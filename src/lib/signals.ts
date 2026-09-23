/**
 * Buy/sell signal derivation.
 *
 * Turns a DetectedSetup's state + direction + geometry into ONE decisive,
 * plain-English directive: BUY / PREP BUY / SELL·SHORT / PREP SHORT / WAIT /
 * AVOID — with the exact trigger price, the condition that flips it actionable,
 * the stop, and the sell targets. This is the "what do I actually do" layer on
 * top of the nuanced state machine.
 */

import type { DetectedSetup, TradeSignal, SignalAction, SetupType } from '@/types'

// A triggered setup whose reward/risk is below this floor is NOT worth a BUY /
// SELL·SHORT call — the target is too close to the stop. We downgrade it to a
// WATCH that names the reason rather than screaming an action on a bad trade.
const MIN_TRIGGER_RR = 1.5

// Price-aware formatting: micro-caps need more decimals than large caps.
function px(n: number): string {
  const abs = Math.abs(n)
  const d = abs < 1 ? 3 : abs < 10 ? 2 : 2
  return `$${n.toFixed(d)}`
}

// The condition that must print at the trigger price for each setup type.
function triggerConditionFor(type: SetupType, direction: 'long' | 'short'): string {
  switch (type) {
    case 'breakout': return 'a candle CLOSE above'
    case 'bull_flag': return 'a break + hold above the flag high'
    case 'break_of_structure': return 'a break of the prior swing high'
    case 'opening_drive': return 'a break of the premarket/prior-day high'
    case 'pullback': return 'a bounce + reclaim of'
    case 'momentum_pullback': return 'a new high off the pullback above'
    case 'ema9_bounce': return 'a hold + reclaim above'
    case 'ema21_bounce': return 'a higher low + reclaim above'
    case 'vwap_bounce': return 'buyers defending / hold above'
    case 'vwap_reclaim': return 'a close back above'
    case 'level_reclaim': return 'a close back above'
    case 'resistance_rejection': return 'a rejection + close below'
    case 'support_breakdown': return 'a decisive close below'
    default: return direction === 'long' ? 'a reclaim of' : 'a loss of'
  }
}

export function deriveSignal(s: DetectedSetup): TradeSignal {
  const long = s.direction === 'long'
  // The level that flips the setup actionable: reclaim/break the top (long) or
  // lose the bottom (short) of the zone.
  const triggerPrice = long ? s.zoneUpper : s.zoneLower
  // Where you actually fill entering on the trigger (buy the reclaim), never
  // below current price for a long — so we don't tell the user to rest a limit
  // in a zone that a strong mover never revisits.
  const entryFill = s.entryFill ?? triggerPrice
  const cond = triggerConditionFor(s.type, s.direction)
  const stop = s.invalidation
  const targets = s.targets.map(t => t.price)
  const tgtText = targets.length ? targets.slice(0, 2).map(px).join(' → ') : 'open'
  const dist = Math.abs(s.distanceToZonePct)

  let action: SignalAction
  let verb: string
  let urgency: TradeSignal['urgency']
  let headline: string

  switch (s.state) {
    case 'triggered': {
      // Poor reward/risk (target too close to the stop) → don't call an action.
      const poorRR = s.rewardRisk != null && s.rewardRisk < MIN_TRIGGER_RR
      if (poorRR) {
        action = 'watch'; verb = 'WATCH'; urgency = 'watch'
        headline = `${s.symbol} ${label(s.type)} triggered but R/R only ${rr(s)} — target ${px(targets[0] ?? triggerPrice)} too close to stop ${px(stop)}. Skip unless the setup improves.`
      } else if (long) {
        action = 'buy'; verb = 'BUY'; urgency = 'now'
        headline = `BUY ${s.symbol} — ${label(s.type)} triggered. Enter now ~${px(entryFill)} (on the reclaim), stop ${px(stop)}, sell into ${tgtText}. R/R ${rr(s)}.`
      } else {
        action = 'sell_short'; verb = 'SELL / SHORT'; urgency = 'now'
        headline = `SELL/SHORT ${s.symbol} — ${label(s.type)} triggered. Entry ~${px(triggerPrice)}, stop ${px(stop)}, cover into ${tgtText}. R/R ${rr(s)}.`
      }
      break
    }

    case 'confirming':
      if (long) {
        action = 'prep_buy'; verb = 'PREP BUY'; urgency = 'soon'
        headline = `Prepare to BUY ${s.symbol} — confirming at ${px(s.zoneMidpoint)}. Trigger: ${cond} ${px(triggerPrice)}. Stop ${px(stop)}.`
      } else {
        action = 'prep_short'; verb = 'PREP SHORT'; urgency = 'soon'
        headline = `Prepare to SHORT ${s.symbol} — confirming at ${px(s.zoneMidpoint)}. Trigger: ${cond} ${px(triggerPrice)}. Stop ${px(stop)}.`
      }
      break

    case 'at_level':
      action = 'watch'; verb = 'WAIT'; urgency = 'watch'
      headline = `${s.symbol} at the ${long ? 'buy' : 'short'} zone ${px(s.zoneLower)}–${px(s.zoneUpper)} — WAIT for ${cond} ${px(triggerPrice)}. Don't chase; invalid below ${px(stop)}.`
      break

    case 'approaching':
      action = 'watch'; verb = 'WATCH'; urgency = 'watch'
      headline = `${s.symbol} approaching the ${long ? 'buy' : 'short'} zone ${px(s.zoneLower)}–${px(s.zoneUpper)} (${dist.toFixed(1)}% away). Arm alert; trigger on ${cond} ${px(triggerPrice)}.`
      break

    case 'failed':
      action = 'avoid'; verb = 'AVOID'; urgency = 'none'
      headline = `${s.symbol} ${label(s.type)} invalidated — stand aside.${s.nextIfFails ? ` Next level ${px(s.nextIfFails)}.` : ''}`
      break

    default: // identified / expired
      action = 'watch'; verb = 'WATCH'; urgency = 'none'
      headline = `${s.symbol} ${label(s.type)} identified at ${px(s.zoneMidpoint)} — not in range yet. Trigger on ${cond} ${px(triggerPrice)}.`
  }

  return { action, verb, urgency, headline, triggerPrice, triggerCondition: `${cond} ${px(triggerPrice)}`, stop, targets }
}

function rr(s: DetectedSetup): string {
  return s.rewardRisk != null ? `${s.rewardRisk.toFixed(1)}:1` : 'n/a'
}

function label(type: SetupType): string {
  return type.replace(/_/g, ' ')
}
