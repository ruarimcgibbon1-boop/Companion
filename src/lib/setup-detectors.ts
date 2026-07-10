/**
 * Setup detectors.
 *
 * Each detector inspects the analysis context and, when justified, emits a
 * DetectedSetup with its own zone, confirmation requirements, invalidation,
 * targets, adaptive approach threshold, and a setup-specific score. Detectors
 * describe *geometry + evidence*; the state machine (setup-state-machine.ts)
 * decides transitions and alerting across polls.
 *
 * Nothing is invented: when a reference (EMA, VWAP, level) is unavailable the
 * corresponding detector simply returns nothing.
 */

import type {
  Candle, SessionLevels, TechnicalData, KeyLevel,
  DetectedSetup, SetupType, SetupDirection, SetupState, SetupTarget,
} from '@/types'
import { scoreSetup, type ScoringContext } from './scoring-matrix'
import { approachThresholdPct } from './adaptive-threshold'
import { deriveSignal } from './signals'

export interface DetectionContext {
  symbol: string
  price: number
  candles: Candle[]          // intraday, chronological
  sessionLevels: SessionLevels
  technical: TechnicalData
  levels: KeyLevel[]
  catalystScore: number      // 0-15
  hasCatalyst: boolean
  spreadPct: number | null
  changePct: number
}

// ── Small candle utilities ──────────────────────────────────────────────────

function lastN(candles: Candle[], n: number): Candle[] { return candles.slice(-n) }

function hasRejectionWick(c: Candle, side: 'top' | 'bottom'): boolean {
  const range = c.high - c.low
  if (range <= 0) return false
  const body = Math.abs(c.close - c.open)
  if (side === 'bottom') {
    const lowerWick = Math.min(c.open, c.close) - c.low
    return lowerWick > body && lowerWick / range > 0.4
  }
  const upperWick = c.high - Math.max(c.open, c.close)
  return upperWick > body && upperWick / range > 0.4
}

function makingHigherLows(candles: Candle[]): boolean {
  const lows = lastN(candles, 6).map(c => c.low)
  if (lows.length < 4) return false
  return lows[lows.length - 1] > lows[0] && Math.min(...lows.slice(-2)) >= Math.min(...lows.slice(0, 2))
}

function makingLowerHighs(candles: Candle[]): boolean {
  const highs = lastN(candles, 6).map(c => c.high)
  if (highs.length < 4) return false
  return highs[highs.length - 1] < highs[0]
}

function volumeContracting(candles: Candle[]): boolean {
  const recent = lastN(candles, 6)
  if (recent.length < 4) return false
  const firstHalf = recent.slice(0, Math.floor(recent.length / 2)).reduce((s, c) => s + c.volume, 0)
  const secondHalf = recent.slice(Math.floor(recent.length / 2)).reduce((s, c) => s + c.volume, 0)
  return secondHalf < firstHalf * 0.9
}

function volumeExpanding(candles: Candle[]): boolean {
  const recent = lastN(candles, 20)
  if (recent.length < 5) return false
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length
  const last = recent[recent.length - 1]
  return last.volume > avg * 1.3
}

// ── Long-bounce quality gates (from the 2026-07-06/07 trade review) ──────────
// Buying "bounces" into a stock that has already rolled over off its session
// high (CLRO 10.5 after a 9→12 run; JLHL 4.8 after topping 5.5; FISV 54.8 off
// the top) produced the worst clusters of losers. Veto the *trigger* in those
// conditions — the setup stays visible as a watch but won't log a BUY.
// ≥5% below the session high on lower highs = rolling over. Tightened from 8%
// after 2026-07-09, where several "bought the top" losers (SDOT after its blow-off,
// etc.) sat 5–10% off the high and rolled but slipped the looser gate.
const ROLLOVER_OFF_HIGH_PCT = 0.05
// A stop tighter than this is noise on a low-float and gets shaken out before
// the thesis plays (SEER's 0.6% scalp). We floor stop width — never tighten.
const MIN_STOP_PCT = 0.015
// A long "bounce" whose price has already run well above its entry zone is a
// chase, not a bounce: the zone is unfillable and entering at the trigger means
// a wide stop for a tiny first target. Don't let it fire a BUY. (2026-07-08's
// runnable triggers sat 0.6–2.4% above the zone; the dead 8–10% chases — PRME
// EMA21, ELTX pullback — get dropped.)
const MAX_TRIGGER_EXTENSION_PCT = 0.04

function sessionHigh(candles: Candle[]): number {
  let h = 0
  for (const c of candles) if (c.high > h) h = c.high
  return h
}

