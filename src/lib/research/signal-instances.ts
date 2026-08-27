/**
 * Relevant-signal-instance enumeration — pure core for deterministic post-signal
 * tape coverage (Session-3 finding C).
 *
 * READ-ONLY / DIAGNOSTIC: enumerates which signals the review cares about so the
 * shell can acquire a 1-minute tape for each. It NEVER feeds trading, admission,
 * thresholds, or the frozen PASS/FAIL — it only defines what to fetch and reports
 * coverage denominators.
 *
 * Classes (primary, precedence high→low):
 *   replacement_candidate  the shadow REPLACEMENT_ADMISSION (also capacity-blocked)
 *   filled                 a paper trade that actually filled
 *   aborted                a paper trade that never filled (entry timeout)
 *   capacity_blocked       an entry_blocked attempt (cap/budget)
 * `offHighRemoved` annotates the DIRECT_REMOVAL instance (which is itself a filled
 * trade) without moving it out of its primary class.
 *
 * The "core" coverage set = filled ∪ aborted ∪ replacement_candidate — the review's
 * excursion denominator (2026-08-27: 10 instances / 9 unique symbols).
 */

export type InstanceClass = 'filled' | 'aborted' | 'capacity_blocked' | 'replacement_candidate'

export interface SignalInstance {
  setupId: string
  symbol: string
  primaryClass: InstanceClass
  offHighRemoved: boolean
  offHighPct: number | null
  signalTs: number | null
  blockedFor: string | null
}

export interface InstanceEnumeration {
  instances: SignalInstance[]
  /** filled ∪ aborted ∪ replacement_candidate — the review coverage denominator. */
  core: SignalInstance[]
  coreInstanceCount: number
  coreUniqueSymbols: string[]
  allUniqueSymbols: string[]
}

const symbolOf = (setupId: string): string => setupId.split(':')[0] ?? setupId

interface RawTrade { setupId?: unknown; symbol?: unknown; entryFilledAt?: unknown; entrySubmittedAt?: unknown; createdAt?: unknown }
interface RawEvent { event?: unknown; setupId?: unknown; symbol?: unknown; reason?: unknown; ts?: unknown }
interface RawDecision { setupId?: unknown; offHighPct?: unknown; ts?: unknown }

interface ShadowLike {
  reshuffle?: {
    DIRECT_REMOVAL?: { setupIds?: unknown }
    REPLACEMENT_ADMISSION?: { detail?: Array<{ setupId?: unknown; offHighPct?: unknown; blockedFor?: unknown }> }
  }
}

const capReason = (r: string): string =>
  /premarket/.test(r) ? 'premarket' : /concurrent/.test(r) ? 'concurrent' : /trades\/day|per day|\/day/.test(r) ? 'day' : 'other'

export function enumerateInstances(input: {
  trades: RawTrade[]
  events: RawEvent[]
  shadow: ShadowLike
  decisions?: RawDecision[]
}): InstanceEnumeration {
  const { trades, events, shadow, decisions = [] } = input

  // offHighPct / first signal ts by setupId, from the decisions log.
  const decInfo = new Map<string, { offHighPct: number | null; ts: number | null }>()
  for (const d of decisions) {
    const id = String(d.setupId ?? '')
    if (!id || decInfo.has(id)) continue
    const ts = typeof d.ts === 'string' ? Date.parse(d.ts) : (typeof d.ts === 'number' ? d.ts : null)
    decInfo.set(id, { offHighPct: d.offHighPct == null ? null : Number(d.offHighPct), ts: Number.isFinite(ts as number) ? (ts as number) : null })
  }

  const removedIds = new Set<string>(
    ((shadow.reshuffle?.DIRECT_REMOVAL?.setupIds as unknown[]) ?? []).map(String),
  )
  const replacementDetail = shadow.reshuffle?.REPLACEMENT_ADMISSION?.detail ?? []
  const replacementById = new Map<string, { blockedFor: string | null }>()
  for (const r of replacementDetail) {
    const id = String(r.setupId ?? '')
    if (id) replacementById.set(id, { blockedFor: r.blockedFor == null ? null : String(r.blockedFor) })
  }

  // Build instances with precedence, deduped by setupId.
  const byId = new Map<string, SignalInstance>()
  const put = (inst: SignalInstance, precedence: number) => {
    const prev = byId.get(inst.setupId)
    if (!prev || precedence > CLASS_PRECEDENCE[prev.primaryClass]) byId.set(inst.setupId, inst)
  }

  const info = (id: string) => decInfo.get(id) ?? { offHighPct: null, ts: null }

  // filled / aborted from trades
  for (const t of trades) {
    const id = String(t.setupId ?? '')
    if (!id) continue
    const sym = String(t.symbol ?? symbolOf(id))
    const filled = t.entryFilledAt != null
    const i = info(id)
    put({
      setupId: id, symbol: sym,
      primaryClass: filled ? 'filled' : 'aborted',
      offHighRemoved: removedIds.has(id),
      offHighPct: i.offHighPct, signalTs: i.ts, blockedFor: null,
    }, filled ? CLASS_PRECEDENCE.filled : CLASS_PRECEDENCE.aborted)
  }

  // capacity_blocked from events
  for (const e of events) {
    if (String(e.event ?? '') !== 'entry_blocked') continue
    const id = String(e.setupId ?? '')
    if (!id) continue
    const sym = String(e.symbol ?? symbolOf(id))
    const i = info(id)
    put({
      setupId: id, symbol: sym,
      primaryClass: 'capacity_blocked',
      offHighRemoved: removedIds.has(id),
      offHighPct: i.offHighPct, signalTs: i.ts,
      blockedFor: capReason(String(e.reason ?? '')),
    }, CLASS_PRECEDENCE.capacity_blocked)
  }

  // replacement_candidate from shadow (highest precedence)
  for (const [id, r] of replacementById) {
    const i = info(id)
    put({
      setupId: id, symbol: symbolOf(id),
      primaryClass: 'replacement_candidate',
      offHighRemoved: removedIds.has(id),
      offHighPct: i.offHighPct, signalTs: i.ts,
      blockedFor: r.blockedFor,
    }, CLASS_PRECEDENCE.replacement_candidate)
  }

  const instances = [...byId.values()].sort((a, b) => a.setupId.localeCompare(b.setupId))
  const core = instances.filter(i =>
    i.primaryClass === 'filled' || i.primaryClass === 'aborted' || i.primaryClass === 'replacement_candidate')
  const uniq = (arr: SignalInstance[]) => [...new Set(arr.map(i => i.symbol))].sort()

  return {
    instances,
    core,
    coreInstanceCount: core.length,
    coreUniqueSymbols: uniq(core),
    allUniqueSymbols: uniq(instances),
  }
}

const CLASS_PRECEDENCE: Record<InstanceClass, number> = {
  capacity_blocked: 1,
  aborted: 2,
  filled: 3,
  replacement_candidate: 4,
}
