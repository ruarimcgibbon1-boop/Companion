/**
 * MIKE'S STRATEGY — stateful, observational driver core (v0.2).
 *
 * Pure lifecycle logic: given the persisted store, the per-symbol engine output, and
 * the tape, it freezes the breakout level for the life of a candidate, tracks state
 * across sweeps without duplicating events, and records rejection / supporting /
 * shadow telemetry. It NEVER calls the executor or broker and NEVER touches REGULAR.
 *
 * The freeze guarantee lives here: an active candidate's frozen breakoutLevel is fed
 * back to the engine as `prior`, so a rising HOD cannot move it; and the lifecycle's
 * stored level is written once (at creation) and never overwritten.
 */
import type { Candle } from '@/types'
import {
  MIKE_STRATEGY,
  type MikeCandidate, type MikeState, type MikeBreakoutLevel, type MikeSupporting,
  type MikeStop, type MikeVeto, type MikeIndicators, type MikeRejectionTelemetry,
  type MikeOneMinRejection, type MikeShadowOutcome,
} from './types'

// ── Completed-5m determination (deterministic, conservative) ─────────────────
/**
 * A 5m bucket starting at `barTimeSec` covers [t, t+300). It is COMPLETE once the
 * wall clock has passed its end. `>=` makes the exact boundary complete. Applies
 * identically in RTH and extended hours; a delayed/missing most-recent bar simply
 * yields fewer bars, never a partial.
 */
export function isFiveMinComplete(barTimeSec: number, nowMs: number): boolean {
  return nowMs >= (barTimeSec + 300) * 1000
}
/** Generic completed-bar filter for a given bucket size (300 = 5m, 60 = 1m). */
export function completedBars(bars: Candle[], nowMs: number, bucketSec: number): Candle[] {
  return bars.filter(b => nowMs >= (b.time + bucketSec) * 1000).sort((a, b) => a.time - b.time)
}
export function completedFiveMin(bars: Candle[], nowMs: number): Candle[] {
  return completedBars(bars, nowMs, 300)
}
export function completedOneMin(bars: Candle[], nowMs: number): Candle[] {
  return completedBars(bars, nowMs, 60)
}

// ── Immediate-rejection telemetry (observational; engine rule unchanged) ─────
export function computeRejectionTelemetry(
  candles5m: Candle[], level: number, acceptIndex: number, price: number, oneMinPost?: Candle[] | null,
): MikeRejectionTelemetry | null {
  if (acceptIndex < 0 || !(level > 0)) return null
  const acc = candles5m[acceptIndex]
  const post = candles5m.slice(acceptIndex + 1)
  const lows = post.map(c => c.low)
  const lowestPriceAfter = post.length ? Math.min(Math.min(...lows), price) : (price < acc.close ? price : acc.close)
  const tradedIntrabarBelow = post.some(c => c.low < level) || price < level
  const completed5mClosedBelow = post.some(c => c.close < level)
  let barsToFirstBelow: number | null = null
  for (let i = 0; i < post.length; i++) { if (post[i].low < level) { barsToFirstBelow = i + 1; break } }
  let recoveredAfter = false
  if (barsToFirstBelow != null) {
    const after = post.slice(barsToFirstBelow)
    recoveredAfter = after.some(c => c.close > level) || price > level
  }
  const maxBelow = lowestPriceAfter != null ? ((lowestPriceAfter - level) / level) * 100 : null
  const oneMin = computeOneMinRejection(oneMinPost ?? null, level)
  return {
    acceptanceCandleTime: acc.time,
    lowestPriceAfter: round(lowestPriceAfter),
    maxExcursionBelowPct: maxBelow != null ? round(Math.min(0, maxBelow)) : null,
    tradedIntrabarBelow,
    completed5mClosedBelow,
    completed1mClosedBelow: oneMin ? oneMin.closedBelow : null,
    barsToFirstBelow,
    recoveredAfter,
    oneMin,
  }
}

/**
 * 1-minute rejection evidence from COMPLETED post-acceptance 1m bars. Observational
 * only — it never feeds the veto. Returns null when no 1m tape is supplied.
 */
export function computeOneMinRejection(oneMinPost: Candle[] | null, level: number): MikeOneMinRejection | null {
  if (oneMinPost == null) return null
  const tradedIntrabarBelow = oneMinPost.some(c => c.low < level)
  let firstCloseBelowBar: number | null = null
  for (let i = 0; i < oneMinPost.length; i++) { if (oneMinPost[i].close < level) { firstCloseBelowBar = i; break } }
  const closedBelow = firstCloseBelowBar != null
  const lows = oneMinPost.map(c => c.low)
  const maxBelow = lows.length ? ((Math.min(...lows) - level) / level) * 100 : null
  let recoveredAfter = false
  if (firstCloseBelowBar != null) {
    recoveredAfter = oneMinPost.slice(firstCloseBelowBar + 1).some(c => c.close > level)
  }
  return {
    tradedIntrabarBelow, closedBelow, firstCloseBelowBar,
    maxExcursionBelowPct: maxBelow != null ? round(Math.min(0, maxBelow)) : null,
    recoveredAfter,
  }
}

