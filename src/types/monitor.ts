/**
 * Types for the always-on setup-monitoring engine.
 *
 * These extend the existing snapshot analysis with:
 *  - Ranked support/resistance levels (KeyLevel)
 *  - Distinct, separately-scored setups (DetectedSetup)
 *  - A live price roadmap above and below current price
 *  - A per-setup state machine with adaptive alert thresholds
 *  - Setup performance logs for later calibration
 */

// ── Setup taxonomy ──────────────────────────────────────────────────────────

export type SetupType =
  | 'pullback'
  | 'momentum_pullback'
  | 'breakout'
  | 'premarket_breakout'
  | 'opening_range_break'
  | 'opening_drive'
  | 'hod_break'
  | 'bull_flag'
  | 'break_of_structure'
  | 'ema9_bounce'
  | 'ema21_bounce'
  | 'vwap_bounce'
  | 'vwap_reclaim'
  | 'level_reclaim'
  | 'resistance_rejection'
  | 'support_breakdown'

export type SetupDirection = 'long' | 'short'

/**
 * Lifecycle of every potential setup. Alerts are emitted on state transitions
 * (plus material score/roadmap changes), never on every poll.
 */
export type SetupState =
  | 'identified'   // level found, price not yet close enough to alert
  | 'approaching'  // price within adaptive early-warning distance
  | 'at_level'     // price inside the reaction zone
  | 'confirming'   // evidence the anticipated reaction is occurring
  | 'triggered'    // full setup conditions met
  | 'failed'       // technical justification lost / invalidated
  | 'expired'      // level no longer relevant (aged out / far away)

export type SetupGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'C' | 'below'

// ── Support / resistance levels ─────────────────────────────────────────────

export type LevelSource =
  | 'premarket_high' | 'premarket_low'
  | 'prev_day_high' | 'prev_day_low' | 'prev_close'
  | 'day_high' | 'day_low'
  | 'or5_high' | 'or5_low' | 'or15_high' | 'or15_low'
  | 'swing_high' | 'swing_low'
  | 'daily_swing_high' | 'daily_swing_low'
  | 'gap_fill' | 'consolidation_high' | 'consolidation_low'
  | 'whole_dollar' | 'half_dollar'
  | 'ema9' | 'ema21' | 'vwap'
  | 'ma50' | 'ma200'
  | 'volume_shelf' | 'breakout_retest'

export interface KeyLevel {
  /** Zone bounds (merged from nearby levels). */
  lower: number
  upper: number
  midpoint: number
  kind: 'support' | 'resistance'
  /** 0-100 strength. */
  strength: number
  /** Human sources that contributed to this level. */
  sources: LevelSource[]
  sourceLabels: string[]
  /** How many times price reacted at this zone in the loaded window. */
  touches: number
  /** Unix ms of most recent reaction, or null. */
  lastReactionAt: number | null
  /** Setup we'd expect if price returns here. */
  expectedSetup: SetupType | null
  /** Is this a dynamic (moving) level like an EMA/VWAP? */
  dynamic: boolean
  /** True if confluent with VWAP or an EMA. */
  hasConfluence: boolean
}

// ── Detected setup ──────────────────────────────────────────────────────────

export interface SetupTarget {
  price: number
  label: string
  rewardRisk: number | null
}

export interface ScoreBreakdown {
  levelQuality: number       // /20
  priceAction: number        // /15
  volumeMomentum: number     // /15
  trendAlignment: number     // /10
  catalyst: number           // /10
  rewardRisk: number         // /15
  liquidity: number          // /10
  confirmation: number       // /5
}

// ── Actionable buy/sell signal ──────────────────────────────────────────────

export type SignalAction =
  | 'buy'          // triggered long — actionable entry now
  | 'prep_buy'     // long confirming — get ready
  | 'sell_short'   // triggered short — actionable entry now
  | 'prep_short'   // short confirming — get ready
  | 'watch'        // at/approaching a zone — wait for the trigger
  | 'avoid'        // invalidated / no clean action

