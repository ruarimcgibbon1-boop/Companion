/**
 * Support & Resistance levels engine.
 *
 * Produces a ranked set of merged KeyLevel zones from every meaningful source
 * (session levels, swings, EMAs, VWAP, whole/half dollars, gap fills,
 * consolidations, volume shelves). Each zone carries a 0-100 strength score,
 * its contributing sources, touch count, recency, and the setup we'd expect
 * if price returns there.
 *
 * Pure + deterministic — no invented data. When a source is unavailable it is
 * simply omitted rather than fabricated.
 */

import type {
  Candle,
  SessionLevels,
  TechnicalData,
  KeyLevel,
  LevelSource,
  SetupType,
} from '@/types'

interface RawLevel {
  price: number
  source: LevelSource
  label: string
  dynamic: boolean
  /** Higher-timeframe (daily) levels get a relevance boost. */
  higherTf: boolean
  /** Premarket-derived level. */
  premarket: boolean
}

const LABELS: Record<LevelSource, string> = {
  premarket_high: 'Premarket High',
  premarket_low: 'Premarket Low',
  prev_day_high: 'Prev Day High',
  prev_day_low: 'Prev Day Low',
  prev_close: 'Prev Close',
  day_high: 'High of Day',
  day_low: 'Low of Day',
  or5_high: '5-min OR High',
  or5_low: '5-min OR Low',
  or15_high: '15-min OR High',
  or15_low: '15-min OR Low',
  swing_high: 'Swing High',
  swing_low: 'Swing Low',
  daily_swing_high: 'Daily Swing High',
  daily_swing_low: 'Daily Swing Low',
  gap_fill: 'Gap Fill',
  consolidation_high: 'Consolidation High',
  consolidation_low: 'Consolidation Low',
  whole_dollar: 'Whole Dollar',
  half_dollar: 'Half Dollar',
  ema9: '9 EMA',
  ema21: '21 EMA',
  vwap: 'VWAP',
  ma50: '50-day MA',
  ma200: '200-day MA',
  volume_shelf: 'Volume Shelf',
  breakout_retest: 'Breakout Retest',
}

const DYNAMIC_SOURCES = new Set<LevelSource>(['ema9', 'ema21', 'vwap', 'ma50', 'ma200'])

/** Expected setup when price returns to a level, given its source + side. */
function expectedSetupFor(source: LevelSource, kind: 'support' | 'resistance'): SetupType | null {
  if (source === 'vwap') return kind === 'support' ? 'vwap_bounce' : 'vwap_reclaim'
  if (source === 'ema9') return 'ema9_bounce'
  if (source === 'ema21') return 'ema21_bounce'
  if (kind === 'resistance') return 'breakout'
  return 'pullback'
}

export interface LevelsEngineInput {
  intraday: Candle[]
  daily: Candle[]
  sessionLevels: SessionLevels
  technical: TechnicalData
  currentPrice: number
  nowTs?: number   // simulated "now" for replay/backtest; defaults to live
}

