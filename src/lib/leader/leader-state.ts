/**
 * H3C — persistent, strategy-neutral LEADER STATE (pure core).
 *
 * A HISTORY layer over the H3B canonical SweepSnapshot: "what has this symbol been doing
 * across time?". OBSERVATIONAL ONLY — it consumes the snapshot, never calls providers, never
 * mutates the snapshot, and never reaches execution. CORE/CHALLENGER are SHADOW roles /
 * metadata; they change nothing BASE monitors or trades.
 *
 * All thresholds are PROVISIONAL, config-driven, and stamped with a ruleVersion — they exist
 * only to exercise the architecture, not to encode any trading rule. The real local-reset
 * geometry (EXPANDING/BASE_FORMING) belongs to H4A and is NOT faked here.
 */
import type { SweepSnapshot } from '@/lib/universe/coordinator'
import type { RankedRow } from '@/lib/universe/pipeline'

// Observable coarse lifecycle. EXPANDING / BASE_FORMING are RESERVED for H4A (need local-base
// geometry that does not exist yet) and are never assigned in H3C.
export type LifecycleState =
  | 'DISCOVERED' | 'LEADER_CANDIDATE' | 'LEADER_CONFIRMED'
  | 'RESETTING' | 'REEXPANDING'          // coarse/provisional (from available offHigh + peak change)
  | 'STALE' | 'EXPIRED'
export type LeaderRole = 'NONE' | 'CHALLENGER' | 'CORE'

export interface LeaderStateRecord {
  // identity
  symbol: string
  leaderEpisodeId: string
  tradingDay: string                  // ET day this EPISODE belongs to (day-scoped; never mixes day-change across days)
  firstSeenAt: string; lastSeenAt: string
  firstSeenSweepId: string; lastSeenSweepId: string
  // lifetime (persists across day rolls)
  firstEverSeenAt: string; episodeCount: number
  // discovery history
  sourcesEverSeen: string[]; currentSources: string[]
  bestSourceRank: number | null; currentSourceRanks: Record<string, number>
  // rank / universe history (best = MIN rank)
  bestPre60Rank: number | null; bestPre30Rank: number | null; bestRouteRank: number | null; bestLegacyTop15Rank: number | null
  firstTop60At: string | null; firstTop30At: string | null; firstLegacyTop15At: string | null
  timesTop60: number; timesTop30: number; timesLegacyTop15: number
  // price / demand history (DAY-SCOPED)
  firstObservedChangePct: number; currentChangePct: number
  peakObservedChangePct: number; peakObservedAt: string
  currentOffHighPct: number | null; peakRvol: number | null
  currentVolume: number | null; currentFloat: number | null
  // presence / churn
  presentThisSweep: boolean
  consecutiveSweepsSeen: number; consecutiveSweepsAbsent: number
  lastPresentAt: string; lastAbsentAt: string | null
  reappearanceCount: number
  // lifecycle
  lifecycleState: LifecycleState; lifecycleEnteredAt: string
  priorLifecycleState: LifecycleState | null; transitionReason: string | null; transitionSweepId: string | null
  // shadow role
  role: LeaderRole; roleEnteredAt: string; priorRole: LeaderRole | null; roleRuleVersion: string
  // research completeness
  historyComplete: boolean            // false when this episode began after a fresh/degraded state load
}

export type LeaderStateMap = Record<string, LeaderStateRecord>

export interface LeaderStateConfig {
  ruleVersion: string
  candidateMinChangePct: number       // PROVISIONAL
  confirmMinChangePct: number         // PROVISIONAL
  confirmTimesTop30: number           // PROVISIONAL
  resettingOffHighPct: number         // PROVISIONAL (coarse)
  staleAbsentSweeps: number           // PROVISIONAL
  expireAbsentSweeps: number          // PROVISIONAL
  maxRecords: number                  // memory bound
}
export const DEFAULT_LEADER_CONFIG: LeaderStateConfig = {
  ruleVersion: 'h3c-provisional-1',
  candidateMinChangePct: 30, confirmMinChangePct: 50, confirmTimesTop30: 2,
  resettingOffHighPct: -8, staleAbsentSweeps: 20, expireAbsentSweeps: 80, maxRecords: 500,
}

