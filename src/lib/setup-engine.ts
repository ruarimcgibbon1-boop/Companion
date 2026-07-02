import type {
  TechnicalData,
  SessionLevels,
  SupportResistanceZone,
  PullbackScenario,
  SetupScore,
  SetupStatus,
  CatalystQuality,
} from '@/types'

export function calculatePullbackScenarios(
  price: number,
  technical: TechnicalData,
  levels: SessionLevels,
  zones: SupportResistanceZone[]
): PullbackScenario[] {
  const scenarios: PullbackScenario[] = []
  const now = Date.now() / 1000

  const supports = zones.filter(z => z.type === 'support' && z.midpoint < price)
  const vwap = levels.vwap
  const ema9 = technical.ema9
  const ema20 = technical.ema20
  const rsi = technical.rsi14

  // Helper
  const findNearestResistance = (above: number) =>
    zones.filter(z => z.midpoint > above).sort((a, b) => a.midpoint - b.midpoint)[0]?.midpoint ?? null

  // 1. VWAP retest
  if (vwap && price > vwap * 1.01) {
    const entry = { low: vwap * 0.997, high: vwap * 1.003 }
    const t1 = findNearestResistance(price)
    const t2 = t1 ? findNearestResistance(t1 + 0.01) : null
    const stopBelow = vwap * 0.992
    const rr = t1 ? (t1 - entry.high) / (entry.low - stopBelow) : null
    scenarios.push({
      name: 'VWAP Retest',
      entryZoneLow: entry.low,
      entryZoneHigh: entry.high,
      confirmation: 'Price holds above VWAP on a retest with declining sell volume',
      trigger: 'Bullish candle close above VWAP after touch',
      invalidation: stopBelow,
      target1: t1,
      target2: t2,
      rewardRisk: rr && rr > 0 ? rr : null,
      whatMakesStronger: ['Volume dries up on pullback', 'First test of VWAP', 'Strong overall market'],
      whatMakesWeaker: ['Multiple VWAP failures', 'Heavy sell volume', 'Weak market'],
      volumeConfirms: technical.volumeTrend === 'decreasing',
      isChasing: false,
      confidenceScore: 65,
      timestamp: now,
    })
  }

  // 2. 9 EMA pullback
  if (ema9 && price > ema9 * 1.01) {
    const entry = { low: ema9 * 0.997, high: ema9 * 1.005 }
    const t1 = findNearestResistance(price)
    const stopBelow = ema9 * 0.990
    const rr = t1 ? (t1 - entry.high) / (entry.low - stopBelow) : null
    scenarios.push({
      name: '9 EMA Pullback',
      entryZoneLow: entry.low,
      entryZoneHigh: entry.high,
      confirmation: 'Candle holds 9 EMA, bids showing on tape',
      trigger: 'Bullish engulfing or hammer near 9 EMA',
      invalidation: stopBelow,
      target1: t1,
      target2: null,
      rewardRisk: rr && rr > 0 ? rr : null,
      whatMakesStronger: ['Trending strongly, volume drying', 'EMA sloping up', 'RSI not overbought'],
      whatMakesWeaker: ['EMA flattening', 'Volume heavy on pullback', 'Multiple tests'],
      volumeConfirms: technical.volumeTrend !== 'increasing',
      isChasing: price > ema9 * 1.05,
      confidenceScore: 60,
      timestamp: now,
    })
  }

  // 3. 20 EMA pullback
  if (ema20 && price > ema20 * 1.01) {
    const entry = { low: ema20 * 0.995, high: ema20 * 1.005 }
    const t1 = findNearestResistance(price)
    const stopBelow = ema20 * 0.988
    const rr = t1 ? (t1 - entry.high) / (entry.low - stopBelow) : null
    scenarios.push({
      name: '20 EMA Pullback',
      entryZoneLow: entry.low,
      entryZoneHigh: entry.high,
      confirmation: 'Price stabilises at 20 EMA with tight candles',
      trigger: 'Bullish close above 20 EMA after test',
      invalidation: stopBelow,
      target1: t1,
      target2: null,
      rewardRisk: rr && rr > 0 ? rr : null,
      whatMakesStronger: ['Clean first test', 'VWAP held above 20 EMA'],
      whatMakesWeaker: ['Price accelerating through 20 EMA', 'Market weakness'],
      volumeConfirms: technical.volumeTrend !== 'increasing',
      isChasing: price > ema20 * 1.08,
      confidenceScore: 55,
      timestamp: now,
    })
  }

  // 4. Support zone pullback
  for (const zone of supports.slice(0, 2)) {
    if (zone.strengthScore < 4) continue
    const t1 = findNearestResistance(price)
    const stopBelow = zone.lower * 0.99
    const rr = t1 ? (t1 - zone.upper) / (zone.midpoint - stopBelow) : null
    scenarios.push({
      name: `Support Zone Pullback (${zone.reasons[0]})`,
      entryZoneLow: zone.lower,
      entryZoneHigh: zone.upper,
      confirmation: `Price holds ${zone.reasons[0]} zone with decreasing volume`,
      trigger: 'Bounce with increasing buy volume from zone',
      invalidation: stopBelow,
      target1: t1,
      target2: null,
      rewardRisk: rr && rr > 0 ? rr : null,
      whatMakesStronger: zone.reasons.map(r => `${r} acting as support`),
      whatMakesWeaker: ['Zone tested multiple times', 'Heavy volume into zone'],
      volumeConfirms: technical.volumeTrend !== 'increasing',
      isChasing: false,
      confidenceScore: Math.min(80, zone.strengthScore * 7),
      timestamp: now,
    })
  }

  // 5. High-of-day breakout retest
  if (levels.regularHigh && price > levels.regularHigh * 0.99) {
    const hod = levels.regularHigh
    const entry = { low: hod * 0.997, high: hod * 1.003 }
    const t1 = findNearestResistance(hod * 1.005)
    const stopBelow = hod * 0.990
    const rr = t1 ? (t1 - entry.high) / (entry.low - stopBelow) : null
    scenarios.push({
      name: 'HOD Breakout Retest',
      entryZoneLow: entry.low,
      entryZoneHigh: entry.high,
      confirmation: 'Prior high-of-day becomes support on retest',
      trigger: 'Bullish candle after retesting HOD from above',
      invalidation: stopBelow,
      target1: t1,
      target2: null,
      rewardRisk: rr && rr > 0 ? rr : null,
      whatMakesStronger: ['Clean breakout on volume', 'First pullback', 'Market following'],
      whatMakesWeaker: ['Multiple attempts at HOD', 'Fading volume on breakout'],
      volumeConfirms: true,
      isChasing: false,
      confidenceScore: 70,
      timestamp: now,
    })
  }

  // Extension check — suppress scenarios when overextended
  const isExtended =
    (technical.distanceFromVwapPct ?? 0) > 8 ||
    (rsi !== null && rsi > 80) ||
    technical.lowerHighsLows === true

  if (isExtended && scenarios.length > 0) {
    // Reduce confidence on all scenarios
    for (const s of scenarios) {
      s.confidenceScore = Math.max(20, s.confidenceScore - 20)
    }
  }

  return scenarios.sort((a, b) => b.confidenceScore - a.confidenceScore).slice(0, 4)
}