/** Last few candles carving lower highs on a net-lower close = a down-leg, not a healthy higher-low pullback. */
export function rollingOver(candles: Candle[]): boolean {
  const r = lastN(candles, 4)
  if (r.length < 4) return false
  const lowerHighs = r[3].high < r[1].high && r[2].high <= r[1].high
  const netDown = r[3].close < r[0].close
  return lowerHighs && netDown
}

/** Fraction below the session high (positive when below). Prefers the session-correct
 *  technical reading (regular high, or premarket high before the open); falls back to a
 *  candle scan only when that's unavailable. */
function offSessionHighPct(ctx: DetectionContext): number | null {
  const d = ctx.technical.distanceFromDayHighPct
  if (d != null) return -d / 100
  const hi = sessionHigh(ctx.candles)
  return hi > 0 ? (hi - ctx.price) / hi : null
}

/** Fractal swing pivots over a candle window: a high/low with `k` lower/higher bars on each side. */
function pivots(cs: Candle[], k: number): { highs: { i: number; price: number }[]; lows: { i: number; price: number }[] } {
  const highs: { i: number; price: number }[] = []
  const lows: { i: number; price: number }[] = []
  for (let i = k; i < cs.length - k; i++) {
    let isHigh = true, isLow = true
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue
      if (cs[j].high >= cs[i].high) isHigh = false
      if (cs[j].low <= cs[i].low) isLow = false
    }
    if (isHigh) highs.push({ i, price: cs[i].high })
    if (isLow) lows.push({ i, price: cs[i].low })
  }
  return { highs, lows }
}

// The off-high distance that counts as "rolled over" scales with the name's own
// volatility: a high-ATR momentum name (2026-07-10 JZXN, atr ~7%) that pulls
// back <1.5 ATR is just breathing, not rolling over — the fixed 5% gate wrongly
// flagged its winners. A quiet name still trips at the 5% floor.
const ROLLOVER_MIN_ATR = 1.5

/** Veto a long *bounce* trigger when price has already rolled over well off the session high. */
export function longBounceRolledOver(ctx: DetectionContext): boolean {
  const offHigh = offSessionHighPct(ctx)
  if (offHigh == null) return false
  const atrFrac = ctx.technical.atr != null && ctx.price > 0 ? ctx.technical.atr / ctx.price : null
  const threshold = atrFrac != null
    ? Math.max(ROLLOVER_OFF_HIGH_PCT, atrFrac * ROLLOVER_MIN_ATR)
    : ROLLOVER_OFF_HIGH_PCT
  return offHigh > threshold && rollingOver(ctx.candles)
}

function cleanCandlesInto(candles: Candle[], direction: SetupDirection): boolean {
  // For a long, penalise large red candles in the pullback; for a short, large green.
  const recent = lastN(candles, 5)
  for (const c of recent) {
    const range = (c.high - c.low) / (c.close || 1)
    const isRed = c.close < c.open
    if (range > 0.04 && ((direction === 'long' && isRed) || (direction === 'short' && !isRed))) {
      return false
    }
  }
  return true
}

/** Count how many times price reacted within tolerance of a (static) level value. */
function countTests(candles: Candle[], level: number, tolerancePct: number): number {
  const tol = level * tolerancePct
  let count = 0
  let inZone = false
  for (const c of candles) {
    const near = c.low <= level + tol && c.high >= level - tol
    if (near && !inZone) { count++; inZone = true }
    else if (!near) inZone = false
  }
  return count
}

// ── Target / RR helpers ─────────────────────────────────────────────────────

function levelsAbove(levels: KeyLevel[], price: number): KeyLevel[] {
  return levels.filter(l => l.midpoint > price * 1.001).sort((a, b) => a.midpoint - b.midpoint)
}
function levelsBelow(levels: KeyLevel[], price: number): KeyLevel[] {
  return levels.filter(l => l.midpoint < price * 0.999).sort((a, b) => b.midpoint - a.midpoint)
}

function rr(entry: number, stop: number, target: number): number | null {
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  if (risk <= 0) return null
  return Math.round((reward / risk) * 10) / 10
}

// ── Common assembly ─────────────────────────────────────────────────────────

interface BuildArgs {
  ctx: DetectionContext
  type: SetupType
  direction: SetupDirection
  zoneLower: number
  zoneUpper: number
  rationale: string
  confirmation: string[]
  invalidation: number
  testCount: number
  scoringOverrides: Partial<ScoringContext>
  confirmationSignals: number
  triggered: boolean
  confirming: boolean
  notes: string
  risks?: string[]
  /** When active, suppress the `triggered` state (no BUY logged) and surface the reason. */
  vetoTrigger?: { active: boolean; reason: string }
  /** Synthetic targets (e.g. measured moves) merged with level-based targets — for breakouts to new highs that have no levels overhead. */
  extraTargets?: number[]
}

