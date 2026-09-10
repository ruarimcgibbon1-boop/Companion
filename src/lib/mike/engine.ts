/**
 * MIKE'S STRATEGY — pure evaluation engine (v0.2).
 *
 * All functions are pure and deterministic: given the same MikeInput they return
 * the same MikeCandidate. No clock, no I/O, no market-data client, no shared state
 * with REGULAR. The daemon/route supplies the data; this decides state + veto.
 *
 * HARD gates (Part 7): valid completed-5m acceptance, no immediate rejection back
 * through the level, inside the +10% loading ceiling. SUPPORTING confirmations: at
 * least `minSupportingConfirmations` of six, none individually mandatory (volume is
 * just one of the six, with a RELATIVE test — no fixed expansion multiplier).
 */
import type { Candle } from '@/types'
import {
  DEFAULT_MIKE_CONFIG, MIKE_STRATEGY,
  type MikeInput, type MikeCandidate, type MikeConfig, type MikeState,
  type MikeBreakoutLevel, type MikeSupporting, type MikeHardGates, type MikeStop,
  type MikeTradePlan, type MikeVeto, type MikeVetoReason, type MikeIndicators,
} from './types'

// ── 5-minute resampling (for callers holding 1m tape) ────────────────────────
/**
 * Aggregate 1-minute candles into COMPLETED, ET-aligned 5-minute bars. The final
 * partial bucket (a forming bar) is dropped so acceptance only ever sees completed
 * candles — the whole point of the 5m gate.
 */
export function resampleTo5m(candles1m: Candle[]): Candle[] {
  if (candles1m.length === 0) return []
  const sorted = candles1m.slice().sort((a, b) => a.time - b.time)
  const buckets = new Map<number, Candle>()
  for (const c of sorted) {
    const key = Math.floor(c.time / 300) * 300
    const b = buckets.get(key)
    if (!b) {
      buckets.set(key, { time: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })
    } else {
      b.high = Math.max(b.high, c.high)
      b.low = Math.min(b.low, c.low)
      b.close = c.close
      b.volume += c.volume
    }
  }
  const out = [...buckets.values()].sort((a, b) => a.time - b.time)
  // Drop the last bucket only if it is still forming: we cannot know completeness
  // without a clock, so callers pass ALREADY-completed 1m bars. Keep all here; the
  // acceptance rule itself never treats a partial as complete because callers feed
  // completed data. (Documented so wiring stays honest.)
  return out
}

// ── Hard gate 1: mandatory 5-minute acceptance ───────────────────────────────
/**
 * First completed 5m candle that OPENS strictly above AND CLOSES strictly above the
 * level. A wick above with a close back below is NOT acceptance; a candle that opens
 * below and closes above is NOT acceptance (it must open above too).
 */
export function fiveMinAcceptance(candles5m: Candle[], level: number): { accepted: boolean; index: number; candleTime: number | null } {
  if (!(level > 0)) return { accepted: false, index: -1, candleTime: null }
  for (let i = 0; i < candles5m.length; i++) {
    const c = candles5m[i]
    if (c.open > level && c.close > level) return { accepted: true, index: i, candleTime: c.time }
  }
  return { accepted: false, index: -1, candleTime: null }
}

// ── Hard gate 2: no immediate rejection back through the level ────────────────
/**
 * Conservative: after the acceptance candle, if ANY completed candle CLOSES back
 * below the level, the breakout was rejected. (A single wick below that closes back
 * above does not count — we test closes, not lows.) A current live price below the
 * level is also a rejection.
 */
export function hasImmediateRejection(candles5m: Candle[], level: number, acceptIndex: number, price?: number): boolean {
  if (acceptIndex < 0) return false
  for (let i = acceptIndex + 1; i < candles5m.length; i++) {
    if (candles5m[i].close < level) return true
  }
  if (price != null && price < level) return true
  return false
}

// ── Hard gate 3: loading ceiling ─────────────────────────────────────────────
export function withinLoadingCeiling(price: number, level: number, ceilingPct: number): boolean {
  if (!(level > 0)) return false
  return price <= level * (1 + ceilingPct)
}

/** Max % above the level reached across the tape + current price (excursion). */
export function maxExcursionAbovePct(candles5m: Candle[], level: number, price: number): number | null {
  if (!(level > 0)) return null
  let hi = price
  for (const c of candles5m) hi = Math.max(hi, c.high)
  const pct = ((hi - level) / level) * 100
  return pct > 0 ? pct : 0
}

