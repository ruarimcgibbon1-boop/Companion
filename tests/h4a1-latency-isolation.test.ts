/**
 * H4A.1 — BASE resource isolation (red-team RT-1…RT-8).
 *
 * Beyond promise-level isolation, this proves REAL resource isolation: BASE-first network acquisition
 * (observation never contends with BASE for the provider pool), timeout ABORTS the underlying request,
 * at-most-one observational pass in flight (no cross-sweep accumulation), and genuine 1m bar-bucket
 * refresh alignment. Proven deterministically against the coordinator with injected fetchers.
 */
import { describe, it, expect } from 'vitest'
import type { MonitorResult } from '../src/types'
import {
  runSharedMonitorPass, shouldRefreshObservation, observationBucket, decideObservationAction,
  resolveObservationPassConfig, observationPassConfigHash, DEFAULT_OBSERVATION_PASS_CONFIG, type MonitorFetcher,
} from '../src/lib/leader/observation-pass'

const r = (symbol: string): MonitorResult => ({ symbol } as MonitorResult)
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))
const BASE = Array.from({ length: 15 }, (_, i) => `B${i}`)
const OBS = Array.from({ length: 8 }, (_, i) => `Z${i}`)

// A fetcher whose BASE call is fast and whose OBSERVATIONAL call is delayed / fails / hangs. Records the
// symbol lists and start timestamps each call received, and captures the AbortSignal it was handed.
function makeFetcher(opts: { obsDelayMs?: number; obsFail?: boolean; obsHang?: boolean } = {}) {
  const calls: { base?: string[]; obs?: string[]; baseStart?: number; obsStart?: number; obsSignal?: AbortSignal } = {}
  const fetcher: MonitorFetcher = async (symbols, observationalOnly, signal) => {
    if (observationalOnly && observationalOnly.length) {
      calls.obs = symbols; calls.obsStart = Date.now(); calls.obsSignal = signal
      if (opts.obsHang) { await sleep(60_000); return [] }
      if (opts.obsDelayMs) await sleep(opts.obsDelayMs)
      if (opts.obsFail) throw new Error('observation provider failed')
      return symbols.map(r)
    }
    calls.base = symbols; calls.baseStart = Date.now()
    return symbols.map(r)   // BASE resolves immediately
  }
  return { fetcher, calls }
}

describe('RT-1 BASE completion barrier + abortable tail', () => {
  it('A/B. base resolves promptly with 0 and with 8 observation symbols', async () => {
    const a = makeFetcher(); const t0 = Date.now()
    expect((await runSharedMonitorPass(a.fetcher, BASE, []).baseResults).map(x => x.symbol)).toEqual(BASE)
    expect(Date.now() - t0).toBeLessThan(200)
    const b = makeFetcher(); const t1 = Date.now()
    const p = runSharedMonitorPass(b.fetcher, BASE, OBS)
    expect((await p.baseResults).map(x => x.symbol)).toEqual(BASE)
    expect(Date.now() - t1).toBeLessThan(200)
    expect((await p.observationResults).map(x => x.symbol)).toEqual(OBS)
  })

  it('C. base resolves BEFORE a 1s-delayed observation tail', async () => {
    const { fetcher } = makeFetcher({ obsDelayMs: 1000 })
    const start = Date.now()
    const pass = runSharedMonitorPass(fetcher, BASE, OBS)
    await pass.baseResults
    expect(Date.now() - start).toBeLessThan(300)
    await pass.observationResults
    expect(Date.now() - start).toBeGreaterThanOrEqual(900)
  })

  it('D. an observation failure resolves the tail to [] and never rejects; base intact', async () => {
    const { fetcher } = makeFetcher({ obsFail: true })
    let observedErr = false
    const pass = runSharedMonitorPass(fetcher, BASE, OBS, { onObservationError: () => { observedErr = true } })
    expect((await pass.baseResults).map(x => x.symbol)).toEqual(BASE)
    await expect(pass.observationResults).resolves.toEqual([])
    expect(observedErr).toBe(true)
  })

  it('E. a hanging provider: base unaffected; tail times out to [] AND the request is aborted', async () => {
    const { fetcher, calls } = makeFetcher({ obsHang: true })
    const start = Date.now()
    const pass = runSharedMonitorPass(fetcher, BASE, OBS, { observationTimeoutMs: 150 })
    expect((await pass.baseResults).map(x => x.symbol)).toEqual(BASE)
    await expect(pass.observationResults).resolves.toEqual([])
    expect(Date.now() - start).toBeLessThan(2000)
    // RT-4: the timeout ABORTED the underlying request (not merely un-awaited).
    expect(calls.obsSignal?.aborted).toBe(true)
  })
})