function buildSetup(args: BuildArgs): DetectedSetup {
  const { ctx, type, direction, zoneLower, zoneUpper, rationale, confirmation, invalidation, testCount } = args
  const { price, levels, technical: t, sessionLevels: sl } = ctx
  const zoneMidpoint = (zoneLower + zoneUpper) / 2

  // Targets from ranked levels in the trade direction.
  const forward = direction === 'long' ? levelsAbove(levels, price) : levelsBelow(levels, price)
  const entryRef = direction === 'long' ? zoneUpper : zoneLower

  // Where you'd actually fill entering ON the trigger (buy the reclaim), never
  // below current price for a long. Strong movers never come back to the zone,
  // so a resting limit misses them — the real entry is here.
  const entryFill = direction === 'long' ? Math.max(zoneUpper, price) : Math.min(zoneLower, price)

  // Minimum stop-width floor: widen a degenerate sub-MIN_STOP_PCT stop so we never
  // emit a scalp that noise stops out (SEER 0.6%, 2026-07-06). Only ever widens.
  const minStopDist = price * MIN_STOP_PCT
  let stopRef = invalidation
  if (direction === 'long' && entryRef - stopRef < minStopDist) stopRef = entryRef - minStopDist
  else if (direction === 'short' && stopRef - entryRef < minStopDist) stopRef = entryRef + minStopDist

  // Candidate targets: ranked levels in the trade direction, plus any synthetic
  // targets (measured moves) supplied by momentum setups. Keep those genuinely
  // beyond price, nearest-first, deduped within 0.3%.
  const cand: { price: number; label: string }[] = [
    ...forward.map(l => ({ price: l.midpoint, label: l.sourceLabels[0] ?? '' })),
    ...(args.extraTargets ?? []).map(p => ({ price: p, label: 'measured move' })),
  ]
  const dirLong = direction === 'long'
  const picked: { price: number; label: string }[] = []
  for (const o of cand
    .filter(o => dirLong ? o.price > price * 1.001 : o.price < price * 0.999)
    .sort((a, b) => dirLong ? a.price - b.price : b.price - a.price)) {
    if (!picked.some(p => Math.abs(p.price - o.price) / o.price < 0.003)) picked.push(o)
  }
  const targets: SetupTarget[] = picked.slice(0, 3).map((o, i) => ({
    price: o.price,
    label: `T${i + 1}${o.label ? ` (${o.label})` : ''}`,
    rewardRisk: rr(entryRef, stopRef, o.price),
  }))
  const bestRR = targets.length ? targets[0].rewardRisk : null

  // Room to first target ≥ 1.5R; opposing level within 1% counts as crowded.
  const roomToTarget = bestRR != null && bestRR >= 1.5
  const opposing = direction === 'long' ? levelsAbove(levels, price)[0] : levelsBelow(levels, price)[0]
  const nearbyOpposingLevel = opposing != null && Math.abs(opposing.midpoint - price) / price < 0.01 && (bestRR == null || bestRR < 1.2)

  const level = nearestLevelToZone(levels, zoneMidpoint)
  const distanceToZonePct = ((zoneMidpoint - price) / price) * 100

  const scoreCtx: ScoringContext = {
    setupType: type,
    levelStrength: level?.strength ?? 40,
    levelTouches: level?.touches ?? 0,
    levelHigherTf: level ? level.sources.some(s => s.startsWith('prev_') || s.startsWith('daily_') || s === 'ma50' || s === 'ma200') : false,
    levelConfluence: level?.hasConfluence ?? false,
    structureIntact: direction === 'long' ? t.higherHighsLows !== false : t.lowerHighsLows !== false,
    cleanCandles: cleanCandlesInto(ctx.candles, direction),
    constructiveConsolidation: volumeContracting(ctx.candles),
    structureBroken: direction === 'long' ? t.lowerHighsLows === true : t.higherHighsLows === true,
    relativeVolume: t.relativeVolume,
    volumeContractsIntoZone: volumeContracting(ctx.candles),
    volumeExpandsOnSignal: volumeExpanding(ctx.candles),
    sustainedInterest: (t.relativeVolume ?? 0) > 1.5,
    intradayTrendAligned: direction === 'long' ? t.trend5m !== 'down' : t.trend5m !== 'up',
    higherTfTrendAligned: direction === 'long' ? t.trend15m !== 'down' : t.trend15m !== 'up',
    aboveVwap: sl.vwap ? price > sl.vwap : null,
    emaStackAligned: t.ema9 != null && t.ema20 != null ? (direction === 'long' ? t.ema9 >= t.ema20 : t.ema9 <= t.ema20) : false,
    catalystScore: ctx.catalystScore,
    unusualVolume: (t.relativeVolume ?? 0) > 3,
    rewardRisk: bestRR,
    roomToTarget,
    nearbyOpposingLevel,
    clearInvalidation: true,
    spreadPct: ctx.spreadPct,
    liquidVolume: (t.relativeVolume ?? 0) >= 1,
    priceStable: t.vwapCrossCount < 6,
    confirmationSignals: args.confirmationSignals,
    testCount,
    ...args.scoringOverrides,
  }

  const { total, grade, breakdown, risks: scoreRisks } = scoreSetup(scoreCtx)

  const approachThreshold = approachThresholdPct({ price, technical: t, candles: ctx.candles, spreadPct: ctx.spreadPct })

  // Observed (instantaneous) state from geometry + evidence.
  // A vetoed trigger cannot advance to `triggered` (so it logs no BUY) but stays visible.
  const vetoed = args.vetoTrigger?.active ?? false
  // An over-extended long bounce is a chase, not a fillable trigger — drop it entirely.
  const extended = direction === 'long'
    ? price > zoneUpper * (1 + MAX_TRIGGER_EXTENSION_PCT)
    : price < zoneLower * (1 - MAX_TRIGGER_EXTENSION_PCT)
  const rawTrigger = args.triggered && !extended
  const inZone = price >= zoneLower && price <= zoneUpper
  let state: SetupState
  if (rawTrigger && !vetoed) state = 'triggered'
  else if (inZone && args.confirming) state = 'confirming'
  else if (inZone) state = 'at_level'
  else if (Math.abs(distanceToZonePct) <= approachThreshold) state = 'approaching'
  else state = 'identified'

  const nextForward = forward[0]?.midpoint ?? null
  const backward = direction === 'long' ? levelsBelow(levels, zoneLower) : levelsAbove(levels, zoneUpper)
  const nextBackward = backward[0]?.midpoint ?? null

  const id = `${ctx.symbol}:${type}:${zoneMidpoint.toFixed(2)}`

  const built: Omit<DetectedSetup, 'signal'> = {
    id,
    symbol: ctx.symbol,
    type,
    direction,
    state,
    triggeredRaw: rawTrigger,
    qualityVetoed: vetoed,
    entryFill,
    score: total,
    grade,
    breakdown,
    zoneLower,
    zoneUpper,
    zoneMidpoint,
    rationale,
    confirmation,
    invalidation: stopRef,
    stopReference: stopRef,
    targets,
    rewardRisk: bestRR,
    distanceToZonePct,
    distanceFromVwapPct: t.distanceFromVwapPct,
    distanceFromEma9Pct: t.ema9 ? ((price - t.ema9) / t.ema9) * 100 : null,
    distanceFromEma21Pct: t.ema20 ? ((price - t.ema20) / t.ema20) * 100 : null,
    approachThresholdPct: approachThreshold,
    testCount,
    confidence: Math.round((total + (level?.strength ?? 40)) / 2),
    risks: [...new Set([
      ...(args.risks ?? []),
      ...(vetoed && args.vetoTrigger ? [args.vetoTrigger.reason] : []),
      ...scoreRisks,
    ])],
    keyRisks: scoreRisks.slice(0, 3),
    notes: args.notes,
    nextIfHolds: nextForward,
    nextIfFails: nextBackward,
  }

  return { ...built, signal: deriveSignal(built as DetectedSetup) }
}

