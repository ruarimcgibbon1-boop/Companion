/**
 * Transparent 100-point trade-idea scoring matrix.
 *
 * Eight categories (Level, Price Action, Volume/Momentum, Trend, Catalyst,
 * Reward/Risk, Liquidity, Confirmation). Each setup type redistributes the
 * category maximums so a breakout weights resistance/consolidation/volume,
 * a pullback weights support/selling-contraction/trend, etc. Weaknesses are
 * never hidden — every sub-score and every material risk is surfaced.
 */

import type { ScoreBreakdown, SetupGrade, SetupType } from '@/types'

export interface ScoringContext {
  setupType: SetupType
  // Level quality signals
  levelStrength: number          // 0-100
  levelTouches: number
  levelHigherTf: boolean
  levelConfluence: boolean
  // Price action signals (each 0..1 where noted)
  structureIntact: boolean       // higher-lows (long) / lower-highs (short)
  cleanCandles: boolean          // no big opposing candles into the zone
  constructiveConsolidation: boolean
  structureBroken: boolean
  // Volume / momentum
  relativeVolume: number | null
  volumeContractsIntoZone: boolean   // good for pullback/bounce
  volumeExpandsOnSignal: boolean     // good for breakout/trigger
  sustainedInterest: boolean
  // Trend alignment
  intradayTrendAligned: boolean
  higherTfTrendAligned: boolean
  aboveVwap: boolean | null
  emaStackAligned: boolean
  // Catalyst
  catalystScore: number          // 0-15 raw (from news engine mapping)
  unusualVolume: boolean
  // Reward / risk
  rewardRisk: number | null
  roomToTarget: boolean
  nearbyOpposingLevel: boolean   // resistance just above (long) — penalise
  clearInvalidation: boolean
  // Liquidity / execution
  spreadPct: number | null
  liquidVolume: boolean
  priceStable: boolean
  // Confirmation
  confirmationSignals: number    // count of confirmations currently present
  // Repeated-test penalty
  testCount: number
}

/** Per-setup category maximums. Each profile sums to 100. */
const WEIGHTS: Record<SetupType, ScoreBreakdown> = {
  //                     level pa  vol trend cat  rr  liq conf
  pullback:            w(20, 15, 13, 12, 8, 17, 10, 5),
  breakout:            w(22, 12, 18, 8, 9, 14, 12, 5),
  opening_range_break: w(14, 14, 20, 15, 10, 14, 8, 5),
  hod_break:           w(16, 14, 19, 16, 8, 13, 9, 5),
  bull_flag:           w(14, 16, 18, 13, 8, 14, 12, 5),
  break_of_structure:  w(16, 15, 17, 15, 8, 13, 11, 5),
  ema9_bounce:         w(16, 16, 18, 14, 6, 14, 10, 6),
  ema21_bounce:        w(18, 18, 12, 16, 6, 14, 10, 6),
  vwap_bounce:         w(22, 14, 14, 12, 6, 16, 11, 5),
  vwap_reclaim:        w(20, 14, 15, 12, 7, 15, 11, 6),
  level_reclaim:       w(20, 15, 14, 11, 8, 16, 11, 5),
  resistance_rejection:w(22, 15, 14, 11, 6, 16, 11, 5),
  support_breakdown:   w(22, 15, 14, 11, 6, 16, 11, 5),
}

function w(
  levelQuality: number, priceAction: number, volumeMomentum: number,
  trendAlignment: number, catalyst: number, rewardRisk: number,
  liquidity: number, confirmation: number
): ScoreBreakdown {
  return { levelQuality, priceAction, volumeMomentum, trendAlignment, catalyst, rewardRisk, liquidity, confirmation }
}

export interface ScoreResult {
  total: number
  grade: SetupGrade
  breakdown: ScoreBreakdown
  risks: string[]
}

