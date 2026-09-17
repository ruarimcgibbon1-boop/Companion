/**
 * H3B — UniverseCoordinator: the single daemon-side owner of the canonical monitored
 * universe and the per-sweep SweepSnapshot.
 *
 * OWNERSHIP (H3B, compatibility mode). H3B changes WHERE the daemon-side universe truth is
 * owned, not WHAT BASE receives. The coordinator:
 *   - obtains the route's ranked rows via an INJECTED fetcher (the existing /api/gainers call —
 *     provider path and cache scope UNCHANGED; H3B adds ZERO provider requests), and
 *   - applies the frozen daemon selection (selectMonitoredUniverse) to produce the monitored set,
 *   - assembles an immutable-by-convention SweepSnapshot that every daemon consumer reads.
 *
 * NON-GOALS (deferred): CORE/CHALLENGERS policy, leader state, in-process provider consolidation
 * (that would change cache scope / provider request count — forbidden in H3B, see Step 9). The
 * `policy` field is a placeholder; only LEGACY_COMPAT exists and it reproduces legacy output exactly.
 */
import { selectMonitoredUniverse, DEFAULT_MONITORED_CAP, type RankedRow } from './pipeline'

export type UniversePolicy = 'LEGACY_COMPAT'   // future: 'CORE_CHALLENGERS' (no effect until a policy phase)

export interface SweepContextIn {
  sweepId: string
  runId: string | null
  producerHead: string | null
  session: string
}

/** Immutable-by-convention canonical snapshot for one sweep. Consumers MUST NOT mutate it. */
export interface SweepSnapshot {
  readonly sweepId: string
  readonly runId: string | null
  readonly asOfUtc: string
  readonly session: string
  readonly producerHead: string | null
  readonly schemaVersion: number
  readonly policy: UniversePolicy
  /** The route's ranked rows (≤30). Route-equivalent top-30 = the discovery/rank truth we received. */
  readonly rawDiscovery: readonly RankedRow[]
  readonly routeEquivalentTop30: readonly RankedRow[]
  /** Monitored universe after the daemon-equivalent re-sort + top-cap. */
  readonly monitoredUniverse: readonly RankedRow[]
  readonly monitoredSymbols: readonly string[]
  readonly universeSizeBefore: number   // rows received (route top-30)
  readonly universeSizeAfter: number    // monitored (top-cap)
}

/** Schema version of the SweepSnapshot shape (independent of the funnel event schema). */
export const SWEEP_SNAPSHOT_SCHEMA_VERSION = 1

export interface UniverseCoordinatorDeps {
  /** Fetch the route's ranked rows for this sweep. Injected so the provider path is unchanged
   *  and so tests can supply frozen fixtures. */
  fetchRankedRows: (ctx: SweepContextIn) => Promise<RankedRow[]>
  monitoredCap?: number
  now?: () => number
}

export class UniverseCoordinator {
  constructor(private readonly deps: UniverseCoordinatorDeps) {}

  async buildSweep(ctx: SweepContextIn, policy: UniversePolicy = 'LEGACY_COMPAT'): Promise<SweepSnapshot> {
    const rows = await this.deps.fetchRankedRows(ctx)
    return this.assemble(ctx, rows, policy)
  }

  /** Pure assembly from already-fetched rows — used by buildSweep and by the parity harness. */
  assemble(ctx: SweepContextIn, rows: RankedRow[], policy: UniversePolicy = 'LEGACY_COMPAT'): SweepSnapshot {
    const cap = this.deps.monitoredCap ?? DEFAULT_MONITORED_CAP
    const { monitored, symbols } = selectMonitoredUniverse(rows, cap)
    const now = (this.deps.now ?? Date.now)()
    const snap: SweepSnapshot = {
      sweepId: ctx.sweepId, runId: ctx.runId, asOfUtc: new Date(now).toISOString(),
      session: ctx.session, producerHead: ctx.producerHead, schemaVersion: SWEEP_SNAPSHOT_SCHEMA_VERSION,
      policy,
      rawDiscovery: rows, routeEquivalentTop30: rows,
      monitoredUniverse: monitored, monitoredSymbols: symbols,
      universeSizeBefore: rows.length, universeSizeAfter: monitored.length,
    }
    // Immutable-by-convention: freeze the top level + arrays so an accidental consumer mutation throws in dev.
    Object.freeze(snap.rawDiscovery); Object.freeze(snap.monitoredUniverse); Object.freeze(snap.monitoredSymbols)
    return Object.freeze(snap)
  }
}