function nearestLevelToZone(levels: KeyLevel[], mid: number): KeyLevel | null {
  let best: KeyLevel | null = null
  let bestDist = Infinity
  for (const l of levels) {
    const d = Math.abs(l.midpoint - mid)
    if (d < bestDist) { bestDist = d; best = l }
  }
  return best
}

// ── Individual detectors ────────────────────────────────────────────────────

function detectPullback(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  // Long pullback only when trend isn't clearly down and we're above VWAP-ish.
  if (t.trend5m === 'down' && t.trend15m === 'down') return null
  const support = ctx.levels.find(l => l.kind === 'support' && l.strength >= 40)
  if (!support) return null
  const halfWidth = (support.upper - support.lower) / 2 || price * 0.004
  const zoneLower = support.lower
  const zoneUpper = support.upper
  const invalidation = zoneLower - Math.max(halfWidth, (t.atr ?? price * 0.01) * 0.3)

  const lastCandle = candles[candles.length - 1]
  const confirming = makingHigherLows(candles) && volumeContracting(candles)
  const reclaim = lastCandle ? lastCandle.close > zoneUpper : false
  const triggered = reclaim && volumeExpanding(candles) && makingHigherLows(candles)
  const signals =
    (makingHigherLows(candles) ? 1 : 0) +
    (volumeContracting(candles) ? 1 : 0) +
    (lastCandle && hasRejectionWick(lastCandle, 'bottom') ? 1 : 0) +
    (reclaim ? 1 : 0)

  const vwapDist = t.distanceFromVwapPct ?? 0
  const depth = vwapDist > 10 ? 'deep' : vwapDist > 4 ? 'preferred' : 'shallow'

  return buildSetup({
    ctx, type: 'pullback', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `Controlled pullback into ${support.sourceLabels.join(' + ')} support (${depth} depth). ${support.touches} prior reaction(s).`,
    confirmation: [
      'Selling volume contracts into the zone',
      'Higher low forms / rejection wick off support',
      `Reclaim and hold above $${zoneUpper.toFixed(2)}`,
    ],
    invalidation,
    testCount: support.touches,
    scoringOverrides: { volumeContractsIntoZone: volumeContracting(candles) },
    confirmationSignals: signals,
    triggered,
    confirming,
    vetoTrigger: { active: longBounceRolledOver(ctx), reason: 'Rolled over ≥8% off session high on lower highs — bounce may be a falling knife' },
    notes: `${depth[0].toUpperCase() + depth.slice(1)} pullback. Prioritise controlled selling; avoid buying large red candles.`,
    risks: t.lowerHighsLows ? ['Lower highs/lows forming — pullback may become a trend reversal'] : [],
  })
}

