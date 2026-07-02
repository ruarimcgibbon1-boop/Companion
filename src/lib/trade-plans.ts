import type {
  TradePlan,
  TechnicalData,
  SessionLevels,
  SupportResistanceZone,
  CatalystQuality,
  BreakoutStatus,
} from '@/types'

interface Context {
  price: number
  technical: TechnicalData
  levels: SessionLevels
  zones: SupportResistanceZone[]
  catalystQuality: CatalystQuality
  breakout: BreakoutStatus
}

function nearestResistance(price: number, zones: SupportResistanceZone[], levels: SessionLevels): number | null {
  const candidates: number[] = []
  if (levels.regularHigh && levels.regularHigh > price) candidates.push(levels.regularHigh)
  if (levels.premarketHigh && levels.premarketHigh > price) candidates.push(levels.premarketHigh)
  if (levels.previousDayHigh && levels.previousDayHigh > price) candidates.push(levels.previousDayHigh)
  for (const z of zones) {
    if (z.type === 'resistance' && z.midpoint > price) candidates.push(z.midpoint)
  }
  return candidates.sort((a, b) => a - b)[0] ?? null
}

function nextResistance(price: number, first: number | null, zones: SupportResistanceZone[]): number | null {
  if (!first) return null
  const above = zones.filter(z => z.type === 'resistance' && z.midpoint > first + 0.01)
  return above.sort((a, b) => a.midpoint - b.midpoint)[0]?.midpoint ?? null
}

function rr(entry: number, stop: number, target: number): number | null {
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  if (risk <= 0) return null
  return Math.round((reward / risk) * 10) / 10
}

// ── Plan A: Breakout ───────────────────────────────────────────────────────

function buildPlanA(ctx: Context): TradePlan {
  const { price, levels, zones, breakout } = ctx
  const hod = levels.regularHigh ?? levels.premarketHigh
  const t1 = hod ? nextResistance(price, hod, zones) : null
  const t2 = t1 ? nextResistance(price, t1, zones) : null
  const stop = hod ? hod * 0.992 : price * 0.98
  const valid = breakout.state === 'approaching' || breakout.state === 'testing' || breakout.state === 'triggered'

  return {
    label: 'A',
    type: 'Breakout',
    name: 'Breakout Play',
    valid,
    invalidReason: !valid ? `Breakout state is ${breakout.state} — not a setup entry point` : null,
    entryLow: hod ? hod * 1.001 : null,
    entryHigh: hod ? hod * 1.008 : null,
    entryTrigger: `Candle close above ${breakout.levelLabel ?? 'HOD'} on ≥1.5× average volume`,
    confirmation: [
      'Strong green candle close above level',
      'Volume > 1.5× average bar volume',
      'Bid strength visible on Level 2',
      'Spread tightening on approach',
    ],
    stopLoss: stop,
    invalidation: hod ? hod * 0.995 : null,
    targets: [
      ...(t1 ? [{ price: t1, label: 'T1', rewardRisk: rr(hod ?? price, stop, t1) }] : []),
      ...(t2 ? [{ price: t2, label: 'T2', rewardRisk: rr(hod ?? price, stop, t2) }] : []),
    ],
    idealConditions: [
      'First breakout attempt of the day',
      'Volume surging on approach',
      'Clean consolidation below level',
      'Strong market conditions / sector green',
    ],
    avoidWhen: [
      'Multiple failed attempts at same level',
      'Volume declining on approach',
      'Extended from VWAP (>10%)',
      'Wide spread or thin tape',
    ],
    notes: `Breakout above ${breakout.levelLabel ?? 'key resistance'}${hod ? ` ($${hod.toFixed(2)})` : ''}. Wait for candle close, not just intrabar pop.`,
    pullbackDepth: null,
  }
}

// ── Plan B: Pullback ───────────────────────────────────────────────────────

