/**
 * H4A — LOCAL RESET / LOCAL EXTENSION FEATURE ENGINE (pure, strategy-neutral).
 *
 * Derives local vs global structural geometry from the canonical intraday bar series that the daemon
 * already fetches (H3B/monitor pipeline) plus current global indicators (VWAP/EMA/session-high) that
 * BASE already computes. It answers "what is the local shape right now?" — most recent impulse,
 * pullback/reset, base/compression, local extension vs global extension, re-expansion — WITHOUT
 * deciding whether any of it is tradable.
 *
 * FEATURE EXTRACTION ONLY. This module:
 *   - has NO executor reference, makes NO provider calls (pure over its inputs),
 *   - defines NO entry/stop/target thresholds, changes NO BASE/arbitration/execution behavior,
 *   - never mutates its inputs, and fails HONESTLY (null + explicit status, never a fake zero).
 *
 * Every segmentation boundary is PROVISIONAL, config-driven, and fingerprinted (localFeatureConfigHash)
 * so a later study can pin exactly which parameters produced a measurement. The H1/H1.1 audit motivates
 * the geometry (a globally-extended leader can still be locally fresh) but NOTHING here encodes
 * "off-high = good": these are measurements, not verdicts.
 */
import type { Candle } from '@/types'

export const LOCAL_FEATURE_SCHEMA_VERSION = 1

// ── Config (all PROVISIONAL segmentation boundaries; fingerprinted) ───────────────────────────────
export interface LocalStructureConfig {
  version: string
  lookbackBars: number        // analysis window length (most recent N bars)
  minBars: number             // fewer than this → INSUFFICIENT_BARS
  staleBarsMs: number         // last bar older than this vs asOf → STALE_BARS
  swingLookback: number       // bars each side to confirm a swing extremum (prominence window)
  minImpulsePct: number       // a leg smaller than this is not a meaningful impulse
  minImpulseBars: number      // a leg shorter than this is not a meaningful impulse
  shallowPullbackPct: number  // pullback ≤ this → SHALLOW (boundary only, not a verdict)
  deepPullbackPct: number     // pullback ≥ this → DEEP
  failedRetracePct: number    // retrace ≥ this % of the impulse height → FAILED (gave the leg back)
  baseWindowBars: number      // trailing bars considered for the base/compression region
  minBaseBars: number         // fewer trailing bars than this → no base asserted
  maxBaseRangePct: number     // base range wider than this → not asserted "tight" (provisional)
  baseTestTolPct: number      // proximity (%) to count a touch of base high / low
  gapToleranceMult: number    // a bar gap > mult × median spacing → discontinuity/halt suspicion
  cadenceConsistencyMin: number // min fraction of intervals matching the dominant cadence, else → mixed
}

export const DEFAULT_LOCAL_FEATURE_CONFIG: LocalStructureConfig = {
  version: 'h4a-provisional-1',
  lookbackBars: 180, minBars: 15, staleBarsMs: 180_000,
  swingLookback: 3, minImpulsePct: 3, minImpulseBars: 2,
  shallowPullbackPct: 3, deepPullbackPct: 8, failedRetracePct: 100,
  baseWindowBars: 20, minBaseBars: 4, maxBaseRangePct: 4, baseTestTolPct: 0.3,
  gapToleranceMult: 4, cadenceConsistencyMin: 0.8,
}