function detectBreakout(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  const res = levelsAbove(ctx.levels, price).find(l => l.strength >= 45)
  if (!res) return null
  // Skip if wildly extended already.
  if ((t.distanceFromVwapPct ?? 0) > 12) return null
  const zoneLower = res.lower
  const zoneUpper = res.upper
  const invalidation = zoneLower - Math.max((t.atr ?? price * 0.01) * 0.4, price * 0.004)

  const lastCandle = candles[candles.length - 1]
  const tightening = makingHigherLows(candles) && res.midpoint - price < (t.atr ?? price * 0.02)
  const closedAbove = lastCandle ? lastCandle.close > res.upper : false
  const triggered = closedAbove && volumeExpanding(candles)
  const confirming = (price >= zoneLower && price <= zoneUpper) && tightening
  const signals =
    (tightening ? 1 : 0) + (volumeExpanding(candles) ? 1 : 0) + (closedAbove ? 1 : 0)

  return buildSetup({
    ctx, type: 'breakout', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `Breakout watch at ${res.sourceLabels.join(' + ')} ($${res.midpoint.toFixed(2)}). ${res.touches} test(s); ${tightening ? 'range tightening below' : 'not yet coiled'}.`,
    confirmation: [
      `Candle CLOSE above $${res.upper.toFixed(2)} (not just an intrabar tag)`,
      'Volume expands on the breakout bar (≥1.3× recent average)',
      'Holds above on the retest with bid support',
    ],
    invalidation,
    testCount: res.touches,
    scoringOverrides: { volumeExpandsOnSignal: volumeExpanding(candles), constructiveConsolidation: tightening },
    confirmationSignals: signals,
    triggered,
    confirming,
    notes: res.touches >= 3 ? 'Multiple tests — higher false-breakout risk; demand volume + close.' : 'Fresh level — cleaner breakout odds.',
    risks: res.touches >= 3 ? ['Level tested repeatedly — false-breakout risk'] : [],
  })
}

function detectEmaBounce(ctx: DetectionContext, which: 'ema9' | 'ema21'): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  const ema = which === 'ema9' ? t.ema9 : t.ema20
  if (ema == null) return null
  // Only a bounce candidate when in an uptrend and price is at/above the EMA.
  if (t.trend5m === 'down') return null
  if (price < ema * 0.985) return null // already lost the EMA meaningfully
  const band = (t.atr ?? price * 0.01) * (which === 'ema9' ? 0.25 : 0.35)
  const zoneLower = ema - band
  const zoneUpper = ema + band
  const invalidation = zoneLower - Math.max(band, price * 0.004)
  const tests = countTests(candles, ema, which === 'ema9' ? 0.004 : 0.006)

  const lastCandle = candles[candles.length - 1]
  const holding = lastCandle ? lastCandle.close > ema : false
  const confirming = (price >= zoneLower && price <= zoneUpper) && makingHigherLows(candles)
  const triggered = holding && volumeExpanding(candles) && makingHigherLows(candles) && price > zoneUpper
  const signals =
    (makingHigherLows(candles) ? 1 : 0) + (holding ? 1 : 0) + (volumeContracting(candles) ? 1 : 0)

  const type: SetupType = which === 'ema9' ? 'ema9_bounce' : 'ema21_bounce'
  const label = which === 'ema9' ? '9 EMA' : '21 EMA'

  return buildSetup({
    ctx, type, direction: 'long',
    zoneLower, zoneUpper,
    rationale: `${label} bounce candidate — ${tests === 1 ? 'first test' : `${tests}${ordinal(tests)} test`} of the rising ${label}. Trend ${t.trend15m}.`,
    confirmation: [
      `Reaction / hold at the ${label} ($${ema.toFixed(2)})`,
      'Limited selling volume into the EMA',
      `Bounce candle closes back above with follow-through`,
    ],
    invalidation,
    testCount: tests,
    scoringOverrides: {
      // 9 EMA weights momentum; repeated tests reduce reliability (handled by testCount penalty).
      volumeContractsIntoZone: volumeContracting(candles),
      structureIntact: makingHigherLows(candles),
    },
    confirmationSignals: signals,
    triggered,
    confirming,
    vetoTrigger: { active: longBounceRolledOver(ctx), reason: 'Rolled over ≥8% off session high on lower highs — bounce may be a falling knife' },
    notes: tests >= 3 ? `${label} tested ${tests}× — support weakening, reduce size.` : `Clean ${label} test — momentum reference intact.`,
    risks: tests >= 3 ? [`${label} tested ${tests}× — each retest weakens it`] : [],
  })
}

