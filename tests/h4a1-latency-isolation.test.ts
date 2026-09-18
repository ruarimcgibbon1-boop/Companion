/**
 * H4A.1 — BASE latency isolation (red-team §1/§6/§7).
 *
 * The load-bearing property: observational latency or failure must NOT delay the moment BASE can
 * start processing its own results, must not cancel/reorder/alter BASE, and base symbols must never
 * be displaced by observational ones. Proven deterministically against the shared-pass coordinator
 * with injected delayed / failing / hanging fetchers.
 */
import { describe, it, expect } from 'vitest'
import type { MonitorResult } from '../src/types'
import {
  runSharedMonitorPass, shouldRefreshObservation, resolveObservationPassConfig,
  observationPassConfigHash, DEFAULT_OBSERVATION_PASS_CONFIG, type MonitorFetcher,
} from '../src/lib/leader/observation-pass'

const r = (symbol: string): MonitorResult => ({ symbol } as MonitorResult)
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

// A fetcher whose BASE call is fast and whose OBSERVATIONAL call is delayed by `obsDelayMs`
// (or fails / hangs). Records the symbol lists each call received.
function makeFetcher(opts: { obsDelayMs?: number; obsFail?: boolean; obsHang?: boolean } = {}) {
  const calls: { base?: string[]; obs?: string[] } = {}
  const fetcher: MonitorFetcher = async (symbols, observationalOnly) => {
    if (observationalOnly && observationalOnly.length) {
      calls.obs = symbols
      if (opts.obsHang) { await sleep(60_000); return [] }        // never resolves within a test
      if (opts.obsDelayMs) await sleep(opts.obsDelayMs)
      if (opts.obsFail) throw new Error('observation provider failed')
      return symbols.map(r)
    }
    calls.base = symbols
    return symbols.map(r)   // BASE resolves immediately
  }
  return { fetcher, calls }
}

const BASE = Array.from({ length: 15 }, (_, i) => `B${i}`)
const OBS = Array.from({ length: 8 }, (_, i) => `Z${i}`)

describe('§1 BASE completion barrier', () => {
  it('A/B. base resolves promptly with 0 and with 8 fast observation symbols', async () => {
    const a = makeFetcher()
    const t0 = Date.now()
    const noObs = runSharedMonitorPass(a.fetcher, BASE, [])
    expect((await noObs.baseResults).map(x => x.symbol)).toEqual(BASE)
    const tA = Date.now() - t0

    const b = makeFetcher()
    const t1 = Date.now()
    const withObs = runSharedMonitorPass(b.fetcher, BASE, OBS)
    expect((await withObs.baseResults).map(x => x.symbol)).toEqual(BASE)
    const tB = Date.now() - t1
    expect(tA).toBeLessThan(200); expect(tB).toBeLessThan(200)   // adding observation did not slow base
    expect((await withObs.observationResults).map(x => x.symbol)).toEqual(OBS)
  })

  it('C. base resolves BEFORE a 1s-delayed observation tail (no latency coupling)', async () => {
    const { fetcher } = makeFetcher({ obsDelayMs: 1000 })
    const start = Date.now()
    const pass = runSharedMonitorPass(fetcher, BASE, OBS)
    await pass.baseResults
    const baseAt = Date.now() - start
    expect(baseAt).toBeLessThan(300)              // BASE did not wait for the 1s observation tail
    await pass.observationResults
    const obsAt = Date.now() - start
    expect(obsAt).toBeGreaterThanOrEqual(900)     // the tail really was delayed ~1s
  })

  it('D. an observation failure resolves the tail to [] and never rejects; base is intact', async () => {
    const { fetcher } = makeFetcher({ obsFail: true })
    let observedErr = false
    const pass = runSharedMonitorPass(fetcher, BASE, OBS, { onObservationError: () => { observedErr = true } })
    expect((await pass.baseResults).map(x => x.symbol)).toEqual(BASE)
    await expect(pass.observationResults).resolves.toEqual([])   // best-effort: [] not a rejection
    expect(observedErr).toBe(true)
  })

  it('E. a hanging observation provider cannot hold base or the tail hostage (timeout → [])', async () => {
    const { fetcher } = makeFetcher({ obsHang: true })
    const start = Date.now()
    const pass = runSharedMonitorPass(fetcher, BASE, OBS, { observationTimeoutMs: 150 })
    expect((await pass.baseResults).map(x => x.symbol)).toEqual(BASE)   // base unaffected by the hang
    await expect(pass.observationResults).resolves.toEqual([])          // tail gives up at the timeout
    expect(Date.now() - start).toBeLessThan(2000)                       // did not wait on the 60s hang
  })
})

describe('§6 base-first capacity — structural separation', () => {
  it('base and observation are DISJOINT requests; base is never truncated by observation', async () => {
    const { fetcher, calls } = makeFetcher()
    const pass = runSharedMonitorPass(fetcher, BASE, OBS)
    await pass.baseResults; await pass.observationResults
    expect(calls.base).toEqual(BASE)                          // base request carries exactly the base set
    expect(calls.obs).toEqual(OBS)                            // observation is a separate request
    expect(calls.base!.some(s => OBS.includes(s))).toBe(false)  // no observational symbol in the base request
  })

  it('no observational request is issued when the cohort is empty', async () => {
    const { fetcher, calls } = makeFetcher()
    const pass = runSharedMonitorPass(fetcher, BASE, [])
    await pass.baseResults
    expect(pass.observationRequested).toBe(false)
    expect(await pass.observationResults).toEqual([])
    expect(calls.obs).toBeUndefined()
  })
})

describe('§3 observational refresh cadence', () => {
  const cfg = { ...DEFAULT_OBSERVATION_PASS_CONFIG, observationRefreshMs: 60_000 }
  it('first sweep refreshes; within the interval it does not; after the interval it does', () => {
    expect(shouldRefreshObservation(1_000_000, null, cfg)).toBe(true)          // first ever
    expect(shouldRefreshObservation(1_000_000 + 15_000, 1_000_000, cfg)).toBe(false)  // +15s < 60s
    expect(shouldRefreshObservation(1_000_000 + 45_000, 1_000_000, cfg)).toBe(false)  // +45s < 60s
    expect(shouldRefreshObservation(1_000_000 + 60_000, 1_000_000, cfg)).toBe(true)   // +60s == interval
    expect(shouldRefreshObservation(1_000_000 + 90_000, 1_000_000, cfg)).toBe(true)   // +90s
  })

  it('refresh interval + timeout are env-overridable and fingerprinted', () => {
    const base = resolveObservationPassConfig({})
    const over = resolveObservationPassConfig({ COMPANION_LEADER_OBS_REFRESH_MS: '30000', COMPANION_LEADER_OBS_TIMEOUT_MS: '5000' })
    expect(over.observationRefreshMs).toBe(30_000)
    expect(over.observationTimeoutMs).toBe(5_000)
    expect(observationPassConfigHash(over)).not.toBe(observationPassConfigHash(base))
    expect(observationPassConfigHash({ ...base })).toBe(observationPassConfigHash(base))
  })
})
