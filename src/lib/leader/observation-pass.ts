/**
 * H4A.1 — shared monitor pass coordinator + observational refresh cadence (pure).
 *
 * RESOURCE ISOLATION (red-team RT-1/RT-2/RT-3). BASE and the observational cohort share ONE data
 * plane (one /api/monitor endpoint = one buildMonitorBatch = one cache/single-flight = one provider
 * client = one feature implementation). But observational work must not affect BASE through awaiting,
 * request capacity, provider concurrency, timeout, or cancellation. Two mechanisms enforce this:
 *
 *   1. BASE-FIRST NETWORK ACQUISITION. The observational request is launched only AFTER the BASE data
 *      request has settled — it is chained off `baseResults`, never fired alongside it. So the
 *      observational fetch can never contend with BASE for the shared network / provider throughput;
 *      it overlaps only BASE's CPU-side detector/arbitration work (which touches no providers). This
 *      is still ONE shared data plane — "one plane" does not require simultaneous acquisition.
 *
 *   2. ABORTABLE, BEST-EFFORT TAIL. The observational request carries an AbortSignal; on timeout it is
 *      aborted (the HTTP request is torn down, not merely un-awaited) and resolves []. It never rejects
 *      and BASE never awaits it. The caller keeps at most ONE observational pass in flight (see the
 *      daemon's inFlight guard) so a slow tail can never accumulate across sweeps.
 *
 * REFRESH CADENCE (RT-3/RT-6). H4A local geometry is BAR-DRIVEN, so the observational fetch is gated to
 * a 1m TIME BUCKET (not a rolling "elapsed 60s"): a refresh fires once per new 1m bar bucket, offset by
 * a conservative provider-publication lag so the just-closed bar is actually available. The daemon still
 * SELECTS the cohort every 15s sweep; only the data FETCH is bucket-gated.
 *
 * All parameters are OBSERVATIONAL, provisional, config-driven and fingerprinted. None touches BASE
 * cadence, BASE inputs, or execution.
 */
import type { MonitorResult } from '@/types'

export interface ObservationPassConfig {
  version: string
  /** 1m bar bucket size in ms. A refresh fires once per new bucket. */
  observationRefreshMs: number
  /** Offset into the bucket before a just-closed bar is considered published/available. */
  barPublicationLagMs: number
  /** Max time the caller waits for the observational tail before aborting it. The underlying request is
   *  aborted (HTTP torn down); BASE never blocks on it and a slow tail cannot stretch the sweep. */
  observationTimeoutMs: number
}

export const DEFAULT_OBSERVATION_PASS_CONFIG: ObservationPassConfig = {
  version: 'h4a1-obs-pass-2',       // v2: base-first acquisition + bar-bucket alignment + abort
  observationRefreshMs: 60_000,     // one 1m bar — H4A geometry is bar-driven (report §3/RT-3)
  barPublicationLagMs: 5_000,       // wait 5s into the new bucket so the just-closed 1m bar is published
  observationTimeoutMs: 8_000,      // < SWEEP_MS (15s); on timeout the tail is aborted, not left hanging
}

