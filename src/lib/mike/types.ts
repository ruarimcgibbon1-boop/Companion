/**
 * MIKE'S STRATEGY — types (v0.2, experimental).
 *
 * A NEW, SEPARATE strategy that lives entirely under src/lib/mike/. It shares NO
 * state, files, or decision code with the REGULAR strategy. Every record carries
 * `strategy: 'mike'` so nothing can be mixed into REGULAR aggregates.
 *
 * v0.2 is OBSERVATIONAL: Mike detects, freezes a breakout level, gates on a
 * mandatory completed 5-minute acceptance candle, seeks confirmation inside a +10%
 * loading zone, computes an intended entry/stop/trim plan, and shadow-resolves
 * outcomes. It places NO orders. Execution wiring to the paper account (with
 * separate attribution) is a documented follow-up.
 */
import type { Candle, KeyLevel } from '@/types'

export const MIKE_STRATEGY = 'mike' as const

/** Mike's own lifecycle vocabulary — deliberately distinct from REGULAR SetupState. */
export type MikeState =
  | 'SCANNED'                // in the universe, no breakout level being tested yet
  | 'APPROACHING_HIGH'       // price nearing the frozen breakout level from below
  | 'BREAKING'              // price just crossed above the level; no completed 5m since
  | 'WAITING_5M_ACCEPTANCE' // above the level, ≥1 completed 5m, none yet qualifies
  | 'ACCEPTED'              // a completed 5m opened AND closed above the level
  | 'LOADING'              // accepted + inside +10% zone, gathering confirmation (<min)
  | 'TRIGGERED'            // hard gates pass + ≥min supporting + valid stop (intended entry)
  | 'MANAGING'             // post-trigger (position live) — v0.2 shadow only
  | 'VETOED'              // a veto reason fired
  | 'EXPIRED'             // chase limit / never confirmed

export type MikeVetoReason =
  | 'NO_5M_ACCEPTANCE'
  | 'REJECTED_BREAKOUT'
  | 'CHASE_LIMIT'
  | 'INSUFFICIENT_CONFIRMATION'
  | 'MOMENTUM_FAILED'
  | 'STRUCTURE_FAILED'
  | 'INDICATOR_SUPPORT_LOST'
  | 'VOLUME_DIED'
  | 'RISK_TOO_WIDE'
  | 'DATA_INVALID'

export type MikeOutcome = 'TRADED' | 'VETOED' | 'EXPIRED' | 'PENDING'

/** The FROZEN breakout reference — never chases the new high upward once set. */
export interface MikeBreakoutLevel {
  price: number
  type: 'prev_day_high' | 'premarket_high' | 'hod' | 'twenty_day_high' | 'resistance'
  /** ms epoch the level was established/frozen. */
  establishedAt: number
  /** 0-100 if derived from a scored KeyLevel; else a fixed tier by type. */
  confidence: number | null
}

/** The six SUPPORTING confirmations (none individually mandatory; volume is just one). */
export interface MikeSupporting {
  higherLowAboveLevel: boolean      // C1 structure
  expandingVolume: boolean          // C2 volume (relative, no fixed multiplier)
  continuedMomentum: boolean        // C3 momentum
  secondCandleHolds: boolean        // C4 ≥2 completed closes above the level
  vwapSupport: boolean              // C5 price above VWAP
  emaSupport: boolean               // C6 EMA9≥EMA21 and price above EMA9
}

export interface MikeHardGates {
  fiveMinAcceptance: boolean
  noImmediateRejection: boolean
  withinLoadingCeiling: boolean
}

export interface MikeStop {
  price: number
  ref: 'breakout_level' | 'vwap' | 'ema9' | 'ema21' | 'higher_low'
  distancePct: number   // (entry - stop) / entry * 100
}

export interface MikeTrim {
  gainPct: number               // +0.10, +0.15
  sellOriginalFraction: number  // 0.50, 0.25 — of the ORIGINAL position N
  targetPrice: number
}

export interface MikeTradePlan {
  entry: number
  stop: MikeStop
  trims: MikeTrim[]
  runnerFraction: number
  /** v0.2: runner exit is deliberately UNRESOLVED — never silently reuse REGULAR runner logic. */
  runnerExit: 'UNRESOLVED_EXPERIMENTAL'
}

/** Indicator snapshot Mike consumes (from MonitorResult.technicals; ema21 = the 20/21 slot). */
export interface MikeIndicators {
  vwap: number | null
  ema9: number | null
  ema21: number | null
  rvol: number | null
}

/** Snapshot stored at veto time (Part 11) — everything needed to explain the veto. */
export interface MikeVetoSnapshot {
  symbol: string
  time: number
  breakoutLevel: number | null
  price: number
  maxExcursionAbovePct: number | null
  acceptance: boolean
  supporting: MikeSupporting
  supportingCount: number
  hardGates: MikeHardGates
  failedConditions: string[]
  indicators: MikeIndicators
  session: string
}

export interface MikeVeto {
  reason: MikeVetoReason
  snapshot: MikeVetoSnapshot
}