export interface TradeSignal {
  action: SignalAction
  /** Big decisive label: 'BUY', 'PREP BUY', 'SELL / SHORT', 'PREP SHORT', 'WAIT', 'AVOID'. */
  verb: string
  urgency: 'now' | 'soon' | 'watch' | 'none'
  /** One-line plain-English directive with the numbers. */
  headline: string
  /** The price that flips this to actionable (level to reclaim/break/lose). */
  triggerPrice: number | null
  /** What has to happen at the trigger price. */
  triggerCondition: string
  stop: number
  targets: number[]
}

export interface DetectedSetup {
  /** Stable id: `${symbol}:${type}:${zoneMidpoint}` rounded — used for dedup + state tracking. */
  id: string
  symbol: string
  type: SetupType
  direction: SetupDirection
  state: SetupState
  /** Raw geometric trigger, BEFORE any quality veto downgrades `state`. The Buy
   *  Log records on this so it captures every signal for review; `state` still
   *  drives what the user is told to act on. */
  triggeredRaw?: boolean
  /** A quality gate (e.g. rolled-over-off-high) fired — the signal is logged but flagged. */
  qualityVetoed?: boolean
  /** Price you'd actually fill entering on the trigger (buy the reclaim), never below current price for a long. */
  entryFill?: number
  score: number
  grade: SetupGrade
  breakdown: ScoreBreakdown

  /** Reaction zone. */
  zoneLower: number
  zoneUpper: number
  zoneMidpoint: number
  /** Why this zone matters. */
  rationale: string

  /** What must happen for the setup to become actionable. */
  confirmation: string[]
  /** Where the setup is invalidated. */
  invalidation: number
  stopReference: number

  targets: SetupTarget[]
  rewardRisk: number | null

  /** Distances (percent) from dynamic references at detection time. */
  distanceToZonePct: number
  distanceFromVwapPct: number | null
  distanceFromEma9Pct: number | null
  distanceFromEma21Pct: number | null

  /** Adaptive early-warning distance (percent) computed for this stock. */
  approachThresholdPct: number

  /** Setup-specific context. */
  testCount: number          // e.g. Nth EMA/VWAP test (support weakens with repetition)
  confidence: number         // 0-100 qualitative confidence
  risks: string[]
  keyRisks: string[]
  notes: string

  /** Next level if this one holds / fails. */
  nextIfHolds: number | null
  nextIfFails: number | null

  /** Decisive buy/sell directive derived from state + geometry. */
  signal: TradeSignal
}

// ── Price roadmap ───────────────────────────────────────────────────────────

export interface RoadmapLevel {
  price: number
  zoneLower: number
  zoneUpper: number
  label: string
  why: string
  possibleSetup: SetupType | null
  confirmationNeeded: string
  invalidation: string
  ifHolds: string
  ifFails: string
  strength: number
  distancePct: number
}

export interface PriceRoadmap {
  symbol: string
  currentPrice: number
  upside: RoadmapLevel[]
  downside: RoadmapLevel[]
  updatedAt: number
}

// ── Data integrity flags ────────────────────────────────────────────────────

export interface DataIntegrity {
  marketDataTimestamp: number   // unix ms of the freshest underlying data point
  ageMs: number
  session: string               // SessionType as string
  delayed: boolean              // true if the feed is stale/delayed
  missing: string[]             // named data points that were unavailable
}

// ── Per-symbol monitor result (returned by /api/monitor) ────────────────────

/**
 * Compact per-symbol technical/session summary surfaced on the monitor result so
 * the continuation evaluator can classify front-side/backside and extension
 * without re-deriving indicators. All fields are honest nulls when unavailable.
 */
export interface ContinuationTechnicals {
  vwap: number | null
  ema9: number | null
  ema20: number | null
  rsi14: number | null
  atr: number | null
  atrPct: number | null
  distanceFromVwapPct: number | null
  distanceFromEma9Pct: number | null
  distanceFromDayHighPct: number | null
  aboveVwap: boolean | null
  higherHighsLows: boolean | null
  lowerHighsLows: boolean | null
  trend5m: 'up' | 'down' | 'flat'
  trend15m: 'up' | 'down' | 'flat'
  volumeTrend: 'increasing' | 'decreasing' | 'flat'
  gapPct: number | null
  premarketHigh: number | null
  premarketVolume: number | null
  dayHigh: number | null
  previousDayHigh: number | null
  previousClose: number | null
  or5High: number | null
  or15High: number | null
  twentyDayHigh: number | null
}