const numEnv = (v: string | undefined, d: number): number => {
  if (v == null || v.trim() === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
export function resolveLocalFeatureConfig(env: Record<string, string | undefined> = process.env): LocalStructureConfig {
  const d = DEFAULT_LOCAL_FEATURE_CONFIG
  return {
    version: env.COMPANION_H4A_VERSION?.trim() || d.version,
    cadenceConsistencyMin: numEnv(env.COMPANION_H4A_CADENCE_MIN, d.cadenceConsistencyMin),
    lookbackBars: numEnv(env.COMPANION_H4A_LOOKBACK_BARS, d.lookbackBars),
    minBars: numEnv(env.COMPANION_H4A_MIN_BARS, d.minBars),
    staleBarsMs: numEnv(env.COMPANION_H4A_STALE_BARS_MS, d.staleBarsMs),
    swingLookback: numEnv(env.COMPANION_H4A_SWING_LOOKBACK, d.swingLookback),
    minImpulsePct: numEnv(env.COMPANION_H4A_MIN_IMPULSE_PCT, d.minImpulsePct),
    minImpulseBars: numEnv(env.COMPANION_H4A_MIN_IMPULSE_BARS, d.minImpulseBars),
    shallowPullbackPct: numEnv(env.COMPANION_H4A_SHALLOW_PULLBACK_PCT, d.shallowPullbackPct),
    deepPullbackPct: numEnv(env.COMPANION_H4A_DEEP_PULLBACK_PCT, d.deepPullbackPct),
    failedRetracePct: numEnv(env.COMPANION_H4A_FAILED_RETRACE_PCT, d.failedRetracePct),
    baseWindowBars: numEnv(env.COMPANION_H4A_BASE_WINDOW_BARS, d.baseWindowBars),
    minBaseBars: numEnv(env.COMPANION_H4A_MIN_BASE_BARS, d.minBaseBars),
    maxBaseRangePct: numEnv(env.COMPANION_H4A_MAX_BASE_RANGE_PCT, d.maxBaseRangePct),
    baseTestTolPct: numEnv(env.COMPANION_H4A_BASE_TEST_TOL_PCT, d.baseTestTolPct),
    gapToleranceMult: numEnv(env.COMPANION_H4A_GAP_TOLERANCE_MULT, d.gapToleranceMult),
  }
}
/** Canonical, order-stable serialization of every behavior-affecting boundary. */
export function localFeatureConfigCanonical(c: LocalStructureConfig): string {
  return [
    'h4a', `v=${c.version}`, `lb=${c.lookbackBars}`, `min=${c.minBars}`, `stale=${c.staleBarsMs}`,
    `swing=${c.swingLookback}`, `impPct=${c.minImpulsePct}`, `impBars=${c.minImpulseBars}`,
    `shallow=${c.shallowPullbackPct}`, `deep=${c.deepPullbackPct}`, `failed=${c.failedRetracePct}`,
    `baseWin=${c.baseWindowBars}`, `baseBars=${c.minBaseBars}`, `baseRange=${c.maxBaseRangePct}`,
    `baseTol=${c.baseTestTolPct}`, `gap=${c.gapToleranceMult}`, `cadence=${c.cadenceConsistencyMin}`,
  ].join('|')
}
/** Deterministic 8-hex fingerprint (FNV-1a, dep-free). Same config → same hash; any change → different. */
export function localFeatureConfigHash(c: LocalStructureConfig): string {
  const s = localFeatureConfigCanonical(c)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ── Output shape ──────────────────────────────────────────────────────────────────────────────────
export type LocalStructureStatus =
  | 'AVAILABLE'
  | 'INSUFFICIENT_BARS' | 'STALE_BARS' | 'GAP_DETECTED' | 'HALT_OR_DISCONTINUITY'
  | 'UNSUPPORTED_TIMEFRAME' | 'MISSING_VOLUME' | 'MISSING_REFERENCE'
export type Timeframe = '1m' | '5m' | '15m' | 'mixed' | 'unknown'
// Factual reset classification from measured pullback + base + trend — NOT a quality verdict.
export type ResetState = 'NO_RESET' | 'STILL_PULLING_BACK' | 'SHALLOW' | 'DEEP' | 'STABILIZING' | 'FAILED' | 'UNKNOWN'

export interface GlobalContext {
  sessionHigh: number | null
  offHighPct: number | null            // (price - sessionHigh)/sessionHigh*100 — ≤0 when below the high
  dayChangePct: number | null
  distanceFromVWAPPct: number | null
  distanceFromEMA9Pct: number | null
  distanceFromEMA21Pct: number | null
  timeSinceSessionHighSec: number | null   // only when the session high appears within the window
}
export interface ImpulseFeatures {
  detected: boolean                    // this is the CURRENT LOCAL impulse (most recent qualifying leg)
  startAt: number | null; startPrice: number | null
  peakAt: number | null; peakPrice: number | null
  pct: number | null                   // (peak - start)/start*100
  durationBars: number | null
  volume: number | null
  volumeVsWindowRatio: number | null   // leg avg bar volume ÷ window avg bar volume — a PROXY, NOT the RTH RVOL
  dominantImpulsePct: number | null    // magnitude of the LARGEST qualifying leg in the window (may differ from the current one)
}
export interface PullbackFeatures {
  startAt: number | null               // = impulse peak time
  lowAt: number | null; lowPrice: number | null
  pctFromImpulsePeak: number | null    // (peak - low)/peak*100
  maxPct: number | null
  durationBars: number | null
  retracementRatio: number | null      // pullback depth / impulse height (0..~1+); >1 = gave the whole leg back
  stillPullingBack: boolean            // last bar is at/near the pullback low
}
export interface BaseFeatures {
  detected: boolean                    // PROVISIONAL, observational only — never read by BASE/execution
  startAt: number | null; endAt: number | null; durationBars: number | null
  high: number | null; low: number | null; rangePct: number | null
  rangeContraction: number | null      // recent-half range / earlier-half range (<1 = contracting)
  volumeContraction: number | null     // base avg bar volume / impulse avg bar volume (<1 = contracting)
  realizedVolContraction: number | null// recent-half return stdev / earlier-half return stdev
  slopePctPerBar: number | null        // linreg slope of closes over the base region, as % of price
  upperTests: number | null; lowerTests: number | null
}
export interface LocalExtensionFeatures {
  referencePrice: number | null        // base high if a base is present, else impulse peak
  distanceFromBaseHighPct: number | null
  distanceFromBaseLowPct: number | null
  localExtensionPct: number | null     // (price - referencePrice)/referencePrice*100 — ~0 or <0 = locally FRESH
  downsideToBaseLowPct: number | null  // (price - baseLow)/price*100 — GEOMETRIC distance down to the base low (NOT a stop)
  spaceToSessionHighPct: number | null // (sessionHigh - price)/price*100 — GEOMETRIC room back to the session high (NOT a target)
  globalVsLocalExtensionRatio: number | null // |offHigh| / max(localExtension,ε): high ⇒ globally extended yet locally fresh
}
export interface ReExpansionFeatures {
  observed: boolean
  breakoutAboveBaseHighPct: number | null   // (price - baseHigh)/baseHigh*100 (positive once broken out)
  volumeExpansion: number | null            // last bar volume / base avg bar volume
  barsSinceBaseBreak: number | null
  reclaimedVWAP: boolean | null
  reclaimedEMA9: boolean | null
}
export interface PathRiskFeatures {
  recentLocalMAEProxy: number | null   // deepest adverse excursion in the reset region (= maxPullbackPct)
  distanceToBaseLowPct: number | null  // GEOMETRIC distance down to the base low — a reference level, NOT a stop instruction
  distanceToImpulseLowPct: number | null
  atrPct: number | null
  realizedVolPct: number | null        // stdev of 1-bar returns over the window, in %
  spreadPct: number | null             // null when the feed does not carry a real spread (honest)
}
export interface LocalStructureProvenance {
  symbol: string
  leaderEpisodeId: string | null       // filled by the daemon (H3C join); null here / when no leader record
  sweepId: string | null               // filled by the daemon
  runId: string | null                 // filled by the daemon
  asOfUtc: string
  timeframe: Timeframe
  barsStartAt: number | null; barsEndAt: number | null; barsCount: number
  dataFreshnessMs: number | null       // age of the last bar vs asOf
  discontinuityInWindow: boolean       // a suspected halt/gap occurred inside the analysis window
  sessionsInWindow: string[]           // ET session buckets the window spans: 'premarket' | 'regular' | 'afterhours'
  containsSessionBoundary: boolean     // the window spans ≥2 sessions (e.g. PM→RTH) — DESCRIPTIVE only, no rule imposed
  cadenceConsistency: number | null    // fraction of intervals matching the dominant cadence (1 = perfectly homogeneous)
  featureSchemaVersion: number
  localFeatureConfigVersion: string
  localFeatureConfigHash: string
}
// Composable data-quality: `status` is the PRIMARY (worst) condition; `qualityFlags` preserves EVERY
// detected defect so an audit can reconstruct e.g. stale+missing-volume, gap+mixed-cadence, etc.
export type QualityFlag =
  | 'STALE_BARS' | 'GAP_IN_WINDOW' | 'HALT_OR_DISCONTINUITY' | 'MIXED_CADENCE'
  | 'MISSING_VOLUME' | 'INSUFFICIENT_BARS' | 'UNSUPPORTED_TIMEFRAME' | 'CONTAINS_SESSION_BOUNDARY' | 'FUTURE_BARS_DROPPED'
export interface LocalStructureFeatures {
  status: LocalStructureStatus
  qualityFlags: QualityFlag[]
  resetState: ResetState
  global: GlobalContext
  impulse: ImpulseFeatures
  pullback: PullbackFeatures
  base: BaseFeatures
  localExtension: LocalExtensionFeatures
  reExpansion: ReExpansionFeatures
  pathRisk: PathRiskFeatures
  provenance: LocalStructureProvenance
}

export interface LocalStructureInput {
  symbol: string
  candles: Candle[]                    // canonical bars, chronological (oldest→newest); NOT mutated
  asOfMs: number
  session?: string
  globals?: Partial<{
    price: number
    sessionHigh: number | null; dayChangePct: number | null
    vwap: number | null; ema9: number | null; ema21: number | null
    atr: number | null; atrPct: number | null; relativeVolume: number | null; spreadPct: number | null
  }>
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
const pct = (a: number, b: number): number | null => (b > 0 ? ((a - b) / b) * 100 : null)
const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
function validCandle(c: Candle): boolean {
  return isFiniteNum(c.open) && isFiniteNum(c.high) && isFiniteNum(c.low) && isFiniteNum(c.close)
    && isFiniteNum(c.time) && c.high >= c.low && c.open > 0 && c.close > 0 && c.high > 0 && c.low > 0
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1))
}
function classifyTimeframe(spacingSec: number): Timeframe {
  if (spacingSec <= 0) return 'unknown'
  if (Math.abs(spacingSec - 60) <= 15) return '1m'
  if (Math.abs(spacingSec - 300) <= 60) return '5m'
  if (Math.abs(spacingSec - 900) <= 120) return '15m'
  return 'unknown'
}
/** Swing-high indices: local maxima of `high` dominant over ±k, strictly above the immediate left neighbour. */
function swingHighs(seg: Candle[], k: number): number[] {
  const out: number[] = []
  for (let i = k; i <= seg.length - 1 - k; i++) {
    let ok = seg[i].high > seg[i - 1].high
    for (let j = i - k; j <= i + k && ok; j++) if (j !== i && seg[j].high > seg[i].high) ok = false
    if (ok) out.push(i)
  }
  return out
}
/** argmin of `low` over [lo, hi] inclusive; ties → the LATEST index (closest to the peak). -1 if empty. */
function argminLow(seg: Candle[], lo: number, hi: number): number {
  let idx = -1, best = Infinity
  for (let i = Math.max(0, lo); i <= hi && i < seg.length; i++) if (seg[i].low <= best) { best = seg[i].low; idx = i }
  return idx
}
function maxHigh(seg: Candle[], lo: number, hi: number): number {
  let m = -Infinity
  for (let i = Math.max(0, lo); i <= hi && i < seg.length; i++) if (seg[i].high > m) m = seg[i].high
  return m
}

const nullImpulse = (): ImpulseFeatures => ({ detected: false, startAt: null, startPrice: null, peakAt: null, peakPrice: null, pct: null, durationBars: null, volume: null, volumeVsWindowRatio: null, dominantImpulsePct: null })
const nullPullback = (): PullbackFeatures => ({ startAt: null, lowAt: null, lowPrice: null, pctFromImpulsePeak: null, maxPct: null, durationBars: null, retracementRatio: null, stillPullingBack: false })
const nullBase = (): BaseFeatures => ({ detected: false, startAt: null, endAt: null, durationBars: null, high: null, low: null, rangePct: null, rangeContraction: null, volumeContraction: null, realizedVolContraction: null, slopePctPerBar: null, upperTests: null, lowerTests: null })
const nullLocalExt = (): LocalExtensionFeatures => ({ referencePrice: null, distanceFromBaseHighPct: null, distanceFromBaseLowPct: null, localExtensionPct: null, downsideToBaseLowPct: null, spaceToSessionHighPct: null, globalVsLocalExtensionRatio: null })
const nullReExp = (): ReExpansionFeatures => ({ observed: false, breakoutAboveBaseHighPct: null, volumeExpansion: null, barsSinceBaseBreak: null, reclaimedVWAP: null, reclaimedEMA9: null })

// ── ET session bucket (no imports — Intl is a global; keeps the engine dependency-free) ─────────────
const etHourMinFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
function etSession(timeSec: number): 'premarket' | 'regular' | 'afterhours' | 'overnight' {
  const parts = etHourMinFmt.formatToParts(new Date(timeSec * 1000))
  const hh = Number(parts.find(p => p.type === 'hour')?.value ?? '0') % 24
  const mm = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  const t = hh * 60 + mm
  if (t >= 240 && t < 570) return 'premarket'      // 04:00–09:30 ET
  if (t >= 570 && t < 960) return 'regular'         // 09:30–16:00 ET
  if (t >= 960 && t < 1200) return 'afterhours'     // 16:00–20:00 ET
  return 'overnight'
}
function sessionsCovered(seg: Candle[]): string[] {
  const set = new Set<string>()
  for (const c of seg) set.add(etSession(c.time))
  return [...set]
}
/** Fraction of intervals within tolerance of the dominant (median) spacing — 1 = perfectly homogeneous. */
function cadenceConsistency(spacings: number[], dominant: number): number {
  if (spacings.length === 0 || dominant <= 0) return 1
  const tol = Math.max(dominant * 0.25, 5)
  const onCadence = spacings.filter(s => Math.abs(s - dominant) <= tol).length
  return onCadence / spacings.length
}

function globalContext(input: LocalStructureInput, seg: Candle[], price: number): GlobalContext {
  const g = input.globals ?? {}
  const sessionHigh = g.sessionHigh ?? null
  const offHighPct = sessionHigh != null ? pct(price, sessionHigh) : null
  // timeSinceSessionHigh only when the session high actually appears inside the analysis window.
  let timeSinceSessionHighSec: number | null = null
  if (sessionHigh != null && seg.length > 0) {
    let hiIdx = -1
    for (let i = 0; i < seg.length; i++) if (seg[i].high >= sessionHigh - 1e-9) hiIdx = i
    if (hiIdx >= 0) timeSinceSessionHighSec = Math.max(0, Math.round(input.asOfMs / 1000 - seg[hiIdx].time))
  }
  return {
    sessionHigh, offHighPct, dayChangePct: g.dayChangePct ?? null,
    distanceFromVWAPPct: g.vwap != null ? pct(price, g.vwap) : null,
    distanceFromEMA9Pct: g.ema9 != null ? pct(price, g.ema9) : null,
    distanceFromEMA21Pct: g.ema21 != null ? pct(price, g.ema21) : null,
    timeSinceSessionHighSec,
  }
}

function provenance(input: LocalStructureInput, seg: Candle[], timeframe: Timeframe, discontinuity: boolean, cadenceConsist: number | null, cfg: LocalStructureConfig): LocalStructureProvenance {
  const last = seg.length ? seg[seg.length - 1] : null
  const sessions = sessionsCovered(seg)
  return {
    symbol: input.symbol, leaderEpisodeId: null, sweepId: null, runId: null,
    asOfUtc: new Date(input.asOfMs).toISOString(), timeframe,
    barsStartAt: seg.length ? seg[0].time : null, barsEndAt: last ? last.time : null, barsCount: seg.length,
    dataFreshnessMs: last ? input.asOfMs - last.time * 1000 : null,
    discontinuityInWindow: discontinuity,
    sessionsInWindow: sessions, containsSessionBoundary: sessions.length > 1, cadenceConsistency: cadenceConsist,
    featureSchemaVersion: LOCAL_FEATURE_SCHEMA_VERSION,
    localFeatureConfigVersion: cfg.version, localFeatureConfigHash: localFeatureConfigHash(cfg),
  }
}

/** Build an all-null feature set carrying a specific failure status + all detected quality flags. */
function degraded(input: LocalStructureInput, seg: Candle[], timeframe: Timeframe, status: LocalStructureStatus, price: number, opts: { discontinuity?: boolean; qualityFlags?: QualityFlag[]; cadence?: number | null } = {}, cfg = DEFAULT_LOCAL_FEATURE_CONFIG): LocalStructureFeatures {
  return {
    status, qualityFlags: opts.qualityFlags ?? [], resetState: 'UNKNOWN',
    global: globalContext(input, seg, price),
    impulse: nullImpulse(), pullback: nullPullback(), base: nullBase(),
    localExtension: nullLocalExt(), reExpansion: nullReExp(),
    pathRisk: { recentLocalMAEProxy: null, distanceToBaseLowPct: null, distanceToImpulseLowPct: null, atrPct: input.globals?.atrPct ?? null, realizedVolPct: null, spreadPct: input.globals?.spreadPct ?? null },
    provenance: provenance(input, seg, timeframe, opts.discontinuity ?? false, opts.cadence ?? null, cfg),
  }
}

/**
 * Compute the local structural features for one symbol at one moment. Pure: no I/O, inputs untouched.
 */
export function computeLocalStructure(input: LocalStructureInput, cfg: LocalStructureConfig = DEFAULT_LOCAL_FEATURE_CONFIG): LocalStructureFeatures {
  // 0) CAUSAL / AS-OF SAFETY: drop any bar dated after asOf BEFORE anything else, so a later bar can
  //    never influence the features reported for this timestamp (mandatory for the H4B tape replay).
  const raw = input.candles ?? []
  const withinAsOf = raw.filter(c => c.time * 1000 <= input.asOfMs)
  const futureDropped = withinAsOf.length < raw.filter(validCandle).length && raw.some(c => validCandle(c) && c.time * 1000 > input.asOfMs)

  // 1) Sanitize & order bars. Drop malformed prints; de-dup identical timestamps (keep the later one);
  //    sort ascending so out-of-order feeds cannot corrupt geometry.
  const cleaned = withinAsOf.filter(validCandle).sort((a, b) => a.time - b.time)
  const dedup: Candle[] = []
  for (const c of cleaned) {
    if (dedup.length && dedup[dedup.length - 1].time === c.time) dedup[dedup.length - 1] = c
    else dedup.push(c)
  }
  const priceOf = (arr: Candle[]): number => input.globals?.price ?? (arr.length ? arr[arr.length - 1].close : 0)
  const flag = (fs: QualityFlag[], f: QualityFlag) => { if (!fs.includes(f)) fs.push(f) }

  if (dedup.length < cfg.minBars) return degraded(input, dedup, dedup.length ? classifyTimeframe(median(diffs(dedup))) : 'unknown', 'INSUFFICIENT_BARS', priceOf(dedup), { qualityFlags: ['INSUFFICIENT_BARS'] }, cfg)

  // 2) Timeframe from the DOMINANT (median) spacing PLUS a cadence-consistency check — a materially mixed
  //    feed (e.g. alternating 1m/5m, or a big 5m section) is NOT labelled 1m just because the median is 60s.
  const spacings = diffs(dedup)
  const spacing = median(spacings)
  const consistency = cadenceConsistency(spacings, spacing)
  let timeframe = classifyTimeframe(spacing)
  if (timeframe === 'unknown' || consistency < cfg.cadenceConsistencyMin) {
    const flags: QualityFlag[] = ['UNSUPPORTED_TIMEFRAME']
    if (consistency < cfg.cadenceConsistencyMin && timeframe !== 'unknown') { timeframe = 'mixed'; flag(flags, 'MIXED_CADENCE') }
    return degraded(input, dedup, timeframe === 'mixed' ? 'mixed' : 'unknown', 'UNSUPPORTED_TIMEFRAME', priceOf(dedup), { qualityFlags: flags, cadence: consistency }, cfg)
  }

  // 3) Analysis window = most recent lookbackBars, then trimmed to the contiguous run AFTER the last
  //    discontinuity (a reopen gap must not be read as one continuous impulse).
  const win = dedup.slice(Math.max(0, dedup.length - cfg.lookbackBars))
  const { seg, discontinuity } = trimToContiguous(win, spacing, cfg.gapToleranceMult)
  const price = priceOf(seg)
  const last = seg[seg.length - 1]
  const freshnessMs = input.asOfMs - last.time * 1000

  // Compose ALL detected defects; `status` is the primary (worst) one, `qualityFlags` keeps the rest.
  const qualityFlags: QualityFlag[] = []
  if (futureDropped) flag(qualityFlags, 'FUTURE_BARS_DROPPED')
  if (discontinuity) flag(qualityFlags, 'GAP_IN_WINDOW')
  const winConsistency = cadenceConsistency(diffs(seg), spacing)
  if (seg.length >= 2 && diffs(seg).some(s => s > spacing * cfg.gapToleranceMult)) flag(qualityFlags, 'GAP_IN_WINDOW')
  if (freshnessMs > cfg.staleBarsMs) flag(qualityFlags, 'STALE_BARS')
  if (seg.every(c => c.volume === 0)) flag(qualityFlags, 'MISSING_VOLUME')
  else if (seg.some(c => c.volume === 0)) flag(qualityFlags, 'MISSING_VOLUME')
  if (sessionsCovered(seg).length > 1) flag(qualityFlags, 'CONTAINS_SESSION_BOUNDARY')

  if (seg.length < cfg.minBars) return degraded(input, seg, timeframe, discontinuity ? 'HALT_OR_DISCONTINUITY' : 'INSUFFICIENT_BARS', price, { discontinuity, qualityFlags: [...qualityFlags, discontinuity ? 'HALT_OR_DISCONTINUITY' : 'INSUFFICIENT_BARS'], cadence: winConsistency }, cfg)
  if (freshnessMs > cfg.staleBarsMs) return degraded(input, seg, timeframe, 'STALE_BARS', price, { discontinuity, qualityFlags, cadence: winConsistency }, cfg)
  if (seg.every(c => c.volume === 0)) return degraded(input, seg, timeframe, 'MISSING_VOLUME', price, { discontinuity, qualityFlags, cadence: winConsistency }, cfg)

  // 4) Impulse — the CURRENT LOCAL impulse (most recent qualifying leg), with the dominant historical
  //    leg magnitude kept separately so recency and dominance are never conflated.
  const det = detectImpulse(seg, cfg)
  const impulse = det.impulse

  // 5) Pullback/reset from the impulse peak; 6) base/compression.
  //    Post-impulse base = the consolidation after the pullback (price came off the peak).
  //    When price is still at the peak (no bars after it), the reference is the PRE-impulse launch base.
  let pullback = nullPullback(), base = nullBase(), resetState: ResetState = impulse.detected ? 'UNKNOWN' : 'NO_RESET'
  if (impulse.detected && det.peakIdx >= 0) {
    const postPeakLen = seg.length - 1 - det.peakIdx
    if (postPeakLen > 0) {
      pullback = measurePullback(seg, det.peakIdx, impulse)
      base = measureBasePost(seg, det.peakIdx, impulse, cfg)
      resetState = classifyReset(pullback, base, cfg)
    } else {
      base = measureBasePre(seg, det.troughIdx, impulse, cfg)   // price at the peak → launch pad is the local base
      resetState = 'NO_RESET'
    }
  }

  const g = input.globals ?? {}
  const globalCtx = globalContext(input, seg, price)
  const localExtension = measureLocalExtension(price, impulse, base, globalCtx)
  const reExpansion = measureReExpansion(seg, base, price, g)

  // 7) Path / risk geometry (factual; supports later bounded-risk research — NOT pass/fail).
  const returns: number[] = []
  for (let i = 1; i < seg.length; i++) if (seg[i - 1].close > 0) returns.push((seg[i].close - seg[i - 1].close) / seg[i - 1].close)
  const pathRisk: PathRiskFeatures = {
    recentLocalMAEProxy: pullback.maxPct,
    distanceToBaseLowPct: localExtension.downsideToBaseLowPct,
    distanceToImpulseLowPct: impulse.startPrice != null ? pct(price, impulse.startPrice) : null,
    atrPct: g.atrPct ?? null,
    realizedVolPct: returns.length >= 2 ? stdev(returns) * 100 : null,
    spreadPct: g.spreadPct ?? null,
  }

  // `status` = the single primary condition (worst wins); `qualityFlags` already carries every defect.
  const status: LocalStructureStatus = qualityFlags.includes('HALT_OR_DISCONTINUITY') ? 'HALT_OR_DISCONTINUITY'
    : qualityFlags.includes('GAP_IN_WINDOW') ? 'GAP_DETECTED' : 'AVAILABLE'
  return {
    status, qualityFlags,
    resetState, global: globalCtx, impulse, pullback, base, localExtension, reExpansion, pathRisk,
    provenance: provenance(input, seg, timeframe, discontinuity, winConsistency, cfg),
  }
}

function diffs(cs: Candle[]): number[] {
  const out: number[] = []
  for (let i = 1; i < cs.length; i++) out.push(cs[i].time - cs[i - 1].time)
  return out
}

/** Keep only the most-recent contiguous run: walk back from the end until a bar gap exceeds tolerance. */
function trimToContiguous(win: Candle[], spacing: number, gapMult: number): { seg: Candle[]; discontinuity: boolean } {
  if (win.length < 2 || spacing <= 0) return { seg: win, discontinuity: false }
  const tol = spacing * gapMult
  let start = 0, discontinuity = false
  for (let i = win.length - 1; i >= 1; i--) {
    if (win[i].time - win[i - 1].time > tol) { start = i; discontinuity = true; break }
  }
  return { seg: start > 0 ? win.slice(start) : win, discontinuity }
}

/** Most recent qualifying impulse. Tries the newest swing highs first (plus the endpoint when at highs). */
interface ImpulseDetection { impulse: ImpulseFeatures; peakIdx: number; troughIdx: number }
/**
 * The dominant recent up-leg. Candidate peaks = confirmed swing highs plus the endpoint when it is the
 * window high (an ongoing/vertical move). For each candidate the leg is isolated to the run since the
 * PREVIOUS swing high (so two genuine impulses do not merge) and the trough is the lowest low of that run.
 *
 * The CURRENT LOCAL impulse is the MOST RECENT leg that clears minImpulsePct/minImpulseBars — so once a
 * later meaningful impulse establishes new structure, the geometry follows it rather than staying anchored
 * to an older, larger move. A sub-threshold base wiggle is NOT a new impulse (the size gate rejects it).
 * The largest qualifying leg is reported separately as `dominantImpulsePct` (dominant ≠ current).
 */
function detectImpulse(seg: Candle[], cfg: LocalStructureConfig): ImpulseDetection {
  const highs = swingHighs(seg, cfg.swingLookback)
  const candidates = new Set(highs)
  candidates.add(seg.length - 1)   // the endpoint is always a candidate, so a NEWER impulse whose peak is
                                   // the current bar (even below the window high) can become the current one
  const windowAvgVol = seg.reduce((s, c) => s + c.volume, 0) / seg.length

  let current: { peakIdx: number; troughIdx: number; legPct: number } | null = null   // most recent qualifying
  let dominantPct: number | null = null                                                // largest qualifying
  for (const p of candidates) {
    if (p <= 0) continue
    let q = -1                                    // latest swing high strictly before p → isolates this leg
    for (const h of highs) if (h < p) q = h
    const troughIdx = argminLow(seg, q + 1, p - 1)
    if (troughIdx < 0) continue
    const legPct = pct(seg[p].high, seg[troughIdx].low)
    const durationBars = p - troughIdx
    if (legPct == null || legPct < cfg.minImpulsePct || durationBars < cfg.minImpulseBars) continue
    dominantPct = dominantPct == null ? legPct : Math.max(dominantPct, legPct)
    // recency wins: prefer the later peak; on an exact tie prefer the larger leg.
    if (!current || p > current.peakIdx || (p === current.peakIdx && legPct > current.legPct)) current = { peakIdx: p, troughIdx, legPct }
  }
  if (!current) return { impulse: nullImpulse(), peakIdx: -1, troughIdx: -1 }

  const { peakIdx, troughIdx } = current
  let vol = 0
  for (let i = troughIdx + 1; i <= peakIdx; i++) vol += seg[i].volume
  const durationBars = peakIdx - troughIdx
  const legAvgVol = durationBars > 0 ? vol / durationBars : 0
  return {
    peakIdx, troughIdx,
    impulse: {
      detected: true, startAt: seg[troughIdx].time, startPrice: seg[troughIdx].low,
      peakAt: seg[peakIdx].time, peakPrice: seg[peakIdx].high, pct: current.legPct, durationBars, volume: vol,
      volumeVsWindowRatio: windowAvgVol > 0 ? legAvgVol / windowAvgVol : null, dominantImpulsePct: dominantPct,
    },
  }
}

function measurePullback(seg: Candle[], peakIdx: number, impulse: ImpulseFeatures): PullbackFeatures {
  const peakPrice = impulse.peakPrice!
  const lowIdx = argminLow(seg, peakIdx + 1, seg.length - 1)   // pullback low is AFTER the peak
  if (lowIdx < 0) return nullPullback()
  const lowPrice = seg[lowIdx].low
  const drop = pct(peakPrice, lowPrice)                        // (peak - low)/peak*100, positive downward
  const dropMag = drop != null ? Math.abs(drop) : null
  const impulseHeightPct = impulse.pct ?? 0
  const retracementRatio = impulseHeightPct > 0 && dropMag != null ? dropMag / impulseHeightPct : null
  return {
    startAt: impulse.peakAt, lowAt: seg[lowIdx].time, lowPrice,
    pctFromImpulsePeak: dropMag, maxPct: dropMag,
    durationBars: lowIdx - peakIdx, retracementRatio,
    stillPullingBack: lowIdx >= seg.length - 1,               // the low is the last bar → still going down
  }
}

/** Shared factual measurement over a base region (a slice of `seg`), given the impulse for volume comparison. */
function baseMeasurements(region: Candle[], impulse: ImpulseFeatures, cfg: LocalStructureConfig): BaseFeatures {
  if (region.length < cfg.minBaseBars) return nullBase()
  const high = Math.max(...region.map(c => c.high))
  const low = Math.min(...region.map(c => c.low))
  const rangePct = pct(high, low)
  const half = Math.floor(region.length / 2)
  const rng = (arr: Candle[]) => (arr.length ? Math.max(...arr.map(c => c.high)) - Math.min(...arr.map(c => c.low)) : 0)
  const earlyRng = rng(region.slice(0, half)), lateRng = rng(region.slice(half))
  const rangeContraction = earlyRng > 0 ? lateRng / earlyRng : null
  const baseAvgVol = region.reduce((s, c) => s + c.volume, 0) / region.length
  const impulseAvgVol = impulse.durationBars && impulse.volume != null && impulse.durationBars > 0 ? impulse.volume / impulse.durationBars : null
  const volumeContraction = impulseAvgVol && impulseAvgVol > 0 ? baseAvgVol / impulseAvgVol : null
  const rets = (arr: Candle[]) => { const r: number[] = []; for (let i = 1; i < arr.length; i++) if (arr[i - 1].close > 0) r.push((arr[i].close - arr[i - 1].close) / arr[i - 1].close); return r }
  const earlyVol = stdev(rets(region.slice(0, half + 1))), lateVol = stdev(rets(region.slice(half)))
  const realizedVolContraction = earlyVol > 0 ? lateVol / earlyVol : null
  const slopePctPerBar = linregSlopePct(region.map(c => c.close))
  const tol = cfg.baseTestTolPct / 100
  let upperTests = 0, lowerTests = 0
  for (const c of region) { if (c.high >= high * (1 - tol)) upperTests++; if (c.low <= low * (1 + tol)) lowerTests++ }
  const detected = region.length >= cfg.minBaseBars && rangePct != null && rangePct <= cfg.maxBaseRangePct
    && (slopePctPerBar == null || Math.abs(slopePctPerBar) <= cfg.maxBaseRangePct / cfg.minBaseBars)
  return {
    detected, startAt: region[0].time, endAt: region[region.length - 1].time, durationBars: region.length,
    high, low, rangePct, rangeContraction, volumeContraction, realizedVolContraction, slopePctPerBar, upperTests, lowerTests,
  }
}

/** Post-impulse base: the consolidation from the pullback low to the last non-breakout bar. Trailing bars
 *  that make new highs above the prior consolidation are peeled off (they are re-expansion, not the base). */
function measureBasePost(seg: Candle[], peakIdx: number, impulse: ImpulseFeatures, cfg: LocalStructureConfig): BaseFeatures {
  // Region = the trailing post-peak bars (bounded by baseWindowBars). A DEEP pullback keeps this range
  // wide → the base is honestly NOT asserted; a shallow pullback leaves it tight → a base is measured.
  const from = Math.max(peakIdx + 1, seg.length - cfg.baseWindowBars)
  const region = seg.slice(from)
  // Peel trailing breakout bars: while the last bar's high exceeds the base built by the earlier bars.
  let end = region.length
  while (end > cfg.minBaseBars && region[end - 1].high > maxHigh(region, 0, end - 2) + 1e-9) end--
  return baseMeasurements(region.slice(0, end), impulse, cfg)
}

/** Pre-impulse (launch-pad) base: the consolidation ending at the impulse trough. Used when price is still
 *  at the peak (no post-impulse bars) so local extension can be measured above the base it launched from. */
function measureBasePre(seg: Candle[], troughIdx: number, impulse: ImpulseFeatures, cfg: LocalStructureConfig): BaseFeatures {
  if (troughIdx < 0) return nullBase()
  const region = seg.slice(Math.max(0, troughIdx - cfg.baseWindowBars + 1), troughIdx + 1)
  return baseMeasurements(region, impulse, cfg)
}

function linregSlopePct(ys: number[]): number | null {
  const n = ys.length
  if (n < 2) return null
  const mean = ys.reduce((s, y) => s + y, 0) / n
  if (mean <= 0) return null
  let num = 0, den = 0
  const xMean = (n - 1) / 2
  for (let i = 0; i < n; i++) { num += (i - xMean) * (ys[i] - mean); den += (i - xMean) ** 2 }
  if (den === 0) return null
  return ((num / den) / mean) * 100   // % of mean price per bar
}

function classifyReset(pb: PullbackFeatures, base: BaseFeatures, cfg: LocalStructureConfig): ResetState {
  if (pb.pctFromImpulsePeak == null) return 'NO_RESET'
  if (pb.retracementRatio != null && pb.retracementRatio * 100 >= cfg.failedRetracePct) return 'FAILED'
  if (pb.stillPullingBack && !base.detected) return 'STILL_PULLING_BACK'
  if (base.detected) return 'STABILIZING'
  if (pb.pctFromImpulsePeak < 1e-9) return 'NO_RESET'
  if (pb.pctFromImpulsePeak <= cfg.shallowPullbackPct) return 'SHALLOW'
  if (pb.pctFromImpulsePeak >= cfg.deepPullbackPct) return 'DEEP'
  return 'SHALLOW'
}

function measureLocalExtension(price: number, impulse: ImpulseFeatures, base: BaseFeatures, g: GlobalContext): LocalExtensionFeatures {
  if (!impulse.detected) return nullLocalExt()
  const referencePrice = base.detected && base.high != null ? base.high : impulse.peakPrice
  const distanceFromBaseHighPct = base.high != null ? pct(price, base.high) : null
  const distanceFromBaseLowPct = base.low != null ? pct(price, base.low) : null
  const localExtensionPct = referencePrice != null ? pct(price, referencePrice) : null
  const downsideToBaseLowPct = base.low != null && price > 0 ? ((price - base.low) / price) * 100 : null
  const spaceToSessionHighPct = g.sessionHigh != null && price > 0 ? ((g.sessionHigh - price) / price) * 100 : null
  const offHighMag = g.offHighPct != null ? Math.abs(g.offHighPct) : null
  const localExtMag = localExtensionPct != null ? Math.max(Math.abs(localExtensionPct), 0.1) : null
  const globalVsLocalExtensionRatio = offHighMag != null && localExtMag != null ? offHighMag / localExtMag : null
  return { referencePrice, distanceFromBaseHighPct, distanceFromBaseLowPct, localExtensionPct, downsideToBaseLowPct, spaceToSessionHighPct, globalVsLocalExtensionRatio }
}

function measureReExpansion(seg: Candle[], base: BaseFeatures, price: number, g: NonNullable<LocalStructureInput['globals']>): ReExpansionFeatures {
  if (!base.detected || base.high == null || base.startAt == null || base.endAt == null) return nullReExp()
  const breakoutAboveBaseHighPct = pct(price, base.high)
  const observed = breakoutAboveBaseHighPct != null && breakoutAboveBaseHighPct > 0
  // Count the trailing run of bars whose close is above the base high (bars since the base broke).
  let barsSinceBaseBreak: number | null = null
  for (let i = seg.length - 1; i >= 0; i--) {
    if (seg[i].close > base.high) barsSinceBaseBreak = seg.length - 1 - i
    else break
  }
  // Base-region average bar volume (the actual base bars, not the breakout bars) vs the last bar.
  const baseBars = seg.filter(c => c.time >= base.startAt! && c.time <= base.endAt!)
  const baseAvgVol = baseBars.length ? baseBars.reduce((s, c) => s + c.volume, 0) / baseBars.length : null
  const lastVol = seg[seg.length - 1].volume
  const volumeExpansion = baseAvgVol && baseAvgVol > 0 ? lastVol / baseAvgVol : null
  return {
    observed, breakoutAboveBaseHighPct, volumeExpansion, barsSinceBaseBreak,
    reclaimedVWAP: g.vwap != null ? price > g.vwap : null,
    reclaimedEMA9: g.ema9 != null ? price > g.ema9 : null,
  }
}