function detectVwap(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, sessionLevels: sl, candles } = ctx
  const vwap = sl.vwap
  if (vwap == null) return null
  const band = (t.atr ?? price * 0.01) * 0.3

  // Proximity gate: a VWAP bounce/reclaim only exists when price is actually
  // NEAR VWAP. Without this, any stock trading above VWAP (by any distance)
  // was tagged a "vwap bounce" — even 15% away. Require price within ~1 ATR or
  // 2.5% of VWAP (whichever is larger, to allow volatile low-float names).
  const nearThreshold = Math.max(price * 0.025, band * 3)
  if (Math.abs(price - vwap) > nearThreshold) return null

  const zoneLower = vwap - band
  const zoneUpper = vwap + band
  const above = price >= vwap
  const type: SetupType = above ? 'vwap_bounce' : 'vwap_reclaim'
  const direction: SetupDirection = 'long'
  const invalidation = above ? zoneLower - band : vwap - band * 2
  const tests = t.vwapCrossCount

  const lastCandle = candles[candles.length - 1]
  const reclaimed = lastCandle ? lastCandle.close > vwap : false
  const confirming = Math.abs(price - vwap) / vwap < (band / vwap) && makingHigherLows(candles)
  const triggered = above
    ? reclaimed && makingHigherLows(candles) && volumeContracting(candles) && price > zoneUpper
    : reclaimed && volumeExpanding(candles) && price > vwap
  const signals =
    (reclaimed ? 1 : 0) + (makingHigherLows(candles) ? 1 : 0) +
    (above ? (volumeContracting(candles) ? 1 : 0) : (volumeExpanding(candles) ? 1 : 0))

  return buildSetup({
    ctx, type, direction,
    zoneLower, zoneUpper,
    rationale: above
      ? `VWAP bounce — price holding above session VWAP ($${vwap.toFixed(2)}). ${tests} cross(es) so far.`
      : `VWAP reclaim attempt — price below VWAP ($${vwap.toFixed(2)}) looking to reclaim. ${tests} cross(es).`,
    confirmation: above
      ? ['Buyers respond at VWAP', 'Higher low off VWAP', 'Holds above with declining sell volume']
      : ['Candle closes back above VWAP', 'Reclaim holds on retest', 'Volume expands on reclaim'],
    invalidation,
    testCount: tests,
    scoringOverrides: {
      volumeContractsIntoZone: above && volumeContracting(candles),
      volumeExpandsOnSignal: !above && volumeExpanding(candles),
    },
    confirmationSignals: signals,
    triggered,
    confirming,
    vetoTrigger: { active: longBounceRolledOver(ctx), reason: 'Rolled over ≥8% off session high on lower highs — bounce may be a falling knife' },
    notes: tests > 4 ? 'VWAP crossed many times — choppy, treat reclaims sceptically.' : 'Respecting VWAP so far this session.',
    risks: tests > 4 ? ['VWAP whipsawed repeatedly — low reliability'] : [],
  })
}

