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

// PER-SYMBOL LOG CAP — removed 2026-08-07, RESTORED 2026-08-11.
//
// One session without it was decisive: on 2026-08-10 VATE logged and filled THREE
// times (12.00, 12.65, 13.00) for −$1,306 — 65% of the day's −$2,012. The third
// fill alone (−$356) is one the cap would have refused outright. Restored at 2,
// and now swept alongside the leg-maturity gate rather than assumed:
//   MAX_LOGS_PER_SYMBOL=3 npx tsx scripts/backtest.ts
//
// Original rationale and the history that led here:
//
// It caps a name at 2 logged ideas per session (anti-spray: TNMG logged 8× as it
// climbed, ENSC 6×, on the 70-signal/27%-win day of 2026-08-04). Raising it 2→3 was
// A/B'd on 2026-08-05 and DILUTED the book (106→137 signals, 46%→42% win,
// +1.25→+0.81%/trade).
//
// KNOWN SHARP EDGE: the count is read from persisted buy history, which survives a
// daemon restart — so signals logged by an EARLIER run consume the budget. On
// 2026-08-07 CELZ was `capped` at 08:18 ET on slots used at 07:03/07:04 by a
// previous daemon process. If that bites again, prune the history to the current
// session on load rather than removing the cap.
export const MAX_LOGS_PER_SYMBOL = envInt('MAX_LOGS_PER_SYMBOL', 2)
export const SYMBOL_LOG_WINDOW_MS = 12 * 60 * 60 * 1000  // one session