export function buildKeyLevels(input: LevelsEngineInput): KeyLevel[] {
  const { intraday, daily, sessionLevels: sl, technical: t, currentPrice } = input
  const nowTs = input.nowTs ?? Date.now()
  if (currentPrice <= 0) return []

  const atr = t.atr && t.atr > 0 ? t.atr : currentPrice * 0.01
  // Merge distance: ~0.4× ATR, clamped to a sane percentage band.
  const mergeDist = Math.min(currentPrice * 0.02, Math.max(currentPrice * 0.0025, atr * 0.4))
  // Zone half-width: ~0.2× ATR.
  const halfWidth = Math.max(currentPrice * 0.0015, atr * 0.2)

  const raw: RawLevel[] = []
  const add = (
    price: number | null | undefined,
    source: LevelSource,
    opts: { higherTf?: boolean; premarket?: boolean } = {}
  ) => {
    if (price == null || !isFinite(price) || price <= 0) return
    // Ignore levels absurdly far from price (>25%) — not actionable intraday.
    if (Math.abs(price - currentPrice) / currentPrice > 0.25) return
    raw.push({
      price,
      source,
      label: LABELS[source],
      dynamic: DYNAMIC_SOURCES.has(source),
      higherTf: opts.higherTf ?? false,
      premarket: opts.premarket ?? false,
    })
  }

  // Session levels
  add(sl.premarketHigh, 'premarket_high', { premarket: true })
  add(sl.premarketLow, 'premarket_low', { premarket: true })
  add(sl.previousDayHigh, 'prev_day_high', { higherTf: true })
  add(sl.previousDayLow, 'prev_day_low', { higherTf: true })
  add(sl.previousClose, 'prev_close', { higherTf: true })
  add(sl.regularHigh, 'day_high')
  add(sl.regularLow, 'day_low')
  add(sl.or5High, 'or5_high')
  add(sl.or5Low, 'or5_low')
  add(sl.or15High, 'or15_high')
  add(sl.or15Low, 'or15_low')

  // Dynamic references
  add(sl.vwap, 'vwap')
  add(t.ema9, 'ema9')
  add(t.ema20, 'ema21') // engine treats the 20/21 EMA slot as the "21 EMA" reference
  add(t.ma50Daily, 'ma50', { higherTf: true })
  add(t.ma200Daily, 'ma200', { higherTf: true })

  // Whole / half dollar levels around price
  const base = Math.floor(currentPrice)
  const dollarSpan = currentPrice < 5 ? 1 : currentPrice < 20 ? 2 : 4
  for (let i = base - dollarSpan; i <= base + dollarSpan + 1; i++) {
    add(i, 'whole_dollar')
    add(i + 0.5, 'half_dollar')
  }

  // Intraday swings
  const swings = findSwings(intraday, 3)
  for (const s of swings.highs) add(s, 'swing_high')
  for (const s of swings.lows) add(s, 'swing_low')

  // Daily swings (higher timeframe)
  const dailySwings = findSwings(daily, 2)
  for (const s of dailySwings.highs) add(s, 'daily_swing_high', { higherTf: true })
  for (const s of dailySwings.lows) add(s, 'daily_swing_low', { higherTf: true })

  // Gap fill — prior close is the target when today gapped
  if (sl.previousClose && sl.openingPrint && Math.abs(sl.openingPrint - sl.previousClose) / sl.previousClose > 0.02) {
    add(sl.previousClose, 'gap_fill', { higherTf: true })
  }

  // Consolidation zones + volume shelves from intraday
  const consolidations = findConsolidations(intraday)
  for (const c of consolidations) {
    add(c.high, 'consolidation_high')
    add(c.low, 'consolidation_low')
  }
  const shelves = findVolumeShelves(intraday, halfWidth)
  for (const s of shelves) add(s, 'volume_shelf')

  if (raw.length === 0) return []

  // ── Merge nearby levels into zones ────────────────────────────────────────
  raw.sort((a, b) => a.price - b.price)
  interface Cluster {
    prices: number[]
    sources: LevelSource[]
    labels: string[]
    higherTf: boolean
    premarket: boolean
    dynamic: boolean
  }
  const clusters: Cluster[] = []
  for (const r of raw) {
    const last = clusters[clusters.length - 1]
    const anchor = last ? last.prices[last.prices.length - 1] : null
    if (last && anchor != null && Math.abs(anchor - r.price) <= mergeDist) {
      last.prices.push(r.price)
      if (!last.sources.includes(r.source)) last.sources.push(r.source)
      if (!last.labels.includes(r.label)) last.labels.push(r.label)
      last.higherTf = last.higherTf || r.higherTf
      last.premarket = last.premarket || r.premarket
      last.dynamic = last.dynamic || r.dynamic
    } else {
      clusters.push({
        prices: [r.price],
        sources: [r.source],
        labels: [r.label],
        higherTf: r.higherTf,
        premarket: r.premarket,
        dynamic: r.dynamic,
      })
    }
  }

  // ── Score each cluster ────────────────────────────────────────────────────
  const levels: KeyLevel[] = clusters.map(c => {
    const midpoint = c.prices.reduce((a, b) => a + b, 0) / c.prices.length
    const lower = midpoint - halfWidth
    const upper = midpoint + halfWidth
    const kind: 'support' | 'resistance' = midpoint <= currentPrice ? 'support' : 'resistance'

    const { touches, lastReactionAt, volumeAtLevel, actedBothSides, controlledApproach } =
      analyzeReactions(intraday, midpoint, halfWidth, currentPrice)

    const hasConfluence = c.sources.some(s => s === 'vwap' || s === 'ema9' || s === 'ema21')
    const hasRoundConfluence = c.sources.some(s => s === 'whole_dollar' || s === 'half_dollar')

    // ── Strength (0-100) ──
    let strength = 0
    strength += Math.min(24, c.sources.length * 8)          // confluence of distinct sources
    strength += Math.min(24, touches * 8)                   // prior reactions
    if (c.higherTf) strength += 12                          // higher-timeframe relevance
    if (c.premarket) strength += 6                          // premarket relevance
    if (hasConfluence) strength += 10                       // VWAP/EMA confluence
    if (hasRoundConfluence) strength += 6                   // psychological confluence
    if (actedBothSides) strength += 8                       // flipped S<->R
    // Recency: reactions within last 45 min score higher
    if (lastReactionAt) {
      const ageMin = (nowTs - lastReactionAt) / 60000
      if (ageMin < 15) strength += 8
      else if (ageMin < 45) strength += 4
    }
    // Volume traded near level (relative to typical bar)
    if (volumeAtLevel > 0) strength += Math.min(6, volumeAtLevel)
    // Controlled consolidation into the level is more reliable than a spike
    if (controlledApproach) strength += 4
    // Proximity: obvious nearby levels matter more than distant ones
    const distPct = Math.abs(midpoint - currentPrice) / currentPrice * 100
    if (distPct > 15) strength -= 10
    else if (distPct > 8) strength -= 4

    strength = Math.max(1, Math.min(100, Math.round(strength)))

    // Expected setup — prefer the strongest signal source in the cluster
    const primary = pickPrimarySource(c.sources)
    const expectedSetup = expectedSetupFor(primary, kind)

    return {
      lower,
      upper,
      midpoint,
      kind,
      strength,
      sources: c.sources,
      sourceLabels: c.labels,
      touches,
      lastReactionAt,
      expectedSetup,
      dynamic: c.dynamic,
      hasConfluence: hasConfluence || hasRoundConfluence,
    }
  })

  // Rank: strongest first, then nearest.
  return levels
    .sort((a, b) => {
      if (b.strength !== a.strength) return b.strength - a.strength
      return Math.abs(a.midpoint - currentPrice) - Math.abs(b.midpoint - currentPrice)
    })
    .slice(0, 16)
}

