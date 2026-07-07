/**
 * Intraday continuation evaluation layer (Phase 1).
 *
 * Consumes a MonitorResult (price, change%, RVOL, key levels, detected setups,
 * catalyst, data integrity, and the compact `technicals` summary) and produces a
 * continuation-specific verdict:
 *   - front-side vs backside classification
 *   - extension / chase classification
 *   - a continuation quality score with EVERY adjustment shown separately
 *   - a live setup status and a plain-English verdict + main risk
 *   - the primary long setup and its trade plan (entry/stop/targets/RR)
 *
 * This is deliberately long-only: a continuation trade is an existing UP move
 * attempting to continue. Backside / breakdown-dominated names are surfaced and
 * penalised, never presented as strong long-continuation setups.
 *
 * It REUSES the existing detectors/scoring rather than re-deriving TA, and never
 * invents data — missing inputs degrade the relevant sub-judgement rather than
 * fabricating a value.
 */

import type { MonitorResult, DetectedSetup } from '@/types'

export type FrontSideClass =
  | 'Early front side'
  | 'Established front side'
  | 'Late front side'
  | 'Transitioning to backside'
  | 'Backside'
  | 'Unclear'

export type ExtensionClass =
  | 'Not extended'
  | 'Slightly extended'
  | 'Moderately extended'
  | 'Highly extended'
  | 'Parabolic'

export type ContinuationStatus =
  | 'Triggering now'
  | 'Approaching entry'
  | 'Pulling back constructively'
  | 'Consolidating beneath resistance'
  | 'Waiting for volume'
  | 'Waiting for VWAP reclaim'
  | 'Waiting for high-of-day break'
  | 'Breakout confirmed'
  | 'Breakout retesting'
  | 'Extended—do not chase'
  | 'Losing momentum'
  | 'Backside transition'
  | 'Setup failed'
  | 'Avoid'

export interface ScoreAdjustment {
  label: string
  delta: number   // signed points applied to the base setup score
}

export interface ContinuationCandidate {
  symbol: string
  price: number
  changePct: number
  relativeVolume: number | null
  catalyst: string
  session: string
  delayed: boolean
  dataAgeMs: number

  /** Best long setup driving the continuation thesis (null → nothing long). */
  primarySetupType: DetectedSetup['type'] | null
  /** Human continuation label (e.g. "Gap-and-go", "High-of-day break"). */
  continuationType: string
  frontSide: FrontSideClass
  extension: ExtensionClass
  status: ContinuationStatus

  baseScore: number             // primary setup's own 0-100 score
  adjustments: ScoreAdjustment[] // every continuation adjustment, shown separately
  continuationScore: number     // clamped 0-100 after adjustments
  scoreLabel: string            // "Strong continuation setup", etc.

  rewardRisk: number | null
  entryZone: [number, number] | null
  triggerPrice: number | null
  stop: number | null
  targets: number[]

  verdict: string
  mainRisk: string
  qualifies: boolean            // clears the actionable floor (RR≥2, front-side, data ok…)
  rejectionReason: string | null

  lastUpdate: number
}

const LONG_CONTINUATION_TYPES: DetectedSetup['type'][] = [
  'breakout', 'pullback', 'vwap_bounce', 'vwap_reclaim',
  'ema9_bounce', 'ema21_bounce', 'level_reclaim',
]

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