function detectBullFlag(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  if (candles.length < 12) return null
  if (t.trend5m === 'down') return null

  const win = lastN(candles, 14)
  const flagLen = 5
  if (win.length < flagLen + 5) return null
  const flag = win.slice(-flagLen)
  const pole = win.slice(0, win.length - flagLen)

  const poleLow = Math.min(...pole.map(c => c.low))
  const poleHigh = Math.max(...pole.map(c => c.high))
  const poleH = poleHigh - poleLow
  const atrPct = (t.atr ?? price * 0.01) / price
  // Need a real impulse: ≥5% or ≥3 ATR, and the high must come AFTER the low (up-pole).
  if (poleH / poleLow < Math.max(0.05, atrPct * 3)) return null
  const lowI = pole.reduce((bi, c, i, a) => (c.low < a[bi].low ? i : bi), 0)
  const highI = pole.reduce((bi, c, i, a) => (c.high > a[bi].high ? i : bi), 0)
  if (highI <= lowI) return null

  const flagHigh = Math.max(...flag.map(c => c.high))
  const flagLow = Math.min(...flag.map(c => c.low))
  const retrace = (poleHigh - flagLow) / poleH          // how deep the flag pulled back
  if (retrace > 0.55) return null                        // too deep → not a flag, a reversal
  if (flagHigh - flagLow > poleH * 0.6) return null       // flag not tight enough
  if (price < flagLow) return null                        // broke down out of the flag

  const band = (t.atr ?? price * 0.01) * 0.2
  const zoneLower = flagHigh - band
  const zoneUpper = flagHigh + band
  const invalidation = flagLow - Math.max(band, price * 0.004)

  const last = candles[candles.length - 1]
  const closedAbove = last.close > flagHigh
  const triggered = closedAbove && volumeExpanding(candles)
  const confirming = price >= zoneLower && price <= zoneUpper && volumeContracting(flag)
  const signals = (volumeContracting(flag) ? 1 : 0) + (closedAbove ? 1 : 0) + (makingHigherLows(candles) ? 1 : 0)

  return buildSetup({
    ctx, type: 'bull_flag', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `Bull flag — ${(poleH / poleLow * 100).toFixed(0)}% pole then a tight ${flagLen}-bar flag holding ${(100 - retrace * 100).toFixed(0)}% of the move. Break of $${flagHigh.toFixed(2)} continues it.`,
    confirmation: [
      `Break + hold above the flag high $${flagHigh.toFixed(2)}`,
      'Volume expands on the breakout bar',
      `Flag stays above its low $${flagLow.toFixed(2)}`,
    ],
    invalidation, testCount: 0,
    scoringOverrides: {
      volumeContractsIntoZone: volumeContracting(flag),
      volumeExpandsOnSignal: volumeExpanding(candles),
      constructiveConsolidation: true,
    },
    confirmationSignals: signals, triggered, confirming,
    extraTargets: [flagHigh + poleH, flagHigh + poleH * 1.618],   // 1× and 1.618× measured moves
    notes: 'Momentum continuation — enter the break, not the drift down the flag.',
    risks: retrace > 0.4 ? ['Deeper flag — momentum cooling, size down'] : [],
  })
}

function detectBreakOfStructure(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  if (candles.length < 14) return null
  if (t.trend5m === 'down') return null

  const win = lastN(candles, 22)
  const { highs, lows } = pivots(win, 2)
  if (highs.length < 2 || lows.length < 1) return null

  const lastSwingHigh = highs[highs.length - 1].price
  const priorSwingHigh = highs[highs.length - 2].price
  const lastSwingLow = lows[lows.length - 1].price
  // Continuation only: an uptrend of rising swing highs, a recent higher low intact.
  if (lastSwingHigh <= priorSwingHigh) return null
  if (!makingHigherLows(candles)) return null
  if (price < lastSwingLow) return null                       // structure already broken down
  const distToSwing = (lastSwingHigh - price) / price
  if (distToSwing > 0.03) return null                          // too far below the break level to be a trigger

  const band = (t.atr ?? price * 0.01) * 0.25
  const zoneLower = lastSwingHigh - band
  const zoneUpper = lastSwingHigh + band
  const invalidation = lastSwingLow - Math.max(band, price * 0.004)

  const last = candles[candles.length - 1]
  const closedAbove = last.close > lastSwingHigh
  const triggered = closedAbove && volumeExpanding(candles) && makingHigherLows(candles)
  const confirming = price >= zoneLower && price <= zoneUpper && makingHigherLows(candles)
  const signals = (closedAbove ? 1 : 0) + (volumeExpanding(candles) ? 1 : 0) + (makingHigherLows(candles) ? 1 : 0)

  const range = lastSwingHigh - lastSwingLow

  return buildSetup({
    ctx, type: 'break_of_structure', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `Break of structure — higher swing highs ($${priorSwingHigh.toFixed(2)} → $${lastSwingHigh.toFixed(2)}) over a higher low $${lastSwingLow.toFixed(2)}. Reclaiming $${lastSwingHigh.toFixed(2)} continues the trend.`,
    confirmation: [
      `Break of the prior swing high $${lastSwingHigh.toFixed(2)} on a close`,
      'Volume expands on the break',
      `Holds the higher low $${lastSwingLow.toFixed(2)} on any retest`,
    ],
    invalidation, testCount: highs.length,
    scoringOverrides: {
      volumeExpandsOnSignal: volumeExpanding(candles),
      structureIntact: makingHigherLows(candles),
    },
    confirmationSignals: signals, triggered, confirming,
    extraTargets: [lastSwingHigh + range, lastSwingHigh + range * 1.618],
    notes: 'Trend continuation — buy the break of structure, invalid on loss of the higher low.',
    risks: [],
  })
}

