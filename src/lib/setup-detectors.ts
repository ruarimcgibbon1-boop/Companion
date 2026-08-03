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
import type { SessionType } from './market-hours'

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
  session: SessionType       // premarket detectors gate on this
  minutesSinceOpen: number | null  // minutes past the 09:30 open (null outside RTH); gates the opening lockout
  float: number | null       // shares float (null when unknown); feeds the in-play gate
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

// The confirmation entry every momentum trader teaches (Warrior micro-pullback,
// Kev "wait for a buyer to step in"): don't buy the dip itself — buy the FIRST
// candle that takes out the pullback's high after a 2–3 bar digestion. That flips
// the entry from "price is back near the level" (catching a falling knife) to
// "buyers have proven they're back". Requires: a real pullback in the recent bars,
// then the current bar breaking above it and closing in its upper half.
function newHighAfterPullback(candles: Candle[]): boolean {
  const r = lastN(candles, 5)
  if (r.length < 4) return false
  const cur = r[r.length - 1]
  const pb = r.slice(0, -1).slice(-3)                 // the up-to-3-bar pullback before `cur`
  const pbHigh = Math.max(...pb.map(c => c.high))
  const pulledBack = pb.some(c => c.close < c.open) || pb[pb.length - 1].low < pb[0].low
  const closedStrong = cur.close >= cur.open // a green confirmation bar, not an upper-wick rejection
  return pulledBack && cur.high > pbHigh && closedStrong
}

function volumeContracting(candles: Candle[]): boolean {
  const recent = lastN(candles, 6)
  if (recent.length < 4) return false
  const firstHalf = recent.slice(0, Math.floor(recent.length / 2)).reduce((s, c) => s + c.volume, 0)
  const secondHalf = recent.slice(Math.floor(recent.length / 2)).reduce((s, c) => s + c.volume, 0)
  return secondHalf < firstHalf * 0.9
}

// Volume confirmation — the single gate on EVERY momentum trigger, so its
// calibration sets breadth across the whole stack. "Expanding" means the break
// bar carries more volume than the bars IMMEDIATELY before it. The old 20-bar
// average penalised CONTINUATION breaks: mid-trend that average is already
// inflated by the move, so a real thrust rarely cleared 1.3× it and HOD/BOS
// triggers starved (2026-07-23: only 3 setups all day). Compare to the recent
// lull at a lower multiple instead — still rejects a break on fading/dead
// volume, but admits the sustained-volume continuation we kept missing.
const VOLUME_EXPANSION_MULT = 1.2
const VOLUME_EXPANSION_LOOKBACK = 8
export function volumeExpanding(candles: Candle[]): boolean {
  const recent = lastN(candles, VOLUME_EXPANSION_LOOKBACK)
  if (recent.length < 4) return false
  const last = recent[recent.length - 1]
  const prior = recent.slice(0, -1)
  const avg = prior.reduce((s, c) => s + c.volume, 0) / prior.length
  return avg > 0 && last.volume > avg * VOLUME_EXPANSION_MULT
}