function buildPlanB(ctx: Context): TradePlan {
  const { price, technical, levels, zones } = ctx
  const vwap = levels.vwap
  const ema9 = technical.ema9
  const ema20 = technical.ema20

  // Classify pullback depth from VWAP distance
  const vwapDist = technical.distanceFromVwapPct ?? 0
  const pullbackDepth =
    vwapDist > 10 ? 'deep' : vwapDist > 5 ? 'moderate' : 'shallow'

  // Entry near nearest dynamic support
  const entryLevel = ema9 ?? vwap ?? price * 0.97
  const stop = ema20 ? ema20 * 0.988 : entryLevel * 0.985
  const t1 = nearestResistance(price, zones, levels)
  const t2 = t1 ? nextResistance(price, t1, zones) : null

  const valid = technical.trend5m !== 'down' && technical.higherHighsLows !== false

  return {
    label: 'B',
    type: 'Pullback',
    name: `Pullback — ${pullbackDepth.charAt(0).toUpperCase() + pullbackDepth.slice(1)}`,
    valid,
    invalidReason: !valid ? 'Trend is down or structure is broken — pullback too risky' : null,
    entryLow: entryLevel * 0.997,
    entryHigh: entryLevel * 1.003,
    entryTrigger: 'Bullish candle at dynamic support with volume contraction on pullback',
    confirmation: [
      'Volume drying up on pullback (decreasing bars)',
      'Bounce candle engulfs prior candle',
      'Price holds above entry level on close',
    ],
    stopLoss: stop,
    invalidation: stop,
    targets: [
      ...(t1 ? [{ price: t1, label: 'T1 (HOD/Resistance)', rewardRisk: rr(entryLevel, stop, t1) }] : []),
      ...(t2 ? [{ price: t2, label: 'T2 (Next Zone)', rewardRisk: rr(entryLevel, stop, t2) }] : []),
    ],
    idealConditions: [
      'First pullback of the day in an uptrend',
      'Volume contracting on red candles',
      'Holding above VWAP and 9 EMA',
      `${pullbackDepth === 'shallow' ? 'Small retracement — momentum intact' : pullbackDepth === 'moderate' ? 'Medium retracement testing EMA' : 'Deep retracement — higher reward if holds'}`,
    ],
    avoidWhen: [
      'Lower highs and lower lows forming',
      'Heavy sell volume on pullback',
      'VWAP lost on multiple candles',
      'Pullback extends past 20 EMA without holding',
    ],
    notes: `${pullbackDepth === 'deep' ? 'Deep pullback — size smaller, wait for strong bounce candle.' : pullbackDepth === 'moderate' ? 'Moderate pullback testing key EMAs.' : 'Shallow pullback — momentum likely intact.'}`,
    pullbackDepth,
  }
}

// ── Plan C: Reclaim ────────────────────────────────────────────────────────