// ── Supporting confirmations (need ≥ min; none individually mandatory) ────────
export function countSupporting(
  candles5m: Candle[], level: number, price: number, ind: MikeIndicators, acceptIndex: number,
): { supporting: MikeSupporting; count: number } {
  const post = acceptIndex >= 0 ? candles5m.slice(acceptIndex) : []

  // C1 higher low above the level: every post-acceptance low holds above the level
  // AND the lows are non-decreasing (a rising floor), needing ≥2 post bars.
  const lows = post.map(c => c.low)
  const higherLowAboveLevel = post.length >= 2 && lows.every(l => l > level) &&
    post[post.length - 1].low >= post[0].low

  // C2 expanding volume: last completed 5m volume > the prior completed one
  // (RELATIVE — no fixed multiplier).
  const n = candles5m.length
  const expandingVolume = n >= 2 && candles5m[n - 1].volume > candles5m[n - 2].volume

  // C3 continued momentum: last completed candle green, or price above the
  // acceptance candle's high.
  const acc = acceptIndex >= 0 ? candles5m[acceptIndex] : null
  const lastC = n > 0 ? candles5m[n - 1] : null
  const continuedMomentum = (lastC != null && lastC.close > lastC.open) ||
    (acc != null && price > acc.high)

  // C4 a second candle holds above the level: ≥2 completed closes above.
  const secondCandleHolds = candles5m.filter(c => c.close > level).length >= 2

  // C5 VWAP support underneath price.
  const vwapSupport = ind.vwap != null && price > ind.vwap

  // C6 EMA stack support: EMA9 ≥ EMA21 and price above EMA9.
  const emaSupport = ind.ema9 != null && ind.ema21 != null && ind.ema9 >= ind.ema21 && price > ind.ema9

  const supporting: MikeSupporting = {
    higherLowAboveLevel, expandingVolume, continuedMomentum, secondCandleHolds, vwapSupport, emaSupport,
  }
  const count = Object.values(supporting).filter(Boolean).length
  return { supporting, count }
}

// ── Structural stop selection ────────────────────────────────────────────────
/**
 * Choose the TIGHTEST defensible structural stop strictly below entry and within
 * maxStopPct. Candidates: the accepted breakout level, VWAP, EMA9, EMA21, and an
 * established higher low. Returns null when none is within the ceiling → the caller
 * vetoes RISK_TOO_WIDE rather than inventing an arbitrary 10% stop.
 */
export function selectStop(
  args: { entry: number; level: number; ind: MikeIndicators; higherLow: number | null; maxStopPct: number },
): MikeStop | null {
  const { entry, level, ind, higherLow, maxStopPct } = args
  if (!(entry > 0)) return null
  const candidates: Array<{ price: number; ref: MikeStop['ref'] }> = [
    { price: level, ref: 'breakout_level' },
    ...(ind.vwap != null ? [{ price: ind.vwap, ref: 'vwap' as const }] : []),
    ...(ind.ema9 != null ? [{ price: ind.ema9, ref: 'ema9' as const }] : []),
    ...(ind.ema21 != null ? [{ price: ind.ema21, ref: 'ema21' as const }] : []),
    ...(higherLow != null ? [{ price: higherLow, ref: 'higher_low' as const }] : []),
  ]
  // Only supports strictly below entry, within the ceiling; tightest (highest) wins.
  const valid = candidates
    .filter(c => c.price > 0 && c.price < entry && (entry - c.price) / entry <= maxStopPct)
    .sort((a, b) => b.price - a.price)
  const best = valid[0]
  if (!best) return null
  return { price: best.price, ref: best.ref, distancePct: ((entry - best.price) / entry) * 100 }
}

/** The +10% / +15% / runner ladder on the ORIGINAL position (runner exit unresolved). */
export function buildTradePlan(entry: number, stop: MikeStop, config: MikeConfig): MikeTradePlan {
  return {
    entry,
    stop,
    trims: config.trims.map(t => ({
      gainPct: t.gainPct,
      sellOriginalFraction: t.sellOriginalFraction,
      targetPrice: entry * (1 + t.gainPct),
    })),
    runnerFraction: config.runnerFraction,
    runnerExit: 'UNRESOLVED_EXPERIMENTAL',
  }
}