// ── Lifecycle model (persisted) ──────────────────────────────────────────────
export interface MikeTransition { ts: number; from: MikeState; to: MikeState; reason?: string }

export interface MikeLifecycle {
  candidateId: string
  strategy: typeof MIKE_STRATEGY
  symbol: string
  firstSeen: number
  lastSeen: number
  breakoutLevel: MikeBreakoutLevel | null   // FROZEN object — written once at creation
  breakoutLevelFrozenAt: number | null
  state: MikeState
  terminal: boolean
  history: MikeTransition[]
  acceptanceCandleTime: number | null
  acceptanceCandle: Candle | null
  loadingZone: { low: number; high: number } | null
  supporting: MikeSupporting | null
  supportingCount: number
  intendedEntry: number | null
  stop: MikeStop | null
  target10: number | null
  target15: number | null
  veto: MikeVeto | null
  rejection: MikeRejectionTelemetry | null
  indicators: MikeIndicators | null
  shadow: MikeShadowOutcome | null
  /** Deterministic event-dedup fingerprint of the last recorded observation. */
  lastFingerprint: string
}

export interface MikeEvent {
  strategy: typeof MIKE_STRATEGY
  ts: number
  symbol: string
  candidateId: string
  kind: 'created' | 'state_change' | 'evidence_change' | 'terminal'
  from: MikeState | null
  state: MikeState
  supportingCount: number
  acceptance: boolean
  vetoReason: string | null
  fingerprint: string
}

export interface MikeStoreState { candidates: MikeLifecycle[] }

const TERMINAL: MikeState[] = ['VETOED', 'EXPIRED']
const ACTIVE_STATES: MikeState[] = ['APPROACHING_HIGH', 'BREAKING', 'WAITING_5M_ACCEPTANCE', 'ACCEPTED', 'LOADING', 'TRIGGERED', 'MANAGING']
const LEVEL_EPS = 0.001   // levels within 0.1% are "the same" established high

/** Material-change fingerprint: state + supportingCount + acceptance + veto reason. */
export function fingerprint(c: MikeCandidate): string {
  return `${c.state}|${c.supportingCount}|${c.acceptance.accepted ? 1 : 0}|${c.veto?.reason ?? ''}`
}

export function candidateId(symbol: string, levelPrice: number): string {
  return `${symbol}:${levelPrice.toFixed(4)}`
}

export function activeLifecycle(state: MikeStoreState, symbol: string): MikeLifecycle | null {
  return state.candidates.find(c => c.symbol === symbol && !c.terminal) ?? null
}

/**
 * Reconstruct the minimal engine `prior` from a lifecycle so the engine reuses the
 * FROZEN level. The engine reads only prior.breakoutLevel + prior.state.
 */
export function priorForEngine(lc: MikeLifecycle): MikeCandidate {
  return {
    strategy: MIKE_STRATEGY, symbol: lc.symbol, session: 'regular', now: lc.lastSeen, state: lc.state,
    outcome: 'PENDING', price: 0, breakoutLevel: lc.breakoutLevel, loadingZone: lc.loadingZone,
    acceptance: { accepted: lc.acceptanceCandleTime != null, candleTime: lc.acceptanceCandleTime },
    maxExcursionAbovePct: null,
    hardGates: { fiveMinAcceptance: false, noImmediateRejection: false, withinLoadingCeiling: false },
    supporting: lc.supporting ?? emptySupporting(), supportingCount: lc.supportingCount, supportingRequired: 2,
    stop: lc.stop, tradePlan: null, veto: lc.veto, indicators: lc.indicators ?? nullIndicators(),
  }
}

export interface IngestExtras {
  acceptanceCandle: Candle | null
  rejection: MikeRejectionTelemetry | null
  shadow: MikeShadowOutcome | null
}

/**
 * Fold one sweep's engine output for a symbol into the store. Returns the new store
 * and an event to append (or null when nothing material changed — no per-sweep spam).
 * Never mutates inputs.
 */