// The Yahoo feed returns PREMARKET 1-min bars with price but volume: 0 (a DATA
// GAP, not "no volume"). Every momentum trigger gates on volumeExpanding, which is
// always false on zero volume — so nothing could ever trigger before the open
// (2026-08-03: 51 premarket setups, 0 triggered). When there's no usable volume
// data, confirm the trigger on the price break alone; require expansion only when
// volume actually exists (so RTH behaviour is unchanged).
function hasVolumeData(candles: Candle[]): boolean {
  return lastN(candles, VOLUME_EXPANSION_LOOKBACK).some(c => c.volume > 0)
}
function volumeConfirmsTrigger(candles: Candle[]): boolean {
  return volumeExpanding(candles) || !hasVolumeData(candles)
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
// (Bounce/pullback setups only; strength entries use the pivot stop below.)
const MIN_STOP_PCT = 0.015
// Strength-entry stop model. When you enter on a CONFIRMED break/reclaim (a new
// high), the stop belongs at the breakout pivot — ~a volatility unit under the
// ACTUAL fill — not at the far base low. On a chased fill (price ran past the
// trigger) the base-low stop balloons risk into a sub-0.1R trade that the R/R
// gate then benches (NVEC 2026-07-23: fill 130.60, base stop 126.15 → 0.1R).
const STOP_ATR_MULT = 1.3        // pivot stop sits ~1.3 ATR under the fill
const MIN_STOP_FLOOR_PCT = 0.004 // absolute stop-width floor when ATR is missing/tiny
// The setups you enter on strength — the stop trails up to the pivot for these.
// Mean-reversion bounces keep their structural stop under the level they bounce from.
const STRENGTH_ENTRY_TYPES: SetupType[] = [
  'breakout', 'bull_flag', 'break_of_structure', 'opening_range_break', 'opening_drive',
  'vwap_reclaim', 'level_reclaim',
]
// A target only a few basis points beyond the fill is noise, not a target: it
// tanks R/R and books phantom "wins" (KUST/MWC/INM 2026-07-22). The first RATED
// target must clear a meaningful reward — ≥ this fraction of the risk, or a small
// % of price, whichever is larger — so trivial levels are skipped for the measured
// move behind them.
const MIN_T1_REWARD_R = 0.8
const MIN_T1_REWARD_PCT = 0.004
// A long "bounce" whose price has already run well above its entry zone is a
// chase, not a bounce: the zone is unfillable and entering at the trigger means
// a wide stop for a tiny first target. Don't let it fire a BUY. (2026-07-08's
// runnable triggers sat 0.6–2.4% above the zone; the dead 8–10% chases — PRME
// EMA21, ELTX pullback — get dropped.)
const MAX_TRIGGER_EXTENSION_PCT = 0.04
// Genuine runners (the day's top gainers) blow through the break level faster than
// a bar can confirm, landing >4% past it — so the flat cap made us refuse exactly
// the moves we most want (CYCU/NUWE 2026-07-30). Widen the cap for a strength entry
// on a real runner (high RVOL + high ATR + big day move) so it can still trigger a
// bit further past the level. This IS more chasing — the slippage haircut keeps the
// measured P/L honest, and momentum_pullback still catches what runs past even this.
const MAX_TRIGGER_EXTENSION_MOMENTUM = 0.09
const RUNNER_MIN_RVOL = 5
const RUNNER_MIN_ATR_PCT = 3
const RUNNER_MIN_CHANGE_PCT = 20
// A "runner" must still be near its high. A name deep below the day high has already
// faded — its break is a dead-cat, not a run — so it must NOT get the wider chase
// cap (CUPR −44% off high / FCUV −32% kept dropping, 2026-07-31). Within this % of
// the day high = still running; further off = faded, back to the strict 4% cap.
const RUNNER_MAX_OFF_HIGH_PCT = 8

function maxTriggerExtension(ctx: DetectionContext, type: SetupType): number {
  if (!STRENGTH_ENTRY_TYPES.includes(type)) return MAX_TRIGGER_EXTENSION_PCT
  const t = ctx.technical
  const rvol = t.relativeVolume ?? 0
  const atrPct = t.atr != null && ctx.price > 0 ? (t.atr / ctx.price) * 100 : 0
  const offHigh = t.distanceFromDayHighPct ?? -99 // negative = below the day high
  const nearHigh = offHigh > -RUNNER_MAX_OFF_HIGH_PCT
  const runner = rvol >= RUNNER_MIN_RVOL && atrPct >= RUNNER_MIN_ATR_PCT &&
    Math.abs(ctx.changePct) >= RUNNER_MIN_CHANGE_PCT && nearHigh
  return runner ? MAX_TRIGGER_EXTENSION_MOMENTUM : MAX_TRIGGER_EXTENSION_PCT
}
// Sum of the last 5 bars' dollar volume below which a name is untradeable. Low
// by design: it screens out dead tickers (few-hundred-share bars) without
// touching genuine low-float runners, which clear it many times over.
const MIN_RECENT_DOLLAR_VOL = 50_000

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

// The first minutes of RTH are a whipsaw graveyard for bounce entries: price is
// finding its footing, VWAP/EMAs are noisy, and "bounces" get shaken out before
// any real move. 2026-07-15's first 15 minutes were 3 wins / 10 losses (net
// −12.6%, nearly the whole day's damage), while the day's best trade (NVVE +6.4%)
// came at 09:47, just past the window. So lock OUT bounce *triggers* (they stay
// visible as watches) for the opening window — the open belongs to breakouts, not
// dip-buys. Momentum detectors (ORB/HOD/breakout) are unaffected.
const OPEN_BOUNCE_LOCKOUT_MIN = 15

function openBounceLockout(ctx: DetectionContext): boolean {
  return ctx.session === 'regular' && ctx.minutesSinceOpen != null && ctx.minutesSinceOpen < OPEN_BOUNCE_LOCKOUT_MIN
}

// ── Bounce quality gates ─────────────────────────────────────────────────────
// Bounces only pay on names that are actually MOVING. 2026-07-20 review (29
// de-duplicated trades): ATR ≥3% won 75% (+4.10%/trade) while ATR <1.5% won 50%
// but bled −0.67%/trade; price hugging VWAP (<2% away) won just 36% (−1.19%/
// trade) versus 75% for names well clear of it. Published practice says the same
// thing two ways — a "dead stock" in a tight range has too few participants to
// respect the level, and a name crossing VWAP repeatedly has no trend at all, so
// VWAP becomes a noise zone rather than a bounce zone. Both are chop; chop is
// where this strategy bleeds.
// The ATR floor was a blunt PROXY for "is this name actually moving?" — and on
// low-volatility days it starved the book (2026-07-22 fired ~3 trades; 13/15
// gainers were ATR-blocked midday). Now that the real "in play" dimensions are on
// the signal path (RVOL + float + catalyst, per Warrior/Kev/Poarch), the ATR floor
// drops to a thin backstop that only rejects a genuinely dead range, and the
// in-play gate below does the real filtering.
const BOUNCE_MIN_ATR_PCT = 0.010   // volatility backstop only (was 1.5%)
const BOUNCE_MAX_VWAP_CROSSES = 3  // >3 crosses = chop day, don't buy dips

function bounceQualityFail(ctx: DetectionContext): boolean {
  const { price, technical: t } = ctx
  const atrFrac = t.atr != null && price > 0 ? t.atr / price : null
  if (atrFrac != null && atrFrac < BOUNCE_MIN_ATR_PCT) return true
  if (t.vwapCrossCount > BOUNCE_MAX_VWAP_CROSSES) return true
  return false
}

// ── In-play gate (Warrior/Kev/Poarch: only trade names actually in play) ─────
// A name is "in play" when there's real participation AND/OR a clear reason to
// move. Deliberately lenient — any single strong tell passes — so it filters the
// dead drifters without starving the book. RVOL is the proven discriminator
// (2026-07-20: RVOL≥5 won 60%, RVOL 1–2 won 33%); float + catalyst + gap are the
// corroborating pillars. Never blocks on missing data.
const IN_PLAY_MIN_RVOL = 2            // strong participation clears the gate outright
const IN_PLAY_MIN_GAP_PCT = 5         // a 5%+ mover is in play even on a soft RVOL reading
const IN_PLAY_FLOAT_CEILING = 20_000_000
const IN_PLAY_LOWFLOAT_MIN_RVOL = 1   // low floats move on less volume — normal pace is enough

function inPlay(ctx: DetectionContext): boolean {
  const rvol = ctx.technical.relativeVolume
  if (rvol != null && rvol >= IN_PLAY_MIN_RVOL) return true
  if (ctx.hasCatalyst) return true
  if (Math.abs(ctx.changePct) >= IN_PLAY_MIN_GAP_PCT) return true
  if (ctx.float != null && ctx.float < IN_PLAY_FLOAT_CEILING &&
      (rvol == null || rvol >= IN_PLAY_LOWFLOAT_MIN_RVOL)) return true
  // No participation signal at all and no data to judge on → don't block.
  if (rvol == null && ctx.float == null) return true
  return false
}

/** Every reason a long *bounce* trigger should be suppressed (setup stays visible). */
function bounceBlocked(ctx: DetectionContext): boolean {
  return openBounceLockout(ctx) || bounceQualityFail(ctx) || !inPlay(ctx)
}

/** Volume dried up INTO the pullback — measured excluding the trigger bar, so a
 *  big confirming bar doesn't mask the contraction that preceded it. */
function volumeContractingBefore(candles: Candle[]): boolean {
  return volumeContracting(candles.slice(0, -1))
}

// 2026-07-20: ema9_bounce was the worst performer by a wide margin — 25% win,
// −3.80%/trade — and it failed precisely on the high-RVOL, high-ATR pumps the
// gates above would still pass (ADVB rvol 18 lost −3.9%, ZYBT rvol 25 lost −8.0%).
// Published practice agrees: the 9 EMA whips on small-cap news pumps because price
// slices it every other candle. Quarantine its TRIGGERS — the setup stays visible
// as a watch and keeps logging state, so we can keep measuring it. Flip to re-enable.
const EMA9_BOUNCE_TRIGGERS_ENABLED = false

// Past this multiple of the (already ATR-scaled) threshold, price is deep enough
// off the high that the 4-bar rollingOver() confirmation becomes redundant — and,
// worse, brittle: a single green bounce candle flips its net-down test and de-arms
// the veto even as the name keeps bleeding. 2026-07-13 BRAI spiked to 11.33 on a
// rejection wick then fell straight to 6.42; its worst late entries fired at ~17%
// off that high (−5.7% / −4.5%) but a green print had cleared the flag. 1.5× keeps
// the quiet-name floor at 7.5% (won't clip a clean shallow first pullback) while
// flagging BRAI-style falling knives from ~16% down regardless of the last candle.
const ROLLOVER_DEEP_MULT = 1.5

/** Veto a long *bounce* trigger when price has already rolled over well off the session high. */
export function longBounceRolledOver(ctx: DetectionContext): boolean {
  const offHigh = offSessionHighPct(ctx)
  if (offHigh == null) return false
  const atrFrac = ctx.technical.atr != null && ctx.price > 0 ? ctx.technical.atr / ctx.price : null
  const threshold = atrFrac != null
    ? Math.max(ROLLOVER_OFF_HIGH_PCT, atrFrac * ROLLOVER_MIN_ATR)
    : ROLLOVER_OFF_HIGH_PCT
  if (offHigh <= threshold) return false
  return offHigh > threshold * ROLLOVER_DEEP_MULT || rollingOver(ctx.candles)
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

  // Stop placement. Strength entries (breaks/reclaims confirmed by a new high)
  // trail the stop up to the breakout pivot — ~STOP_ATR_MULT ATR under the ACTUAL
  // fill — so a chased fill doesn't inherit the far base-low stop and a 0.1R trade.
  // We only ever TIGHTEN toward the pivot; never loosen past the structural
  // invalidation. Bounces keep their structural stop (with the legacy noise floor).
  let stopRef = invalidation
  if (STRENGTH_ENTRY_TYPES.includes(type)) {
    const atr = t.atr != null && t.atr > 0 ? t.atr : entryFill * MIN_STOP_FLOOR_PCT
    const stopDist = Math.max(atr * STOP_ATR_MULT, entryFill * MIN_STOP_FLOOR_PCT)
    const pivotStop = direction === 'long' ? entryFill - stopDist : entryFill + stopDist
    stopRef = direction === 'long' ? Math.max(invalidation, pivotStop) : Math.min(invalidation, pivotStop)
  } else {
    // Minimum stop-width floor: widen a degenerate sub-MIN_STOP_PCT stop so we never
    // emit a scalp that noise stops out (SEER 0.6%, 2026-07-06). Only ever widens.
    const minStopDist = price * MIN_STOP_PCT
    if (direction === 'long' && entryRef - stopRef < minStopDist) stopRef = entryRef - minStopDist
    else if (direction === 'short' && stopRef - entryRef < minStopDist) stopRef = entryRef + minStopDist
  }
  const riskDist = Math.abs(entryFill - stopRef)

  // Candidate targets: ranked levels in the trade direction, plus any synthetic
  // targets (measured moves) supplied by momentum setups. Keep those genuinely
  // beyond price, nearest-first, deduped within 0.3%.
  const cand: { price: number; label: string }[] = [
    ...forward.map(l => ({ price: l.midpoint, label: l.sourceLabels[0] ?? '' })),
    ...(args.extraTargets ?? []).map(p => ({ price: p, label: 'measured move' })),
  ]
  const dirLong = direction === 'long'
  // Targets must sit beyond the ACTUAL entry fill, not the current price. entryFill
  // can be above price (a level-based zone the trigger closed through), so filtering
  // on price let a "target" land between price and the fill — i.e. BELOW the entry.
  // 2026-07-22 KUST/MWC/INM each logged a first target under their fill (negative
  // rr), and one even booked a phantom +1.2% "win" hitting a target below entry.
  // The first rated target must clear a meaningful reward beyond the fill (see
  // MIN_T1_REWARD_R) — a level a few bps away is noise that tanks R/R and books
  // phantom wins. Skip those in favour of the measured move behind them.
  const minReward = Math.max(riskDist * MIN_T1_REWARD_R, entryFill * MIN_T1_REWARD_PCT)
  const targetFloor = dirLong ? entryFill + minReward : entryFill - minReward
  const picked: { price: number; label: string }[] = []
  for (const o of cand
    .filter(o => dirLong ? o.price > targetFloor : o.price < targetFloor)
    .sort((a, b) => dirLong ? a.price - b.price : b.price - a.price)) {
    if (!picked.some(p => Math.abs(p.price - o.price) / o.price < 0.003)) picked.push(o)
  }
  const targets: SetupTarget[] = picked.slice(0, 3).map((o, i) => ({
    price: o.price,
    label: `T${i + 1}${o.label ? ` (${o.label})` : ''}`,
    rewardRisk: rr(entryFill, stopRef, o.price),
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
  // An over-extended long bounce is a chase, not a fillable trigger — drop it
  // entirely. The cap widens for a strength entry on a genuine runner (see
  // maxTriggerExtension) so the day's top gainers aren't refused for running fast.
  const maxExt = maxTriggerExtension(ctx, type)
  const extended = direction === 'long'
    ? price > zoneUpper * (1 + maxExt)
    : price < zoneLower * (1 - maxExt)
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
  const triggered = reclaim && volumeConfirmsTrigger(candles) && newHighAfterPullback(candles) && !bounceBlocked(ctx)
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
    vetoTrigger: { active: longBounceRolledOver(ctx), reason: 'Rolled over well off the session high — bounce may be a falling knife' },
    notes: `${depth[0].toUpperCase() + depth.slice(1)} pullback. Prioritise controlled selling; avoid buying large red candles.`,
    risks: t.lowerHighsLows ? ['Lower highs/lows forming — pullback may become a trend reversal'] : [],
  })
}

// The first-pullback continuation entry on a RUNNER. The biggest gainers move
// parabolically — you can't catch the initial vertical break without chasing past
// the extension cap (CYCU +495%, 2026-07-30). The tradeable entry is the FIRST
// orderly pullback: a strong in-play name that ran, digested a few bars off its
// high while holding VWAP, then makes a new high off the dip. Entering the reclaim
// sits right at the pullback high (not extended), stop under the higher-low → good
// R/R on a name that's already proven it can run. Gated hard to strong uptrends so
// it never becomes a knife-catcher; the rollover veto drops it once the pullback
// turns into a reversal.
const MOMENTUM_PULLBACK_MIN_CHANGE = 10   // ≥ this % on the day = a genuine runner
const MOMENTUM_PULLBACK_MAX_DEPTH = 0.10  // pullback no deeper than this off the high (first pullback, not a rollover)
// Cap the stop distance. On a hyper-ATR name the 3-bar pullback low can sit far
// below the entry from one wild wick (ZEO 2026-07-31: pbLow 26% under entry → a
// −26.8% trade), even when price is only a few % off the high. Never let the stop
// exceed this % below the reclaim — a tighter stop stops out more on wild names,
// but caps the per-trade loss instead of blowing up the book on one candle.
const MOMENTUM_PULLBACK_MAX_STOP_PCT = 0.08

function detectMomentumPullback(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles, sessionLevels: sl } = ctx
  const vwap = sl.vwap
  if (vwap == null) return null

  // Only strong, in-play runners holding trend — not a generic dip.
  if (!inPlay(ctx)) return null
  if (t.trend5m === 'down') return null
  if (price < vwap) return null
  if (t.higherHighsLows !== true) return null
  if (ctx.changePct < MOMENTUM_PULLBACK_MIN_CHANGE) return null

  if (candles.length < 6) return null
  const prior = candles.slice(0, -1)              // everything before the current (breakout) bar
  const recentHigh = Math.max(...lastN(prior, 12).map(c => c.high)) // the run high being reclaimed
  const pbBars = lastN(prior, 3)                  // the digestion bars before the reclaim
  if (pbBars.length < 2) return null
  const pbHigh = Math.max(...pbBars.map(c => c.high)) // the reclaim / trigger level
  const pbLow = Math.min(...pbBars.map(c => c.low))   // the higher-low we stop under

  // Shallow, controlled pullback off the high — not a deep give-back / rollover.
  const offHigh = recentHigh > 0 ? (recentHigh - price) / recentHigh : 1
  if (offHigh > MOMENTUM_PULLBACK_MAX_DEPTH) return null
  if (price <= pbLow) return null

  const atr = t.atr ?? price * 0.01
  const zoneUpper = pbHigh
  const zoneLower = pbLow
  // Stop under the pullback low, but never further than MAX_STOP_PCT below the reclaim.
  const rawInvalidation = pbLow - Math.max(atr * 0.5, price * 0.005)
  const invalidation = Math.max(rawInvalidation, pbHigh * (1 - MOMENTUM_PULLBACK_MAX_STOP_PCT))

  const triggered = newHighAfterPullback(candles) && volumeConfirmsTrigger(candles) && price >= pbHigh
  const confirming = price >= zoneLower && price <= zoneUpper && volumeContracting(candles)
  const rvol = t.relativeVolume ?? 0
  const signals =
    (newHighAfterPullback(candles) ? 1 : 0) + (volumeExpanding(candles) ? 1 : 0) +
    (rvol >= 2 ? 1 : 0) + (price > vwap ? 1 : 0)

  // Targets: reclaim the prior high, then the measured continuation (the run height).
  const runHeight = Math.max(recentHigh - pbLow, price * 0.01)
  const extraTargets = [recentHigh, recentHigh + runHeight]

  return buildSetup({
    ctx, type: 'momentum_pullback', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `First pullback on a runner (+${ctx.changePct.toFixed(0)}% day, RVOL ${rvol.toFixed(1)}×) — digesting ${(offHigh * 100).toFixed(1)}% off the high $${recentHigh.toFixed(2)}, holding VWAP. Enter the reclaim of $${pbHigh.toFixed(2)}.`,
    confirmation: [
      `Reclaim of the pullback high $${pbHigh.toFixed(2)} — first new high off the dip`,
      'Selling volume dried up into the pullback',
      'Still holding above VWAP — trend intact',
    ],
    invalidation,
    testCount: 0,
    scoringOverrides: {
      volumeContractsIntoZone: volumeContracting(candles),
      volumeExpandsOnSignal: volumeExpanding(candles),
    },
    confirmationSignals: signals,
    triggered,
    confirming,
    vetoTrigger: { active: longBounceRolledOver(ctx), reason: 'Pullback rolled over well off the high — continuation may have failed' },
    extraTargets,
    notes: 'First-pullback continuation on a strong intraday runner. Stop under the pullback low; targets the prior high then the measured continuation.',
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
  const triggered = closedAbove && volumeConfirmsTrigger(candles)
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

// Premarket breakout. The day's biggest movers usually set up before 09:30: a
// name gapping on a catalyst that pushes through its premarket high while holding
// premarket VWAP is the earliest read on a runner. This fires ONLY in premarket
// (RTH hands off to the ORB detector at the open) and demands a real gap + a VWAP
// hold, so it flags the in-play gappers and stays quiet on names drifting on air.
// Premarket access thresholds — loosened 2026-07-29 to arm more early gappers
// (was gap 4% / coil 3%). The PM-VWAP hold below is kept as the quality gate, so
// this widens breadth without re-admitting fading names. NOTE: premarket fills are
// thin — treat the resulting P/L with a slippage haircut, not at face value.
const PREMARKET_MIN_GAP_PCT = 2    // gap vs prior close to count as "in play" (was 4)
const PREMARKET_MAX_COIL_PCT = 0.05 // prior bars must have based within this % of the PM high (was 0.03)

function detectPremarketBreakout(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, sessionLevels: sl, candles, session } = ctx
  if (session !== 'premarket') return null
  const pmHigh = sl.premarketHigh
  const prevClose = sl.previousClose
  if (pmHigh == null || prevClose == null || prevClose <= 0 || candles.length < 4) return null

  // Real gapper in play, and holding above premarket VWAP (buyers in control).
  const gapPct = ((price - prevClose) / prevClose) * 100
  if (gapPct < PREMARKET_MIN_GAP_PCT) return null
  const vwap = sl.vwap
  if (vwap != null && price < vwap) return null

  // Anti-spike: a premarket "breakout" that's a single print tagging the high from
  // far below (thin book) doesn't hold into the open. But there are TWO healthy
  // shapes into a break, not one: price COILED near the high (a base), OR it's
  // climbing on HIGHER LOWS (a steady continuation). Require either — that still
  // rejects the spike-from-nowhere while letting the many gappers that grind up to
  // new premarket highs fire (they were the ones we were missing before the open).
  const priorHigh = Math.max(...candles.slice(0, -1).map(c => c.high))
  const coiled = (pmHigh - priorHigh) / pmHigh <= PREMARKET_MAX_COIL_PCT
  const continuation = makingHigherLows(candles)
  if (!coiled && !continuation) return null

  // Break level = the premarket high; clearing the prior-day high too is extra strength.
  const band = (t.atr ?? price * 0.01) * 0.3
  const zoneUpper = pmHigh
  const zoneLower = pmHigh - Math.max(band, price * 0.006)
  const invalidation = pmHigh - Math.max((t.atr ?? price * 0.01) * 0.5, price * 0.01)

  const lastCandle = candles[candles.length - 1]
  const closedAbove = lastCandle ? lastCandle.close > pmHigh : false
  const rvol = t.relativeVolume ?? 0
  // Premarket volume is thin — accept a bar-over-bar expansion OR elevated RVOL.
  const volumeOk = volumeConfirmsTrigger(candles) || rvol >= 1.5
  const triggered = closedAbove && price > pmHigh && volumeOk
  const confirming = price >= zoneLower && price <= zoneUpper
  const pdh = sl.previousDayHigh
  const signals =
    (closedAbove ? 1 : 0) + (volumeOk ? 1 : 0) +
    (vwap != null && price > vwap ? 1 : 0) + (pdh != null && price > pdh ? 1 : 0)

  // Targets: prior-day high (the classic gap target) then measured moves off the gap.
  const range = Math.max((t.atr ?? price * 0.02) * 2, price * 0.02)
  const extraTargets: number[] = []
  if (pdh != null && pdh > price * 1.002) extraTargets.push(pdh)
  extraTargets.push(pmHigh + range, pmHigh + range * 2)

  return buildSetup({
    ctx, type: 'premarket_breakout', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `Premarket breakout — gapped +${gapPct.toFixed(0)}% and pushing through the premarket high $${pmHigh.toFixed(2)}${vwap != null ? `, holding above PM VWAP $${vwap.toFixed(2)}` : ''}. RVOL ${rvol.toFixed(1)}×.`,
    confirmation: [
      `Candle CLOSE above the premarket high $${pmHigh.toFixed(2)}`,
      'Real volume behind the push (premarket is thin — demand bids)',
      'Holds the gap and PM VWAP into the 09:30 open',
    ],
    invalidation,
    testCount: 0,
    scoringOverrides: {
      volumeExpandsOnSignal: volumeOk,
      unusualVolume: rvol > 3,
    },
    confirmationSignals: signals,
    triggered,
    confirming,
    extraTargets,
    notes: 'Premarket: thin liquidity and wide spreads — size down and expect slippage. Strongest when it holds the gap into the open.',
    risks: [
      'Premarket liquidity is thin — fills and stops are unreliable',
      ...(rvol < 1.5 ? ['Light premarket volume — the gap may fade at the open'] : []),
    ],
  })
}

// Opening-range break / gap-and-go. The biggest movers declare themselves early:
// an in-play, gapped name that holds above VWAP and breaks its opening-range high
// on expanding volume runs to multiple targets (2026-07-14's winners — LEDS 09:35,
// FCEL/EDBL/YYGH on their opening pushes — were all this shape, yet no detector
// targeted it; we only had dip-buyers). The go/no-go filter is the lesson from the
// losers: a gapper is a "go" ONLY while it holds VWAP. NXTC/SHPH had already lost
// VWAP when we bought their "bounce" and knifed — this detector never fires there.
// The opening drive — the first 10% move of the day, before an opening range even
// exists. ORB can't fire until or5High is set (~09:35) and by 09:45 it switches to
// the wider 15-min range, so a name that tops early (NUWE peaked 09:40, 2026-07-30)
// is missed. This covers 09:30–09:45: a gapper in play driving through its premarket
// high (or prior-day high) on the open push, holding VWAP. Hands off to ORB after.
const OPENING_DRIVE_WINDOW_MIN = 15

function detectOpeningDrive(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, sessionLevels: sl, candles, session } = ctx
  if (session !== 'regular') return null
  if (ctx.minutesSinceOpen == null || ctx.minutesSinceOpen >= OPENING_DRIVE_WINDOW_MIN) return null

  const vwap = sl.vwap
  if (!inPlay(ctx)) return null
  if (ctx.changePct <= 0) return null           // green on the day
  if (vwap != null && price < vwap) return null  // holding VWAP
  if (t.trend5m === 'down') return null

  // The level a fresh gapper must clear to keep running: its premarket high, else PDH.
  const pmHigh = sl.premarketHigh
  const pdh = sl.previousDayHigh
  const breakLevel = pmHigh ?? pdh
  if (breakLevel == null) return null
  if (price > breakLevel * 1.05) return null     // already well past → a chase, not the drive

  const atr = t.atr ?? price * 0.01
  const band = atr * 0.3
  const zoneUpper = breakLevel
  const zoneLower = breakLevel - Math.max(band, price * 0.004)
  const invalidation = breakLevel - Math.max(atr * 0.5, price * 0.008)

  const lastCandle = candles[candles.length - 1]
  const closedAbove = lastCandle ? lastCandle.close > breakLevel : false
  const rvol = t.relativeVolume ?? 0
  const volOk = volumeConfirmsTrigger(candles) || rvol >= 2
  const triggered = closedAbove && price > breakLevel && volOk
  const confirming = price >= zoneLower && price <= zoneUpper
  const signals =
    (closedAbove ? 1 : 0) + (volOk ? 1 : 0) +
    (vwap != null && price > vwap ? 1 : 0) + (pdh != null && price > pdh ? 1 : 0)

  const range = Math.max(atr * 2, price * 0.02)
  const extraTargets: number[] = []
  if (pdh != null && breakLevel === pmHigh && pdh > price * 1.002) extraTargets.push(pdh)
  extraTargets.push(breakLevel + range, breakLevel + range * 2)

  return buildSetup({
    ctx, type: 'opening_drive', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `Opening drive — first 15 min, breaking the ${pmHigh != null ? 'premarket high' : 'prior-day high'} $${breakLevel.toFixed(2)} on the open push${vwap != null ? `, holding VWAP $${vwap.toFixed(2)}` : ''}. RVOL ${rvol.toFixed(1)}×.`,
    confirmation: [
      `Candle close above $${breakLevel.toFixed(2)} on the opening drive`,
      'Volume expanding on the push',
      'Holding above VWAP — no failed open',
    ],
    invalidation,
    testCount: 0,
    scoringOverrides: { volumeExpandsOnSignal: volumeExpanding(candles), unusualVolume: rvol > 3 },
    confirmationSignals: signals,
    triggered,
    confirming,
    extraTargets,
    notes: 'First-15-minute opening drive through the premarket / prior-day high — catches the early move before an opening range exists. Hands off to the ORB detector after.',
  })
}

function detectOpeningRangeBreak(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, sessionLevels: sl, candles } = ctx
  const vwap = sl.vwap
  const orHigh = sl.or15High ?? sl.or5High
  const orLow = sl.or15High != null ? sl.or15Low : sl.or5Low
  if (orHigh == null || vwap == null) return null

  // Go/no-go: bullish and in control. Green on the day, holding above VWAP, and
  // the 5-min trend not rolling over. Any of these failing = a fade, not a go.
  if (price < vwap) return null
  if (t.trend5m === 'down') return null
  if (ctx.changePct <= 0) return null

  // Break level = the opening-range high, unless the premarket high sits just
  // above it (a gapper that held into the open) — then the PM high is the real
  // resistance whose break confirms continuation.
  const pmHigh = sl.premarketHigh
  const breakLevel = pmHigh != null && pmHigh > orHigh && pmHigh < price * 1.03 ? pmHigh : orHigh
  const band = (t.atr ?? price * 0.01) * 0.3
  const zoneUpper = breakLevel
  const zoneLower = breakLevel - Math.max(band, price * 0.003)
  const invalidation = breakLevel - Math.max((t.atr ?? price * 0.01) * 0.5, price * 0.005)

  const lastCandle = candles[candles.length - 1]
  const closedAbove = lastCandle ? lastCandle.close > breakLevel : false
  const triggered = closedAbove && price > zoneUpper && volumeConfirmsTrigger(candles)
  const confirming = price >= zoneLower && price <= zoneUpper && makingHigherLows(candles)
  const rvol = t.relativeVolume ?? 0
  const signals =
    (closedAbove ? 1 : 0) + (volumeExpanding(candles) ? 1 : 0) +
    (rvol >= 2 ? 1 : 0) + (price > vwap ? 1 : 0)

  // Measured-move targets for a break into clean air (new HOD, no levels overhead):
  // project the opening-range height above the break, 1× and 2×.
  const orRange = orLow != null ? Math.max(orHigh - orLow, price * 0.01) : price * 0.02
  const extraTargets = [breakLevel + orRange, breakLevel + orRange * 2]
  const gapped = sl.previousClose != null && sl.openingPrint != null && sl.openingPrint > sl.previousClose * 1.02

  return buildSetup({
    ctx, type: 'opening_range_break', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `Opening-range break${gapped ? ' (gap-and-go)' : ''} — holding above VWAP ($${vwap.toFixed(2)}) and breaking the ${sl.or15High != null ? '15' : '5'}-min range high ($${breakLevel.toFixed(2)}). RVOL ${rvol.toFixed(1)}×.`,
    confirmation: [
      `Candle CLOSE above $${breakLevel.toFixed(2)} (not an intrabar tag)`,
      'Volume expands on the break (≥1.3× recent average)',
      'Holds above VWAP — no failed break back under it',
    ],
    invalidation,
    testCount: 0,
    scoringOverrides: {
      volumeExpandsOnSignal: volumeExpanding(candles),
      unusualVolume: rvol > 3,
    },
    confirmationSignals: signals,
    triggered,
    confirming,
    extraTargets,
    notes: gapped
      ? 'Gap-and-go: strongest when it never loses VWAP. First break has the cleanest odds.'
      : 'Intraday range break — best early; demand volume and a VWAP hold.',
    risks: rvol < 1.5 ? ['Light relative volume — breakout may not sustain'] : [],
  })
}

// High-of-day break continuation. On a trend day a strong name makes a LADDER of
// new highs — each break of the prior HOD after a tight base is a continuation
// thrust. We only ever caught these on the pullback (and the ORB catches just the
// first push), so the mid-trend breaks were missed entirely (HODO laddered
// 1.25→1.85 on 2026-07-14 and we only got its dips). The tight-base requirement
// doubles as the anti-blow-off filter: a vertical climax spike has no base under
// its high, so it never qualifies — we break WITH the trend, not into the top tick.
function detectHodBreak(ctx: DetectionContext): DetectedSetup | null {
  const { price, technical: t, candles } = ctx
  if (candles.length < 6) return null
  if (t.trend5m === 'down') return null

  // The HOD to break = highest high EXCLUDING the current bar, so a push to a new
  // high is a genuine break rather than just the running max.
  const prior = candles.slice(0, -1)
  const hod = Math.max(...prior.map(c => c.high))
  if (!(hod > 0)) return null

  // Require a tight base sitting just under the HOD — price coiled below the high,
  // not a vertical run into it (a chase) or a blow-off spike (which has no base).
  const atrFrac = (t.atr ?? price * 0.01) / price
  const base = lastN(prior, 4)
  const baseHigh = Math.max(...base.map(c => c.high))
  const baseLow = Math.min(...base.map(c => c.low))
  const tightBase = baseHigh > 0 && (baseHigh - baseLow) / baseHigh < Math.max(0.025, atrFrac * 1.5)
  const baseNearHod = (hod - baseHigh) / hod < 0.02
  if (!tightBase || !baseNearHod) return null

  const band = (t.atr ?? price * 0.01) * 0.3
  const zoneUpper = hod
  const zoneLower = hod - Math.max(band, price * 0.004)
  const invalidation = baseLow - Math.max((t.atr ?? price * 0.01) * 0.4, price * 0.004)

  const lastCandle = candles[candles.length - 1]
  const closedAbove = lastCandle ? lastCandle.close > hod : false
  const rvol = t.relativeVolume ?? 0
  const triggered = closedAbove && price > hod && volumeConfirmsTrigger(candles) && makingHigherLows(candles)
  const confirming = price >= zoneLower && price <= zoneUpper && makingHigherLows(candles)
  const signals =
    (closedAbove ? 1 : 0) + (volumeExpanding(candles) ? 1 : 0) +
    (rvol >= 2 ? 1 : 0) + (makingHigherLows(candles) ? 1 : 0)

  // Measured-move targets: the base height projected above the break (a new HOD
  // breaks into clean air with no levels overhead).
  const baseRange = Math.max(baseHigh - baseLow, price * 0.01)
  const extraTargets = [hod + baseRange, hod + baseRange * 2]

  return buildSetup({
    ctx, type: 'hod_break', direction: 'long',
    zoneLower, zoneUpper,
    rationale: `High-of-day break — tight base under $${hod.toFixed(2)} then a push through it. Trend ${t.trend15m}, RVOL ${rvol.toFixed(1)}×.`,
    confirmation: [
      `Candle CLOSE above the HOD $${hod.toFixed(2)} (not an intrabar tag)`,
      'Volume expands on the break bar',
      'Base holds — no failed break back under it',
    ],
    invalidation,
    testCount: 0,
    scoringOverrides: {
      volumeExpandsOnSignal: volumeExpanding(candles),
      constructiveConsolidation: true,
      unusualVolume: rvol > 3,
    },
    confirmationSignals: signals,
    triggered,
    confirming,
    extraTargets,
    notes: 'Continuation: buy the break with the trend, trail under each new base. Skips vertical blow-offs (no base).',
    risks: rvol < 1.5 ? ['Light relative volume — new-high break may fail'] : [],
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
  const triggered = holding && volumeConfirmsTrigger(candles) && newHighAfterPullback(candles) &&
    price > zoneUpper && !bounceBlocked(ctx) &&
    (which === 'ema9' ? EMA9_BOUNCE_TRIGGERS_ENABLED : true)
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
    vetoTrigger: { active: longBounceRolledOver(ctx), reason: 'Rolled over well off the session high — bounce may be a falling knife' },
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
  // A VWAP *bounce* only makes sense in an intraday uptrend. Alone among the
  // long-bounce detectors, detectVwap had no trend filter, so it fired on any
  // name near VWAP — including ones that had topped and were fading straight
  // through it. 2026-07-14 was 53/54 vwap_bounces and most losers were exactly
  // this: a "bounce" bought into a 5-min downtrend (GLOO/LHAI/NXTC/TRNR/SOBR/…).
  // Match the guard every sibling has (detectEmaBounce/detectPullback). The
  // reclaim-from-below subtype keeps its own volume-expansion gate, so only the
  // above-VWAP bounce is filtered here.
  if (above && t.trend5m === 'down') return null
  const type: SetupType = above ? 'vwap_bounce' : 'vwap_reclaim'
  const direction: SetupDirection = 'long'
  const invalidation = above ? zoneLower - band : vwap - band * 2
  const tests = t.vwapCrossCount

  const lastCandle = candles[candles.length - 1]
  const reclaimed = lastCandle ? lastCandle.close > vwap : false
  const confirming = Math.abs(price - vwap) / vwap < (band / vwap) && makingHigherLows(candles)
  // The above-VWAP bounce previously asked only that volume CONTRACT into the
  // zone — never that it confirm on the way out. Published practice is explicit
  // that both halves are required: volume dries up on the pullback AND spikes on
  // the bounce candle; without the surge it's a false signal. (The reclaim case
  // already demanded expansion.)
  const triggered = (above
    ? reclaimed && newHighAfterPullback(candles) && volumeContractingBefore(candles) &&
      volumeConfirmsTrigger(candles) && price > zoneUpper
    : reclaimed && newHighAfterPullback(candles) && volumeConfirmsTrigger(candles) && price > vwap) && !bounceBlocked(ctx)
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
      volumeContractsIntoZone: above && volumeContractingBefore(candles),
      volumeExpandsOnSignal: volumeExpanding(candles),
    },
    confirmationSignals: signals,
    triggered,
    confirming,
    vetoTrigger: { active: longBounceRolledOver(ctx), reason: 'Rolled over well off the session high — bounce may be a falling knife' },
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
  const triggered = closedAbove && volumeConfirmsTrigger(candles)
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
  const triggered = closedAbove && volumeConfirmsTrigger(candles) && makingHigherLows(candles)
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
  const triggered = lastCandle ? lastCandle.close < res.lower && volumeConfirmsTrigger(candles) : false
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
  const triggered = lostLevel && volumeConfirmsTrigger(candles)
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
  // Data-integrity gate: if the quote price disagrees wildly with the candle
  // tape, the two feeds are out of sync and every signal built on it is garbage
  // (2026-07-10: DCX/IOTR/HAO/ELAB logged entries 11–47% outside the day's
  // actual range). Only the egregious cases are blocked (>10%), so a genuine
  // fast breakout tick above recent highs still trades.
  const recent = lastN(ctx.candles, 20)
  if (recent.length >= 5) {
    const hi = Math.max(...recent.map(c => c.high))
    const lo = Math.min(...recent.map(c => c.low))
    if (hi > 0 && (ctx.price > hi * 1.1 || ctx.price < lo * 0.9)) return []
  }
  // Liquidity floor: a name printing a few hundred shares a bar can't be filled,
  // so a "signal" on it is noise that only pollutes the log. 2026-07-14 logged
  // entries on WFF/AMPGZ/DCX/late-EDBL (recent $-vol well under $30k) that no one
  // could trade. Require a small floor of recent dollar volume. Set deliberately
  // low — real movers (even thin low-floats) clear it by orders of magnitude
  // ($5M+ over 5 bars), so this only removes the truly dead, never a runner.
  const liq = lastN(ctx.candles, 5)
  if (liq.length >= 5) {
    // Some feeds (notably Yahoo premarket) return bars with price but volume 0.
    // That's a DATA GAP, not illiquidity — gating on it silently blocked every
    // setup on every symbol in premarket, which is why premarket_breakout could
    // never fire. Only apply the floor when we actually have volume data.
    const shareVol = liq.reduce((s, c) => s + c.volume, 0)
    if (shareVol > 0) {
      const dollarVol = liq.reduce((s, c) => s + c.volume * c.close, 0)
      if (dollarVol < MIN_RECENT_DOLLAR_VOL) return []
    }
  }
  const out: (DetectedSetup | null)[] = [
    detectPullback(ctx),
    detectMomentumPullback(ctx),
    detectBreakout(ctx),
    detectPremarketBreakout(ctx),
    detectOpeningDrive(ctx),
    detectOpeningRangeBreak(ctx),
    detectHodBreak(ctx),
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
