/**
 * H4A.1 — bounded OBSERVATIONAL leader cohort selection (pure core).
 *
 * Selects a bounded set of persistent H3C leaders to keep FRESH MARKET DATA for,
 * so that H4B can later study the fallen-but-fresh leader population H1/H1.1 motivated.
 *
 * This is a DATA-COVERAGE policy ONLY. Membership is derived exclusively from H3C
 * PERSISTENT FACTS (role / lifecycle / rank / strength history) and is INDEPENDENT of
 * any H4A local-feature outcome — using baseDetected / reExpansionObserved / localExtensionPct
 * to pick the cohort would create circular feature-availability bias, so it is forbidden here.
 *
 * NON-NEGOTIABLE: cohort members are OBSERVATIONAL. They receive shared monitor data and
 * nothing else. They NEVER enter detectSetups, BASE scoring, decision logging as BASE
 * candidates, arbitration, position sizing, risk, orders, or the PaperExecutor. The daemon
 * excludes them from `snapshot.monitoredSymbols` and from the BASE result set.
 *
 * All thresholds are PROVISIONAL, config-driven, and fingerprinted (leaderObservationConfigHash).
 * They are OBSERVATIONAL CAPACITY policy, NOT trading logic, and NOT a claim about the final
 * optimal CORE policy.
 */
import type { LeaderStateMap, LeaderStateRecord, LeaderRole, LifecycleState } from './leader-state'

// ── Config ───────────────────────────────────────────────────────────────────
export interface LeaderObservationConfig {
  version: string
  /** Hard cap on ADDITIONAL observational symbols beyond the BASE monitored set. */
  maxSymbols: number
  /** Whether CHALLENGER (not just CORE) leaders are eligible. CORE is always eligible. */
  includeChallengers: boolean
  /** Grace: a role-NONE record that recently held CORE-tier strength stays eligible for
   *  this many absent sweeps (keeps a temporarily fallen leader fresh across a short gap). */
  recentlyCoreGraceSweeps: number
  /** A role-NONE record qualifies for the recently-CORE grace only if it EARNED CORE-tier
   *  strength — peak day-change ≥ this OR times-top30 ≥ recentlyCoreMinTimesTop30 (persistent facts). */
  recentlyCoreMinPeakChangePct: number
  recentlyCoreMinTimesTop30: number
}

export const DEFAULT_LEADER_OBSERVATION_CONFIG: LeaderObservationConfig = {
  version: 'h4a1-provisional-1',
  // Provisional, conservative. H3C role holders (CORE requires peak ≥50% or ≥2× top30;
  // CHALLENGER ≥30% or 1× top30) are few in a typical session, and each cold cohort symbol
  // adds bounded provider load (see the H4A.1 report). 8 keeps the shared batch (top15 + cohort)
  // well under buildMonitorBatch's hard 40-symbol ceiling. NOT asserted optimal.
  maxSymbols: 8,
  includeChallengers: true,
  recentlyCoreGraceSweeps: 10,
  recentlyCoreMinPeakChangePct: 50,   // mirrors H3C confirmMinChangePct (CORE-tier strength)
  recentlyCoreMinTimesTop30: 2,       // mirrors H3C confirmTimesTop30
}