// Prefer dynamic/round sources for setup classification when present.
function pickPrimarySource(sources: LevelSource[]): LevelSource {
  const priority: LevelSource[] = ['vwap', 'ema9', 'ema21', 'day_high', 'premarket_high', 'prev_day_high']
  for (const p of priority) if (sources.includes(p)) return p
  return sources[0]
}

function findSwings(candles: Candle[], n: number): { highs: number[]; lows: number[] } {
  const highs: number[] = []
  const lows: number[] = []
  for (let i = n; i < candles.length - n; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) isHigh = false
      if (candles[j].low <= c.low) isLow = false
    }
    if (isHigh) highs.push(c.high)
    if (isLow) lows.push(c.low)
  }
  return { highs, lows }
}

/** Find tight consolidation ranges (>=4 bars within a small band). */
function findConsolidations(candles: Candle[]): Array<{ high: number; low: number }> {
  const out: Array<{ high: number; low: number }> = []
  const window = 6
  for (let i = 0; i + window <= candles.length; i += window) {
    const slice = candles.slice(i, i + window)
    const hi = Math.max(...slice.map(c => c.high))
    const lo = Math.min(...slice.map(c => c.low))
    const mid = (hi + lo) / 2
    if (mid > 0 && (hi - lo) / mid < 0.02) {
      out.push({ high: hi, low: lo })
    }
  }
  return out.slice(-4)
}

/** Price buckets where the most volume traded — high-volume nodes / shelves. */
function findVolumeShelves(candles: Candle[], bucketSize: number): number[] {
  if (candles.length < 10 || bucketSize <= 0) return []
  const buckets = new Map<number, number>()
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3
    const key = Math.round(tp / bucketSize)
    buckets.set(key, (buckets.get(key) ?? 0) + c.volume)
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1])
  return sorted.slice(0, 3).map(([key]) => key * bucketSize)
}

function analyzeReactions(
  candles: Candle[],
  price: number,
  tolerance: number,
  currentPrice: number
): {
  touches: number
  lastReactionAt: number | null
  volumeAtLevel: number
  actedBothSides: boolean
  controlledApproach: boolean
} {
  let touches = 0
  let inZone = false
  let lastReactionAt: number | null = null
  let volNear = 0
  let volTotal = 0
  let bounceCount = 0
  let closesAbove = 0
  let closesBelow = 0
  let bigSpikeIntoZone = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const near = c.low <= price + tolerance && c.high >= price - tolerance
    volTotal += c.volume
    if (near) {
      volNear += c.volume
      if (!inZone) {
        touches++
        lastReactionAt = c.time * 1000
        inZone = true
        // Did the prior candle approach with a large range (spike) vs tight (controlled)?
        const prev = candles[i - 1]
        if (prev) {
          const prevRange = (prev.high - prev.low) / (prev.close || 1)
          if (prevRange > 0.03) bigSpikeIntoZone++
        }
        // Bounce = closed away from the level after touching
        if (c.close > price + tolerance || c.close < price - tolerance) bounceCount++
      }
      if (c.close > price) closesAbove++
      else closesBelow++
    } else {
      inZone = false
    }
  }

  const avgBarVol = volTotal / (candles.length || 1)
  const volumeAtLevel = avgBarVol > 0 ? volNear / avgBarVol : 0
  const actedBothSides = closesAbove > 0 && closesBelow > 0 && Math.min(closesAbove, closesBelow) >= 2
  const controlledApproach = touches > 0 && bigSpikeIntoZone / touches < 0.5

  void bounceCount
  void currentPrice
  return { touches, lastReactionAt, volumeAtLevel, actedBothSides, controlledApproach }
}