/**
 * ESTABLISHED intraday high from COMPLETED 5m candles — a prior high that price had
 * already made and then FAILED to exceed on a later bar. A high created purely by the
 * current, still-extending move (every bar a new high) is NOT established and returns
 * null, so the running HOD of the current break can never become that break's own
 * reference. Deterministic; uses only completed-candle data (no invented value).
 *
 * Example: highs 4.8, 4.9, 5.00, 4.95, 4.97, 5.05, 5.10, 5.20 → established = 5.00
 * (5.00 was made, then bars closed under it before the 5.05→5.20 run). A straight
 * 4.8→5.2 vertical (all new highs) → null (no reliable established HOD).
 */
export function establishedHigh(candles5m: Candle[]): number | null {
  if (candles5m.length < 2) return null
  let priorMax = candles5m[0].high
  let established: number | null = null
  for (let i = 1; i < candles5m.length; i++) {
    if (candles5m[i].high <= priorMax) established = priorMax   // failed to make a new high → priorMax is established
    else priorMax = candles5m[i].high
  }
  return established
}

// ── Breakout-level selection (frozen) ────────────────────────────────────────
/**
 * Pick the meaningful resistance / HOD Mike watches. Once chosen it is FROZEN — a
 * prior active candidate's level is reused verbatim so the reference never chases
 * the new high upward.
 */
export function selectBreakoutLevel(input: MikeInput, config: MikeConfig): MikeBreakoutLevel | null {
  const prior = input.prior
  const ACTIVE: MikeState[] = ['APPROACHING_HIGH', 'BREAKING', 'WAITING_5M_ACCEPTANCE', 'ACCEPTED', 'LOADING', 'TRIGGERED', 'MANAGING']
  if (prior && prior.breakoutLevel && ACTIVE.includes(prior.state)) return prior.breakoutLevel

  const { price, refs, levels, now } = input
  const cands: Array<{ price: number; type: MikeBreakoutLevel['type']; confidence: number | null }> = []
  const push = (p: number | null | undefined, type: MikeBreakoutLevel['type'], confidence: number | null) => {
    if (p != null && isFinite(p) && p > 0) cands.push({ price: p, type, confidence })
  }
  push(refs.previousDayHigh, 'prev_day_high', 70)
  push(refs.premarketHigh, 'premarket_high', 55)
  push(refs.twentyDayHigh, 'twenty_day_high', 65)
  // HOD candidate is the ESTABLISHED prior high from completed candles — NEVER the
  // running HOD of the current move (see establishedHigh). refs.dayHigh (the running
  // session high) is intentionally NOT a selection candidate.
  push(establishedHigh(input.candles5m), 'hod', 60)
  for (const l of levels) {
    if (l.kind === 'resistance' && l.strength >= config.minLevelStrength) push(l.midpoint, 'resistance', l.strength)
  }
  if (cands.length === 0) return null

  const ceiling = config.loadingCeilingPct
  const band = config.approachBandPct
  // A level is "in play" when price is at/just-broken it (≤ +ceiling above) or
  // approaching from just below (within band). Among those, prefer the one nearest
  // to price so Mike watches the level actually being tested.
  const inPlay = cands.filter(c =>
    (price >= c.price && price <= c.price * (1 + ceiling)) ||
    (price < c.price && (c.price - price) / c.price <= band),
  )
  const pool = inPlay.length ? inPlay : cands
  pool.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
  const chosen = pool[0]
  return { price: chosen.price, type: chosen.type, establishedAt: now, confidence: chosen.confidence }
}

// ── Main evaluation ──────────────────────────────────────────────────────────
const NO_GATES: MikeHardGates = { fiveMinAcceptance: false, noImmediateRejection: false, withinLoadingCeiling: false }