function detectRejection(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  const res = levelsAbove(ctx.levels, price).find(l => l.strength >= 50)
  if (!res) return null
  if (Math.abs(res.midpoint - price) / price > 0.02) return null // only when close
  const lastCandle = candles[candles.length - 1]
  const rejecting = lastCandle ? hasRejectionWick(lastCandle, 'top') || makingLowerHighs(candles) : false
  if (!rejecting) return null

  const band = (t.atr ?? price * 0.01) * 0.3
  const zoneLower = res.lower
  const zoneUpper = res.upper
  const invalidation = res.upper + band * 1.5
  const triggered = lastCandle ? lastCandle.close < res.lower && volumeExpanding(candles) : false
  const confirming = makingLowerHighs(candles)
  const signals = (rejecting ? 1 : 0) + (makingLowerHighs(candles) ? 1 : 0) + (volumeExpanding(candles) ? 1 : 0)

  return buildSetup({
    ctx, type: 'resistance_rejection', direction: 'short',
    zoneLower, zoneUpper,
    rationale: `Rejection from ${res.sourceLabels.join(' + ')} resistance ($${res.midpoint.toFixed(2)}). ${res.touches} test(s).`,
    confirmation: ['Upper rejection wick / lower high', 'Loss of the level on a close', 'Sell volume expands'],
    invalidation,
    testCount: res.touches,
    scoringOverrides: {},
    confirmationSignals: signals,
    triggered,
    confirming,
    notes: 'Short setup — requires borrow availability; check squeeze risk on low float.',
    risks: ['Short side — confirm shares are shortable and squeeze risk is acceptable'],
  })
}

function detectBreakdown(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  const sup = levelsBelow(ctx.levels, price).find(l => l.strength >= 50)
  if (!sup) return null
  if (Math.abs(price - sup.midpoint) / price > 0.02) return null
  const band = (t.atr ?? price * 0.01) * 0.3
  const zoneLower = sup.lower
  const zoneUpper = sup.upper
  const invalidation = sup.upper + band * 1.5

  const lastCandle = candles[candles.length - 1]
  const lostLevel = lastCandle ? lastCandle.close < sup.lower : false
  const triggered = lostLevel && volumeExpanding(candles)
  const confirming = makingLowerHighs(candles) && price <= zoneUpper
  const signals = (lostLevel ? 1 : 0) + (makingLowerHighs(candles) ? 1 : 0) + (volumeExpanding(candles) ? 1 : 0)

  return buildSetup({
    ctx, type: 'support_breakdown', direction: 'short',
    zoneLower, zoneUpper,
    rationale: `Breakdown watch through ${sup.sourceLabels.join(' + ')} support ($${sup.midpoint.toFixed(2)}). ${sup.touches} prior hold(s).`,
    confirmation: ['Decisive close below the level', 'Sell volume expands', 'Fails the retest from below'],
    invalidation,
    testCount: sup.touches,
    scoringOverrides: {},
    confirmationSignals: signals,
    triggered,
    confirming,
    notes: 'Short setup — confirm borrow and avoid chasing an already-extended flush.',
    risks: ['Short side — confirm shortable; do not chase an extended breakdown'],
  })
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return 'th'
  switch (n % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

// ── Public entry point ──────────────────────────────────────────────────────

export function detectSetups(ctx: DetectionContext): DetectedSetup[] {
  if (ctx.price <= 0 || ctx.candles.length === 0) return []
  const out: (DetectedSetup | null)[] = [
    detectPullback(ctx),
    detectBreakout(ctx),
    detectBullFlag(ctx),
    detectBreakOfStructure(ctx),
    detectEmaBounce(ctx, 'ema9'),
    detectEmaBounce(ctx, 'ema21'),
    detectVwap(ctx),
    detectRejection(ctx),
    detectBreakdown(ctx),
  ]
  // Dedup by id, keep the highest score if two detectors collide on a zone.
  const byId = new Map<string, DetectedSetup>()
  for (const s of out) {
    if (!s) continue
    const existing = byId.get(s.id)
    if (!existing || s.score > existing.score) byId.set(s.id, s)
  }
  return [...byId.values()].sort((a, b) => b.score - a.score)
}