// ── Front-side vs backside ───────────────────────────────────────────────────
function classifyFrontSide(r: MonitorResult): FrontSideClass {
  const t = r.technicals
  if (!t) return 'Unclear'

  let score = 0
  let signals = 0
  const tally = (cond: boolean | null, w: number) => {
    if (cond == null) return
    signals++
    score += cond ? w : -w
  }

  tally(t.higherHighsLows, 2)
  tally(t.lowerHighsLows === null ? null : !t.lowerHighsLows, 1)
  tally(t.aboveVwap, 2)
  tally(t.trend5m === 'flat' ? null : t.trend5m === 'up', 1.5)
  tally(t.trend15m === 'flat' ? null : t.trend15m === 'up', 1)
  // Price holding within ~2% of the day high = still testing HOD (front-side).
  if (t.distanceFromDayHighPct != null) {
    signals++
    score += Math.abs(t.distanceFromDayHighPct) <= 2 ? 1.5 : t.distanceFromDayHighPct < -6 ? -1 : 0
  }
  // Above the 9 EMA supports the trend; well below it is a structure break.
  if (t.distanceFromEma9Pct != null) {
    signals++
    score += t.distanceFromEma9Pct >= 0 ? 0.5 : t.distanceFromEma9Pct < -4 ? -1.5 : 0
  }
  // Dominant setup direction: breakdown/rejection setups outscoring longs = backside.
  const bestLong = bestLongSetup(r)?.score ?? 0
  const bestShort = Math.max(0, ...r.setups.filter(s => s.direction === 'short').map(s => s.score))
  if (bestShort > 0 || bestLong > 0) {
    signals++
    score += bestLong >= bestShort ? 1 : -2
  }

  if (signals === 0) return 'Unclear'
  const norm = score / signals   // roughly -2 .. +2

  if (norm >= 1.2) return 'Early front side'
  if (norm >= 0.5) return 'Established front side'
  if (norm >= 0.0) return 'Late front side'
  if (norm >= -0.6) return 'Transitioning to backside'
  return 'Backside'
}

// ── Extension / chase classification ─────────────────────────────────────────
function classifyExtension(r: MonitorResult): ExtensionClass {
  const t = r.technicals
  if (!t) return 'Not extended'
  const dv = Math.abs(t.distanceFromVwapPct ?? 0)
  const de = Math.abs(t.distanceFromEma9Pct ?? 0)
  const rsi = t.rsi14 ?? 50
  // Extension is driven by distance stretched from the mean-reverting refs, with
  // RSI as a confirming momentum-exhaustion signal.
  const stretch = Math.max(dv, de * 0.8)
  if (stretch >= 18 || (rsi >= 88 && de >= 10)) return 'Parabolic'
  if (stretch >= 10 || rsi >= 82) return 'Highly extended'
  if (stretch >= 6) return 'Moderately extended'
  if (stretch >= 3) return 'Slightly extended'
  return 'Not extended'
}

// ── Continuation-type label ──────────────────────────────────────────────────
function continuationLabel(r: MonitorResult, s: DetectedSetup | null): string {
  if (!s) return 'No long setup'
  const t = r.technicals
  const nearDayHigh = t?.distanceFromDayHighPct != null && Math.abs(t.distanceFromDayHighPct) <= 1.5
  const bigGap = (t?.gapPct ?? 0) >= 4
  const brokePDH = t?.previousDayHigh != null && r.price > t.previousDayHigh
  switch (s.type) {
    case 'breakout':
      if (nearDayHigh) return 'High-of-day break'
      if (brokePDH) return 'Previous-day-high break'
      return bigGap ? 'Gap-and-go continuation' : 'Breakout continuation'
    case 'pullback': return 'Bull-flag / pullback continuation'
    case 'vwap_bounce': return 'VWAP hold'
    case 'vwap_reclaim': return 'VWAP reclaim'
    case 'ema9_bounce': return '9 EMA continuation'
    case 'ema21_bounce': return '20/21 EMA continuation'
    case 'level_reclaim': return 'Level reclaim'
    default: return s.type.replace(/_/g, ' ')
  }
}

// ── Live status ──────────────────────────────────────────────────────────────
function deriveStatus(r: MonitorResult, s: DetectedSetup | null, front: FrontSideClass, ext: ExtensionClass): ContinuationStatus {
  if (!s) return front === 'Backside' ? 'Backside transition' : 'Avoid'
  if (ext === 'Parabolic' || ext === 'Highly extended') return 'Extended—do not chase'
  if (front === 'Backside') return 'Backside transition'
  if (front === 'Transitioning to backside') return 'Losing momentum'
  switch (s.state) {
    case 'triggered': return 'Breakout confirmed'
    case 'confirming': return 'Approaching entry'
    case 'at_level':
      return s.type === 'breakout' ? 'Consolidating beneath resistance' : 'Pulling back constructively'
    case 'approaching': return s.type === 'vwap_reclaim' ? 'Waiting for VWAP reclaim' : 'Approaching entry'
    case 'failed': return 'Setup failed'
    default: {
      // 'identified' / 'expired' — only call it "waiting for volume" when volume
      // is genuinely light; a high-RVOL name is consolidating, not starved.
      const lightVolume = (r.relativeVolume ?? 0) < 1.5
      if (s.type === 'breakout') return 'Waiting for high-of-day break'
      if (s.type === 'vwap_reclaim') return 'Waiting for VWAP reclaim'
      return lightVolume ? 'Waiting for volume' : 'Consolidating beneath resistance'
    }
  }
}

