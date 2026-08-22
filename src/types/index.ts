export * from './monitor'

export type Exchange = 'NASDAQ' | 'NYSE' | 'AMEX'

export type SessionType = 'premarket' | 'regular' | 'afterhours' | 'overnight' | 'closed'

export type CatalystCategory =
  | 'Earnings'
  | 'Guidance'
  | 'FDA/Clinical'
  | 'Contract'
  | 'Partnership'
  | 'Acquisition'
  | 'Financing'
  | 'Offering'
  | 'Share Repurchase'
  | 'Analyst Action'
  | 'Legal/Regulatory'
  | 'Management Change'
  | 'Product Launch'
  | 'Sector Sympathy'
  | 'No Catalyst'

export type CatalystQuality =
  | 'Strong Confirmed Catalyst'
  | 'Moderate Catalyst'
  | 'Weak or Recycled Catalyst'
  | 'Unclear Catalyst'
  | 'Negative or Dilutive Catalyst'
  | 'No Recent Catalyst Found'

export type SetupStatus =
  | 'Constructive'
  | 'Developing'
  | 'Extended'
  | 'Chasing Risk'
  | 'Weakening'
  | 'Breakdown Risk'
  | 'No Clean Setup'

export type DataQuality = 'High' | 'Acceptable' | 'Limited' | 'Stale'

export type LevelType = 'support' | 'resistance' | 'pivot'

