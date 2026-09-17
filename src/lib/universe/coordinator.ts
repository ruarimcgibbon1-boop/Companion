/**
 * H3B — UniverseCoordinator: the single daemon-side owner of the canonical monitored
 * universe and the per-sweep SweepSnapshot.
 *
 * OWNERSHIP (H3B, compatibility mode). Changes WHERE the daemon-side universe truth is owned,
 * not WHAT BASE receives. The coordinator:
 *   - obtains a daemon-only universe ENVELOPE (ranked rows + full pre-trigger discovery provenance)
 *     via an INJECTED fetcher = the existing /api/gainers call (provider path + cache scope UNCHANGED;
 *     H3B adds ZERO provider requests),
 *   - applies the frozen daemon selection (selectMonitoredUniverse),
 *   - assembles a DEEP-frozen SweepSnapshot carrying the COMPLETE universe truth so H3C's
 *     leader-state observation can see every stage live (raw sources → merge → filters → 60-pool →
 *     top60 → 30-route → top30 → daemon top15) without re-reading the JSONL audit file.
 *
 * NON-GOALS (deferred): CORE/CHALLENGERS policy, leader state, in-process provider consolidation.
 */
import { selectMonitoredUniverse, DEFAULT_MONITORED_CAP, type RankedRow } from './pipeline'
import type { DiscoverySymbolProv } from './discovery-provenance'

export type UniversePolicy = 'LEGACY_COMPAT'   // future: 'CORE_CHALLENGERS' (no effect until a policy phase)

export interface SweepContextIn {
  sweepId: string
  runId: string | null
  producerHead: string | null
  session: string
}

/** The daemon-only response envelope: rows + the full pre-trigger provenance. */
export interface UniverseEnvelope {
  rows: RankedRow[]
  discovery: DiscoverySymbolProv[]
}

/** Immutable canonical snapshot for one sweep. Deep-frozen — consumers cannot mutate shared truth. */
export interface SweepSnapshot {
  readonly sweepId: string
  readonly runId: string | null
  readonly asOfUtc: string
  readonly session: string
  readonly producerHead: string | null
  readonly schemaVersion: number
  readonly policy: UniversePolicy
  /** Route ranked rows (≤30) = route-equivalent top-30. */
  readonly rawDiscovery: readonly Readonly<RankedRow>[]
  readonly routeEquivalentTop30: readonly Readonly<RankedRow>[]
  /** COMPLETE pre-trigger universe truth: every discovered symbol with all-source presence, merge
   *  winner, exact exclusion reason, and 60/30 pre-truncation ranks. THIS is what makes the snapshot
   *  sufficient for H3C to observe a symbol before the top-30 truncation. */
  readonly discovery: readonly Readonly<DiscoverySymbolProv>[]
  /** Monitored universe after the daemon-equivalent re-sort + top-cap. */
  readonly monitoredUniverse: readonly Readonly<RankedRow>[]
  readonly monitoredSymbols: readonly string[]
  readonly universeSizeBefore: number
  readonly universeSizeAfter: number
}

export const SWEEP_SNAPSHOT_SCHEMA_VERSION = 1

export interface UniverseCoordinatorDeps {
  /** Fetch the daemon-only universe envelope. Injected so the provider path is unchanged and tests
   *  can supply frozen fixtures. */
  fetchUniverse: (ctx: SweepContextIn) => Promise<UniverseEnvelope>
  monitoredCap?: number
  now?: () => number
}

/** Bounded deep-freeze: freeze each row/discovery object and its nested arrays. Snapshot holds ≤30
 *  rows + ≤~200 discovery entries, so this is O(few hundred) tiny freezes per sweep (measured sub-ms). */
function freezeRow<T extends object>(r: T): Readonly<T> { return Object.freeze(r) }
function freezeDiscovery(d: DiscoverySymbolProv): Readonly<DiscoverySymbolProv> {
  Object.freeze(d.sources)                 // the nested SourceObservation[]
  d.sources.forEach(s => Object.freeze(s))
  return Object.freeze(d)
}

export class UniverseCoordinator {
  constructor(private readonly deps: UniverseCoordinatorDeps) {}

  async buildSweep(ctx: SweepContextIn, policy: UniversePolicy = 'LEGACY_COMPAT'): Promise<SweepSnapshot> {
    return this.assemble(ctx, await this.deps.fetchUniverse(ctx), policy)
  }

  /** Pure assembly from an already-fetched envelope — used by buildSweep and the parity harness. */
  assemble(ctx: SweepContextIn, env: UniverseEnvelope, policy: UniversePolicy = 'LEGACY_COMPAT'): SweepSnapshot {
    const cap = this.deps.monitoredCap ?? DEFAULT_MONITORED_CAP
    const rows = env.rows
    const discovery = env.discovery ?? []
    const { monitored, symbols } = selectMonitoredUniverse(rows, cap)
    const now = (this.deps.now ?? Date.now)()
    // Deep-freeze every shared object so one consumer cannot mutate what another sees.
    rows.forEach(freezeRow); monitored.forEach(freezeRow); discovery.forEach(freezeDiscovery)
    const snap: SweepSnapshot = {
      sweepId: ctx.sweepId, runId: ctx.runId, asOfUtc: new Date(now).toISOString(),
      session: ctx.session, producerHead: ctx.producerHead, schemaVersion: SWEEP_SNAPSHOT_SCHEMA_VERSION,
      policy,
      rawDiscovery: rows, routeEquivalentTop30: rows, discovery,
      monitoredUniverse: monitored, monitoredSymbols: symbols,
      universeSizeBefore: rows.length, universeSizeAfter: monitored.length,
    }
    Object.freeze(snap.rawDiscovery); Object.freeze(snap.monitoredUniverse)
    Object.freeze(snap.monitoredSymbols); Object.freeze(snap.discovery)
    return Object.freeze(snap)
  }
}
