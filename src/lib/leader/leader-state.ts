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

export interface LeaderTransition { symbol: string; leaderEpisodeId: string; priorState: LifecycleState | null; newState: LifecycleState; reason: string }
export interface LeaderRoleChange { symbol: string; leaderEpisodeId: string; priorRole: LeaderRole; newRole: LeaderRole }
export interface LeaderUpdateResult {
  state: LeaderStateMap
  transitions: LeaderTransition[]
  roleChanges: LeaderRoleChange[]
  evicted: number
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

function classifyRole(state: LifecycleState, cfg: LeaderStateConfig): LeaderRole {
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

  const evicted = evictOverCap(state, cfg.maxRecords)
  return { state, transitions, roleChanges, evicted }
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
  const newRole = classifyRole(rec.lifecycleState, cfg)
  if (newRole !== rec.role) {
    roleChanges.push({ symbol: rec.symbol, leaderEpisodeId: rec.leaderEpisodeId, priorRole: rec.role, newRole })
    rec.priorRole = rec.role; rec.role = newRole; rec.roleEnteredAt = iso; rec.roleRuleVersion = cfg.ruleVersion
  }
}

/** Memory bound: evict EXPIRED first, then oldest lastSeen, until at/under cap. Returns evicted count. */
function evictOverCap(state: LeaderStateMap, maxRecords: number): number {
  const keys = Object.keys(state)
  if (keys.length <= maxRecords) return 0
  const ranked = keys.sort((a, b) => {
    const ea = state[a].lifecycleState === 'EXPIRED' ? 0 : 1, eb = state[b].lifecycleState === 'EXPIRED' ? 0 : 1
    if (ea !== eb) return ea - eb
    return Date.parse(state[a].lastSeenAt) - Date.parse(state[b].lastSeenAt)   // oldest first
  })
  let evicted = 0
  for (const k of ranked) { if (Object.keys(state).length <= maxRecords) break; delete state[k]; evicted++ }
  return evicted
}