function bestLongSetup(r: MonitorResult): DetectedSetup | null {
  const longs = r.setups.filter(s => s.direction === 'long' && LONG_CONTINUATION_TYPES.includes(s.type))
  if (!longs.length) return null
  return longs.reduce((a, b) => (b.score > a.score ? b : a))
}

const SCORE_LABELS: Array<[number, string]> = [
  [90, 'Exceptional continuation setup'],
  [82, 'Strong continuation setup'],
  [74, 'Promising — actionable on confirmation'],
  [66, 'Watchlist candidate'],
  [55, 'Weak or incomplete setup'],
  [0, 'Avoid'],
]
const labelFor = (score: number) => SCORE_LABELS.find(([floor]) => score >= floor)![1]

// ── Verdict language ─────────────────────────────────────────────────────────
function deriveVerdict(front: FrontSideClass, ext: ExtensionClass, status: ContinuationStatus, s: DetectedSetup | null, rr: number | null): string {
  if (!s) return front === 'Backside' ? 'Transitioning to backside — avoid' : 'Avoid — no clean long continuation'
  if (front === 'Backside') return 'Transitioning to backside'
  if (ext === 'Parabolic') return 'Strong stock but parabolic — do not chase'
  if (ext === 'Highly extended') return 'Strong stock but currently extended'
  if (rr != null && rr < 2) return 'Structure valid but reward-to-risk too thin — wait for a better entry'
  switch (status) {
    case 'Breakout confirmed': return 'Actionable on confirmed breakout'
    case 'Pulling back constructively': return 'Actionable on controlled pullback'
    case 'Consolidating beneath resistance': return 'Wait for high-of-day break'
    case 'Waiting for VWAP reclaim': return 'Wait for VWAP reclaim'
    case 'Waiting for high-of-day break': return 'Wait for high-of-day break'
    case 'Approaching entry': return 'Approaching a high-quality entry'
    case 'Losing momentum': return 'Losing momentum — stand aside'
    case 'Setup failed': return 'Continuation thesis failed'
    default: return 'Strong front-side momentum'
  }
}

function deriveMainRisk(r: MonitorResult, front: FrontSideClass, ext: ExtensionClass, s: DetectedSetup | null): string {
  if (r.integrity.delayed) return 'Data delayed — verify a live quote before acting'
  if (front === 'Backside') return 'Backside price action — long continuation odds are poor'
  if (ext === 'Parabolic' || ext === 'Highly extended') return 'Overextended — high risk of a sharp mean-reversion flush'
  if (r.catalyst === 'No catalyst data') return 'No fresh catalyst identified — momentum may fade'
  if ((r.relativeVolume ?? 0) < 1.5) return 'Relative volume light — participation may not sustain the move'
  if (s && s.rewardRisk != null && s.rewardRisk < 2) return 'Limited room before resistance — thin reward-to-risk'
  return s?.keyRisks?.[0] ?? s?.risks?.[0] ?? 'Standard intraday continuation risk'
}