function buildPlanC(ctx: Context): TradePlan {
  const { price, technical, levels, zones } = ctx
  const vwap = levels.vwap
  const belowVwap = vwap != null && price < vwap

  const reclaimLevel = vwap ?? technical.ema20 ?? null
  const stop = reclaimLevel ? reclaimLevel * 0.993 : price * 0.985
  const t1 = nearestResistance(price, zones, levels) ?? (reclaimLevel ? reclaimLevel * 1.02 : null)
  const t2 = t1 ? nextResistance(price, t1, zones) : null

  const valid = belowVwap || (technical.vwapCrossCount <= 2)

  return {
    label: 'C',
    type: 'Reclaim',
    name: 'VWAP / EMA Reclaim',
    valid,
    invalidReason: !valid ? 'Price already above VWAP and reclaim conditions not met' : null,
    entryLow: reclaimLevel ? reclaimLevel * 1.001 : null,
    entryHigh: reclaimLevel ? reclaimLevel * 1.007 : null,
    entryTrigger: `Candle closes above ${reclaimLevel && vwap && Math.abs(reclaimLevel - vwap) < 0.01 ? 'VWAP' : 'key EMA'} and holds for 1 full candle`,
    confirmation: [
      'Successful retest of reclaimed level from above',
      'Volume picks up on reclaim candle',
      'No immediate fade back below',
    ],
    stopLoss: stop,
    invalidation: reclaimLevel ? reclaimLevel * 0.995 : null,
    targets: [
      ...(t1 ? [{ price: t1, label: 'T1', rewardRisk: rr(reclaimLevel ?? price, stop, t1) }] : []),
      ...(t2 ? [{ price: t2, label: 'T2', rewardRisk: rr(reclaimLevel ?? price, stop, t2) }] : []),
    ],
    idealConditions: [
      'Clean loss and reclaim of VWAP',
      'First reclaim attempt',
      'Broader market recovering',
      'Catalyst still intact',
    ],
    avoidWhen: [
      'Multiple VWAP failures (chop zone)',
      'No catalyst or catalyst fading',
      'Declining overall market',
      'Very wide spread or thin tape',
    ],
    notes: 'Reclaim setups require patience — wait for the candle close above, then look for retest of the level as support.',
    pullbackDepth: null,
  }
}

// ── Plan D: No-Trade ──────────────────────────────────────────────────────

function buildPlanD(ctx: Context): TradePlan {
  const { technical, breakout, catalystQuality } = ctx
  const reasons: string[] = []

  if (catalystQuality === 'No Recent Catalyst Found') reasons.push('No identifiable catalyst')
  if (catalystQuality === 'Negative or Dilutive Catalyst') reasons.push('Dilutive or negative catalyst present')
  if (technical.lowerHighsLows) reasons.push('Lower highs and lower lows — broken structure')
  if ((technical.distanceFromVwapPct ?? 0) > 15) reasons.push('Excessively extended from VWAP')
  if (breakout.state === 'failed') reasons.push('Breakout already failed — avoid re-entry until new structure forms')
  if (technical.vwapCrossCount > 5) reasons.push('Too many VWAP crosses — price is churning, not trending')
  if ((technical.rsi14 ?? 50) > 85) reasons.push('RSI extremely overbought')

  return {
    label: 'D',
    type: 'No-Trade',
    name: 'No-Trade / Stand Aside',
    valid: true,
    invalidReason: null,
    entryLow: null,
    entryHigh: null,
    entryTrigger: 'N/A — stand aside',
    confirmation: [],
    stopLoss: null,
    invalidation: null,
    targets: [],
    idealConditions: [],
    avoidWhen: [],
    notes:
      reasons.length > 0
        ? `Conditions favour staying out: ${reasons.join('; ')}.`
        : 'No specific red flags but no high-conviction setup present either. Patience is the trade.',
    pullbackDepth: null,
  }
}

// ── Main export ───────────────────────────────────────────────────────────

export function buildTradePlans(ctx: Context): TradePlan[] {
  return [buildPlanA(ctx), buildPlanB(ctx), buildPlanC(ctx), buildPlanD(ctx)]
}

export function calcPosition(
  accountSize: number,
  maxRiskPct: number,
  entry: number,
  stop: number
) {
  const maxMonetaryRisk = accountSize * (maxRiskPct / 100)
  const riskPerShare = Math.abs(entry - stop)
  const maxShares = riskPerShare > 0 ? Math.floor(maxMonetaryRisk / riskPerShare) : 0
  const positionValue = maxShares * entry

  const riskRewardTargets = [1.5, 2, 2.5, 3, 4].map(ratio => ({
    ratio,
    targetPrice: entry + ratio * riskPerShare * (entry > stop ? 1 : -1),
    profit: maxShares * ratio * riskPerShare,
  }))

  return {
    maxMonetaryRisk,
    riskPerShare,
    maxShares,
    positionValue,
    riskRewardTargets,
  }
}