export interface Candle {
  time: number // unix seconds
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Quote {
  symbol: string
  name: string
  price: number
  change: number
  changesPercentage: number
  open: number
  dayHigh: number
  dayLow: number
  previousClose: number
  volume: number
  avgVolume: number
  marketCap: number
  exchange: string
  timestamp: number
  pe?: number
  eps?: number
  sharesOutstanding?: number
}

export interface CompanyProfile {
  symbol: string
  companyName: string
  exchange: string
  industry: string
  sector: string
  float: number | null
  sharesOutstanding: number | null
  marketCap: number | null
  isEtf: boolean
  isFund: boolean
  isActivelyTrading: boolean
  description: string
}

export interface NewsItem {
  id: string
  title: string
  text: string
  url: string
  source: string
  publishedDate: string
  symbol: string
  age: string
  isDilutive: boolean
  isOriginalRelease: boolean
  catalystCategory: CatalystCategory
  bullishElements: string[]
  bearishElements: string[]
  quality: CatalystQuality
}

export interface SupportResistanceZone {
  lower: number
  upper: number
  midpoint: number
  type: LevelType
  strengthScore: number // 1-10
  reasons: string[]
  priorReactions: number
  status: 'intact' | 'testing' | 'failed'
}

export interface SessionLevels {
  premarketHigh: number | null
  premarketLow: number | null
  premarketVolume: number | null
  regularHigh: number | null
  regularLow: number | null
  openingPrint: number | null
  or5High: number | null
  or5Low: number | null
  or15High: number | null
  or15Low: number | null
  vwap: number | null
  previousClose: number | null
  previousDayHigh: number | null
  previousDayLow: number | null
}

export interface TechnicalData {
  // Intraday
  vwap: number | null
  ema9: number | null
  ema20: number | null
  ma50Intraday: number | null
  rsi14: number | null
  atr: number | null
  relativeVolume: number | null
  volumeTrend: 'increasing' | 'decreasing' | 'flat'
  trend5m: 'up' | 'down' | 'flat'
  trend15m: 'up' | 'down' | 'flat'
  vwapCrossCount: number
  higherHighsLows: boolean | null
  lowerHighsLows: boolean | null
  distanceFromVwapPct: number | null
  distanceFromDayHighPct: number | null
  // Daily
  ma50Daily: number | null
  ma200Daily: number | null
  dailyRsi: number | null
  dailyAtr: number | null
  gapPct: number | null
  fiveDayHigh: number | null
  fiveDayLow: number | null
  twentyDayHigh: number | null
  twentyDayLow: number | null
  avgVolume20d: number | null
  isBreakingOutOfRange: boolean
}

export interface PullbackScenario {
  name: string
  entryZoneLow: number
  entryZoneHigh: number
  confirmation: string
  trigger: string
  invalidation: number
  target1: number | null
  target2: number | null
  rewardRisk: number | null
  whatMakesStronger: string[]
  whatMakesWeaker: string[]
  volumeConfirms: boolean
  isChasing: boolean
  confidenceScore: number // 0-100
  timestamp: number
}

export interface SetupScore {
  total: number
  breakdown: {
    trendStructure: number
    volumeLiquidity: number
    catalystQuality: number
    pullbackQuality: number
    srClarity: number
    rewardRisk: number
    extensionRisk: number
  }
  classification: string
  status: SetupStatus
}

export type BorrowAvailability = 'Easy' | 'Moderate' | 'Tight' | 'HTB' | 'Unknown'

export interface ShortAvailability {
  availability: BorrowAvailability
  floatShares: number | null       // absolute float
  freeFloatPct: number | null      // % freely tradeable
  warning: string | null           // human-readable caution
  squeezeRisk: boolean             // true when float is very low and stock is running
}

export interface TickerSnapshot {
  symbol: string
  quote: Quote
  profile: CompanyProfile | null
  sessionLevels: SessionLevels
  technical: TechnicalData
  zones: SupportResistanceZone[]
  pullbacks: PullbackScenario[]
  news: NewsItem[]
  catalystSummary: string
  catalystQuality: CatalystQuality
  catalystCategory: CatalystCategory
  setupScore: SetupScore
  dataQuality: DataQuality
  sessionType: SessionType
  warnings: string[]
  breakoutStatus: BreakoutStatus
  tradePlans: TradePlan[]
  shortAvailability: ShortAvailability
  timestamp: number
}

export interface ScannerRow {
  rank: number
  symbol: string
  name: string
  price: number
  changePct: number
  volume: number
  relativeVolume: number | null
  float: number | null
  marketCap: number | null
  exchange: string
  catalystLabel: CatalystQuality
  catalystCategory: CatalystCategory
  setupScore: number
  status: SetupStatus
  badges: Badge[]
  lastUpdate: number
  // Premarket enrichment (populated during premarket/overnight)
  premarketChangePct: number | null
  premarketChange: number | null
  premarketVolume: number | null
  bid: number | null
  ask: number | null
  spread: number | null
  latestTradeTime: number | null
  // ── Momentum ranking (see src/lib/momentum-rank.ts) ───────────────────────
  /** % moved over the trailing 15 minutes — "is it moving NOW", not "did it move". */
  rocPct?: number | null
  /** Distance below the session high, negative. Drives the fade demotion. */
  offHighPct?: number | null
  /** Sort key: names our own gates can trade outrank names they'd refuse. */
  momentumScore?: number | null
}

export type BadgeType =
  | 'Fresh News'
  | 'Low Float'
  | 'High RVOL'
  | 'Extended'
  | 'Halt Risk'
  | 'Dilution Risk'
  | 'No Catalyst'
  | 'VWAP Hold'
  | 'VWAP Lost'

export interface Badge {
  type: BadgeType
  label: string
}

export interface ScannerFilters {
  minPrice: number
  maxPrice: number
  minChangePct: number
  maxChangePct: number
  minVolume: number
  minRelativeVolume: number
  minMarketCap: number | null
  maxMarketCap: number | null
  maxFloat: number | null
  exchanges: Exchange[]
  commonStocksOnly: boolean
  includeLowFloat: boolean
  sessionMode: 'premarket' | 'regular' | 'afterhours'
  maxResults: number
  minNewsRecencyHours: number | null
}

export const DEFAULT_FILTERS: ScannerFilters = {
  minPrice: 1,
  // No max-price cap by default — intraday continuation must not inherit the
  // swing-trade "$300 max" restriction. A liquid $400 stock can be the better
  // intraday trade. Kept configurable; 100000 is an effective "no cap".
  maxPrice: 100_000,
  minChangePct: 5,
  maxChangePct: 1000,
  minVolume: 500000,
  minRelativeVolume: 0,
  minMarketCap: null,
  maxMarketCap: null,
  maxFloat: null,
  exchanges: ['NASDAQ', 'NYSE', 'AMEX'],
  commonStocksOnly: true,
  includeLowFloat: true,
  sessionMode: 'regular',
  maxResults: 30,
  minNewsRecencyHours: null,
}

export interface WatchlistItem {
  symbol: string
  addedAt: number
  alertConditions: AlertCondition[]
}

export interface AlertCondition {
  type: 'enters_zone' | 'vwap_reclaim' | 'vwap_lost' | 'hod_break' | 'score_above' | 'new_news'
  params: Record<string, number | string>
  triggered: boolean
  lastTriggered: number | null
}

export interface Alert {
  symbol: string
  message: string
  type: AlertCondition['type']
  timestamp: number
  read: boolean
}

// ── Breakout detection ────────────────────────────────────────────────────

export type BreakoutState =
  | 'approaching'    // within 2% of key level
  | 'testing'        // within 0.5%, holding near level
  | 'triggered'      // broke through intrabar
  | 'confirmed'      // candle close above/below + volume
  | 'failed'         // broke through then reversed
  | 'extended'       // >5% beyond level — do not chase
  | 'none'

export interface BreakoutStatus {
  state: BreakoutState
  level: number | null          // the level being monitored
  levelLabel: string | null
  distancePct: number | null
  volumeConfirms: boolean
  canCloseConfirm: boolean
  description: string
}

// ── Trade plans A/B/C/D ───────────────────────────────────────────────────

export type TradePlanLabel = 'A' | 'B' | 'C' | 'D'

export interface TradeTarget {
  price: number
  label: string
  rewardRisk: number | null
}

export interface TradePlan {
  label: TradePlanLabel
  type: 'Breakout' | 'Pullback' | 'Reclaim' | 'No-Trade'
  name: string
  valid: boolean
  invalidReason: string | null
  // Entry
  entryLow: number | null
  entryHigh: number | null
  entryTrigger: string
  confirmation: string[]
  // Risk
  stopLoss: number | null
  invalidation: number | null
  // Targets
  targets: TradeTarget[]
  // Context
  idealConditions: string[]
  avoidWhen: string[]
  notes: string
  // Pullback sub-type
  pullbackDepth: 'shallow' | 'moderate' | 'deep' | null
}

// ── Live position tracker ─────────────────────────────────────────────────

export type PositionDirection = 'long' | 'short'
export type PositionStatus = 'open' | 't1_hit' | 't2_hit' | 't3_hit' | 'stopped' | 'closed'

export interface PositionTarget {
  label: string       // 'T1', 'T2', 'T3'
  price: number
  hit: boolean
  hitAt: number | null
}

export type TrailingStopMode = 'none' | 'pct' | 'atr'

export type TradeTag =
  | 'Breakout'
  | 'Pullback'
  | 'VWAP Reclaim'
  | 'Reclaim'
  | 'Momentum'
  | 'Reversal'
  | 'Gap Fill'
  | 'News Play'
  | 'Overtraded'
  | 'Revenge Trade'
  | 'FOMO'
  | 'Good Execution'
  | 'Early Entry'
  | 'Late Entry'
  | 'Held Too Long'
  | 'Exited Too Early'
  | 'Followed Plan'
  | 'Broke Rules'

export interface Position {
  id: string
  symbol: string
  direction: PositionDirection
  shares: number
  entry: number
  stop: number
  initialStop: number   // original stop — never changes
  targets: PositionTarget[]
  // Trailing stop
  trailingMode: TrailingStopMode
  trailingValue: number   // pct (e.g. 2 = 2%) or ATR multiplier (e.g. 1.5)
  trailingHigh: number    // highest price seen (long) / lowest (short)
  // State
  status: PositionStatus
  openedAt: number
  closedAt: number | null
  closePrice: number | null
  // Live (not persisted — refreshed each poll)
  currentPrice: number | null
  unrealizedPnl: number | null
  unrealizedPnlPct: number | null
  lastPriceUpdate: number | null
  // Journal
  notes: string
  tags: TradeTag[]
  rating: 1 | 2 | 3 | 4 | 5 | null   // self-rating: 1 = poor, 5 = excellent
  plannedEntry: boolean                 // did you follow the plan?
  setupType: string                     // free-form, e.g. "VWAP Pullback"
}

// ── Position risk calculator ──────────────────────────────────────────────

export interface PositionCalcInput {
  accountSize: number
  maxRiskPct: number
  entry: number
  stop: number
}

export interface PositionCalcResult {
  maxMonetaryRisk: number
  riskPerShare: number
  maxShares: number
  positionValue: number
  riskRewardTargets: Array<{ ratio: number; targetPrice: number; profit: number }>
}