// ── PROVISIONAL CONFIG PROVENANCE (red-team §2) ──────────────────────────────
// A static ruleVersion is not enough: env overrides can change behavior while the version string
// stays the same. `leaderConfigHash` is a deterministic fingerprint over EVERY behavior-affecting
// provisional value, so telemetry/persisted state can pin exactly which effective config produced a
// transition. `resolveLeaderConfig` reads the (observational-only) env overrides — these never touch
// trading; they only tune the shadow lifecycle/role thresholds.
const numEnv = (v: string | undefined, d: number): number => {
  if (v == null || v.trim() === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
export function resolveLeaderConfig(env: Record<string, string | undefined> = process.env): LeaderStateConfig {
  const d = DEFAULT_LEADER_CONFIG
  return {
    ruleVersion: env.COMPANION_LEADER_RULE_VERSION?.trim() || d.ruleVersion,
    candidateMinChangePct: numEnv(env.COMPANION_LEADER_CANDIDATE_MIN_CHANGE, d.candidateMinChangePct),
    confirmMinChangePct: numEnv(env.COMPANION_LEADER_CONFIRM_MIN_CHANGE, d.confirmMinChangePct),
    confirmTimesTop30: numEnv(env.COMPANION_LEADER_CONFIRM_TIMES_TOP30, d.confirmTimesTop30),
    resettingOffHighPct: numEnv(env.COMPANION_LEADER_RESETTING_OFFHIGH, d.resettingOffHighPct),
    staleAbsentSweeps: numEnv(env.COMPANION_LEADER_STALE_ABSENT, d.staleAbsentSweeps),
    expireAbsentSweeps: numEnv(env.COMPANION_LEADER_EXPIRE_ABSENT, d.expireAbsentSweeps),
    maxRecords: numEnv(env.COMPANION_LEADER_MAX_RECORDS, d.maxRecords),
  }
}
/** Canonical, order-stable serialization of every behavior-affecting config value. */
export function leaderConfigCanonical(cfg: LeaderStateConfig): string {
  return [
    'h3c', `rv=${cfg.ruleVersion}`,
    `cand=${cfg.candidateMinChangePct}`, `conf=${cfg.confirmMinChangePct}`, `ct30=${cfg.confirmTimesTop30}`,
    `reset=${cfg.resettingOffHighPct}`, `stale=${cfg.staleAbsentSweeps}`, `expire=${cfg.expireAbsentSweeps}`,
    `max=${cfg.maxRecords}`,
  ].join('|')
}
/** Deterministic 8-hex fingerprint (FNV-1a, dep-free). Same config → same hash; any change → different. */
export function leaderConfigHash(cfg: LeaderStateConfig): string {
  const s = leaderConfigCanonical(cfg)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export interface LeaderTransition { symbol: string; leaderEpisodeId: string; priorState: LifecycleState | null; newState: LifecycleState; reason: string }
export interface LeaderRoleChange { symbol: string; leaderEpisodeId: string; priorRole: LeaderRole; newRole: LeaderRole }
// A capacity eviction must be AUDITABLE (red-team §4). `active` = the evicted record was NOT EXPIRED,
// i.e. a live episode was dropped under hard capacity pressure — a research-integrity event that the
// caller surfaces loudly and that marks subsequent history incomplete.
export interface LeaderEviction { symbol: string; leaderEpisodeId: string; role: LeaderRole; lifecycleState: LifecycleState; tradingDay: string; active: boolean }
export interface LeaderUpdateResult {
  state: LeaderStateMap
  transitions: LeaderTransition[]
  roleChanges: LeaderRoleChange[]
  evicted: number
  evictions: LeaderEviction[]
}

/** ET trading day for a timestamp (mirrors execution/store.etDayKey, kept dep-free here). */
export function etDay(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
}

// Per-symbol observable view assembled from snapshot.discovery (+ the ranked row for momentum/offHigh).
interface SymbolView {
  symbol: string; changePct: number; sources: string[]; sourceRanks: Record<string, number>
  pre60Rank: number | null; survived60: boolean; pre30Rank: number | null; survived30: boolean; routeRank: number | null
  legacyTop15Rank: number | null; offHighPct: number | null; rvol: number | null; volume: number | null; float: number | null
}

function buildViews(snap: SweepSnapshot): SymbolView[] {
  const rowBySym = new Map<string, RankedRow>(snap.rawDiscovery.map(r => [r.symbol, r]))
  const legacyRank = new Map<string, number>()
  snap.monitoredSymbols.forEach((s, i) => legacyRank.set(s, i + 1))
  return snap.discovery.map(d => {
    const row = rowBySym.get(d.symbol)
    return {
      symbol: d.symbol, changePct: d.changePct,
      sources: d.sources.map(s => s.source), sourceRanks: Object.fromEntries(d.sources.map(s => [s.source, s.rank])),
      pre60Rank: d.pre60Rank, survived60: d.survived60, pre30Rank: d.pre30Rank, survived30: d.survived30, routeRank: d.routeRank,
      legacyTop15Rank: legacyRank.get(d.symbol) ?? null,
      offHighPct: row?.offHighPct ?? null, rvol: row?.relativeVolume ?? null, volume: row?.volume ?? null, float: row?.float ?? null,
    }
  })
}

const minRank = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.min(a, b)

function classifyLifecycle(rec: LeaderStateRecord, cfg: LeaderStateConfig): { state: LifecycleState; reason: string } {
  // ABSENT branch first (presence handled by caller for present symbols).
  if (!rec.presentThisSweep) {
    if (rec.consecutiveSweepsAbsent >= cfg.expireAbsentSweeps) return { state: 'EXPIRED', reason: 'absent_expire' }
    if (rec.consecutiveSweepsAbsent >= cfg.staleAbsentSweeps) return { state: 'STALE', reason: 'absent_stale' }
    return { state: rec.lifecycleState === 'EXPIRED' ? 'EXPIRED' : rec.lifecycleState, reason: 'absent_hold' }
  }
  const confirmed = rec.peakObservedChangePct >= cfg.confirmMinChangePct || rec.timesTop30 >= cfg.confirmTimesTop30
  const candidate = rec.peakObservedChangePct >= cfg.candidateMinChangePct || rec.timesTop30 >= 1
  if (confirmed) {
    // coarse RESETTING / REEXPANDING from available data only (offHigh present for top-30 names)
    if (rec.currentChangePct >= rec.peakObservedChangePct && (rec.priorLifecycleState === 'RESETTING' || rec.lifecycleState === 'RESETTING'))
      return { state: 'REEXPANDING', reason: 'confirmed_new_peak_after_reset' }
    if (rec.currentOffHighPct != null && rec.currentOffHighPct < cfg.resettingOffHighPct)
      return { state: 'RESETTING', reason: 'confirmed_off_high' }
    return { state: 'LEADER_CONFIRMED', reason: 'confirmed' }
  }
  if (candidate) return { state: 'LEADER_CANDIDATE', reason: 'candidate' }
  return { state: 'DISCOVERED', reason: 'discovered' }
}

function classifyRole(state: LifecycleState): LeaderRole {
  // SHADOW ONLY. CORE is never permanent: EXPIRED/STALE drop the role.
  if (state === 'LEADER_CONFIRMED' || state === 'RESETTING' || state === 'REEXPANDING') return 'CORE'
  if (state === 'LEADER_CANDIDATE') return 'CHALLENGER'
  return 'NONE'   // DISCOVERED / STALE / EXPIRED
}

let episodeSeq = 0
function newEpisodeId(symbol: string, day: string, now: number): string {
  return `led-${symbol}-${day}-${now}-${++episodeSeq}`
}

/**
 * PURE observational update. Returns a NEW state map (input not mutated), plus the transitions
 * and role changes to emit. `historyCompleteDefault` is false when the caller loaded degraded/
 * fresh state (so new episodes are marked historyComplete=false — research must know).
 */
export function updateLeaderState(
  prev: LeaderStateMap, snap: SweepSnapshot, cfg: LeaderStateConfig, now: number, historyCompleteDefault = true,
): LeaderUpdateResult {
  const state: LeaderStateMap = {}
  for (const [k, v] of Object.entries(prev)) state[k] = { ...v, presentThisSweep: false }  // copy; mark all absent
  const iso = new Date(now).toISOString(); const day = etDay(now)
  const views = buildViews(snap)
  const transitions: LeaderTransition[] = []; const roleChanges: LeaderRoleChange[] = []
  const seen = new Set<string>()

  for (const v of views) {
    seen.add(v.symbol)
    let rec = state[v.symbol]
    const rolledDay = rec && rec.tradingDay !== day
    const fromExpired = rec && rec.lifecycleState === 'EXPIRED'
    if (!rec || rolledDay || fromExpired) {
      // NEW EPISODE (first sighting, expiry+re-entry, or a new ET day — never mix day-change across days)
      const reappear = rec ? rec.reappearanceCount + (fromExpired || rolledDay ? 1 : 0) : 0
      const epId = newEpisodeId(v.symbol, day, now)
      const prevRec = rec
      rec = {
        symbol: v.symbol, leaderEpisodeId: epId, tradingDay: day,
        firstSeenAt: iso, lastSeenAt: iso, firstSeenSweepId: snap.sweepId, lastSeenSweepId: snap.sweepId,
        firstEverSeenAt: prevRec?.firstEverSeenAt ?? iso, episodeCount: (prevRec?.episodeCount ?? 0) + 1,
        sourcesEverSeen: [...v.sources], currentSources: [...v.sources],
        bestSourceRank: v.sources.length ? Math.min(...Object.values(v.sourceRanks)) : null, currentSourceRanks: { ...v.sourceRanks },
        bestPre60Rank: v.pre60Rank, bestPre30Rank: v.pre30Rank, bestRouteRank: v.routeRank, bestLegacyTop15Rank: v.legacyTop15Rank,
        firstTop60At: v.survived60 ? iso : null, firstTop30At: v.survived30 ? iso : null, firstLegacyTop15At: v.legacyTop15Rank != null ? iso : null,
        timesTop60: v.survived60 ? 1 : 0, timesTop30: v.survived30 ? 1 : 0, timesLegacyTop15: v.legacyTop15Rank != null ? 1 : 0,
        firstObservedChangePct: v.changePct, currentChangePct: v.changePct, peakObservedChangePct: v.changePct, peakObservedAt: iso,
        currentOffHighPct: v.offHighPct, peakRvol: v.rvol, currentVolume: v.volume, currentFloat: v.float,
        presentThisSweep: true, consecutiveSweepsSeen: 1, consecutiveSweepsAbsent: 0,
        lastPresentAt: iso, lastAbsentAt: prevRec?.lastAbsentAt ?? null, reappearanceCount: reappear,
        lifecycleState: 'DISCOVERED', lifecycleEnteredAt: iso, priorLifecycleState: null, transitionReason: 'first_sighting', transitionSweepId: snap.sweepId,
        role: 'NONE', roleEnteredAt: iso, priorRole: null, roleRuleVersion: cfg.ruleVersion,
        historyComplete: prevRec ? prevRec.historyComplete : historyCompleteDefault,
      }
      transitions.push({ symbol: v.symbol, leaderEpisodeId: epId, priorState: prevRec?.lifecycleState ?? null, newState: 'DISCOVERED', reason: rolledDay ? 'new_day_episode' : fromExpired ? 'reappear_after_expiry' : 'first_sighting' })
    } else {
      // CONTINUE episode
      rec.lastSeenAt = iso; rec.lastSeenSweepId = snap.sweepId
      rec.presentThisSweep = true; rec.consecutiveSweepsSeen += 1; rec.consecutiveSweepsAbsent = 0; rec.lastPresentAt = iso
      for (const s of v.sources) if (!rec.sourcesEverSeen.includes(s)) rec.sourcesEverSeen.push(s)
      rec.currentSources = [...v.sources]; rec.currentSourceRanks = { ...v.sourceRanks }
      if (v.sources.length) rec.bestSourceRank = minRank(rec.bestSourceRank, Math.min(...Object.values(v.sourceRanks)))
      rec.bestPre60Rank = minRank(rec.bestPre60Rank, v.pre60Rank); rec.bestPre30Rank = minRank(rec.bestPre30Rank, v.pre30Rank)
      rec.bestRouteRank = minRank(rec.bestRouteRank, v.routeRank); rec.bestLegacyTop15Rank = minRank(rec.bestLegacyTop15Rank, v.legacyTop15Rank)
      if (v.survived60) { rec.timesTop60 += 1; rec.firstTop60At = rec.firstTop60At ?? iso }
      if (v.survived30) { rec.timesTop30 += 1; rec.firstTop30At = rec.firstTop30At ?? iso }
      if (v.legacyTop15Rank != null) { rec.timesLegacyTop15 += 1; rec.firstLegacyTop15At = rec.firstLegacyTop15At ?? iso }
      rec.currentChangePct = v.changePct
      if (v.changePct > rec.peakObservedChangePct) { rec.peakObservedChangePct = v.changePct; rec.peakObservedAt = iso }
      rec.currentOffHighPct = v.offHighPct; if (v.rvol != null) rec.peakRvol = rec.peakRvol == null ? v.rvol : Math.max(rec.peakRvol, v.rvol)
      rec.currentVolume = v.volume; rec.currentFloat = v.float
    }
    applyLifecycleAndRole(rec, cfg, iso, snap.sweepId, transitions, roleChanges)
    state[v.symbol] = rec
  }

  // ABSENT symbols: increment absence, roll STALE/EXPIRED.
  for (const [sym, rec] of Object.entries(state)) {
    if (seen.has(sym)) continue
    rec.presentThisSweep = false; rec.consecutiveSweepsSeen = 0; rec.consecutiveSweepsAbsent += 1; rec.lastAbsentAt = iso
    applyLifecycleAndRole(rec, cfg, iso, snap.sweepId, transitions, roleChanges)
  }

  const evictions = evictOverCap(state, cfg.maxRecords)
  return { state, transitions, roleChanges, evicted: evictions.length, evictions }
}

function applyLifecycleAndRole(
  rec: LeaderStateRecord, cfg: LeaderStateConfig, iso: string, sweepId: string,
  transitions: LeaderTransition[], roleChanges: LeaderRoleChange[],
): void {
  const { state: newState, reason } = classifyLifecycle(rec, cfg)
  if (newState !== rec.lifecycleState) {
    transitions.push({ symbol: rec.symbol, leaderEpisodeId: rec.leaderEpisodeId, priorState: rec.lifecycleState, newState, reason })
    rec.priorLifecycleState = rec.lifecycleState; rec.lifecycleState = newState
    rec.lifecycleEnteredAt = iso; rec.transitionReason = reason; rec.transitionSweepId = sweepId
  }
  const newRole = classifyRole(rec.lifecycleState)
  if (newRole !== rec.role) {
    roleChanges.push({ symbol: rec.symbol, leaderEpisodeId: rec.leaderEpisodeId, priorRole: rec.role, newRole })
    rec.priorRole = rec.role; rec.role = newRole; rec.roleEnteredAt = iso; rec.roleRuleVersion = cfg.ruleVersion
  }
}

// Eviction PRIORITY (lowest value first): EXPIRED → role NONE (DISCOVERED/STALE) → CHALLENGER → CORE.
// Active CORE/CHALLENGER are evicted LAST and only under hard capacity pressure where nothing cheaper
// remains — the caller then emits leader_state_evicted and degrades completeness.
function evictionTier(rec: LeaderStateRecord): number {
  if (rec.lifecycleState === 'EXPIRED') return 0
  if (rec.role === 'NONE') return 1
  if (rec.role === 'CHALLENGER') return 2
  return 3   // CORE — protect longest
}
/** Memory bound: evict by tier, then oldest lastSeen, until at/under cap. Returns evicted records (auditable). */
function evictOverCap(state: LeaderStateMap, maxRecords: number): LeaderEviction[] {
  const keys = Object.keys(state)
  if (keys.length <= maxRecords) return []
  const ranked = keys.sort((a, b) => {
    const ta = evictionTier(state[a]), tb = evictionTier(state[b])
    if (ta !== tb) return ta - tb
    return Date.parse(state[a].lastSeenAt) - Date.parse(state[b].lastSeenAt)   // oldest first within tier
  })
  const evictions: LeaderEviction[] = []
  for (const k of ranked) {
    if (Object.keys(state).length <= maxRecords) break
    const r = state[k]
    evictions.push({ symbol: r.symbol, leaderEpisodeId: r.leaderEpisodeId, role: r.role, lifecycleState: r.lifecycleState, tradingDay: r.tradingDay, active: r.lifecycleState !== 'EXPIRED' })
    delete state[k]
  }
  return evictions
}
