import type { Candle, SessionLevels, TechnicalData, SupportResistanceZone, BreakoutStatus } from '@/types'

interface CandidateLevel {
  price: number
  label: string
}

function gatherKeyLevels(
  levels: SessionLevels,
  technical: TechnicalData,
  zones: SupportResistanceZone[],
  currentPrice: number
): CandidateLevel[] {
  const candidates: CandidateLevel[] = []

  const add = (price: number | null | undefined, label: string) => {
    if (price != null && price > 0 && Math.abs(price - currentPrice) / currentPrice < 0.08) {
      candidates.push({ price, label })
    }
  }

  add(levels.regularHigh, 'Day High')
  add(levels.premarketHigh, 'Premarket High')
  add(levels.previousDayHigh, 'Prev Day High')
  add(levels.or5High, '5-min OR High')
  add(levels.or15High, '15-min OR High')
  add(levels.vwap, 'VWAP')
  add(technical.ema9, '9 EMA')
  add(technical.ma50Daily, '50-day MA')
  add(technical.ma200Daily, '200-day MA')

  // Add strong resistance zones above price
  for (const z of zones) {
    if (z.type === 'resistance' && z.strengthScore >= 5) {
      add(z.midpoint, z.reasons[0] ?? 'Resistance Zone')
    }
  }

  return candidates
}

function selectNearestResistance(
  candidates: CandidateLevel[],
  currentPrice: number
): CandidateLevel | null {
  const above = candidates
    .filter(c => c.price > currentPrice)
    .sort((a, b) => a.price - b.price)
  return above[0] ?? null
}

export function detectBreakout(
  candles: Candle[],
  levels: SessionLevels,
  technical: TechnicalData,
  zones: SupportResistanceZone[],
  currentPrice: number
): BreakoutStatus {
  const none: BreakoutStatus = {
    state: 'none',
    level: null,
    levelLabel: null,
    distancePct: null,
    volumeConfirms: false,
    canCloseConfirm: false,
    description: 'No key level nearby',
  }

  if (!candles.length) return none

  const candidates = gatherKeyLevels(levels, technical, zones, currentPrice)
  const nearest = selectNearestResistance(candidates, currentPrice)
  if (!nearest) return none

  const { price: keyLevel, label: levelLabel } = nearest
  const distancePct = ((currentPrice - keyLevel) / keyLevel) * 100
  const absPct = Math.abs(distancePct)

  const recentCandles = candles.slice(-20)
  const avgVol = recentCandles.reduce((s, c) => s + c.volume, 0) / (recentCandles.length || 1)
  const lastCandle = candles[candles.length - 1]
  const volumeConfirms = lastCandle ? lastCandle.volume > avgVol * 1.3 : false
  const canCloseConfirm = lastCandle ? lastCandle.close > keyLevel && lastCandle.open < keyLevel : false

  // Extended: price is already well above the level
  if (distancePct > 5) {
    return {
      state: 'extended',
      level: keyLevel,
      levelLabel,
      distancePct,
      volumeConfirms,
      canCloseConfirm: false,
      description: `Price is ${distancePct.toFixed(1)}% above ${levelLabel} — extended, avoid chasing`,
    }
  }

  // Confirmed: candle closed above, volume supports
  if (distancePct > 0.5 && distancePct <= 5) {
    // Check if it was a fake breakout by looking for candle that closed below after being above
    const closedAbove = recentCandles.filter(c => c.close > keyLevel)
    const closedBelow = recentCandles.slice(-5).filter(c => c.close < keyLevel * 0.998)
    if (closedAbove.length > 0 && closedBelow.length > 0) {
      return {
        state: 'failed',
        level: keyLevel,
        levelLabel,
        distancePct,
        volumeConfirms,
        canCloseConfirm: false,
        description: `Breakout above ${levelLabel} failed — price reversed back below`,
      }
    }
    if (volumeConfirms) {
      return {
        state: 'confirmed',
        level: keyLevel,
        levelLabel,
        distancePct,
        volumeConfirms,
        canCloseConfirm: false,
        description: `Breakout above ${levelLabel} at $${keyLevel.toFixed(2)} confirmed with volume`,
      }
    }
    return {
      state: 'triggered',
      level: keyLevel,
      levelLabel,
      distancePct,
      volumeConfirms: false,
      canCloseConfirm: false,
      description: `Breakout above ${levelLabel} triggered — waiting for volume confirmation`,
    }
  }

  // Testing: within 0.5% below
  if (absPct <= 0.5 && distancePct <= 0) {
    return {
      state: 'testing',
      level: keyLevel,
      levelLabel,
      distancePct,
      volumeConfirms,
      canCloseConfirm,
      description: `Testing ${levelLabel} at $${keyLevel.toFixed(2)} — ${canCloseConfirm ? 'watch for close above' : 'no close confirmation yet'}`,
    }
  }

  // Approaching: within 2% below
  if (absPct <= 2 && distancePct < 0) {
    return {
      state: 'approaching',
      level: keyLevel,
      levelLabel,
      distancePct,
      volumeConfirms: false,
      canCloseConfirm: false,
      description: `Approaching ${levelLabel} at $${keyLevel.toFixed(2)} — ${absPct.toFixed(1)}% away`,
    }
  }

  return none
}
