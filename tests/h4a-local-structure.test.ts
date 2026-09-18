/**
 * H4A — local-reset feature engine. Deterministic SYNTHETIC GEOMETRY fixtures (Step 15/20): each
 * asserts the MEASURED geometry, never a trading verdict. Also: timeframe provenance, config hash,
 * data-quality statuses, halt/gap handling, and input immutability.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import type { Candle } from '../src/types'
import {
  computeLocalStructure, DEFAULT_LOCAL_FEATURE_CONFIG, resolveLocalFeatureConfig,
  localFeatureConfigHash, type LocalStructureConfig, type LocalStructureInput,
} from '../src/lib/leader/local-structure'

const T0 = Math.floor(Date.parse('2026-09-18T10:00:00-04:00') / 1000)  // RTH
type Row = { c: number; v?: number; hi?: number; lo?: number }
function build(rows: Row[], spacingSec = 60, startSec = T0): Candle[] {
  let prev = rows[0].c
  return rows.map((r, i) => {
    const o = i === 0 ? r.c : prev
    const c = r.c
    const hi = r.hi ?? Math.max(o, c)
    const lo = r.lo ?? Math.min(o, c)
    prev = c
    return { time: startSec + i * spacingSec, open: o, high: hi, low: lo, close: c, volume: r.v ?? 1000 }
  })
}
const closes = (xs: number[], v = 1000): Row[] => xs.map(c => ({ c, v }))
const asOf = (cs: Candle[]) => Math.max(...cs.map(c => c.time)) * 1000 + 30_000   // 30s after the newest bar → fresh
function run(cs: Candle[], globals?: LocalStructureInput['globals'], cfg?: LocalStructureConfig) {
  return computeLocalStructure({ symbol: 'TEST', candles: cs, asOfMs: asOf(cs), session: 'regular', globals }, cfg)
}

const flat = (n: number, px: number, v = 1000): Row[] => Array.from({ length: n }, () => ({ c: px, v }))

describe('H4A local-structure engine — synthetic geometry', () => {
  it('A. clean impulse → shallow pullback → tight base', () => {
    const cs = build([
      ...flat(6, 10.0),
      { c: 10.3 }, { c: 10.6 }, { c: 10.9 }, { c: 11.0 },          // impulse ~+10%
      { c: 10.92 }, { c: 10.88 },                                  // shallow pullback ~-1.1%
      { c: 10.89 }, { c: 10.90 }, { c: 10.88 }, { c: 10.90 }, { c: 10.89 }, { c: 10.90 },  // tight base
    ])
    const f = run(cs)
    expect(f.status).toBe('AVAILABLE')
    expect(f.impulse.detected).toBe(true)
    expect(f.impulse.pct!).toBeGreaterThan(8)
    expect(f.pullback.pctFromImpulsePeak!).toBeLessThan(3)
    expect(f.base.detected).toBe(true)
    expect(f.base.rangePct!).toBeLessThan(4)
    expect(f.resetState).toBe('STABILIZING')
  })

  it('B. clean impulse → deep (but not full) pullback → wide base', () => {
    const cs = build([
      ...flat(6, 10.0),
      { c: 10.5 }, { c: 11.0 }, { c: 11.5 },                       // impulse +15%, peak 11.5
      { c: 11.0 }, { c: 10.7 }, { c: 10.4 },                       // deep pullback (~9.6%, retrace ~73%)
      { c: 10.5 }, { c: 10.45 }, { c: 10.55 }, { c: 10.5 }, { c: 10.52 }, { c: 10.48 },  // wide region, sub-impulse wiggles
    ])
    const f = run(cs)
    expect(f.impulse.detected).toBe(true)
    expect(f.pullback.pctFromImpulsePeak!).toBeGreaterThan(8)   // deep
    expect(f.pullback.retracementRatio!).toBeLessThan(1)        // but did NOT give the whole leg back
    expect(f.base.detected).toBe(false)                         // range too wide to assert a tight base
    expect(f.base.rangePct!).toBeGreaterThan(4)
    expect(['DEEP', 'STILL_PULLING_BACK']).toContain(f.resetState)
  })

  it('C. globally EXTENDED (far below HOD) yet LOCALLY FRESH (at its base high) — no contradiction', () => {
    // Local: impulse 9.0 → 10.0, base ~9.9–10.0, price at base high (fresh). Global: session high 15 (33% off).
    const cs = build([
      ...flat(6, 9.0),
      { c: 9.3 }, { c: 9.6 }, { c: 9.9 }, { c: 10.0 },
      { c: 9.95 }, { c: 9.92 },
      { c: 9.95 }, { c: 9.98 }, { c: 9.96 }, { c: 9.99 }, { c: 9.97 }, { c: 10.0 },
    ])
    const f = run(cs, { price: 10.0, sessionHigh: 15.0, vwap: 9.5, ema9: 9.8, dayChangePct: 25 })
    expect(f.status).toBe('AVAILABLE')
    expect(f.global.offHighPct!).toBeLessThan(-25)                 // GLOBALLY EXTENDED from the session high
    expect(Math.abs(f.localExtension.localExtensionPct!)).toBeLessThan(1) // LOCALLY FRESH (~at base high)
    expect(f.localExtension.globalVsLocalExtensionRatio!).toBeGreaterThan(5)
    expect(f.base.detected).toBe(true)
  })

  it('D. near HOD but LOCALLY OVEREXTENDED (far above the base it launched from)', () => {
    // launch base ~9.5–9.6, then a push to 10.5 which is the current high (≈ session high).
    const cs = build([
      ...flat(7, 9.5),
      { c: 9.55 }, { c: 9.52 }, { c: 9.58 }, { c: 9.54 }, { c: 9.6 },   // tight launch base
      { c: 9.9 }, { c: 10.2 }, { c: 10.5 },                             // push to a new local high (current)
    ])
    const f = run(cs, { price: 10.5, sessionHigh: 10.5, vwap: 9.7, ema9: 10.0, dayChangePct: 10 })
    expect(Math.abs(f.global.offHighPct!)).toBeLessThan(1)         // NEAR HOD
    expect(f.base.detected).toBe(true)                             // the launch base is measured
    expect(f.localExtension.localExtensionPct!).toBeGreaterThan(3) // locally OVEREXTENDED above the base high
    expect(f.localExtension.globalVsLocalExtensionRatio!).toBeLessThan(1)
  })

  it('E. straight vertical move with no reset (price at the high → nothing has pulled back)', () => {
    const cs = build(closes([10, 10, 10.2, 10.4, 10.6, 10.8, 11.0, 11.3, 11.6, 11.9, 12.2, 12.5, 12.8, 13.1, 13.4, 13.7]))
    const f = run(cs)
    expect(f.impulse.detected).toBe(true)
    expect(f.resetState).toBe('NO_RESET')
    expect(f.pullback.pctFromImpulsePeak).toBeNull()               // at the high, nothing has pulled back
    expect(f.base.detected).toBe(false)                            // < minBaseBars launch bars
  })

  it('F. failed structure — impulse fully retraced (gave the leg back)', () => {
    const cs = build([
      ...flat(6, 10.0),
      { c: 10.4 }, { c: 10.8 }, { c: 11.0 },       // impulse
      { c: 10.5 }, { c: 10.0 }, { c: 9.6 }, { c: 9.3 }, { c: 9.1 }, { c: 9.0 }, { c: 8.9 },  // collapse below start
    ])
    const f = run(cs)
    expect(f.impulse.detected).toBe(true)
    expect(f.pullback.retracementRatio!).toBeGreaterThan(1)        // > whole impulse height
    expect(f.resetState).toBe('FAILED')
  })

  it('G. chop with no meaningful impulse', () => {
    const cs = build(closes([10.0, 10.05, 9.98, 10.02, 9.99, 10.03, 9.97, 10.01, 10.0, 9.98, 10.02, 9.99, 10.01, 10.0, 9.99, 10.02]))
    const f = run(cs)
    expect(f.status).toBe('AVAILABLE')
    expect(f.impulse.detected).toBe(false)     // nothing ≥ minImpulsePct
    expect(f.resetState).toBe('NO_RESET')
  })

  it('H. multiple impulses → selects the MOST RECENT valid structure', () => {
    const cs = build([
      ...flat(4, 9.0),
      { c: 9.4 }, { c: 9.7 }, { c: 10.0 },        // impulse #1 → peak 10.0
      { c: 9.7 }, { c: 9.5 }, { c: 9.6 }, { c: 9.55 },   // pullback / base #1
      { c: 10.2 }, { c: 10.7 }, { c: 11.2 }, { c: 11.5 }, // impulse #2 → peak 11.5 (more recent)
    ])
    const f = run(cs)
    expect(f.impulse.detected).toBe(true)
    expect(f.impulse.peakPrice!).toBeCloseTo(11.5, 1)     // the recent leg, not 10.0
    expect(f.impulse.startPrice!).toBeGreaterThan(9.4)    // trough between the two legs (~9.5), not the day base
  })

  it('I. timestamp gap / halt → analysis restricted to the post-gap contiguous run, flagged', () => {
    const pre = build(closes([10, 10, 10, 10, 10]), 60, T0)
    const postStart = T0 + 5 * 60 + 45 * 60   // 45-min gap after the pre run
    const post = build([...flat(4, 10.0), { c: 10.3 }, { c: 10.6 }, { c: 10.9 }, { c: 11.0 },
      { c: 10.95 }, { c: 10.9 }, { c: 10.92 }, { c: 10.9 }, { c: 10.93 }, { c: 10.91 }, { c: 10.92 }], 60, postStart)
    const cs = [...pre, ...post]
    const f = run(cs)
    expect(f.provenance.discontinuityInWindow).toBe(true)
    expect(f.status).toBe('GAP_DETECTED')
    // the impulse must live entirely in the post-gap run (never spans the halt)
    expect(f.impulse.startAt!).toBeGreaterThanOrEqual(postStart)
  })

  it('J. insufficient bars → honest status, no fabricated geometry', () => {
    const f = run(build(closes([10, 10.2, 10.4, 10.6, 10.8])))   // 5 bars < minBars
    expect(f.status).toBe('INSUFFICIENT_BARS')
    expect(f.impulse.detected).toBe(false)
    expect(f.impulse.pct).toBeNull()                              // null, not a fake 0
  })

  it('K. low-volume base contraction then volume re-expansion breakout', () => {
    const cs = build([
      ...flat(6, 10.0, 2000),
      { c: 10.3, v: 5000 }, { c: 10.6, v: 6000 }, { c: 11.0, v: 7000 },  // impulse on rising volume
      { c: 10.9, v: 1500 }, { c: 10.88, v: 1200 }, { c: 10.9, v: 1000 }, { c: 10.89, v: 900 }, { c: 10.9, v: 800 }, // base: volume contracts
      { c: 11.2, v: 9000 },                                              // breakout above base high on big volume
    ])
    const f = run(cs, { price: 11.2, vwap: 10.5, ema9: 10.8 })
    expect(f.base.volumeContraction!).toBeLessThan(1)            // base quieter than the impulse
    expect(f.reExpansion.observed).toBe(true)
    expect(f.reExpansion.breakoutAboveBaseHighPct!).toBeGreaterThan(0)
    expect(f.reExpansion.volumeExpansion!).toBeGreaterThan(1)
    expect(f.reExpansion.reclaimedVWAP).toBe(true)
  })

  it('L. overnight / new-day boundary is treated as a discontinuity (segments to the recent day)', () => {
    const day1 = build(closes([9, 9.1, 9.2, 9.1, 9.0]), 60, T0)
    const day2Start = T0 + 5 * 60 + 18 * 3600   // ~next day
    const day2 = build([...flat(4, 10.0), { c: 10.3 }, { c: 10.6 }, { c: 10.9 }, { c: 11.0 },
      { c: 10.95 }, { c: 10.9 }, { c: 10.92 }, { c: 10.9 }, { c: 10.93 }, { c: 10.91 }, { c: 10.92 }], 60, day2Start)
    const f = run([...day1, ...day2])
    expect(f.provenance.discontinuityInWindow).toBe(true)
    expect(f.provenance.barsStartAt!).toBeGreaterThanOrEqual(day2Start)   // scoped to the recent day
  })
})

describe('H4A data quality & provenance', () => {
  it('M. stale bars → STALE_BARS', () => {
    const cs = build(closes(Array.from({ length: 20 }, (_, i) => 10 + i * 0.1)))
    const f = computeLocalStructure({ symbol: 'X', candles: cs, asOfMs: cs[cs.length - 1].time * 1000 + 10 * 60_000, session: 'regular' })
    expect(f.status).toBe('STALE_BARS')
  })

  it('missing volume (all zero) → MISSING_VOLUME', () => {
    const cs = build(closes(Array.from({ length: 20 }, (_, i) => 10 + i * 0.1)).map(r => ({ ...r, v: 0 })) as Row[])
    expect(run(cs).status).toBe('MISSING_VOLUME')
  })

  it('malformed / negative / out-of-order / duplicate bars are sanitized, not trusted as geometry', () => {
    const good = build(closes(Array.from({ length: 18 }, (_, i) => 10 + i * 0.1)))
    const dirty: Candle[] = [
      { time: T0 - 60, open: -1, high: -1, low: -2, close: -1, volume: 100 },   // negative → dropped
      { time: T0 + 5 * 60, open: 10, high: 9, low: 11, close: 10, volume: 100 }, // high<low → dropped
      ...good,
      { ...good[3] },                                                            // duplicate timestamp → deduped
    ]
    const f = run(dirty)
    expect(['AVAILABLE', 'GAP_DETECTED']).toContain(f.status)
    expect(f.provenance.barsCount).toBeLessThanOrEqual(good.length)  // dirty rows removed / deduped
  })

  it('N. timeframe provenance is explicit and never mislabelled', () => {
    expect(run(build(closes(Array.from({ length: 20 }, (_, i) => 10 + i * 0.05)), 60)).provenance.timeframe).toBe('1m')
    expect(run(build(closes(Array.from({ length: 20 }, (_, i) => 10 + i * 0.05)), 300)).provenance.timeframe).toBe('5m')
    // irregular ~137s cadence is NOT silently called 1m
    const irregular = Array.from({ length: 20 }, (_, i) => ({ time: T0 + i * 137, open: 10, high: 10.1, low: 9.9, close: 10, volume: 100 }))
    expect(run(irregular).status).toBe('UNSUPPORTED_TIMEFRAME')
  })

  it('O. config hash: deterministic; any behavior-affecting change flips it', () => {
    const base = localFeatureConfigHash(DEFAULT_LOCAL_FEATURE_CONFIG)
    expect(localFeatureConfigHash({ ...DEFAULT_LOCAL_FEATURE_CONFIG })).toBe(base)
    for (const k of ['lookbackBars', 'minBars', 'swingLookback', 'minImpulsePct', 'minImpulseBars', 'shallowPullbackPct', 'deepPullbackPct', 'baseWindowBars', 'minBaseBars', 'maxBaseRangePct', 'baseTestTolPct', 'gapToleranceMult'] as const) {
      expect(localFeatureConfigHash({ ...DEFAULT_LOCAL_FEATURE_CONFIG, [k]: DEFAULT_LOCAL_FEATURE_CONFIG[k] + 1 })).not.toBe(base)
    }
    expect(localFeatureConfigHash({ ...DEFAULT_LOCAL_FEATURE_CONFIG, version: 'other' })).not.toBe(base)
    // env resolves into the effective config and moves the fingerprint
    const envCfg = resolveLocalFeatureConfig({ COMPANION_H4A_MIN_IMPULSE_PCT: '7' })
    expect(envCfg.minImpulsePct).toBe(7)
    expect(localFeatureConfigHash(envCfg)).not.toBe(base)
    expect(resolveLocalFeatureConfig({ COMPANION_H4A_MIN_IMPULSE_PCT: 'nan' }).minImpulsePct).toBe(DEFAULT_LOCAL_FEATURE_CONFIG.minImpulsePct)
  })

  it('P. does not mutate the input candle array (pure)', () => {
    const cs = build(closes([10.5, 10.2, 10.8, 10.1, 10.9, 10.0, 11.0, 10.3, 10.7, 10.4, 10.6, 10.5, 10.9, 10.2, 10.8, 10.3]))
    const before = cs.map(c => ({ ...c }))
    computeLocalStructure({ symbol: 'X', candles: cs, asOfMs: asOf(cs) })
    expect(cs).toEqual(before)   // untouched (engine sorts/dedups a copy)
  })
})

// ── Red-team §2: CURRENT LOCAL impulse (most recent meaningful), not merely the largest historical ──
describe('H4A current-vs-dominant impulse (§2)', () => {
  it('2A. old large impulse + newer meaningful smaller impulse → CURRENT follows the newer one', () => {
    const cs = build([
      ...flat(4, 9.0),
      { c: 9.6 }, { c: 10.3 }, { c: 11.0 },        // impulse #1 → 11 (large, +22%)
      { c: 10.5 }, { c: 9.8 }, { c: 9.5 },         // reset
      { c: 9.6 }, { c: 9.55 }, { c: 9.6 },         // base #1
      { c: 9.9 }, { c: 10.1 }, { c: 10.3 },        // impulse #2 → 10.3 (newer, smaller, from 9.5)
    ])
    const f = run(cs)
    expect(f.impulse.detected).toBe(true)
    expect(f.impulse.peakPrice!).toBeCloseTo(10.3, 1)          // CURRENT = the newer impulse, not the old 11
    expect(f.impulse.startPrice!).toBeGreaterThan(9.4)         // its trough (~9.5), not the day base
    expect(f.impulse.dominantImpulsePct!).toBeGreaterThan(20)  // the old giant is preserved as DOMINANT
    expect(f.impulse.dominantImpulsePct!).toBeGreaterThan(f.impulse.pct!)   // dominant ≠ current
  })

  it('2B. a newer sub-threshold noise wiggle does NOT replace the real impulse', () => {
    const cs = build([
      ...flat(4, 9.0),
      { c: 9.6 }, { c: 10.3 }, { c: 11.0 },        // real impulse → 11
      { c: 10.7 }, { c: 10.5 }, { c: 10.6 }, { c: 10.55 }, { c: 10.62 }, { c: 10.58 }, { c: 10.6 }, { c: 10.63 }, // tiny (<3%) wiggles
    ])
    const f = run(cs)
    expect(f.impulse.peakPrice!).toBeCloseTo(11.0, 1)          // noise did not become "the impulse"
  })

  it('2C. two similar valid impulses → the MOST RECENT defines local geometry', () => {
    const cs = build([
      ...flat(6, 9.0),
      { c: 9.4 }, { c: 9.7 }, { c: 10.0 },         // impulse #1 → 10
      { c: 9.7 }, { c: 9.5 }, { c: 9.4 },          // reset
      { c: 9.7 }, { c: 10.0 }, { c: 10.4 },        // impulse #2 → 10.4 (similar size, newer)
    ])
    const f = run(cs)
    expect(f.impulse.peakPrice!).toBeCloseTo(10.4, 1)
  })

  it('2D. the latest valid impulse fully retraces → CURRENT describes that failed leg (FAILED)', () => {
    const cs = build([
      ...flat(4, 9.0),
      { c: 9.5 }, { c: 10.0 },                     // impulse #1
      { c: 9.7 }, { c: 9.5 },                      // reset
      { c: 9.8 }, { c: 10.1 }, { c: 10.3 },        // impulse #2 → 10.3
      { c: 9.9 }, { c: 9.5 }, { c: 9.3 }, { c: 9.2 }, // fully collapses back
    ])
    const f = run(cs)
    expect(f.impulse.peakPrice!).toBeCloseTo(10.3, 1)          // the recent leg, even though it failed
    expect(f.resetState).toBe('FAILED')
  })
})

// ── Red-team §3: causal / as-of safety (mandatory before the H4B tape replay) ────────────────────
describe('H4A causal as-of invariance (§3)', () => {
  it('future bars (T+1..T+n) cannot change the features reported for T', () => {
    const full = build(closes([9.5, 9.6, 9.4, 9.8, 10.0, 9.7, 10.2, 9.9, 10.3, 10.1, 10.4, 10.2, 10.5, 10.3, 10.6, 10.4, 10.7, 10.5, 10.8, 10.6, 11.0, 10.8, 11.2, 11.0, 11.3]))
    const T = full[17].time * 1000 + 1                     // as-of at bar 17
    const truncated = full.filter(c => c.time * 1000 <= T)
    const fromFull = computeLocalStructure({ symbol: 'X', candles: full, asOfMs: T })
    const fromTrunc = computeLocalStructure({ symbol: 'X', candles: truncated, asOfMs: T })
    // identical geometry+provenance — the ONLY difference is the honest FUTURE_BARS_DROPPED flag.
    const strip = (x: typeof fromFull) => ({ ...x, qualityFlags: x.qualityFlags.filter(q => q !== 'FUTURE_BARS_DROPPED') })
    expect(strip(fromFull)).toEqual(strip(fromTrunc))    // later bars filtered internally → identical
    expect(fromFull.qualityFlags).toContain('FUTURE_BARS_DROPPED')
    expect(fromTrunc.qualityFlags).not.toContain('FUTURE_BARS_DROPPED')
  })
})

// ── Red-team §4: timeframe robustness (a mixed feed must not be labelled 1m) ──────────────────────
describe('H4A timeframe robustness (§4)', () => {
  const rising = (n: number) => closes(Array.from({ length: n }, (_, i) => 10 + i * 0.05))
  it('pure 1m / 5m / 15m are classified correctly', () => {
    expect(run(build(rising(20), 60)).provenance.timeframe).toBe('1m')
    expect(run(build(rising(20), 300)).provenance.timeframe).toBe('5m')
    expect(run(build(rising(20), 900)).provenance.timeframe).toBe('15m')
  })
  it('one missing bar (single 2× gap) stays 1m', () => {
    const rows = rising(20)
    const cs = build(rows, 60)
    cs.splice(10, 1)                                        // drop one bar → a single 120s interval
    expect(run(cs).provenance.timeframe).toBe('1m')
  })
  it('mostly 1m + a substantial 5m section → mixed / UNSUPPORTED_TIMEFRAME', () => {
    const a = build(rising(12), 60, T0)
    const b = build(rising(8), 300, a[a.length - 1].time + 300)
    const f = run([...a, ...b])
    expect(f.status).toBe('UNSUPPORTED_TIMEFRAME')
    expect(['mixed']).toContain(f.provenance.timeframe)
    expect(f.qualityFlags).toContain('MIXED_CADENCE')
  })
  it('alternating 1m / 5m → mixed / UNSUPPORTED_TIMEFRAME', () => {
    const cs: Candle[] = []
    let t = T0
    for (let i = 0; i < 20; i++) { cs.push({ time: t, open: 10, high: 10.1, low: 9.9, close: 10, volume: 100 }); t += i % 2 === 0 ? 60 : 300 }
    expect(run(cs).status).toBe('UNSUPPORTED_TIMEFRAME')
  })
})

// ── Red-team §6: data-quality composition (multiple simultaneous defects preserved) ──────────────
describe('H4A composable data quality (§6)', () => {
  it('stale + missing-volume → primary status plus BOTH flags (no information lost)', () => {
    const cs = build(closes(Array.from({ length: 20 }, (_, i) => 10 + i * 0.1)).map(r => ({ ...r, v: 0 })) as Row[])
    const f = computeLocalStructure({ symbol: 'X', candles: cs, asOfMs: cs[cs.length - 1].time * 1000 + 10 * 60_000 })
    expect(['STALE_BARS', 'MISSING_VOLUME']).toContain(f.status)   // primary is one of them
    expect(f.qualityFlags).toContain('STALE_BARS')
    expect(f.qualityFlags).toContain('MISSING_VOLUME')             // the other is preserved as a flag
  })
})

// ── Red-team §7: premarket→RTH session-coverage provenance (descriptive only) ─────────────────────
describe('H4A session-coverage provenance (§7)', () => {
  it('a window spanning premarket→RTH is flagged, descriptively', () => {
    const pmStart = Math.floor(Date.parse('2026-09-18T09:20:00-04:00') / 1000)   // 09:20 ET, premarket
    const cs = build(closes(Array.from({ length: 20 }, (_, i) => 10 + i * 0.05)), 60, pmStart)  // 09:20→09:39 crosses 09:30
    const f = run(cs)
    expect(f.provenance.containsSessionBoundary).toBe(true)
    expect(f.provenance.sessionsInWindow).toEqual(expect.arrayContaining(['premarket', 'regular']))
    expect(f.qualityFlags).toContain('CONTAINS_SESSION_BOUNDARY')
  })
})

// ── Red-team §8: measured performance + telemetry volume (measure, don't just label) ──────────────
describe('H4A measured performance (§8)', () => {
  it('per-symbol compute latency and telemetry size are within bounds (and reported)', () => {
    const cs = build(closes(Array.from({ length: 180 }, (_, i) => 10 + Math.sin(i / 7) * 0.6 + i * 0.01)))
    const globals = { price: cs[cs.length - 1].close, sessionHigh: 12, vwap: 10.5, ema9: 10.8, ema21: 10.6, atr: 0.2, atrPct: 1.8, relativeVolume: 3, spreadPct: null }
    const N = 500, times: number[] = []
    for (let i = 0; i < N; i++) { const t0 = performance.now(); computeLocalStructure({ symbol: 'X', candles: cs, asOfMs: asOf(cs), globals }); times.push(performance.now() - t0) }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(N / 2)], p95 = times[Math.floor(N * 0.95)]
    // a compact telemetry event (the fields the daemon actually emits) — never a bar array
    const f = computeLocalStructure({ symbol: 'X', candles: cs, asOfMs: asOf(cs), globals })
    const evBytes = Buffer.byteLength(JSON.stringify({ symbol: 'X', leaderEpisodeId: 'led-X-1', resetState: f.resetState, status: f.status, qualityFlags: f.qualityFlags, timeframe: f.provenance.timeframe, impulsePct: f.impulse.pct, dominantImpulsePct: f.impulse.dominantImpulsePct, pullbackPct: f.pullback.pctFromImpulsePeak, baseRangePct: f.base.rangePct, localExtensionPct: f.localExtension.localExtensionPct, downsideToBaseLowPct: f.localExtension.downsideToBaseLowPct, globalVsLocalExtensionRatio: f.localExtension.globalVsLocalExtensionRatio, reExpansionObserved: f.reExpansion.observed, cadenceConsistency: f.provenance.cadenceConsistency, localFeatureConfigHash: f.provenance.localFeatureConfigHash }))
    console.log(`[H4A perf] 180-bar compute median=${median.toFixed(4)}ms p95=${p95.toFixed(4)}ms · event≈${evBytes}B · 15 syms/sweep≈${(p95 * 15).toFixed(2)}ms, ≈${(evBytes * 15)}B/sweep`)
    expect(p95).toBeLessThan(5)          // generous ceiling; negligible vs the 15s cadence + network fetch
    expect(evBytes).toBeLessThan(1024)   // compact; no bar arrays
  })
})

describe('H4A isolation (§18): no executor, no provider, no I/O', () => {
  const src = readFileSync(new URL('../src/lib/leader/local-structure.ts', import.meta.url), 'utf8')

  it('S. the engine imports NOTHING that fetches or touches execution', () => {
    // consumes shared/canonical data only (the Candle TYPE), computes in-process — no provider fan-out.
    for (const forbidden of ['fmp-client', 'yahoo-client', 'webull-client', 'PaperExecutor', 'execution/', 'fetch(', 'axios', 'node-fetch']) {
      expect(src.includes(forbidden), `local-structure must not reference ${forbidden}`).toBe(false)
    }
    // the only import is the Candle type from @/types
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
    expect(imports).toEqual(['@/types'])
  })

  it('Q/R. compute is synchronous (no awaited I/O) and returns a plain feature object', () => {
    const cs = build(closes(Array.from({ length: 20 }, (_, i) => 10 + i * 0.1)))
    const r = computeLocalStructure({ symbol: 'X', candles: cs, asOfMs: asOf(cs) })
    expect(r).not.toBeInstanceOf(Promise)            // pure, synchronous — cannot perform network I/O
    expect(typeof r.provenance.localFeatureConfigHash).toBe('string')
  })
})