/** Env override that is inert in the browser; lets the replay sweep the cap. */
function envInt(key: string, fallback: number): number {
  const raw = typeof process !== 'undefined' && process.env ? process.env[key] : undefined
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

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

  // NOTE: a "strong continuation" override (near-high + high-RVOL clears the grade
  // floor and the per-symbol cap) was shipped 2026-08-06 on the strength of the
  // RITR/PAVS misses, then REVERTED 2026-08-07 after a clean A/B on the same
  // 148-symbol pool: it added 38 signals but cut expectancy from +0.76% to
  // +0.41%/trade (net +98% → +70% over 20 days). Those two trades were real
  // winners, but the class they belong to loses more than it makes. Do not
  // reintroduce without a backtest showing otherwise.
  const standDown = BOUNCE_TYPES.has(setup.type) && recentlyFailedBounce(setup.symbol, now, priorStates)
  const symbolLogsThisSession = priorBuys.filter(
    b => b.symbol === setup.symbol && now - b.timestamp < SYMBOL_LOG_WINDOW_MS,
  ).length
  const overLogged = symbolLogsThisSession >= MAX_LOGS_PER_SYMBOL
  const capped = overLogged || symbolCapReached(setup.symbol, now, priorLogs, priorBuys)
  const gradeFloorFail = setup.grade === 'below' && !GRADE_FLOOR_EXEMPT.has(setup.type)
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

// ── H3A gate decomposition (telemetry only) ──────────────────────────────────
// A PURE PROJECTION of the classifyBuy gate stack into per-gate PASS/FAIL/binding,
// so the funnel log distinguishes OFF_HIGH_ONLY / GRADE_ONLY / OFF_HIGH+GRADE / etc.
// WITHOUT any later reconstruction. It recomputes the SAME intermediates classifyBuy
// uses (verbatim) and NEVER changes a decision — `decomposeGates().verdict` is asserted
// to equal `classifyBuy().verdict` for the same input (see tests). classifyBuy above is
// untouched. The veto tier is broken into its real sub-components, read from the
// additive `setup.gateGeometry` the detector already computed.

export interface BuyGateRecord {
  gateId: string
  observedValue: number | string | boolean | null
  ruleValue: number | string | boolean | null
  result: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'
  binding: boolean | 'unknown'
}

export function decomposeGates(
  setup: DetectedSetup,
  r: MonitorResult,
  ctx: ClassifyContext,
): { verdict: BuyVerdict; gates: BuyGateRecord[] } {
  const { now, priorBuys, priorLogs, priorStates } = ctx
  const fill = setup.entryFill ?? setup.zoneUpper

  // ── SINGLE SOURCE OF TRUTH ─────────────────────────────────────────────────
  // The verdict is taken DIRECTLY from classifyBuy — decomposeGates never re-derives
  // it, so the two can never disagree (no "second truth"). Everything below is pure
  // ATTRIBUTION: which gate the authoritative verdict corresponds to, plus each
  // gate's observed value. The recomputed booleans mirror classifyBuy's intermediates
  // for the per-gate PASS/FAIL readout and are pinned by an exhaustive contract test.
  const verdict: BuyVerdict = classifyBuy(setup, r, ctx).verdict

  const standDown = BOUNCE_TYPES.has(setup.type) && recentlyFailedBounce(setup.symbol, now, priorStates)
  const symbolLogsThisSession = priorBuys.filter(
    b => b.symbol === setup.symbol && now - b.timestamp < SYMBOL_LOG_WINDOW_MS,
  ).length
  const overLogged = symbolLogsThisSession >= MAX_LOGS_PER_SYMBOL
  const capped = overLogged || symbolCapReached(setup.symbol, now, priorLogs, priorBuys)
  const gradeFloorFail = setup.grade === 'below' && !GRADE_FLOOR_EXEMPT.has(setup.type)
  const dup = isDuplicateBuy(setup.symbol, fill, now, priorBuys)
  const tradeable = r.integrity.session === 'premarket' ||
    (r.integrity.session === 'regular' && etMinutesOfDay(now) < LATE_LOG_CUTOFF_ET_MIN)
  const premarketSurge = r.relativeVolume != null && r.relativeVolume >= PREMARKET_SURGE_RVOL
  const volumeOk = r.integrity.session === 'premarket'
    ? r.premarketVolume == null || r.premarketVolume >= MIN_PREMARKET_BUY_VOLUME || premarketSurge
    : r.volume === 0 || r.volume >= MIN_BUY_VOLUME

  // Binding tier = the tier the AUTHORITATIVE verdict names (or none when 'logged').
  // Everything is keyed off this, so attribution can never contradict the verdict.
  const order = ['session', 'volume', 'veto', 'standDown', 'capped', 'dup']
  const bindingName: string | null = verdict === 'logged' ? null : verdict
  const bindingIdx = bindingName ? order.indexOf(bindingName) : order.length
  const reached = (tier: string) => order.indexOf(tier) <= bindingIdx
  const gg = setup.gateGeometry

  // Veto sub-gates, read from the geometry the detector already computed. Invariant
  // (contract-tested): qualityVetoed === (fadedChase||lateInLeg||unconfirmed||
  // quarantined||noRoom||vetoTriggerActive). The `quality_other` CATCH-ALL guarantees
  // a bound veto is NEVER left unattributed even if the geometry is absent/inconsistent.
  const vetoReached = reached('veto')
  const qualityComponents = (gg?.unconfirmed ?? false) || (gg?.quarantined ?? false) || (gg?.vetoTriggerActive ?? false)
  const knownVetoSub = (gg?.fadedChase ?? false) || (gg?.noRoom ?? false) || (gg?.lateInLeg ?? false)
    || qualityComponents || gradeFloorFail
  const subFails: Record<string, boolean> = {
    off_high: gg?.fadedChase ?? false,
    grade_floor: gradeFloorFail,
    space: gg?.noRoom ?? false,
    runup: gg?.lateInLeg ?? false,
    // Catch-all: explicit quality components, OR a veto the tracked components don't explain.
    quality_other: qualityComponents || (verdict === 'veto' && !knownVetoSub),
  }
  const nSubFail = Object.values(subFails).filter(Boolean).length
  const subBinding = (fail: boolean): boolean | 'unknown' =>
    bindingName === 'veto' && fail ? (nSubFail > 1 ? 'unknown' : true) : false
  const res = (reachedTier: boolean, fail: boolean): 'PASS' | 'FAIL' | 'NOT_APPLICABLE' =>
    !reachedTier ? 'NOT_APPLICABLE' : fail ? 'FAIL' : 'PASS'
  // Single-tier binding is anchored to the authoritative verdict, not a recomputed bool.
  const soleBinding = (tier: string): boolean => bindingName === tier

  const gates: BuyGateRecord[] = [
    { gateId: 'session', observedValue: r.integrity.session, ruleValue: 'premarket || (regular && <14:00 ET)',
      result: res(reached('session'), !tradeable), binding: soleBinding('session') },
    { gateId: r.integrity.session === 'premarket' ? 'premarket_volume' : 'volume',
      observedValue: r.integrity.session === 'premarket' ? (r.premarketVolume ?? null) : r.volume,
      ruleValue: r.integrity.session === 'premarket' ? MIN_PREMARKET_BUY_VOLUME : MIN_BUY_VOLUME,
      result: res(reached('volume'), !volumeOk), binding: soleBinding('volume') },
    // veto sub-gates
    { gateId: 'off_high', observedValue: gg?.offHighPct ?? null, ruleValue: -5,
      result: res(vetoReached, subFails.off_high), binding: subBinding(subFails.off_high) },
    { gateId: 'grade_floor', observedValue: setup.grade, ruleValue: "not 'below' (unless exempt)",
      result: res(vetoReached, subFails.grade_floor), binding: subBinding(subFails.grade_floor) },
    { gateId: 'space', observedValue: gg?.spaceR ?? setup.spaceR ?? null, ruleValue: 0.5,
      result: res(vetoReached, subFails.space), binding: subBinding(subFails.space) },
    { gateId: 'runup', observedValue: gg?.runUpPct ?? null, ruleValue: 'MAX_LEG_RUNUP_PCT',
      result: res(vetoReached, subFails.runup), binding: subBinding(subFails.runup) },
    { gateId: 'quality_other', observedValue: null, ruleValue: 'no unconfirmed/quarantined/vetoTrigger',
      result: res(vetoReached, subFails.quality_other), binding: subBinding(subFails.quality_other) },
    // remaining single tiers
    { gateId: 'stand_down', observedValue: standDown, ruleValue: false,
      result: res(reached('standDown'), standDown), binding: soleBinding('standDown') },
    { gateId: 'same_symbol_cap', observedValue: symbolLogsThisSession, ruleValue: MAX_LOGS_PER_SYMBOL,
      result: res(reached('capped'), capped), binding: soleBinding('capped') },
    { gateId: 'dedupe', observedValue: fill, ruleValue: 'not a duplicate fill', result: res(reached('dup'), dup),
      binding: soleBinding('dup') },
  ]
  return { verdict, gates }
}