// ── Main evaluation ──────────────────────────────────────────────────────────
export function evaluateContinuation(r: MonitorResult): ContinuationCandidate {
  const s = bestLongSetup(r)
  const front = classifyFrontSide(r)
  const ext = classifyExtension(r)
  const status = deriveStatus(r, s, front, ext)
  const rvol = r.relativeVolume
  const hasCatalyst = r.catalyst !== 'No catalyst data'

  const base = s?.score ?? 0
  const adj: ScoreAdjustment[] = []
  const add = (label: string, delta: number) => { if (delta !== 0) adj.push({ label, delta }) }

  // Front-side / backside
  if (front === 'Backside') add('Backside price action', -35)
  else if (front === 'Transitioning to backside') add('Transitioning to backside', -18)
  else if (front === 'Late front side') add('Late front side', -5)
  else if (front === 'Early front side') add('Early front side (clean)', +4)
  else if (front === 'Established front side') add('Established front side', +2)

  // Extension / chase
  if (ext === 'Parabolic') add('Parabolic extension', -25)
  else if (ext === 'Highly extended') add('Highly extended from VWAP/9EMA', -14)
  else if (ext === 'Moderately extended') add('Moderately extended', -6)
  else if (ext === 'Slightly extended') add('Slightly extended', -2)

  // Volume / participation
  if (rvol != null) {
    if (rvol >= 3) add('Strong relative volume (≥3×)', +5)
    else if (rvol >= 2) add('Healthy relative volume (≥2×)', +3)
    else if (rvol < 1) add('Relative volume below average', -6)
    else if (rvol < 1.5) add('Light relative volume', -3)
  }

  // Catalyst
  if (hasCatalyst) add('Fresh catalyst present', +4)
  else add('No identifiable catalyst', -6)

  // Reward / risk room
  const rr = s?.rewardRisk ?? null
  if (rr != null) {
    if (rr >= 3) add('Strong reward-to-risk (≥3:1)', +3)
    else if (rr < 2) add('Thin reward-to-risk (<2:1)', -8)
  }

  // Data integrity
  if (r.integrity.delayed) add('Data delayed / stale', -8)

  const continuationScore = clamp(base + adj.reduce((sum, a) => sum + a.delta, 0))

  // Actionable floor (spec: RR≥2, front-side, live-ish data, a real long setup)
  let rejectionReason: string | null = null
  if (!s) rejectionReason = 'No clean long continuation setup'
  else if (front === 'Backside') rejectionReason = 'Backside — not a long continuation'
  else if (ext === 'Parabolic') rejectionReason = 'Parabolic — entry already gone'
  else if (rr != null && rr < 2) rejectionReason = 'Reward-to-risk below 2:1'
  else if ((rvol ?? 0) < 1) rejectionReason = 'Insufficient relative volume'
  else if (r.integrity.delayed) rejectionReason = 'Data delayed — cannot confirm live'
  else if (continuationScore < 66) rejectionReason = 'Score below watchlist floor'
  const qualifies = rejectionReason === null

  const entryZone: [number, number] | null = s ? [s.zoneLower, s.zoneUpper] : null

  return {
    symbol: r.symbol,
    price: r.price,
    changePct: r.changePct,
    relativeVolume: rvol,
    catalyst: r.catalyst,
    session: r.integrity.session,
    delayed: r.integrity.delayed,
    dataAgeMs: r.integrity.ageMs,
    primarySetupType: s?.type ?? null,
    continuationType: continuationLabel(r, s),
    frontSide: front,
    extension: ext,
    status,
    baseScore: base,
    adjustments: adj,
    continuationScore,
    scoreLabel: labelFor(continuationScore),
    rewardRisk: rr,
    entryZone,
    triggerPrice: s ? (s.direction === 'long' ? s.zoneUpper : s.zoneLower) : null,
    stop: s?.stopReference ?? s?.invalidation ?? null,
    targets: s?.targets.map(t => t.price) ?? [],
    verdict: deriveVerdict(front, ext, status, s, rr),
    mainRisk: deriveMainRisk(r, front, ext, s),
    qualifies,
    rejectionReason,
    lastUpdate: Date.now(),
  }
}

/**
 * Rank continuation candidates. Sort primarily by continuation score, but a
 * clean actionable entry outranks a higher-scoring but over-extended name (spec:
 * "a stock that is strong but overextended should rank below a slightly weaker
 * stock forming a clean entry").
 */
export function rankContinuation(results: MonitorResult[]): ContinuationCandidate[] {
  const readiness: Record<ContinuationStatus, number> = {
    'Triggering now': 10, 'Breakout confirmed': 9, 'Approaching entry': 8,
    'Pulling back constructively': 8, 'Consolidating beneath resistance': 7,
    'Waiting for high-of-day break': 6, 'Waiting for VWAP reclaim': 6,
    'Waiting for volume': 5, 'Breakout retesting': 7, 'Losing momentum': 2,
    'Extended—do not chase': 1, 'Backside transition': 0, 'Setup failed': 0, 'Avoid': 0,
  }
  return results
    .map(evaluateContinuation)
    .sort((a, b) => {
      // Qualifying candidates always rank above non-qualifying.
      if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1
      if (b.continuationScore !== a.continuationScore) return b.continuationScore - a.continuationScore
      const rd = (readiness[b.status] ?? 0) - (readiness[a.status] ?? 0)
      if (rd !== 0) return rd
      return (b.relativeVolume ?? 0) - (a.relativeVolume ?? 0)
    })
}