export function calculateSetupScore(
  technical: TechnicalData,
  scenarios: PullbackScenario[],
  zones: SupportResistanceZone[],
  catalystQuality: CatalystQuality
): SetupScore {
  // Trend & structure (20)
  let trendStructure = 0
  if (technical.higherHighsLows) trendStructure += 8
  if (technical.trend5m === 'up') trendStructure += 4
  if (technical.trend15m === 'up') trendStructure += 4
  if (!technical.lowerHighsLows) trendStructure += 4
  trendStructure = Math.min(20, trendStructure)

  // Volume & liquidity (15)
  let volumeLiquidity = 0
  const rvol = technical.relativeVolume ?? 0
  if (rvol > 5) volumeLiquidity += 10
  else if (rvol > 2) volumeLiquidity += 6
  else if (rvol > 1) volumeLiquidity += 3
  if (technical.volumeTrend === 'increasing') volumeLiquidity += 5
  volumeLiquidity = Math.min(15, volumeLiquidity)

  // Catalyst (15)
  let catalystScore = 0
  if (catalystQuality === 'Strong Confirmed Catalyst') catalystScore = 15
  else if (catalystQuality === 'Moderate Catalyst') catalystScore = 10
  else if (catalystQuality === 'Weak or Recycled Catalyst') catalystScore = 5
  else if (catalystQuality === 'Negative or Dilutive Catalyst') catalystScore = 0

  // Pullback quality (20)
  let pullbackQuality = 0
  if (scenarios.length > 0) {
    const best = scenarios[0]
    pullbackQuality = Math.round((best.confidenceScore / 100) * 20)
    if (best.volumeConfirms) pullbackQuality += 3
    if (!best.isChasing) pullbackQuality += 2
    if (best.rewardRisk && best.rewardRisk >= 2) pullbackQuality += 2
  }
  pullbackQuality = Math.min(20, pullbackQuality)

  // SR clarity (10)
  let srClarity = 0
  const strongZones = zones.filter(z => z.strengthScore >= 6)
  srClarity = Math.min(10, strongZones.length * 3)

  // Reward/risk (10)
  let rewardRisk = 0
  const bestRR = scenarios.reduce<number | null>((m, s) => {
    if (s.rewardRisk === null) return m
    return m === null ? s.rewardRisk : Math.max(m, s.rewardRisk)
  }, null)
  if (bestRR !== null) {
    if (bestRR >= 3) rewardRisk = 10
    else if (bestRR >= 2) rewardRisk = 7
    else if (bestRR >= 1.5) rewardRisk = 4
    else rewardRisk = 1
  }

  // Extension risk (10) — higher score means LESS risk
  let extensionRisk = 10
  const vwapDist = technical.distanceFromVwapPct ?? 0
  if (vwapDist > 15) extensionRisk = 0
  else if (vwapDist > 10) extensionRisk = 3
  else if (vwapDist > 6) extensionRisk = 6
  if (technical.rsi14 && technical.rsi14 > 80) extensionRisk = Math.max(0, extensionRisk - 3)
  if (technical.lowerHighsLows) extensionRisk = Math.max(0, extensionRisk - 3)

  const total = trendStructure + volumeLiquidity + catalystScore + pullbackQuality + srClarity + rewardRisk + extensionRisk

  const classification =
    total >= 85
      ? 'Exceptional structure — still requires confirmation'
      : total >= 75
      ? 'Strong watch'
      : total >= 65
      ? 'Developing setup'
      : total >= 50
      ? 'Mixed'
      : 'Avoid or insufficient evidence'

  const status: SetupStatus =
    total >= 75 && !technical.lowerHighsLows
      ? 'Constructive'
      : total >= 65
      ? 'Developing'
      : vwapDist > 10 || (technical.rsi14 ?? 0) > 80
      ? 'Extended'
      : technical.lowerHighsLows
      ? 'Weakening'
      : total < 40
      ? 'No Clean Setup'
      : 'Developing'

  return {
    total,
    breakdown: {
      trendStructure,
      volumeLiquidity,
      catalystQuality: catalystScore,
      pullbackQuality,
      srClarity,
      rewardRisk,
      extensionRisk,
    },
    classification,
    status,
  }
}

export function getWarnings(
  technical: TechnicalData,
  price: number,
  scenarios: PullbackScenario[]
): string[] {
  const warnings: string[] = []
  const vwapDist = technical.distanceFromVwapPct ?? 0
  const rsi = technical.rsi14 ?? 50

  if (vwapDist > 15) warnings.push('Price is excessively extended above VWAP')
  if (technical.ema9 && price > technical.ema9 * 1.08) warnings.push('Price extended above 9 EMA — pullback risk')
  if (rsi > 80) warnings.push(`RSI ${rsi.toFixed(0)} — overbought territory`)
  if (technical.volumeTrend === 'decreasing' && technical.trend5m === 'up') {
    warnings.push('Volume fading while price rising — momentum divergence')
  }
  if (technical.lowerHighsLows) warnings.push('Lower highs and lower lows — trend weakening')
  if (technical.vwapCrossCount > 4) warnings.push('VWAP has been crossed multiple times — indecisive action')
  if (scenarios.every(s => s.isChasing)) warnings.push('All current scenarios involve chasing — no clean entry')
  if (technical.distanceFromDayHighPct && technical.distanceFromDayHighPct < -8) {
    warnings.push('Price well below day high — momentum may have shifted')
  }

  return warnings
}