export interface MonitorResult {
  symbol: string
  price: number
  changePct: number
  relativeVolume: number | null
  spreadPct: number | null
  catalyst: string
  levels: KeyLevel[]
  setups: DetectedSetup[]
  roadmap: PriceRoadmap
  integrity: DataIntegrity
  technicals?: ContinuationTechnicals
  error?: string
}

// ── State machine record (persisted for restart restoration) ────────────────

export interface SetupStateRecord {
  id: string
  symbol: string
  type: SetupType
  state: SetupState
  score: number
  grade: SetupGrade
  zoneMidpoint: number
  /** True while price is inside the zone (drives leave/return dedup). */
  inZone: boolean
  lastState: SetupState
  lastScore: number
  lastAlertAt: number | null
  alertsSent: number
  firstSeenAt: number
  updatedAt: number
  /** States we've already alerted, so we don't repeat the same transition. */
  alertedStates: SetupState[]
  /** How many profit targets we've already sent a take-profit signal for. */
  targetsHitAlerted: number
}

// ── Alert produced by the state machine ─────────────────────────────────────

export type MonitorAlertKind =
  | 'early_warning'
  | 'level_reached'
  | 'confirming'
  | 'triggered'
  | 'take_profit'
  | 'failed'
  | 'score_upgrade'

export interface MonitorAlert {
  id: string             // dedup key
  symbol: string
  setupId: string
  kind: MonitorAlertKind
  setupType: SetupType
  direction: SetupDirection
  state: SetupState
  score: number
  grade: SetupGrade
  title: string
  body: string
  price: number
  zoneLower: number
  zoneUpper: number
  confirmation: string[]
  invalidation: number
  targets: SetupTarget[]
  risks: string[]
  timestamp: number
  dataAgeMs: number
  delayed: boolean
  read: boolean
}

// ── Notification settings (persisted) ───────────────────────────────────────

export interface NotificationSettings {
  enabled: boolean
  minScore: number
  minLevelStrength: number
  /** Multiplier on the adaptive threshold (1 = default). */
  earlyWarningMultiplier: number
  sound: boolean
  browserNotifications: boolean
  inApp: boolean
  setupTypes: Record<SetupType, boolean>
  allowLong: boolean
  allowShort: boolean
  premarketAlerts: boolean
  regularHoursAlerts: boolean
  afterHoursAlerts: boolean
  /** 'watchlist' = only watchlist symbols; 'scanner' = whole monitored universe. */
  scope: 'watchlist' | 'scanner'
  cooldownMs: number
  maxAlertsPerTicker: number
  /** Materials score change (points) required to re-alert. */
  scoreChangeThreshold: number
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  minScore: 70,
  minLevelStrength: 40,
  earlyWarningMultiplier: 1,
  sound: false,
  browserNotifications: true,
  inApp: true,
  setupTypes: {
    pullback: true,
    momentum_pullback: true,
    breakout: true,
    premarket_breakout: true,
    opening_range_break: true,
    opening_drive: true,
    hod_break: true,
    bull_flag: true,
    break_of_structure: true,
    ema9_bounce: true,
    ema21_bounce: true,
    vwap_bounce: true,
    vwap_reclaim: true,
    level_reclaim: true,
    resistance_rejection: true,
    support_breakdown: true,
  },
  allowLong: true,
  allowShort: true,
  premarketAlerts: true,
  regularHoursAlerts: true,
  afterHoursAlerts: false,
  scope: 'scanner',
  cooldownMs: 90_000,
  maxAlertsPerTicker: 8,
  scoreChangeThreshold: 6,
}

// ── Setup performance log (persisted, feeds the review page) ─────────────────

export interface SetupLog {
  id: string
  symbol: string
  type: SetupType
  direction: SetupDirection
  identifiedAt: number
  priceAtIdentification: number
  zoneLower: number
  zoneUpper: number
  score: number
  grade: SetupGrade
  confirmation: string[]
  invalidation: number
  targets: SetupTarget[]
  statesReached: SetupState[]
  /** Filled as monitoring continues. */
  maxFavorablePrice: number
  maxAdversePrice: number
  maxFavorablePct: number
  maxAdversePct: number
  outcome: 'open' | 'target_hit' | 'invalidated' | 'expired'
  outcomeReason: string | null
  triggeredAt: number | null
  resolvedAt: number | null
  relativeVolumeAtId: number | null
  sessionAtId: string
  /** Nth test of the reference level, for first-test vs repeat analysis. */
  testCount: number
}