export function scoreSetup(ctx: ScoringContext): ScoreResult {
  const max = WEIGHTS[ctx.setupType]
  const risks: string[] = []

  // ── Level quality (fill 0..1) ──
  let levelFill = 0
  levelFill += Math.min(0.45, ctx.levelStrength / 100 * 0.45)
  levelFill += Math.min(0.25, ctx.levelTouches * 0.08)
  if (ctx.levelHigherTf) levelFill += 0.18
  if (ctx.levelConfluence) levelFill += 0.15
  levelFill = clamp01(levelFill)
  if (ctx.levelStrength < 40) risks.push('Weak / poorly-defined level')

  // ── Price action ──
  let paFill = 0
  if (ctx.structureIntact) paFill += 0.4
  if (ctx.cleanCandles) paFill += 0.3
  if (ctx.constructiveConsolidation) paFill += 0.3
  if (ctx.structureBroken) { paFill = Math.min(paFill, 0.2); risks.push('Market structure broken (LH/LL for a long)') }
  paFill = clamp01(paFill)

  // ── Volume / momentum ──
  let volFill = 0
  const rvol = ctx.relativeVolume ?? 0
  if (rvol >= 5) volFill += 0.4
  else if (rvol >= 2) volFill += 0.28
  else if (rvol >= 1) volFill += 0.15
  else if (ctx.relativeVolume == null) { risks.push('Relative volume unavailable') }
  // Bounces/pullbacks/flags should see selling dry up into the zone; breakouts and
  // structure breaks should see volume EXPAND on the trigger bar.
  const wantsContraction = ctx.setupType === 'pullback' || ctx.setupType === 'bull_flag' || ctx.setupType.includes('bounce')
  const wantsExpansion = ctx.setupType === 'breakout' || ctx.setupType === 'bull_flag' ||
    ctx.setupType === 'break_of_structure' || ctx.setupType === 'vwap_reclaim' || ctx.setupType === 'level_reclaim'
  if (wantsContraction && ctx.volumeContractsIntoZone) volFill += 0.3
  if (wantsExpansion && ctx.volumeExpandsOnSignal) volFill += 0.3
  if (ctx.sustainedInterest) volFill += 0.15
  volFill = clamp01(volFill)

  // ── Trend alignment ──
  let trendFill = 0
  if (ctx.intradayTrendAligned) trendFill += 0.4
  if (ctx.higherTfTrendAligned) trendFill += 0.25
  if (ctx.emaStackAligned) trendFill += 0.2
  if (ctx.aboveVwap === true) trendFill += 0.15
  trendFill = clamp01(trendFill)

  // ── Catalyst ──
  const catFill = clamp01(ctx.catalystScore / 15 * 0.8 + (ctx.unusualVolume ? 0.2 : 0))

  // ── Reward / risk ──
  let rrFill = 0
  const rr = ctx.rewardRisk
  if (rr != null) {
    if (rr >= 3) rrFill += 0.55
    else if (rr >= 2) rrFill += 0.4
    else if (rr >= 1.5) rrFill += 0.25
    else { rrFill += 0.05; risks.push(`Poor reward-to-risk (${rr.toFixed(1)}:1)`) }
  } else {
    risks.push('Reward-to-risk could not be computed')
  }
  if (ctx.roomToTarget) rrFill += 0.2
  if (ctx.clearInvalidation) rrFill += 0.15
  else risks.push('No clear invalidation level')
  if (ctx.nearbyOpposingLevel) { rrFill -= 0.15; risks.push('Opposing level close by — limited room') }
  rrFill = clamp01(rrFill)

  // ── Liquidity / execution ──
  let liqFill = 0
  if (ctx.liquidVolume) liqFill += 0.45
  if (ctx.priceStable) liqFill += 0.25
  if (ctx.spreadPct != null) {
    if (ctx.spreadPct < 0.2) liqFill += 0.3
    else if (ctx.spreadPct < 0.5) liqFill += 0.15
    else risks.push(`Wide spread (${ctx.spreadPct.toFixed(2)}%) — execution risk`)
  } else {
    liqFill += 0.1 // unknown spread — partial credit, flagged below
    risks.push('Spread unavailable')
  }
  liqFill = clamp01(liqFill)

  // ── Confirmation ──
  const confFill = clamp01(ctx.confirmationSignals / 3)

  // ── Repeated-test penalty (support weakens with repetition) ──
  let testPenalty = 0
  if (ctx.testCount >= 4) { testPenalty = 8; risks.push(`Level tested ${ctx.testCount}× — weakening`) }
  else if (ctx.testCount === 3) { testPenalty = 4; risks.push('Third test of level — support fatiguing') }

  const breakdown: ScoreBreakdown = {
    levelQuality: round(levelFill * max.levelQuality),
    priceAction: round(paFill * max.priceAction),
    volumeMomentum: round(volFill * max.volumeMomentum),
    trendAlignment: round(trendFill * max.trendAlignment),
    catalyst: round(catFill * max.catalyst),
    rewardRisk: round(rrFill * max.rewardRisk),
    liquidity: round(liqFill * max.liquidity),
    confirmation: round(confFill * max.confirmation),
  }

  // Round to a whole number — the sub-scores are fractional, and summing them
  // otherwise produces float artifacts (e.g. 63.9999999) in the UI.
  const total = Math.round(Math.max(0, Math.min(100,
    breakdown.levelQuality + breakdown.priceAction + breakdown.volumeMomentum +
    breakdown.trendAlignment + breakdown.catalyst + breakdown.rewardRisk +
    breakdown.liquidity + breakdown.confirmation - testPenalty
  )))

  return { total, grade: gradeFor(total), breakdown, risks }
}

export function gradeFor(total: number): SetupGrade {
  if (total >= 90) return 'A+'
  if (total >= 85) return 'A'
  if (total >= 80) return 'A-'
  if (total >= 75) return 'B+'
  if (total >= 70) return 'B'
  if (total >= 60) return 'C'
  return 'below'
}

export const GRADE_DESCRIPTIONS: Record<SetupGrade, string> = {
  'A+': 'Exceptional setup',
  'A': 'Strong setup',
  'A-': 'Good setup',
  'B+': 'Watch closely',
  'B': 'Developing setup',
  'C': 'Low-confidence watch',
  'below': 'Not an actionable setup',
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)) }
function round(n: number): number { return Math.round(n * 10) / 10 }
