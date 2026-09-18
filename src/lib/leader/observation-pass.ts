/**
 * H4A.1 — shared monitor pass coordinator + observational refresh cadence (pure).
 *
 * LATENCY ISOLATION (red-team §1). BASE and the observational cohort share ONE data plane (one
 * fetcher = one /api/monitor endpoint = one buildMonitorBatch = one cache/single-flight/provider
 * client), but BASE must NOT wait for the observational tail. `runSharedMonitorPass` fires the BASE
 * request (the completion barrier the caller awaits before any detector/arbitration work) and,
 * concurrently, the observational request as a BEST-EFFORT tail that BASE never awaits and that can
 * fail or time out without touching BASE.
 *
 * REFRESH CADENCE (red-team §3). H4A local geometry (impulse / pullback / base / compression /
 * volume-contraction / local-extension) is BAR-DRIVEN: it can only change when a new 1m bar closes.
 * So the observational data fetch is gated to an explicit, config-driven interval (default one 1m
 * bar), while the daemon still SELECTS the persisted cohort every 15s sweep. Between refreshes no
 * observational provider work is issued at all. Stale/data-quality semantics stay honest — a reused
 * or skipped refresh is simply not re-fetched; localStructure staleBars still governs freshness.
 *
 * All parameters are OBSERVATIONAL, provisional, config-driven and fingerprinted. None touches BASE
 * cadence, BASE inputs, or execution.
 */
import type { MonitorResult } from '@/types'

export interface ObservationPassConfig {
  version: string
  /** Minimum interval between observational DATA fetches. Cohort selection still runs every sweep. */
  observationRefreshMs: number
  /** Max time the caller waits for the observational tail's telemetry. The underlying request is not
   *  cancelled, but BASE never blocks on it and a slow tail cannot stretch the sweep past this. */
  observationTimeoutMs: number
}

export const DEFAULT_OBSERVATION_PASS_CONFIG: ObservationPassConfig = {
  version: 'h4a1-obs-pass-1',
  observationRefreshMs: 60_000,   // one 1m bar — H4A geometry is bar-driven (report §3). NOT a request-saving guess.
  observationTimeoutMs: 8_000,    // < SWEEP_MS (15s), so the best-effort tail can never delay the next sweep.
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
    observationRefreshMs: Math.max(0, Math.floor(numEnv(env.COMPANION_LEADER_OBS_REFRESH_MS, d.observationRefreshMs))),
    observationTimeoutMs: Math.max(0, Math.floor(numEnv(env.COMPANION_LEADER_OBS_TIMEOUT_MS, d.observationTimeoutMs))),
  }
}

export function observationPassConfigCanonical(c: ObservationPassConfig): string {
  return ['h4a1-pass', `v=${c.version}`, `refresh=${c.observationRefreshMs}`, `timeout=${c.observationTimeoutMs}`].join('|')
}

/** Deterministic 8-hex fingerprint (FNV-1a, dep-free). Same config → same hash; any change → different. */
export function observationPassConfigHash(c: ObservationPassConfig): string {
  const s = observationPassConfigCanonical(c)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Should the observational cohort be RE-FETCHED this sweep? True on the first sweep and once the
 * refresh interval has elapsed since the last fetch. Cohort SELECTION is independent of this and
 * runs every sweep regardless.
 */
export function shouldRefreshObservation(nowMs: number, lastRefreshMs: number | null, cfg: ObservationPassConfig): boolean {
  if (lastRefreshMs === null) return true
  return nowMs - lastRefreshMs >= cfg.observationRefreshMs
}

/** The fetcher the daemon already owns: POST /api/monitor for `symbols`, with `observationalOnly` names. */
export type MonitorFetcher = (symbols: string[], observationalOnly?: string[]) => Promise<MonitorResult[]>

export interface SharedMonitorPass {
  /** BASE completion barrier — resolve/reject exactly as the pre-H4A.1 fetchResults(baseSymbols) would. */
  baseResults: Promise<MonitorResult[]>
  /** Observational tail — best-effort: resolves [] on timeout/failure, never rejects, BASE never awaits it. */
  observationResults: Promise<MonitorResult[]>
  /** Whether an observational request was actually issued this pass. */
  observationRequested: boolean
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`observation timeout after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/**
 * Run one shared monitor pass. BASE is fired first and is the ONLY thing the caller awaits before
 * detector/arbitration/execution. The observational request (if any) runs concurrently on the SAME
 * fetcher/cache and is exposed as a best-effort promise that BASE never blocks on.
 *
 * @param observationSymbols  the obs-only cohort symbols (already deduplicated against baseSymbols).
 *                            Pass [] to issue no observational request this sweep (e.g. off-cadence).
 */
export function runSharedMonitorPass(
  fetcher: MonitorFetcher,
  baseSymbols: string[],
  observationSymbols: string[],
  opts: { observationTimeoutMs?: number; onObservationError?: (e: unknown) => void } = {},
): SharedMonitorPass {
  const baseResults = fetcher(baseSymbols)          // BASE barrier — created + started immediately
  if (observationSymbols.length === 0) {
    return { baseResults, observationResults: Promise.resolve<MonitorResult[]>([]), observationRequested: false }
  }
  const timeoutMs = opts.observationTimeoutMs ?? DEFAULT_OBSERVATION_PASS_CONFIG.observationTimeoutMs
  // Same fetcher/endpoint/cache/single-flight; disjoint from base, so no duplicate provider work.
  const raw = fetcher(observationSymbols, observationSymbols)
  const observationResults = withTimeout(raw, timeoutMs).catch((e): MonitorResult[] => {
    opts.onObservationError?.(e)
    return []
  })
  return { baseResults, observationResults, observationRequested: true }
}