const numEnv = (v: string | undefined, d: number): number => {
  if (v == null || v.trim() === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const boolEnv = (v: string | undefined, d: boolean): boolean => {
  if (v == null || v.trim() === '') return d
  const s = v.trim().toLowerCase()
  if (s === '1' || s === 'true' || s === 'yes') return true
  if (s === '0' || s === 'false' || s === 'no') return false
  return d
}

/** Observational-only env overrides. These tune DATA COVERAGE, never trading. */
export function resolveLeaderObservationConfig(
  env: Record<string, string | undefined> = process.env,
): LeaderObservationConfig {
  const d = DEFAULT_LEADER_OBSERVATION_CONFIG
  return {
    version: env.COMPANION_LEADER_OBS_VERSION?.trim() || d.version,
    maxSymbols: Math.max(0, Math.floor(numEnv(env.COMPANION_LEADER_OBS_MAX, d.maxSymbols))),
    includeChallengers: boolEnv(env.COMPANION_LEADER_OBS_INCLUDE_CHALLENGERS, d.includeChallengers),
    recentlyCoreGraceSweeps: numEnv(env.COMPANION_LEADER_OBS_GRACE_SWEEPS, d.recentlyCoreGraceSweeps),
    recentlyCoreMinPeakChangePct: numEnv(env.COMPANION_LEADER_OBS_GRACE_MIN_PEAK, d.recentlyCoreMinPeakChangePct),
    recentlyCoreMinTimesTop30: numEnv(env.COMPANION_LEADER_OBS_GRACE_MIN_TOP30, d.recentlyCoreMinTimesTop30),
  }
}

/** Canonical, order-stable serialization of every behavior-affecting cohort value. */
export function leaderObservationConfigCanonical(c: LeaderObservationConfig): string {
  return [
    'h4a1',
    `v=${c.version}`,
    `max=${c.maxSymbols}`,
    `chal=${c.includeChallengers ? 1 : 0}`,
    `grace=${c.recentlyCoreGraceSweeps}`,
    `gpeak=${c.recentlyCoreMinPeakChangePct}`,
    `gt30=${c.recentlyCoreMinTimesTop30}`,
  ].join('|')
}

/** Deterministic 8-hex fingerprint (FNV-1a, dep-free). Same config → same hash; any change → different. */
export function leaderObservationConfigHash(c: LeaderObservationConfig): string {
  const s = leaderObservationConfigCanonical(c)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ── Selection ──────────────────────────────────────────────────────────────────
export type CohortReason =
  | 'CORE_PRESENT'          // role CORE, present in this sweep's discovery but outside top15
  | 'CORE_FALLEN'           // role CORE, absent from this sweep's discovery (temporarily fallen)
  | 'CHALLENGER_PRESENT'
  | 'CHALLENGER_FALLEN'
  | 'RECENTLY_CORE_GRACE'   // role NONE (STALE) but recently held CORE-tier strength, within grace

export type CohortExclusionReason =
  | 'IN_BASE'               // already covered by the BASE monitored set (deduplicated)
  | 'OPERATIONAL'           // already monitored operationally (e.g. an open broker position)
  | 'EXPIRED'               // lifecycle EXPIRED
  | 'STALE_BEYOND_GRACE'    // role NONE and past the observational grace window
  | 'ROLE_NONE'             // no leader role and not grace-eligible
  | 'CHALLENGER_DISABLED'   // CHALLENGER eligibility off by config

export interface CohortMember {
  symbol: string
  leaderEpisodeId: string
  role: LeaderRole
  lifecycleState: LifecycleState
  presentThisSweep: boolean
  reason: CohortReason
  /** Priority inputs — all already-recorded H3C persistent facts (no future outcomes, no H4A features). */
  priority: {
    roleTier: number              // 0 CORE, 1 CHALLENGER, 2 recently-core grace (lower = higher priority)
    presentTier: number           // 0 present, 1 absent
    consecutiveSweepsAbsent: number
    bestRouteRank: number | null
    timesTop30: number
    peakObservedChangePct: number
  }
}

export interface CohortSelection {
  configVersion: string
  configHash: string
  cap: number
  eligibleCount: number
  selectedCount: number
  excludedByCapCount: number
  /** Selected cohort, in deterministic priority order (highest priority first). */
  selected: CohortMember[]
  /** Eligible but dropped by the hard cap (deterministic order), for auditability. */
  excludedByCap: CohortMember[]
}

const roleTier = (reason: CohortReason): number =>
  reason.startsWith('CORE') ? 0 : reason.startsWith('CHALLENGER') ? 1 : 2

/**
 * Determine cohort eligibility for one record using ONLY H3C persistent facts.
 * Returns the reason if eligible, or null. EXPIRED / role-NONE-beyond-grace are ineligible.
 */
function eligibility(rec: LeaderStateRecord, cfg: LeaderObservationConfig): CohortReason | null {
  if (rec.lifecycleState === 'EXPIRED') return null
  if (rec.role === 'CORE') return rec.presentThisSweep ? 'CORE_PRESENT' : 'CORE_FALLEN'
  if (rec.role === 'CHALLENGER') {
    if (!cfg.includeChallengers) return null
    return rec.presentThisSweep ? 'CHALLENGER_PRESENT' : 'CHALLENGER_FALLEN'
  }
  // role NONE: recently-CORE grace — earned CORE-tier strength and only just fell out of a role.
  const earnedCoreTier =
    rec.priorRole === 'CORE' ||
    rec.peakObservedChangePct >= cfg.recentlyCoreMinPeakChangePct ||
    rec.timesTop30 >= cfg.recentlyCoreMinTimesTop30
  if (earnedCoreTier && rec.consecutiveSweepsAbsent <= cfg.recentlyCoreGraceSweeps) return 'RECENTLY_CORE_GRACE'
  return null
}

function toMember(rec: LeaderStateRecord, reason: CohortReason): CohortMember {
  return {
    symbol: rec.symbol,
    leaderEpisodeId: rec.leaderEpisodeId,
    role: rec.role,
    lifecycleState: rec.lifecycleState,
    presentThisSweep: rec.presentThisSweep,
    reason,
    priority: {
      roleTier: roleTier(reason),
      presentTier: rec.presentThisSweep ? 0 : 1,
      consecutiveSweepsAbsent: rec.consecutiveSweepsAbsent,
      bestRouteRank: rec.bestRouteRank,
      timesTop30: rec.timesTop30,
      peakObservedChangePct: rec.peakObservedChangePct,
    },
  }
}

/**
 * Deterministic, strategy-neutral priority (lower sorts first = selected first):
 *   1. role tier            CORE < CHALLENGER < recently-core grace
 *   2. presence             present < absent (a leader still on the tape is the freshest study target)
 *   3. recency of presence  fewer consecutive absent sweeps first
 *   4. recent rank strength smaller bestRouteRank first (nulls last)
 *   5. persistence          more times-top30 first
 *   6. leader strength      higher peak day-change first
 *   7. symbol               alphabetical (final deterministic tiebreak)
 * Every key is an already-recorded H3C fact; none uses a future outcome or any H4A feature.
 */
function comparePriority(a: CohortMember, b: CohortMember): number {
  const p = a.priority, q = b.priority
  if (p.roleTier !== q.roleTier) return p.roleTier - q.roleTier
  if (p.presentTier !== q.presentTier) return p.presentTier - q.presentTier
  if (p.consecutiveSweepsAbsent !== q.consecutiveSweepsAbsent) return p.consecutiveSweepsAbsent - q.consecutiveSweepsAbsent
  const ar = p.bestRouteRank ?? Number.POSITIVE_INFINITY
  const br = q.bestRouteRank ?? Number.POSITIVE_INFINITY
  if (ar !== br) return ar - br
  if (p.timesTop30 !== q.timesTop30) return q.timesTop30 - p.timesTop30
  if (p.peakObservedChangePct !== q.peakObservedChangePct) return q.peakObservedChangePct - p.peakObservedChangePct
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0
}

/**
 * Select the bounded observational leader cohort.
 *
 * @param leaderState  the current (post-update) H3C leader state map
 * @param baseSymbols  the BASE monitored set (top15) — always EXCLUDED (deduplicated)
 * @param cfg          observational capacity policy
 * @param opts.excludeSymbols  symbols already monitored operationally (e.g. open broker positions)
 */
export function selectLeaderObservationCohort(
  leaderState: LeaderStateMap,
  baseSymbols: readonly string[],
  cfg: LeaderObservationConfig,
  opts: { excludeSymbols?: Iterable<string> } = {},
): CohortSelection {
  const baseSet = new Set(baseSymbols.map(s => s.toUpperCase()))
  const opSet = new Set([...(opts.excludeSymbols ?? [])].map(s => s.toUpperCase()))
  const configHash = leaderObservationConfigHash(cfg)

  const eligible: CohortMember[] = []
  for (const rec of Object.values(leaderState)) {
    const sym = rec.symbol.toUpperCase()
    if (baseSet.has(sym)) continue      // deduplicated against BASE — never double-counted or double-fetched
    if (opSet.has(sym)) continue        // already covered by operational handling
    const reason = eligibility(rec, cfg)
    if (reason === null) continue
    eligible.push(toMember(rec, reason))
  }
  eligible.sort(comparePriority)

  const cap = Math.max(0, Math.floor(cfg.maxSymbols))
  const selected = eligible.slice(0, cap)
  const excludedByCap = eligible.slice(cap)

  return {
    configVersion: cfg.version,
    configHash,
    cap,
    eligibleCount: eligible.length,
    selectedCount: selected.length,
    excludedByCapCount: excludedByCap.length,
    selected,
    excludedByCap,
  }
}

/**
 * Stable, deduplicated union with BASE FIRST. Guarantees base symbols are never displaced
 * or truncated by the observational tail, and that a symbol present in both appears exactly
 * once (single-flight/dedup at the request level; the cache single-flights the rest).
 */
export function stableObservationUnion(
  baseSymbols: readonly string[],
  leaderObservationSymbols: readonly string[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of baseSymbols) {
    const u = s.toUpperCase()
    if (!seen.has(u)) { seen.add(u); out.push(u) }
  }
  for (const s of leaderObservationSymbols) {
    const u = s.toUpperCase()
    if (!seen.has(u)) { seen.add(u); out.push(u) }
  }
  return out
}
