/**
 * Buy-log gate stack — the single source of truth for turning a triggered setup
 * into a logged BUY signal (or a drop). Shared by the client sweep
 * (`useMonitor`), the headless alert daemon (`scripts/alert-daemon.ts`), and the
 * backtest/diagnostic tools — so the gates can't drift between them.
 *
 * Nothing here reaches for the clock beyond the caller-supplied `now`, so it runs
 * identically in the browser and on the server.
 */
import type {
  DetectedSetup, MonitorResult, BuySignalRecord, SetupLog, SetupStateRecord, SetupType,
} from '@/types'
import { etMinutesOfDay } from './market-hours'

// ── Constants ────────────────────────────────────────────────────────────────

// Display/tracking floor: a setup below this score isn't tracked unless its level
// quality clears the level-strength bar.
export const DISPLAY_FLOOR_SCORE = 55

// Liquidity floors. Buy signals need real volume behind them.
export const MIN_BUY_VOLUME = 100_000
export const MIN_PREMARKET_BUY_VOLUME = 50_000
// A strong RVOL surge clears the absolute premarket floor — thin-float rockets
// (YXT: 46× on 46k shares) trade a fraction of a regular session in absolute
// terms but many multiples of their own norm, which is the real "in play" tell.
export const PREMARKET_SURGE_RVOL = 10

// Grade floor: below-grade signals are dropped except the early-momentum winners.
export const GRADE_FLOOR_EXEMPT = new Set<SetupType>(['opening_drive'])

// Per-symbol log cap (anti-spray). A proven runner near its high on a strong RVOL
// surge may be scaled past the normal cap + grade floor, up to a higher-but-finite
// ceiling (RITR/PAVS were floored/capped despite being the target profile).
export const MAX_LOGS_PER_SYMBOL = 2
export const MAX_LOGS_PER_SYMBOL_RUNNER = 4
export const STRONG_CONT_MAX_BELOW_HIGH_PCT = 3   // within 3% of the session high
export const STRONG_CONT_MIN_RVOL = 10            // ≥10× average = a real surge
export const SYMBOL_LOG_WINDOW_MS = 12 * 60 * 60 * 1000  // one session

// Entry-cluster dedup.
export const ENTRY_SIMILARITY_PCT = 0.03
export const BUY_DEDUP_COOLDOWN_MS = 45 * 60 * 1000

// Failed-bounce stand-down + win/loss cap.
export const STANDDOWN_MS = 120 * 60 * 1000
export const SYMBOL_CAP_MS = 120 * 60 * 1000
export const SYMBOL_WIN_CAP = 2
export const BOUNCE_TYPES = new Set<SetupType>(['pullback', 'vwap_bounce', 'vwap_reclaim', 'ema9_bounce', 'ema21_bounce'])

// Late-session cutoff: no new regular-hours BUYs at/after 14:00 ET.
export const LATE_LOG_CUTOFF_ET_MIN = 14 * 60

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isDuplicateBuy(sym: string, entryHigh: number, now: number, prior: BuySignalRecord[]): boolean {
  for (const b of prior) {
    if (b.symbol !== sym) continue
    if (now - b.timestamp > BUY_DEDUP_COOLDOWN_MS) continue
    if (b.entryHigh > 0 && Math.abs(entryHigh - b.entryHigh) / b.entryHigh < ENTRY_SIMILARITY_PCT) return true
  }
  return false
}

export function recentlyFailedBounce(sym: string, now: number, states: SetupStateRecord[]): boolean {
  return states.some(r =>
    r.symbol === sym && r.state === 'failed' && BOUNCE_TYPES.has(r.type) &&
    now - r.updatedAt < STANDDOWN_MS)
}

export function symbolCapReached(sym: string, now: number, logs: SetupLog[], buys: BuySignalRecord[]): boolean {
  const lostSetupIds = new Set(
    logs
      .filter(l => l.outcome === 'invalidated' && l.resolvedAt != null && now - l.resolvedAt < SYMBOL_CAP_MS)
      .map(l => l.id),
  )
  const hasLoss = buys.some(b => b.symbol === sym && lostSetupIds.has(b.setupId))
  if (hasLoss) return true
  const wins = logs.filter(
    l => l.symbol === sym && l.outcome === 'target_hit' && l.resolvedAt != null && now - l.resolvedAt < SYMBOL_CAP_MS,
  ).length
  return wins >= SYMBOL_WIN_CAP
}

/** The display/tracking floor: score ≥ 55, or level quality/confidence clears the bar. */
export function passesTrackingFloor(setup: DetectedSetup, minLevelStrength: number): boolean {
  const meetsLevel = (setup.breakdown.levelQuality / 20) * 100 >= minLevelStrength * 0.2 || setup.confidence >= minLevelStrength
  return setup.score >= DISPLAY_FLOOR_SCORE || meetsLevel
}

// ── Classifier ───────────────────────────────────────────────────────────────