const numEnv = (v: string | undefined, d: number): number => {
  if (v == null || v.trim() === '') return d
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** Observational-only env overrides. Tune data-coverage cadence, never trading. */
export function resolveObservationPassConfig(
  env: Record<string, string | undefined> = process.env,
): ObservationPassConfig {
  const d = DEFAULT_OBSERVATION_PASS_CONFIG
  return {
    version: env.COMPANION_LEADER_OBS_PASS_VERSION?.trim() || d.version,
    observationRefreshMs: Math.max(1, Math.floor(numEnv(env.COMPANION_LEADER_OBS_REFRESH_MS, d.observationRefreshMs))),
    barPublicationLagMs: Math.max(0, Math.floor(numEnv(env.COMPANION_LEADER_OBS_BAR_LAG_MS, d.barPublicationLagMs))),
    observationTimeoutMs: Math.max(0, Math.floor(numEnv(env.COMPANION_LEADER_OBS_TIMEOUT_MS, d.observationTimeoutMs))),
  }
}

export function observationPassConfigCanonical(c: ObservationPassConfig): string {
  return ['h4a1-pass', `v=${c.version}`, `refresh=${c.observationRefreshMs}`, `lag=${c.barPublicationLagMs}`, `timeout=${c.observationTimeoutMs}`].join('|')
}

/** Deterministic 8-hex fingerprint (FNV-1a, dep-free). Same config → same hash; any change → different. */
export function observationPassConfigHash(c: ObservationPassConfig): string {
  const s = observationPassConfigCanonical(c)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The 1m bar bucket a timestamp belongs to, offset by the publication lag. Two timestamps in the same
 * lagged 60s window share a bucket — so a refresh fires at most once per 1m bar, aligned to bar
 * boundaries rather than to a rolling elapsed interval.
 */
export function observationBucket(nowMs: number, cfg: ObservationPassConfig): number {
  return Math.floor((nowMs - cfg.barPublicationLagMs) / cfg.observationRefreshMs)
}

/** Should the observational cohort be RE-FETCHED this sweep? True on the first sweep and whenever the
 *  current 1m bar bucket differs from the last one fetched. Selection is independent and runs every sweep. */
export function shouldRefreshObservation(nowMs: number, lastRefreshedBucket: number | null, cfg: ObservationPassConfig): boolean {
  if (lastRefreshedBucket === null) return true
  return observationBucket(nowMs, cfg) !== lastRefreshedBucket
}

/**
 * What to do with the observational cohort's DATA this sweep. Selection always runs; only the FETCH is
 * gated. `skip_in_flight` enforces AT-MOST-ONE outstanding pass (red-team RT-4/RT-5) so observational
 * passes can never accumulate across sweeps.
 */
export type ObservationAction = 'launch' | 'skip_in_flight' | 'off_cadence' | 'empty'
export function decideObservationAction(input: { cohortSize: number; refreshDue: boolean; inFlight: boolean }): ObservationAction {
  if (input.cohortSize <= 0) return 'empty'
  if (!input.refreshDue) return 'off_cadence'
  if (input.inFlight) return 'skip_in_flight'
  return 'launch'
}

/** The fetcher the daemon already owns: POST /api/monitor for `symbols`, with `observationalOnly` names. */
export type MonitorFetcher = (symbols: string[], observationalOnly?: string[], signal?: AbortSignal) => Promise<MonitorResult[]>

export interface SharedMonitorPass {
  /** BASE completion barrier — resolve/reject exactly as the pre-H4A.1 fetchResults(baseSymbols) would. */
  baseResults: Promise<MonitorResult[]>
  /** Observational tail — launched only AFTER baseResults settles; best-effort ([] on timeout/failure),
   *  never rejects, BASE never awaits it. Settles after at most observationTimeoutMs past its launch. */
  observationResults: Promise<MonitorResult[]>
  /** Whether an observational request was requested this pass. */
  observationRequested: boolean
  /** Abort the observational request (also invoked automatically on timeout). No-op if none is running. */
  abort: () => void
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  if (ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout(); reject(new Error(`observation timeout after ${ms}ms`)) }, ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/**
 * Run one shared monitor pass. BASE is fired first and is the ONLY thing the caller awaits before
 * detector/arbitration/execution. The observational request (if any) is launched ONLY AFTER base data
 * acquisition settles — so it cannot contend with BASE for the provider pool — and is exposed as an
 * abortable, best-effort promise BASE never blocks on.
 *
 * @param observationSymbols  the obs-only cohort symbols (already deduplicated against baseSymbols).
 *                            Pass [] to issue no observational request this pass.
 */
export function runSharedMonitorPass(
  fetcher: MonitorFetcher,
  baseSymbols: string[],
  observationSymbols: string[],
  opts: { observationTimeoutMs?: number; onObservationError?: (e: unknown) => void } = {},
): SharedMonitorPass {
  const baseResults = fetcher(baseSymbols)          // BASE barrier — created + started immediately
  if (observationSymbols.length === 0) {
    return { baseResults, observationResults: Promise.resolve<MonitorResult[]>([]), observationRequested: false, abort: () => {} }
  }
  const timeoutMs = opts.observationTimeoutMs ?? DEFAULT_OBSERVATION_PASS_CONFIG.observationTimeoutMs
  const ac = new AbortController()
  // BASE-FIRST: the observational fetch is launched only after base acquisition settles (resolve OR
  // reject). It then shares the same fetcher/endpoint/cache/single-flight, but never competes with base
  // for the network/provider pool. If base failed, skip the observational work entirely.
  const observationResults = baseResults.then(
    () => withTimeout(fetcher(observationSymbols, observationSymbols, ac.signal), timeoutMs, () => ac.abort())
      .catch((e): MonitorResult[] => { opts.onObservationError?.(e); return [] }),
    (): MonitorResult[] => [],
  )
  return { baseResults, observationResults, observationRequested: true, abort: () => ac.abort() }
}