describe('RT-1/RT-2 BASE-first acquisition — no provider contention', () => {
  it('the observation request is launched only AFTER base acquisition settles', async () => {
    const { fetcher, calls } = makeFetcher({ obsDelayMs: 10 })
    const pass = runSharedMonitorPass(fetcher, BASE, OBS)
    await pass.baseResults; await pass.observationResults
    expect(calls.baseStart).toBeDefined(); expect(calls.obsStart).toBeDefined()
    expect(calls.obsStart!).toBeGreaterThanOrEqual(calls.baseStart!)   // obs starts no earlier than base
  })

  it('slow observation through a SHARED constrained provider pool does not delay base', async () => {
    // One shared semaphore (pool size 2) backs BOTH base and observation "fetches". base holds a slot
    // 10ms/symbol, observation 200ms/symbol. Because observation is launched only after base settles,
    // base never queues behind observation for the pool.
    let active = 0; const waiters: Array<() => void> = []
    const acquire = () => new Promise<void>(res => { if (active < 2) { active++; res() } else waiters.push(() => { active++; res() }) })
    const release = () => { active--; const n = waiters.shift(); if (n) n() }
    const pooled: MonitorFetcher = async (symbols, obsOnly) => {
      const hold = obsOnly?.length ? 200 : 10
      return Promise.all(symbols.map(async s => { await acquire(); try { await sleep(hold); return r(s) } finally { release() } }))
    }
    // base-only baseline
    let t = Date.now()
    await runSharedMonitorPass(pooled, BASE, []).baseResults
    const baseOnly = Date.now() - t
    // base + slow observation
    t = Date.now()
    const pass = runSharedMonitorPass(pooled, BASE, OBS)
    await pass.baseResults
    const baseWithObs = Date.now() - t
    expect(baseWithObs).toBeLessThan(baseOnly + 120)   // base not materially delayed by the slow obs pool load
    await pass.observationResults                       // let the tail drain so the pool empties
  })
})

describe('RT-4/RT-5 at-most-one in flight — no cross-sweep accumulation', () => {
  it('decideObservationAction gates fetch by cadence AND by an outstanding pass', () => {
    expect(decideObservationAction({ cohortSize: 0, refreshDue: true, inFlight: false })).toBe('empty')
    expect(decideObservationAction({ cohortSize: 3, refreshDue: false, inFlight: false })).toBe('off_cadence')
    expect(decideObservationAction({ cohortSize: 3, refreshDue: true, inFlight: true })).toBe('skip_in_flight')
    expect(decideObservationAction({ cohortSize: 3, refreshDue: true, inFlight: false })).toBe('launch')
  })

  it('cross-sweep simulation: a hung pass makes later bucket-due ticks SKIP, never accumulate', () => {
    const cfg = DEFAULT_OBSERVATION_PASS_CONFIG
    let inFlight = false, launches = 0
    // sweep 1 @ t0: bucket due, not in flight → launch, pass hangs (inFlight stays true)
    let bucket: number | null = null
    const tick = (nowMs: number) => {
      const action = decideObservationAction({ cohortSize: 8, refreshDue: shouldRefreshObservation(nowMs, bucket, cfg), inFlight })
      if (action === 'launch') { launches++; inFlight = true; bucket = observationBucket(nowMs, cfg) }
      return action
    }
    const t0 = 1_000_000
    expect(tick(t0)).toBe('launch')                    // sweep 1 launches
    expect(tick(t0 + 15_000)).toBe('off_cadence')      // sweep 2: same bucket, still off-cadence
    expect(tick(t0 + 65_000)).toBe('skip_in_flight')   // sweep 5: new bucket but prior pass still hung → SKIP
    expect(tick(t0 + 80_000)).toBe('skip_in_flight')   // still hung → still skip (no accumulation)
    inFlight = false                                    // the hung pass finally settles (timeout/abort)
    expect(tick(t0 + 95_000)).toBe('launch')            // now a fresh pass may launch
    expect(launches).toBe(2)                            // exactly two launches across the whole window
  })
})

describe('RT-6 genuine 1m bar-bucket alignment', () => {
  const cfg = { ...DEFAULT_OBSERVATION_PASS_CONFIG, observationRefreshMs: 60_000, barPublicationLagMs: 5_000 }
  it('two timestamps in the same lagged 60s bucket share a bucket; crossing a bar boundary changes it', () => {
    const b = (s: string) => observationBucket(Date.parse(`2026-09-18T${s}-04:00`), cfg)
    expect(b('10:00:43')).toBe(b('10:00:59'))         // same 1m bucket
    expect(b('10:01:10')).toBe(b('10:00:43') + 1)     // next bar bucket (past the 5s publication lag)
    // publication lag: 10:01:03 is < 5s into the 10:01 bar, so it still reads the 10:00 bucket
    expect(b('10:01:03')).toBe(b('10:00:43'))
  })
  it('shouldRefreshObservation fires once per new bucket (not on a rolling elapsed interval)', () => {
    const t = (s: string) => Date.parse(`2026-09-18T${s}-04:00`)
    const firstBucket = observationBucket(t('10:00:07'), cfg)
    expect(shouldRefreshObservation(t('10:00:07'), null, cfg)).toBe(true)          // first ever
    expect(shouldRefreshObservation(t('10:00:59'), firstBucket, cfg)).toBe(false)  // same bucket, 52s later
    expect(shouldRefreshObservation(t('10:01:07'), firstBucket, cfg)).toBe(true)   // new bar bucket
  })
})

describe('RT-3 config provenance', () => {
  it('refresh interval, bar lag and timeout are env-overridable and fingerprinted', () => {
    const base = resolveObservationPassConfig({})
    const over = resolveObservationPassConfig({ COMPANION_LEADER_OBS_REFRESH_MS: '30000', COMPANION_LEADER_OBS_BAR_LAG_MS: '2000', COMPANION_LEADER_OBS_TIMEOUT_MS: '5000' })
    expect(over.observationRefreshMs).toBe(30_000)
    expect(over.barPublicationLagMs).toBe(2_000)
    expect(over.observationTimeoutMs).toBe(5_000)
    expect(observationPassConfigHash(over)).not.toBe(observationPassConfigHash(base))
    expect(observationPassConfigHash({ ...base })).toBe(observationPassConfigHash(base))
  })
})