/** The full Mike candidate — one per (symbol, frozen level). Always carries attribution. */
export interface MikeCandidate {
  strategy: typeof MIKE_STRATEGY
  symbol: string
  session: string
  now: number
  state: MikeState
  outcome: MikeOutcome
  price: number
  breakoutLevel: MikeBreakoutLevel | null
  loadingZone: { low: number; high: number } | null
  acceptance: { accepted: boolean; candleTime: number | null }
  maxExcursionAbovePct: number | null
  hardGates: MikeHardGates
  supporting: MikeSupporting
  supportingCount: number
  supportingRequired: number
  stop: MikeStop | null
  tradePlan: MikeTradePlan | null
  veto: MikeVeto | null
  indicators: MikeIndicators
}

export interface MikeConfig {
  /** Absolute chase ceiling above the breakout level. */
  loadingCeilingPct: number
  /** Initial stop may never exceed this fraction of entry. */
  maxStopPct: number
  /** Minimum SUPPORTING confirmations (hard gates are separate). */
  minSupportingConfirmations: number
  /** How near (below) the level counts as APPROACHING_HIGH (display band, not an RVOL gate). */
  approachBandPct: number
  /** Trim ladder on the ORIGINAL position. */
  trims: Array<{ gainPct: number; sellOriginalFraction: number }>
  runnerFraction: number
  /** Minimum KeyLevel strength that counts as meaningful resistance (mirrors the SPACE gate's 45). */
  minLevelStrength: number
}

export const DEFAULT_MIKE_CONFIG: MikeConfig = {
  loadingCeilingPct: 0.10,
  maxStopPct: 0.10,
  minSupportingConfirmations: 2,
  approachBandPct: 0.02,
  trims: [
    { gainPct: 0.10, sellOriginalFraction: 0.50 },
    { gainPct: 0.15, sellOriginalFraction: 0.25 },
  ],
  runnerFraction: 0.25,
  minLevelStrength: 45,
}

/** Inputs the pure engine consumes — no market-data client, no I/O. */
export interface MikeInput {
  symbol: string
  session: string
  now: number
  price: number
  /** Completed 5-minute candles, chronological. */
  candles5m: Candle[]
  indicators: MikeIndicators
  /** Ranked key levels (for stop selection + level selection). */
  levels: KeyLevel[]
  /** Session reference highs Mike may freeze onto. */
  refs: {
    previousDayHigh: number | null
    premarketHigh: number | null
    dayHigh: number | null
    twentyDayHigh: number | null
  }
  config?: MikeConfig
  /** Prior candidate for this symbol — freezes the breakout level so it never chases. */
  prior?: MikeCandidate | null
}

/** Shadow outcome for a candidate (traded OR vetoed) — evidence only, never an order. */
export interface MikeShadowOutcome {
  reference: number     // the price the +10/+15/stop ladder is measured from
  stop: number | null
  hit10: boolean        // reached +10% at any point
  hit15: boolean        // reached +15% at any point
  hitStop: boolean      // touched the stop-equivalent at any point
  mfePct: number | null
  maePct: number | null
  maxRunPct: number | null
  reachedRunner: boolean   // == hit15
  /** How far the remaining 25% could have run AFTER +15% (max high past the +15 bar). Runner EXIT stays unresolved. */
  runnerExcursionAfter15Pct: number | null
  timeTo10Bars: number | null
  timeTo15Bars: number | null
  timeToAdverseBars: number | null   // bars to the first stop-equivalent touch
  barsToResolve: number | null
  resolvedFromBars: number
  resolved: boolean
}

/**
 * Immediate-rejection TELEMETRY (Part 7) — observational only. The engine's
 * REJECTED_BREAKOUT rule is unchanged; this records what actually happened after
 * acceptance so we can later judge whether that rule is too loose or too tight.
 */
export interface MikeRejectionTelemetry {
  acceptanceCandleTime: number | null
  lowestPriceAfter: number | null
  /** Most adverse (low - level)/level*100 after acceptance; ≥0 means price never dipped below. */
  maxExcursionBelowPct: number | null
  tradedIntrabarBelow: boolean          // any post-acceptance 5m low < level
  completed5mClosedBelow: boolean       // any post-acceptance 5m close < level (the engine's actual rule)
  completed1mClosedBelow: boolean | null // convenience mirror of oneMin.closedBelow; null when 1m tape absent
  barsToFirstBelow: number | null       // 5m bars from acceptance to the first intrabar-below
  recoveredAfter: boolean               // after a below event, a later close (or price) back above the level
  /** Finer-grained 1-minute evidence, present only when completed post-acceptance 1m bars are supplied. */
  oneMin: MikeOneMinRejection | null
}

export interface MikeOneMinRejection {
  tradedIntrabarBelow: boolean          // any completed 1m low < level
  closedBelow: boolean                  // any completed 1m close < level
  firstCloseBelowBar: number | null     // index (0-based) of the first completed 1m close below
  maxExcursionBelowPct: number | null   // most adverse (low - level)/level*100 across completed 1m bars
  recoveredAfter: boolean               // after the first 1m below-close, a later 1m closes back above
}