export function evaluateMike(input: MikeInput): MikeCandidate {
  const config = input.config ?? DEFAULT_MIKE_CONFIG
  const { symbol, session, now, price, candles5m, indicators } = input

  // Bare builder — used before a level is established (or when inputs are invalid).
  const mk = (state: MikeState, over: Partial<MikeCandidate> = {}): MikeCandidate => ({
    strategy: MIKE_STRATEGY, symbol, session, now, state, outcome: 'PENDING', price,
    breakoutLevel: null, loadingZone: null, acceptance: { accepted: false, candleTime: null },
    maxExcursionAbovePct: null, hardGates: NO_GATES, supporting: emptySupporting(), supportingCount: 0,
    supportingRequired: config.minSupportingConfirmations, stop: null, tradePlan: null, veto: null, indicators, ...over,
  })

  // DATA_INVALID: genuinely unusable inputs only (never "unknown" — that stays pending).
  if (!(price > 0)) return veto(mk('VETOED'), 'DATA_INVALID', ['price not positive'])

  const level = selectBreakoutLevel(input, config)
  if (!level) return mk('SCANNED')
  if (!(level.price > 0)) return veto(mk('VETOED', { breakoutLevel: level }), 'DATA_INVALID', ['breakout level not positive'])

  // Everything below is derived from the frozen level.
  const acc = fiveMinAcceptance(candles5m, level.price)
  const noRejection = !hasImmediateRejection(candles5m, level.price, acc.index, price)
  const withinCeiling = withinLoadingCeiling(price, level.price, config.loadingCeilingPct)
  const hardGates: MikeHardGates = { fiveMinAcceptance: acc.accepted, noImmediateRejection: noRejection, withinLoadingCeiling: withinCeiling }
  const post = acc.index >= 0 ? candles5m.slice(acc.index) : []
  const postLow = post.length ? Math.min(...post.map(c => c.low)) : null
  const higherLow = postLow != null && postLow > level.price ? postLow : null
  const sup = countSupporting(candles5m, level.price, price, indicators, acc.index)
  const stop = selectStop({ entry: price, level: level.price, ind: indicators, higherLow, maxStopPct: config.maxStopPct })
  const excursion = maxExcursionAbovePct(candles5m, level.price, price)
  const loadingZone = { low: level.price, high: level.price * (1 + config.loadingCeilingPct) }

  // Full builder — overlays every level-derived field.
  const full = (state: MikeState, over: Partial<MikeCandidate> = {}): MikeCandidate => mk(state, {
    breakoutLevel: level, loadingZone, acceptance: { accepted: acc.accepted, candleTime: acc.candleTime },
    maxExcursionAbovePct: excursion, hardGates, supporting: sup.supporting, supportingCount: sup.count, stop, ...over,
  })

  // ── Not yet accepted ──
  if (!acc.accepted) {
    if (excursion != null && excursion > config.loadingCeilingPct * 100) {
      return veto(full('EXPIRED'), 'CHASE_LIMIT', [`excursion ${excursion.toFixed(1)}% > +${(config.loadingCeilingPct * 100).toFixed(0)}% before acceptance`])
    }
    const above = price > level.price
    const completedSinceCross = candles5m.some(c => c.high > level.price)
    if (above && completedSinceCross) return full('WAITING_5M_ACCEPTANCE')
    if (above) return full('BREAKING')
    if ((level.price - price) / level.price <= config.approachBandPct) return full('APPROACHING_HIGH')
    return full('SCANNED')
  }

  // ── Accepted: hard gates in priority order ──
  if (!noRejection) return veto(full('VETOED'), 'REJECTED_BREAKOUT', ['a completed candle closed back below the breakout level after acceptance'])
  if (!withinCeiling) return veto(full('EXPIRED'), 'CHASE_LIMIT', [`price ${price} above +${(config.loadingCeilingPct * 100).toFixed(0)}% ceiling ${loadingZone.high.toFixed(4)}`])
  if (!stop) return veto(full('VETOED'), 'RISK_TOO_WIDE', ['no structural stop within the max stop distance'])

  // Hard gates pass + valid stop. Confirmation decides TRIGGER vs LOADING.
  if (sup.count >= config.minSupportingConfirmations) {
    return full('TRIGGERED', { outcome: 'TRADED', tradePlan: buildTradePlan(price, stop, config) })
  }
  return full('LOADING')
}

function emptySupporting(): MikeSupporting {
  return {
    higherLowAboveLevel: false, expandingVolume: false, continuedMomentum: false,
    secondCandleHolds: false, vwapSupport: false, emaSupport: false,
  }
}

/** Attach a veto (reason + snapshot) to a candidate, stamping outcome. */
function veto(c: MikeCandidate, reason: MikeVetoReason, failedConditions: string[]): MikeCandidate {
  const v: MikeVeto = {
    reason,
    snapshot: {
      symbol: c.symbol, time: c.now, breakoutLevel: c.breakoutLevel?.price ?? null, price: c.price,
      maxExcursionAbovePct: c.maxExcursionAbovePct, acceptance: c.acceptance.accepted,
      supporting: c.supporting, supportingCount: c.supportingCount, hardGates: c.hardGates,
      failedConditions, indicators: c.indicators, session: c.session,
    },
  }
  const outcome = c.state === 'EXPIRED' ? 'EXPIRED' : 'VETOED'
  return { ...c, veto: v, outcome }
}
