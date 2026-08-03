/**
 * Premarket relative volume — the participation measure premarket never had.
 * The candle feed reports premarket volume as 0, so before this the only
 * question a premarket signal could answer about volume was "is the data
 * missing?" (yes) — which is why duds fired.
 */
import { describe, it, expect } from 'vitest'
import {
  premarketVolumeProfile, premarketVolumeByDay, etHHMMNow, etDateNow,
} from '../src/lib/premarket-volume'

/** FMP historical-chart rows: ET wall-clock strings. */
function row(date: string, volume: number) {
  return { date, volume }
}

describe('premarketVolumeByDay', () => {
  it('sums only premarket bars, per session', () => {
    const byDay = premarketVolumeByDay([
      row('2026-08-03 04:05:00', 100),
      row('2026-08-03 08:30:00', 400),
      row('2026-08-03 10:15:00', 999_999),  // regular hours — not premarket
      row('2026-08-03 03:59:00', 500),      // before 04:00 — not premarket
      row('2026-07-31 08:30:00', 250),
    ], 930)
    expect(byDay.get('2026-08-03')).toBe(500)
    expect(byDay.get('2026-07-31')).toBe(250)
  })

  it('compares like for like: prior sessions are cut at the same time of day', () => {
    // At 06:00, yesterday's 08:00 volume has not "happened yet" — counting its
    // full session would make every early-premarket reading look dead.
    const rows = [
      row('2026-08-03 05:00:00', 300),
      row('2026-07-31 05:00:00', 100),
      row('2026-07-31 08:00:00', 5_000),
    ]
    expect(premarketVolumeByDay(rows, 600).get('2026-07-31')).toBe(100)
    expect(premarketVolumeByDay(rows, 930).get('2026-07-31')).toBe(5_100)
  })
})

describe('premarketVolumeProfile', () => {
  it('rates a gapper trading many times its normal premarket volume', () => {
    // Shape of UPC on 2026-08-03 (+102% on the day): ~625k premarket against a
    // baseline of a few hundred shares.
    const rows = [
      row('2026-08-03 08:00:00', 625_000),
      row('2026-07-31 08:00:00', 684),
      row('2026-07-30 08:00:00', 5_676),
      row('2026-07-29 08:00:00', 503),
      row('2026-07-28 08:00:00', 224),
    ]
    const p = premarketVolumeProfile(rows, { todayEt: '2026-08-03', throughHHMM: 900 })
    expect(p.todayVolume).toBe(625_000)
    expect(p.sessions).toBe(4)
    expect(p.relativeVolume!).toBeGreaterThan(100)
  })

  it('rates a name doing its usual premarket business at ~1×', () => {
    const rows = [
      row('2026-08-03 08:00:00', 210_000),
      row('2026-07-31 08:00:00', 200_000),
      row('2026-07-30 08:00:00', 175_000),
      row('2026-07-29 08:00:00', 220_000),
    ]
    const p = premarketVolumeProfile(rows, { todayEt: '2026-08-03', throughHHMM: 900 })
    expect(p.relativeVolume!).toBeGreaterThan(0.8)
    expect(p.relativeVolume!).toBeLessThan(1.3)
  })

  it('uses the median so one huge prior session does not hide today', () => {
    const rows = [
      row('2026-08-03 08:00:00', 400_000),
      row('2026-07-31 08:00:00', 20_000),
      row('2026-07-30 08:00:00', 20_000),
      row('2026-07-29 08:00:00', 4_000_000),  // one outlier day
    ]
    const p = premarketVolumeProfile(rows, { todayEt: '2026-08-03', throughHHMM: 900 })
    expect(p.baselineVolume).toBe(20_000)
    expect(p.relativeVolume!).toBeCloseTo(20, 0)
  })

  it('floors a near-zero baseline instead of returning a meaningless ratio', () => {
    const rows = [
      row('2026-08-03 08:00:00', 50_000),
      row('2026-07-31 08:00:00', 3),
      row('2026-07-30 08:00:00', 5),
    ]
    const p = premarketVolumeProfile(rows, { todayEt: '2026-08-03', throughHHMM: 900 })
    // 50k / 4 shares would be 12,500× — precision theatre. Floored to 1,000.
    expect(p.relativeVolume).toBe(50)
  })

  it('reports null (not a number to gate on) when there is no prior history', () => {
    const p = premarketVolumeProfile([row('2026-08-03 08:00:00', 50_000)], {
      todayEt: '2026-08-03', throughHHMM: 900,
    })
    expect(p.todayVolume).toBe(50_000)
    expect(p.relativeVolume).toBeNull()
    expect(p.sessions).toBe(0)
  })

  it('reports a measured zero for a name that has not traded premarket', () => {
    const rows = [row('2026-07-31 08:00:00', 40_000), row('2026-07-30 08:00:00', 40_000)]
    const p = premarketVolumeProfile(rows, { todayEt: '2026-08-03', throughHHMM: 900 })
    expect(p.todayVolume).toBe(0)
    expect(p.relativeVolume).toBe(0)
  })
})

describe('ET clock helpers', () => {
  it('reads the ET wall clock, not the host clock', () => {
    // 2026-08-03 13:30 UTC = 09:30 ET (EDT) = 14:30 in Europe/London.
    const ts = Date.UTC(2026, 7, 3, 13, 30)
    expect(etHHMMNow(ts)).toBe(930)
    expect(etDateNow(ts)).toBe('2026-08-03')
  })

  it('keeps the ET date when London has already rolled over', () => {
    // 01:00 UTC = 21:00 ET the previous day.
    expect(etDateNow(Date.UTC(2026, 7, 4, 1, 0))).toBe('2026-08-03')
  })
})