// ── Buy-signal log (every BUY indication, for end-of-day review) ────────────

export interface BuySignalRecord {
  id: string              // unique per trigger event (= the alert id)
  setupId: string
  symbol: string
  timestamp: number       // epoch ms when the BUY fired
  setupType: SetupType
  triggerPrice: number    // the level that was reclaimed/broken
  entryLow: number        // reaction zone
  entryHigh: number
  invalidation: number
  stop: number
  targets: number[]
  score: number
  grade: SetupGrade
  rewardRisk: number | null
  priceAtSignal: number
  /** A quality gate fired at trigger time (e.g. rolled over off the session high). Logged for review, not filtered out. */
  flagged?: boolean
  // ── Diagnostic context at signal time — captured so winners vs losers can be
  //    separated empirically at review (which trend/RVOL/position actually pays),
  //    rather than guessing at gates. All optional/additive.
  ctxTrend15m?: 'up' | 'down' | 'flat'
  ctxDistVwapPct?: number | null      // + above VWAP, - below
  ctxDistDayHighPct?: number | null   // ~0 = at HOD (top-buy), very negative = well below
  ctxRelVol?: number | null
  ctxHigherHighsLows?: boolean | null // constructive structure vs chop
  ctxAtrPct?: number | null           // volatility, for stop-vs-noise analysis
  // ── Realized P/L (filled by the EOD resolver, scaled-out model) ──────────────
  /** Realized return % for the trade under the scale-out rule (½ T1, ½ T2, breakeven stop after T1, remainder marked at the close). Null until the day closes and it's resolved. */
  pnlPct?: number | null
  /** False when a remainder was still held at the close (marked-to-close, not a clean exit). */
  pnlFullyClosed?: boolean
}

// ── Signal funnel (per-sweep instrumentation) ───────────────────────────────
// Counts where candidates die each monitor sweep, so a "0 signals" day is
// legible: scanned → detected → cleared floor → triggered → logged, with the
// drop reason at each stage. Ephemeral (latest sweep only), not persisted.
export interface MonitorFunnel {
  timestamp: number
  scanned: number             // symbols in the monitor universe this sweep
  symbolsWithSetups: number   // symbols that produced ≥1 raw setup
  rawSetups: number           // total setups detected across the universe
  belowFloor: number          // dropped by the score/level display floor
  tracked: number             // setups that cleared the floor (entered the state machine)
  byState: Partial<Record<SetupState, number>>  // geometry state among tracked
  triggered: number           // long setups with triggeredRaw among tracked
  droppedSession: number      // …dropped as untradeable (after-hours / overnight)
  droppedVeto: number         // triggered longs dropped by the quality veto (flagged)
  droppedStandDown: number    // …by the failed-bounce stand-down
  droppedCapped: number       // …by the per-symbol cap
  droppedDup: number          // …by the entry-cluster dedup
  logged: number              // buys actually logged this sweep
}

export const SETUP_TYPE_LABELS: Record<SetupType, string> = {
  pullback: 'Pullback',
  momentum_pullback: 'Momentum Pullback',
  breakout: 'Breakout',
  premarket_breakout: 'Premarket Breakout',
  opening_range_break: 'Opening-Range Break',
  opening_drive: 'Opening Drive',
  hod_break: 'HOD Break',
  bull_flag: 'Bull Flag',
  break_of_structure: 'Break of Structure',
  ema9_bounce: '9 EMA Bounce',
  ema21_bounce: '21 EMA Bounce',
  vwap_bounce: 'VWAP Bounce',
  vwap_reclaim: 'VWAP Reclaim',
  level_reclaim: 'Level Reclaim',
  resistance_rejection: 'Resistance Rejection',
  support_breakdown: 'Support Breakdown',
}

export const SETUP_STATE_LABELS: Record<SetupState, string> = {
  identified: 'Identified',
  approaching: 'Approaching',
  at_level: 'At Level',
  confirming: 'Confirming',
  triggered: 'Triggered',
  failed: 'Failed',
  expired: 'Expired',
}