export function ingestCandidate(
  state: MikeStoreState, cand: MikeCandidate, extras: IngestExtras, now: number,
): { state: MikeStoreState; event: MikeEvent | null } {
  const existing = activeLifecycle(state, cand.symbol)
  const isTerminal = TERMINAL.includes(cand.state)
  const isActive = ACTIVE_STATES.includes(cand.state)
  const level = cand.breakoutLevel

  // No level and nothing active → nothing to track (pure SCANNED).
  if (!existing && !level) return { state, event: null }
  // SCANNED with an active lifecycle shouldn't happen (engine reuses the frozen
  // level), but if it does, just refresh lastSeen without an event.
  if (existing && !level && cand.state === 'SCANNED') {
    return { state: replace(state, { ...existing, lastSeen: now }), event: null }
  }

  if (existing) {
    // Update the SAME lifecycle. The frozen level is NEVER overwritten.
    const stateChanged = existing.state !== cand.state
    const merged: MikeLifecycle = {
      ...existing,
      lastSeen: now,
      state: cand.state,
      terminal: isTerminal,
      history: stateChanged ? [...existing.history, { ts: now, from: existing.state, to: cand.state, reason: cand.veto?.reason }] : existing.history,
      acceptanceCandleTime: cand.acceptance.candleTime ?? existing.acceptanceCandleTime,
      acceptanceCandle: existing.acceptanceCandle ?? extras.acceptanceCandle,
      loadingZone: cand.loadingZone ?? existing.loadingZone,
      supporting: cand.supporting, supportingCount: cand.supportingCount,
      intendedEntry: cand.tradePlan?.entry ?? existing.intendedEntry,
      stop: cand.stop ?? existing.stop,
      target10: cand.tradePlan ? cand.tradePlan.trims[0]?.targetPrice ?? existing.target10 : existing.target10,
      target15: cand.tradePlan ? cand.tradePlan.trims[1]?.targetPrice ?? existing.target15 : existing.target15,
      veto: cand.veto ?? existing.veto,
      rejection: extras.rejection ?? existing.rejection,
      indicators: cand.indicators,
      shadow: extras.shadow ?? existing.shadow,
    }
    return finishUpdate(state, existing, merged, cand, now)
  }

  // No active lifecycle. Only create when the engine actually established a level and
  // reached an active OR terminal-with-level state. Do NOT resurrect a terminal
  // candidate that already exists at (approximately) the same level.
  if (!level || (!isActive && !isTerminal)) return { state, event: null }
  const dupTerminal = state.candidates.some(c =>
    c.symbol === cand.symbol && c.breakoutLevel != null && Math.abs(c.breakoutLevel.price - level.price) / level.price <= LEVEL_EPS)
  if (dupTerminal) return { state, event: null }

  const id = candidateId(cand.symbol, level.price)
  const created: MikeLifecycle = {
    candidateId: id, strategy: MIKE_STRATEGY, symbol: cand.symbol,
    firstSeen: now, lastSeen: now,
    breakoutLevel: level, breakoutLevelFrozenAt: now,   // FROZEN here, once
    state: cand.state, terminal: isTerminal,
    history: [{ ts: now, from: 'SCANNED', to: cand.state, reason: cand.veto?.reason }],
    acceptanceCandleTime: cand.acceptance.candleTime, acceptanceCandle: extras.acceptanceCandle,
    loadingZone: cand.loadingZone, supporting: cand.supporting, supportingCount: cand.supportingCount,
    intendedEntry: cand.tradePlan?.entry ?? null, stop: cand.stop,
    target10: cand.tradePlan?.trims[0]?.targetPrice ?? null, target15: cand.tradePlan?.trims[1]?.targetPrice ?? null,
    veto: cand.veto, rejection: extras.rejection, indicators: cand.indicators, shadow: extras.shadow,
    lastFingerprint: '',
  }
  const fp = fingerprint(cand)
  const event: MikeEvent = {
    strategy: MIKE_STRATEGY, ts: now, symbol: cand.symbol, candidateId: id,
    kind: isTerminal ? 'terminal' : 'created', from: null, state: cand.state,
    supportingCount: cand.supportingCount, acceptance: cand.acceptance.accepted,
    vetoReason: cand.veto?.reason ?? null, fingerprint: fp,
  }
  return { state: { candidates: [...state.candidates, { ...created, lastFingerprint: fp }] }, event }
}

function finishUpdate(
  state: MikeStoreState, prev: MikeLifecycle, merged: MikeLifecycle, cand: MikeCandidate, now: number,
): { state: MikeStoreState; event: MikeEvent | null } {
  const fp = fingerprint(cand)
  if (fp === prev.lastFingerprint) {
    // Nothing material changed — refresh lastSeen only, emit NO event.
    return { state: replace(state, { ...merged, lastFingerprint: prev.lastFingerprint }), event: null }
  }
  const stateChanged = prev.state !== cand.state
  const kind: MikeEvent['kind'] = TERMINAL.includes(cand.state) ? 'terminal' : stateChanged ? 'state_change' : 'evidence_change'
  const event: MikeEvent = {
    strategy: MIKE_STRATEGY, ts: now, symbol: cand.symbol, candidateId: merged.candidateId,
    kind, from: prev.state, state: cand.state, supportingCount: cand.supportingCount,
    acceptance: cand.acceptance.accepted, vetoReason: cand.veto?.reason ?? null, fingerprint: fp,
  }
  return { state: replace(state, { ...merged, lastFingerprint: fp }), event }
}

function replace(state: MikeStoreState, lc: MikeLifecycle): MikeStoreState {
  return { candidates: state.candidates.map(c => (c.candidateId === lc.candidateId ? lc : c)) }
}

function emptySupporting(): MikeSupporting {
  return { higherLowAboveLevel: false, expandingVolume: false, continuedMomentum: false, secondCandleHolds: false, vwapSupport: false, emaSupport: false }
}
function nullIndicators(): MikeIndicators { return { vwap: null, ema9: null, ema21: null, rvol: null } }
const round = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