export type BuyVerdict = 'logged' | 'session' | 'volume' | 'veto' | 'standDown' | 'capped' | 'dup'

export interface ClassifyContext {
  now: number
  priorBuys: BuySignalRecord[]      // buys already logged this session (dedup + cap)
  priorLogs: SetupLog[]             // latched setup logs (win/loss cap)
  priorStates: SetupStateRecord[]   // state records (failed-bounce stand-down)
}

/**
 * Decide whether a triggered long setup logs a BUY, or which gate drops it.
 * Caller must pass a setup that is `direction: 'long'`, `triggeredRaw`, and has
 * already cleared `passesTrackingFloor`. Same gate order and geometry the client
 * has always used — this is the extraction of that logic, verbatim.
 */
export function classifyBuy(setup: DetectedSetup, r: MonitorResult, ctx: ClassifyContext): { verdict: BuyVerdict; buy?: BuySignalRecord } {
  const { now, priorBuys, priorLogs, priorStates } = ctx
  const fill = setup.entryFill ?? setup.zoneUpper

  // A proven runner near its high on a strong RVOL surge may be scaled past the
  // normal throttles (grade floor + cap + win/loss stand-down). Narrow by design.
  const offHighPct = r.technicals?.distanceFromDayHighPct ?? null   // negative = below the high
  const strongContinuation = !BOUNCE_TYPES.has(setup.type) &&
    offHighPct != null && offHighPct >= -STRONG_CONT_MAX_BELOW_HIGH_PCT &&
    r.relativeVolume != null && r.relativeVolume >= STRONG_CONT_MIN_RVOL

  const standDown = BOUNCE_TYPES.has(setup.type) && recentlyFailedBounce(setup.symbol, now, priorStates)
  const symbolLogsThisSession = priorBuys.filter(
    b => b.symbol === setup.symbol && now - b.timestamp < SYMBOL_LOG_WINDOW_MS,
  ).length
  const overLogged = symbolLogsThisSession >= (strongContinuation ? MAX_LOGS_PER_SYMBOL_RUNNER : MAX_LOGS_PER_SYMBOL)
  const capped = overLogged || (!strongContinuation && symbolCapReached(setup.symbol, now, priorLogs, priorBuys))
  const gradeFloorFail = setup.grade === 'below' && !GRADE_FLOOR_EXEMPT.has(setup.type) && !strongContinuation
  const dup = isDuplicateBuy(setup.symbol, fill, now, priorBuys)

  // After-close gate + late-session cutoff: premarket always tradeable; regular
  // hours only before 14:00 ET.
  const tradeable = r.integrity.session === 'premarket' ||
    (r.integrity.session === 'regular' && etMinutesOfDay(now) < LATE_LOG_CUTOFF_ET_MIN)
  // Premarket: pass on absolute volume, an unmeasured (null) reading, or a strong surge.
  const premarketSurge = r.relativeVolume != null && r.relativeVolume >= PREMARKET_SURGE_RVOL
  const volumeOk = r.integrity.session === 'premarket'
    ? r.premarketVolume == null || r.premarketVolume >= MIN_PREMARKET_BUY_VOLUME || premarketSurge
    : r.volume === 0 || r.volume >= MIN_BUY_VOLUME

  if (!tradeable) return { verdict: 'session' }
  if (!volumeOk) return { verdict: 'volume' }
  if (setup.qualityVetoed || gradeFloorFail) return { verdict: 'veto' }
  if (standDown) return { verdict: 'standDown' }
  if (capped) return { verdict: 'capped' }
  if (dup) return { verdict: 'dup' }

  const t1 = setup.targets[0]?.price ?? null
  const rr = t1 != null && fill > setup.stopReference
    ? Math.round(((t1 - fill) / (fill - setup.stopReference)) * 10) / 10
    : setup.rewardRisk
  const buy: BuySignalRecord = {
    id: `${setup.id}:triggered:${Math.floor(now / 1000)}`,
    setupId: setup.id,
    symbol: setup.symbol,
    timestamp: now,
    setupType: setup.type,
    triggerPrice: setup.signal.triggerPrice ?? setup.zoneUpper,
    entryLow: setup.zoneLower,
    entryHigh: fill,
    invalidation: setup.invalidation,
    stop: setup.stopReference,
    targets: setup.targets.map(t => t.price),
    score: setup.score,
    grade: setup.grade,
    rewardRisk: rr,
    priceAtSignal: r.price,
    flagged: false,
    ctxTrend15m: r.technicals?.trend15m,
    ctxDistVwapPct: r.technicals?.distanceFromVwapPct ?? null,
    ctxDistDayHighPct: r.technicals?.distanceFromDayHighPct ?? null,
    ctxRelVol: r.relativeVolume,
    ctxHigherHighsLows: r.technicals?.higherHighsLows ?? null,
    ctxAtrPct: r.technicals?.atrPct ?? null,
  }
  return { verdict: 'logged', buy }
}
