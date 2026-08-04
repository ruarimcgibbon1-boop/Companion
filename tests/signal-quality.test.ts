/**
 * Signal-quality guardrails added from the 2026-07-06/07 trade review:
 *  - long-bounce rollover veto (don't buy falling knives off the session high)
 *  - minimum stop-width floor (no degenerate sub-1.5% scalps)
 */
import { describe, it, expect } from 'vitest'
import {
  detectSetups, rollingOver, longBounceRolledOver, volumeExpanding, type DetectionContext,
} from '../src/lib/setup-detectors'
import { buildKeyLevels } from '../src/lib/levels-engine'
import { calculateSessionLevels } from '../src/lib/technical'
import type { Candle, SessionLevels, TechnicalData } from '../src/types'

function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * 300,
    open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c, volume: 100_000,
  }))
}

function technical(over: Partial<TechnicalData> = {}): TechnicalData {
  return {
    vwap: 4.9, ema9: 4.92, ema20: 4.85, ma50Intraday: 4.8, rsi14: 60, atr: 0.08,
    relativeVolume: 3, volumeTrend: 'flat', trend5m: 'up', trend15m: 'up',
    vwapCrossCount: 1, higherHighsLows: true, lowerHighsLows: false,
    distanceFromVwapPct: 2, distanceFromDayHighPct: -1, ma50Daily: 4.5, ma200Daily: 4.0,
    dailyRsi: 58, dailyAtr: 0.2, gapPct: 5, fiveDayHigh: 5.2, fiveDayLow: 4.2,
    twentyDayHigh: 5.5, twentyDayLow: 3.8, avgVolume20d: 1_000_000, isBreakingOutOfRange: false,
    ...over,
  }
}

function session(over: Partial<SessionLevels> = {}): SessionLevels {
  return {
    premarketHigh: 5.1, premarketLow: 4.6, premarketVolume: 500_000, regularHigh: 5.05,
    regularLow: 4.8, openingPrint: 4.85, or5High: 4.95, or5Low: 4.82, or15High: 5.0,
    or15Low: 4.8, vwap: 4.9, previousClose: 4.7, previousDayHigh: 5.15, previousDayLow: 4.5,
    ...over,
  }
}

function ctx(candles: Candle[], price: number, over: Partial<DetectionContext> = {}): DetectionContext {
  const sl = session({ vwap: over.sessionLevels?.vwap ?? price })
  const t = technical(over.technical)
  const levels = buildKeyLevels({ intraday: candles, daily: [], sessionLevels: sl, technical: t, currentPrice: price })
  return {
    symbol: 'TEST', price, candles, sessionLevels: sl, technical: t, levels,
    catalystScore: 10, hasCatalyst: true, spreadPct: 0.15, changePct: 6,
    session: 'regular', minutesSinceOpen: 60, float: 5_000_000, ...over,
  }
}

describe('volumeExpanding', () => {
  const vbars = (vols: number[]): Candle[] =>
    vols.map((v, i) => ({ time: 1_700_000_000 + i * 300, open: 5, high: 5.1, low: 4.9, close: 5, volume: v }))

  it('confirms sustained-volume continuation (thrust above the recent lull)', () => {
    // A mid-trend break: the break bar beats the immediate prior bars by >20%,
    // even though it is NOT an outsized spike vs a long trending average.
    // prior avg 265k, last 350k > 318k → confirms.
    expect(volumeExpanding(vbars([300_000, 280_000, 260_000, 240_000, 250_000, 260_000, 350_000]))).toBe(true)
  })

  it('rejects a break on fading volume', () => {
    expect(volumeExpanding(vbars([300_000, 280_000, 260_000, 250_000, 240_000, 230_000, 210_000]))).toBe(false)
  })

  it('rejects flat volume (no expansion on the break)', () => {
    expect(volumeExpanding(vbars([200_000, 200_000, 200_000, 200_000, 200_000, 200_000, 200_000]))).toBe(false)
  })

  it('is not fooled by an inflated long-run average the way a 20-bar baseline was', () => {
    // A huge spike 12 bars back sits OUTSIDE the 8-bar lookback, so the recent
    // thrust (220k vs a ~150k lull) still confirms — a 20-bar mean would have
    // been dragged up by that early spike and rejected it.
    expect(volumeExpanding(vbars([
      2_000_000, 150_000, 150_000, 150_000, 150_000, 150_000, 150_000, 150_000, 150_000, 150_000, 150_000, 220_000,
    ]))).toBe(true)
  })
})

describe('rollingOver', () => {
  it('flags a lower-highs down-leg', () => {
    expect(rollingOver(bars([5.5, 5.4, 5.3, 5.2]))).toBe(true)
  })
  it('does not flag a rising sequence', () => {
    expect(rollingOver(bars([4.8, 4.9, 5.0, 5.1]))).toBe(false)
  })
})

describe('longBounceRolledOver', () => {
  it('vetoes when price is >8% off the session high on lower highs (CLRO/JLHL pattern)', () => {
    // ran to 5.5 then bled to ~4.8 (≈13% off high) making lower highs
    const c = bars([5.0, 5.3, 5.5, 5.35, 5.15, 4.95, 4.8])
    expect(longBounceRolledOver(ctx(c, 4.8, { technical: technical({ distanceFromDayHighPct: -13 }) }))).toBe(true)
  })
  it('does not veto a shallow pullback near the highs (SKIN/LUCY winners)', () => {
    const c = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0])
    expect(longBounceRolledOver(ctx(c, 5.0, { technical: technical({ distanceFromDayHighPct: -1 }) }))).toBe(false)
  })
  it('vetoes at the tightened 5% threshold (6% off high, rolling — was missed at 8%)', () => {
    const c = bars([5.3, 5.2, 5.1, 5.05, 5.0, 4.95, 4.9])
    expect(longBounceRolledOver(ctx(c, 4.9, { technical: technical({ distanceFromDayHighPct: -6, atr: 0.08 }) }))).toBe(true)
  })
  it('does NOT veto a high-ATR momentum name for a sub-1.5-ATR pullback (2026-07-10 JZXN)', () => {
    // atr 0.4 on a ~4.9 price ≈ 8% ATR → 6% off high is <1 ATR, just breathing
    const c = bars([5.3, 5.2, 5.1, 5.05, 5.0, 4.95, 4.9])
    expect(longBounceRolledOver(ctx(c, 4.9, { technical: technical({ distanceFromDayHighPct: -6, atr: 0.4 }) }))).toBe(false)
  })
  it('falls back to a candle scan when the day-high reading is unavailable', () => {
    const c = bars([5.0, 5.3, 5.5, 5.35, 5.15, 4.95, 4.8])
    expect(longBounceRolledOver(ctx(c, 4.8, { technical: technical({ distanceFromDayHighPct: null }) }))).toBe(true)
  })
  it('vetoes deep off the high even on a green bounce candle (2026-07-13 BRAI)', () => {
    // 17% off high (well past 1.5× the 5% threshold); last candle bounces up so
    // rollingOver() is false — the old gate would de-arm here and re-fire the knife.
    const c = bars([5.0, 4.9, 4.7, 4.6, 4.8])
    expect(rollingOver(c)).toBe(false)
    expect(longBounceRolledOver(ctx(c, 4.8, { technical: technical({ distanceFromDayHighPct: -17 }) }))).toBe(true)
  })
  it('does NOT deep-override a moderate pullback with a green last candle', () => {
    // 6% off high: past the 5% threshold but short of the 7.5% deep floor, and not
    // rolling over — a shallow bounce that must still be allowed to fire.
    const c = bars([5.0, 4.9, 4.7, 4.6, 4.8])
    expect(longBounceRolledOver(ctx(c, 4.8, { technical: technical({ distanceFromDayHighPct: -6 }) }))).toBe(false)
  })
})

describe('premarket-anchored VWAP', () => {
  // Timestamps for 08:00 ET *today* (EDT = -04:00 in July), robust to the machine's
  // local timezone. These are today's premarket bars with NO regular-session bars.
  function todayPremarketBars(closes: number[]): Candle[] {
    const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
    const base = Math.floor(new Date(`${etDate}T08:00:00-04:00`).getTime() / 1000)
    return closes.map((c, i) => ({
      time: base + i * 60,
      open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c, volume: 50_000,
    }))
  }

  // "Today premarket" only exists on a weekday — isTodayPremarket() is false on
  // Sat/Sun, so this session-behavior test can't run on a weekend.
  const isEtWeekend = ['Sat', 'Sun'].includes(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date()))
  it.skipIf(isEtWeekend)('produces a VWAP from premarket candles when there is no regular session yet', () => {
    const candles = todayPremarketBars([2.0, 2.1, 2.25, 2.3, 2.28, 2.35, 2.4])
    const sl = calculateSessionLevels(candles, [])
    // Before this change vwap was null in premarket (regular-only) — now it anchors to premarket.
    expect(sl.vwap).not.toBeNull()
    expect(sl.vwap!).toBeGreaterThan(2.0)
    expect(sl.vwap!).toBeLessThan(2.4)
    expect(sl.premarketHigh).toBeCloseTo(2.42, 1)
  })
})

describe('entry-on-trigger + extension drop', () => {
  // A rising series that closes strong, so a long bounce/momentum setup can trigger.
  const rising = bars([4.7, 4.78, 4.86, 4.95, 5.0, 5.04, 5.08])

  it('entryFill is the current price when price is above the zone (buy the reclaim, not a limit below)', () => {
    const setups = detectSetups(ctx(rising, 5.08))
    const longs = setups.filter(s => s.direction === 'long' && s.entryFill != null)
    expect(longs.length).toBeGreaterThan(0)
    for (const s of longs) {
      // never asks you to enter below current price on a long
      expect(s.entryFill!).toBeGreaterThanOrEqual(Math.min(s.zoneUpper, 5.08) - 1e-9)
    }
  })

  it('does not trigger a long bounce when price is >4% above the entry zone (a chase, not a bounce)', () => {
    // price 5.50 sits ~8% above a ~5.05 zone — the PRME-EMA21 / ELTX-pullback case
    const setups = detectSetups(ctx(rising, 5.5))
    for (const s of setups) {
      if (s.direction === 'long' && s.zoneUpper > 0 && 5.5 > s.zoneUpper * 1.04) {
        expect(s.state).not.toBe('triggered')
        expect(s.triggeredRaw ?? false).toBe(false)
      }
    }
  })
})

describe('data-integrity gate', () => {
  it('builds no setups when the quote price is wildly outside the candle tape', () => {
    const c = bars([1.09, 1.10, 1.11, 1.10, 1.12, 1.13, 1.11])   // tape ~1.07–1.15
    expect(detectSetups(ctx(c, 1.55)).length).toBe(0)             // quote 1.55 = ~35% above (DCX/HAO case)
  })
  it('still trades a genuine fast tick just above recent highs', () => {
    const c = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0])
    expect(detectSetups(ctx(c, 5.2)).length).toBeGreaterThan(0)   // 5.2 within 10% of the ~5.08 high
  })
})

describe('liquidity floor', () => {
  it('builds no setups on an untradeable name (recent $-vol under the floor)', () => {
    const thin = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0]).map(c => ({ ...c, volume: 300 }))
    expect(detectSetups(ctx(thin, 5.0)).length).toBe(0)          // ~300 sh × $5 × 5 bars ≈ $7.5k < $50k
  })
  it('still trades the same shape at normal volume', () => {
    const liquid = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0])  // 100k sh/bar default
    expect(detectSetups(ctx(liquid, 5.0)).length).toBeGreaterThan(0)
  })
  it('never emits a long target at or below the entry fill', () => {
    // invariant: every target must be beyond the actual fill (2026-07-22 KUST/MWC/INM bug)
    for (const p of [4.8, 5.0, 5.06]) {
      for (const s of detectSetups(ctx(bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0]), p))) {
        if (s.direction !== 'long' || s.entryFill == null) continue
        for (const t of s.targets) expect(t.price).toBeGreaterThan(s.entryFill)
      }
    }
  })
  it('does NOT block when the feed reports no volume at all (data gap, not illiquidity)', () => {
    // Yahoo premarket returns bars with price but volume 0 — gating on that
    // silently blocked every premarket setup on every symbol.
    const noVol = bars([4.7, 4.8, 4.9, 5.0, 5.06, 5.02, 5.0]).map(c => ({ ...c, volume: 0 }))
    expect(detectSetups(ctx(noVol, 5.0)).length).toBeGreaterThan(0)
  })
})

describe('detectVwap trend guard', () => {
  it('does not fire a vwap_bounce when the 5-min trend is down (fade, not a bounce)', () => {
    // price sitting just above VWAP (4.9) but the immediate trend has rolled over
    const c = bars([5.2, 5.1, 5.05, 5.0, 4.95, 4.92, 4.93])
    const setups = detectSetups(ctx(c, 4.93, { technical: technical({ trend5m: 'down' }) }))
    expect(setups.some(s => s.type === 'vwap_bounce')).toBe(false)
  })
  it('still fires a vwap_bounce when the trend is up', () => {
    const c = bars([4.7, 4.8, 4.85, 4.88, 4.9, 4.92, 4.93])
    const setups = detectSetups(ctx(c, 4.93, { technical: technical({ trend5m: 'up' }) }))
    expect(setups.some(s => s.type === 'vwap_bounce')).toBe(true)
  })
})

describe('opening-window bounce lockout', () => {
  // Above a VWAP anchored below price: a run-up, a 3-bar pullback (volume drying
  // up), then a green new-high confirmation bar on a volume spike — the full
  // Warrior micro-pullback shape a real vwap_bounce now requires.
  const vbVols = [150_000, 200_000, 180_000, 140_000, 120_000, 100_000, 400_000]
  const vb = [4.75, 4.85, 4.92, 4.90, 4.88, 4.87, 4.95].map((c, i) => ({
    time: 1_700_000_000 + i * 300, open: c - 0.005, high: c + 0.01, low: c - 0.005, close: c,
    volume: vbVols[i],
  }))
  const over = { sessionLevels: session({ vwap: 4.85 }) }

  it('does NOT trigger a bounce BUY in the first 15 minutes of RTH (open whipsaw)', () => {
    const vbSetup = detectSetups(ctx(vb, 4.93, { ...over, minutesSinceOpen: 5 })).find(s => s.type === 'vwap_bounce')
    if (vbSetup) expect(vbSetup.triggeredRaw).toBe(false) // still a visible watch, just no BUY
  })
  it('allows the bounce BUY once past the opening window', () => {
    const setups = detectSetups(ctx(vb, 4.93, { ...over, minutesSinceOpen: 20 }))
    expect(setups.some(s => s.type === 'vwap_bounce' && s.triggeredRaw)).toBe(true)
  })

  it('does NOT trigger without a confirming volume surge on the bounce bar', () => {
    // same shape but volume keeps declining through the reclaim — no confirmation
    const noSurge = vb.map((c, i) => ({ ...c, volume: 200_000 - i * 18_000 }))
    const s = detectSetups(ctx(noSurge, 4.93, { ...over, minutesSinceOpen: 20 })).find(x => x.type === 'vwap_bounce')
    if (s) expect(s.triggeredRaw).toBe(false)
  })

  it('does NOT trigger a bounce on a dead-range name (ATR under the floor)', () => {
    // atr 0.03 on ~4.93 ≈ 0.6% — too tight to respect the level
    const s = detectSetups(ctx(vb, 4.93, { ...over, minutesSinceOpen: 20, technical: technical({ atr: 0.03 }) }))
      .find(x => x.type === 'vwap_bounce')
    if (s) expect(s.triggeredRaw).toBe(false)
  })

  it('does NOT trigger a bounce on a chop day (VWAP crossed more than 3 times)', () => {
    const s = detectSetups(ctx(vb, 4.93, { ...over, minutesSinceOpen: 20, technical: technical({ vwapCrossCount: 6 }) }))
      .find(x => x.type === 'vwap_bounce')
    if (s) expect(s.triggeredRaw).toBe(false)
  })

  it('quarantines ema9_bounce triggers (still visible as a watch)', () => {
    const setups = detectSetups(ctx(vb, 4.93, { ...over, minutesSinceOpen: 20 }))
    expect(setups.some(s => s.type === 'ema9_bounce' && s.triggeredRaw)).toBe(false)
  })
})

describe('in-play gate', () => {
  const over = { sessionLevels: session({ vwap: 4.85 }) }
  // the winning vwap_bounce shape (pullback → green new-high on a volume spike)
  const vbVols = [150_000, 200_000, 180_000, 140_000, 120_000, 100_000, 400_000]
  const vb = [4.75, 4.85, 4.92, 4.90, 4.88, 4.87, 4.95].map((c, i) => ({
    time: 1_700_000_000 + i * 300, open: c - 0.005, high: c + 0.01, low: c - 0.005, close: c, volume: vbVols[i],
  }))
  // A drifter is NOT in play: weak RVOL, no catalyst, high float, small change.
  const dead = { minutesSinceOpen: 30, hasCatalyst: false, changePct: 2, float: 80_000_000, technical: technical({ relativeVolume: 0.6 }) }
  const isVbTrig = (o: object) => detectSetups(ctx(vb, 4.95, { ...over, ...dead, ...o })).some(s => s.type === 'vwap_bounce' && s.triggeredRaw)

  it('blocks a bounce on a dead drifter (weak RVOL, no catalyst, high float, small move)', () => {
    expect(isVbTrig({})).toBe(false)
  })
  it('lets it through on strong RVOL alone', () => {
    expect(isVbTrig({ technical: technical({ relativeVolume: 3 }) })).toBe(true)
  })
  it('lets it through on a catalyst alone', () => {
    expect(isVbTrig({ hasCatalyst: true })).toBe(true)
  })
  it('lets it through on a real gap alone', () => {
    expect(isVbTrig({ changePct: 9 })).toBe(true)
  })
  it('lets it through on low float with normal-pace volume', () => {
    expect(isVbTrig({ float: 8_000_000, technical: technical({ relativeVolume: 1.2 }) })).toBe(true)
  })
})

describe('confirmation-candle entry (buy the new high, not the dip)', () => {
  const over = { sessionLevels: session({ vwap: 4.85 }) }
  it('does NOT trigger on a monotonic rise with no pullback (a chase)', () => {
    // straight up into VWAP — no digestion, no confirmation candle
    const chase = [4.80, 4.83, 4.86, 4.89, 4.91, 4.93, 4.95].map((c, i) => ({
      time: 1_700_000_000 + i * 300, open: c - 0.005, high: c + 0.01, low: c - 0.005, close: c,
      volume: 100_000 + i * 40_000,
    }))
    const s = detectSetups(ctx(chase, 4.95, { ...over, minutesSinceOpen: 30 })).find(x => x.type === 'vwap_bounce')
    if (s) expect(s.triggeredRaw).toBe(false)
  })
  it('does NOT trigger when the confirmation bar closes red (upper-wick rejection)', () => {
    // pullback then a bar that pokes a new high but closes red
    const rej = [
      { c: 4.75, o: 4.745 }, { c: 4.90, o: 4.80 }, { c: 4.88, o: 4.90 },
      { c: 4.86, o: 4.88 }, { c: 4.85, o: 4.86 }, { c: 4.86, o: 4.855 },
      { c: 4.88, o: 4.96 }, // new intrabar high (4.98) but closes red, below open
    ].map((b, i) => ({ time: 1_700_000_000 + i * 300, open: b.o, high: Math.max(b.c, b.o) + 0.02, low: Math.min(b.c, b.o) - 0.005, close: b.c, volume: i === 6 ? 400_000 : 120_000 }))
    const s = detectSetups(ctx(rej, 4.88, { ...over, minutesSinceOpen: 30 })).find(x => x.type === 'vwap_bounce')
    if (s) expect(s.triggeredRaw).toBe(false)
  })
})

describe('opening-range break / gap-and-go', () => {
  // Rising into a fresh HOD with an expanding final bar (session: or15High 5.0, premarketHigh 5.1).
  const orb = bars([4.88, 4.9, 4.95, 5.0, 5.05, 5.1, 5.15]).map((c, i, a) =>
    i === a.length - 1 ? { ...c, volume: 350_000 } : c)

  it('fires a triggered opening_range_break when a green name breaks the range above VWAP on volume', () => {
    const setups = detectSetups(ctx(orb, 5.15, { changePct: 6, technical: technical({ trend5m: 'up' }) }))
    const s = setups.find(x => x.type === 'opening_range_break')
    expect(s).toBeTruthy()
    expect(s!.triggeredRaw).toBe(true)
  })
  it('does NOT fire once price has lost VWAP (a fade, not a go)', () => {
    // same tape but VWAP anchored above the quote — price has lost VWAP
    const setups = detectSetups(ctx(orb, 4.85, { changePct: 6, sessionLevels: session({ vwap: 5.0 }) }))
    expect(setups.some(s => s.type === 'opening_range_break')).toBe(false)
  })
  it('does NOT fire when the name is red on the day', () => {
    const setups = detectSetups(ctx(orb, 5.15, { changePct: -2 }))
    expect(setups.some(s => s.type === 'opening_range_break')).toBe(false)
  })
})

describe('HOD-break continuation', () => {
  // Ran to ~5.02, coiled tight just under it for a few bars, then breaks on volume.
  const laddered = bars([4.5, 4.7, 4.9, 5.0, 4.98, 5.0, 4.99, 5.10]).map((c, i, a) =>
    i === a.length - 1 ? { ...c, volume: 350_000 } : c)

  it('fires a triggered hod_break on a new-high push out of a tight base, on volume', () => {
    const setups = detectSetups(ctx(laddered, 5.10, { technical: technical({ trend5m: 'up' }) }))
    const s = setups.find(x => x.type === 'hod_break')
    expect(s).toBeTruthy()
    expect(s!.triggeredRaw).toBe(true)
  })
  it('does NOT fire on a vertical run into the high (no base = chase / blow-off)', () => {
    const ramp = bars([4.0, 4.2, 4.4, 4.6, 4.8, 5.0, 5.1, 5.2]).map((c, i, a) =>
      i === a.length - 1 ? { ...c, volume: 350_000 } : c)
    expect(detectSetups(ctx(ramp, 5.2)).some(s => s.type === 'hod_break')).toBe(false)
  })
  it('does NOT fire when the 5-min trend is down', () => {
    const setups = detectSetups(ctx(laddered, 5.10, { technical: technical({ trend5m: 'down' }) }))
    expect(setups.some(s => s.type === 'hod_break')).toBe(false)
  })
})

describe('premarket breakout', () => {
  // Gapper pushing through its premarket high (session: premarketHigh 5.1, previousClose 4.7 → ~+9% gap).
  const gapper = bars([4.9, 4.95, 5.0, 5.05, 5.1, 5.08, 5.15]).map((c, i, a) =>
    i === a.length - 1 ? { ...c, volume: 400_000 } : c)

  it('fires a triggered premarket_breakout on a gapper breaking the PM high above VWAP', () => {
    const setups = detectSetups(ctx(gapper, 5.15, { session: 'premarket' }))
    const s = setups.find(x => x.type === 'premarket_breakout')
    expect(s).toBeTruthy()
    expect(s!.triggeredRaw).toBe(true)
  })
  it('does NOT fire during regular hours (ORB owns the open)', () => {
    const setups = detectSetups(ctx(gapper, 5.15, { session: 'regular' }))
    expect(setups.some(s => s.type === 'premarket_breakout')).toBe(false)
  })
  it('does NOT fire without a real gap (previousClose near price)', () => {
    // previousClose bumped to 5.10 → gap < 4%
    const setups = detectSetups(ctx(gapper, 5.15, { session: 'premarket', sessionLevels: session({ previousClose: 5.10 }) }))
    expect(setups.some(s => s.type === 'premarket_breakout')).toBe(false)
  })

  // Premarket in-play is judged by PRICE (a real top-gainer move), with volume as a
  // bonus when the feed actually has the tape. The feed CANNOT see the biggest
  // rockets — FMP had 55 premarket shares for HYFM, which gapped $0.54→$3.44 — so a
  // hard volume gate blocks precisely the trades we want. A flat, low-gap name is
  // the dud; a big gapper with a wide premarket range is the trade.

  // A modest gap that isn't really moving, on unremarkable volume: neither the
  // volume arm nor the price arm passes → no BUY (still visible as a watch).
  const flatLowGapSession = () => session({ previousClose: 5.0, premarketHigh: 5.1, premarketLow: 5.02 })
  it('does NOT trigger on a flat, low-gap name (a dud that does not move)', () => {
    const s = detectSetups(ctx(gapper, 5.15, {
      session: 'premarket', sessionLevels: flatLowGapSession(),
      technical: technical({ relativeVolume: 1.2 }),   // gap ~3%, range ~1.6%, rvol 1.2
    })).find(x => x.type === 'premarket_breakout')
    expect(s).toBeTruthy()
    expect(s!.triggeredRaw).toBe(false)
  })

  it('triggers that same flat name once volume genuinely surges', () => {
    const s = detectSetups(ctx(gapper, 5.15, {
      session: 'premarket', sessionLevels: flatLowGapSession(),
      technical: technical({ relativeVolume: 12 }),    // volume arm carries it
    })).find(x => x.type === 'premarket_breakout')
    expect(s!.triggeredRaw).toBe(true)
  })

  it('triggers a big premarket mover the feed cannot see — in play on PRICE (the HYFM case)', () => {
    // Huge gap + wide premarket range, but no usable volume (rvol null). This is the
    // exact name we were missing: it must fire on price, and say the volume is uncovered.
    const s = detectSetups(ctx(gapper, 5.15, {
      session: 'premarket',
      sessionLevels: session({ previousClose: 3.0, premarketHigh: 5.1, premarketLow: 3.2 }),
      technical: technical({ relativeVolume: null }),
    })).find(x => x.type === 'premarket_breakout')
    expect(s!.triggeredRaw).toBe(true)
    expect(s!.risks.some(r => /feed|price|covered/i.test(r))).toBe(true)
  })
})

// Targets. The book is momentum — low win rate, high payoff — so a first target
// has to be worth scaling into and the ladder has to leave room for the runner.
// 2026-07-31 rated AMCX's ORB T1 at +0.6% (seven cents on an 11.50 fill), which
// is the shape of "we exit a 40% move at +3%".
// Anti-fade gate (2026-08-04 CSV: breakouts fired 20-43% below the session high
// won 20% vs 37% near the high). A chase-family break far under the day high is a
// fade, not a breakout — it must not log a BUY.
describe('anti-fade gate', () => {
  // A break_of_structure (chase family) over rising swing highs.
  const bosBars = () => bars([4.00, 4.06, 4.15, 4.08, 4.02, 4.12, 4.28, 4.20, 4.14, 4.24, 4.40, 4.32, 4.26, 4.36, 4.52, 4.46, 4.50, 4.54])
  const bosAt = (distHigh: number) =>
    detectSetups(ctx(bosBars(), 4.54, { technical: technical({ distanceFromDayHighPct: distHigh }) }))
      .find(s => s.type === 'break_of_structure')

  it('vetoes a chase-family break fired far below the session high (a fade)', () => {
    const s = bosAt(-20)
    expect(s).toBeTruthy()
    expect(s!.qualityVetoed).toBe(true)   // stays visible as a watch, logs no BUY
  })

  it('allows the same break near the high', () => {
    const s = bosAt(-1)
    expect(s).toBeTruthy()
    expect(s!.qualityVetoed).toBe(false)
  })
})

describe('target ladder geometry', () => {
  function breakBars(): Candle[] {
    const closes = [4.85, 4.88, 4.90, 4.92, 4.95, 4.98, 5.02, 5.06, 5.10, 5.14, 5.18]
    return closes.map((c, i) => ({
      time: 1_700_000_000 + i * 300,
      open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c,
      volume: i === closes.length - 1 ? 400_000 : 100_000,
    }))
  }
  const longs = (over: Partial<DetectionContext> = {}) =>
    detectSetups(ctx(breakBars(), 5.18, {
      technical: technical({ atr: 0.30, distanceFromDayHighPct: 0 }),   // ~5.8% ATR: a mover
      sessionLevels: session({ premarketHigh: 4.9, vwap: 5.0 }),
      ...over,
    })).filter(s => s.direction === 'long' && s.targets.length > 0 && s.entryFill != null)

  it('never rates a first target inside a real move of the fill', () => {
    const setups = longs()
    expect(setups.length).toBeGreaterThan(0)
    for (const s of setups) {
      const gain = (s.targets[0].price - s.entryFill!) / s.entryFill!
      expect(gain).toBeGreaterThanOrEqual(0.02)   // ≥ 2% of price…
      expect(s.targets[0].price - s.entryFill!).toBeGreaterThanOrEqual(0.30 * 0.99) // …and ≥ 1 ATR here
    }
  })

  it('spaces the rungs so scaling out three times is three different exits', () => {
    for (const s of longs()) {
      for (let i = 1; i < s.targets.length; i++) {
        const gap = s.targets[i].price - s.targets[i - 1].price
        expect(gap).toBeGreaterThanOrEqual(Math.max(s.entryFill! * 0.015, 0.30 * 0.5) * 0.99)
      }
    }
  })

  it('extends the ladder to a 10% runner when the levels above stop short', () => {
    for (const s of longs()) {
      const top = s.targets[s.targets.length - 1]
      expect(top.price).toBeGreaterThanOrEqual(s.entryFill! * 1.10 * 0.999)
      expect(s.targets.length).toBeLessThanOrEqual(3)
    }
  })

  it('does NOT invent a 10% runner on a name too quiet to reach it', () => {
    // ATR 0.02 on a $5 name (~0.4%): 10% is ~25 ATR away — fantasy, and it would
    // fake a huge R/R. Level-based targets only.
    for (const s of longs({ technical: technical({ atr: 0.02, distanceFromDayHighPct: 0 }) })) {
      expect(s.targets.some(t => t.label.includes('runner'))).toBe(false)
    }
  })
})

describe('new momentum setups', () => {
  it('detects a bull flag — sharp pole then a tight consolidation', () => {
    const c = bars([3.98,4.08,4.20,4.30,4.42,4.50,4.56,4.60,4.62, 4.55,4.52,4.54,4.53,4.56])
    expect(detectSetups(ctx(c, 4.56)).some(s => s.type === 'bull_flag')).toBe(true)
  })

  it('bull flag carries measured-move targets above the pole high', () => {
    const c = bars([3.98,4.08,4.20,4.30,4.42,4.50,4.56,4.60,4.62, 4.55,4.52,4.54,4.53,4.56])
    const bf = detectSetups(ctx(c, 4.56)).find(s => s.type === 'bull_flag')
    expect(bf).toBeTruthy()
    expect(bf!.targets.some(t => t.price > 4.64)).toBe(true)   // 1× measured move clears the pole high
  })

  it('detects a break of structure — rising swing highs over a higher low', () => {
    const c = bars([4.00,4.06,4.15,4.08,4.02,4.12,4.28,4.20,4.14,4.24,4.40,4.32,4.26,4.36,4.52,4.46,4.50,4.54])
    expect(detectSetups(ctx(c, 4.54)).some(s => s.type === 'break_of_structure')).toBe(true)
  })

  it('does not fire momentum setups in a clear downtrend', () => {
    const c = bars([4.62,4.5,4.4,4.3,4.2,4.1,4.0,3.9,3.8,3.75,3.7,3.68,3.66,3.64])
    const types = new Set(detectSetups(ctx(c, 3.64, { technical: technical({ trend5m: 'down' }) })).map(s => s.type))
    expect(types.has('bull_flag')).toBe(false)
    expect(types.has('break_of_structure')).toBe(false)
  })
})

describe('stop-width floors', () => {
  // Strength entries (breaks/reclaims) trail the stop up to the breakout pivot —
  // ~1.3 ATR under the fill — so they are intentionally tighter than the 1.5%
  // bounce floor. Mean-reversion bounces keep the 1.5% noise floor.
  const STRENGTH = new Set([
    'breakout', 'bull_flag', 'break_of_structure', 'opening_range_break',
    'vwap_reclaim', 'level_reclaim',
  ])

  it('bounce/pullback longs never carry a stop tighter than 1.5% (SEER noise floor)', () => {
    const c = bars([4.9, 4.95, 5.0, 5.02, 5.0, 5.01, 5.0])
    const setups = detectSetups(ctx(c, 5.0, { technical: technical({ atr: 0.005 }) }))
    const bounces = setups.filter(s => s.direction === 'long' && s.entryFill != null && !STRENGTH.has(s.type))
    for (const s of bounces) {
      expect(s.entryFill! - s.invalidation).toBeGreaterThanOrEqual(5.0 * 0.015 - 1e-9)
    }
  })

  it('strength longs use a volatility-aware pivot stop, floored so it is never razor-thin', () => {
    // Tiny ATR would otherwise yield a razor-thin stop (the SEER 0.6% case); the
    // 0.4%-of-fill floor binds here and keeps the stop well clear of noise.
    const c = bars([4.9, 4.95, 5.0, 5.02, 5.0, 5.01, 5.0])
    const setups = detectSetups(ctx(c, 5.0, { technical: technical({ atr: 0.005 }) }))
    const strength = setups.filter(s => s.direction === 'long' && s.entryFill != null && STRENGTH.has(s.type))
    expect(strength.length).toBeGreaterThan(0)
    for (const s of strength) {
      const stopDist = s.entryFill! - s.invalidation
      // pivot = max(1.3 × ATR, 0.4% of fill); with ATR 0.005 the % floor wins.
      expect(stopDist).toBeGreaterThanOrEqual(Math.max(1.3 * 0.005, s.entryFill! * 0.004) - 1e-9)
      expect(stopDist).toBeGreaterThan(0.005) // never merely the razor-thin ATR
    }
  })
})

describe('breakout R/R geometry (2026-07-23 NVEC regression)', () => {
  // Enter a break on the confirmed new high but fill ABOVE the trigger (a chase):
  // the stop must trail up to the breakout pivot, not sit at the far base low,
  // and R/R must be rated against a meaningful target — not a bp-away noise level.
  // Before the fix this logged as a benched 0.1R; now it is a real, tradeable setup.
  function risingBreak(): Candle[] {
    const closes = [4.85, 4.88, 4.90, 4.92, 4.95, 4.98, 5.02, 5.06, 5.10, 5.14, 5.18]
    return closes.map((c, i) => ({
      time: 1_700_000_000 + i * 300,
      open: c - 0.01, high: c + 0.02, low: c - 0.02, close: c,
      // last bar's volume expands (>1.3× avg) so the break confirms
      volume: i === closes.length - 1 ? 400_000 : 100_000,
    }))
  }

  const c = risingBreak()
  // premarketHigh below the OR high so the break level is the OR high (5.0),
  // leaving the fill (5.18) a realistic ~3.6% above the trigger.
  const setups = detectSetups(ctx(c, 5.18, {
    technical: technical({ atr: 0.05, distanceFromDayHighPct: 0 }),
    sessionLevels: session({ premarketHigh: 4.9, vwap: 5.0 }),
  }))
  const strength = setups.filter(s =>
    s.direction === 'long' && s.entryFill != null &&
    ['opening_range_break', 'break_of_structure', 'breakout'].includes(s.type))

  it('produces a strength setup on the chased break', () => {
    expect(strength.length).toBeGreaterThan(0)
  })

  it('trails the stop to the pivot (~1.3 ATR under the fill), not the base low', () => {
    for (const s of strength) {
      const risk = s.entryFill! - s.invalidation
      // pivot risk ≈ 0.065 (1.3 × 0.05); the old base-low stop would be ~4% (~0.2).
      expect(risk).toBeLessThan(s.entryFill! * 0.02) // well under the 4% base-low risk
      expect(risk).toBeGreaterThan(0.005)            // still clear of noise
    }
  })

  it('rates R/R against a meaningful target and clears the 1.5 buy gate', () => {
    for (const s of strength) {
      expect(s.rewardRisk).not.toBeNull()
      expect(s.rewardRisk!).toBeGreaterThanOrEqual(1.5)
      // no target sits within the min-reward floor of the fill (no bp-away noise)
      for (const t of s.targets) {
        expect(t.price - s.entryFill!).toBeGreaterThan(s.entryFill! * 0.003)
      }
    }
  })
})

describe('detectMomentumPullback — first pullback on a runner', () => {
  // Run up to 4.92, two red digestion bars, then a green bar reclaiming a new
  // high on expanding volume. A strong in-play name holding VWAP.
  function runnerBars(): Candle[] {
    const o = [
      [3.98, 4.05, 3.95, 4.00, 100_000],
      [4.28, 4.35, 4.25, 4.30, 100_000],
      [4.58, 4.65, 4.55, 4.60, 120_000],
      [4.85, 4.92, 4.80, 4.90, 150_000], // run high
      [4.88, 4.90, 4.70, 4.72, 100_000], // red pullback
      [4.72, 4.74, 4.63, 4.66, 90_000],  // red pullback
      [4.67, 5.00, 4.66, 4.98, 400_000], // green reclaim, new high, vol expands
    ]
    return o.map((b, i) => ({ time: 1_700_000_000 + i * 300, open: b[0], high: b[1], low: b[2], close: b[3], volume: b[4] }))
  }
  const run = (over = {}) => detectSetups(ctx(runnerBars(), 4.98, {
    changePct: 15, sessionLevels: session({ vwap: 4.5 }), technical: technical({ atr: 0.08 }), ...over,
  }))

  it('triggers on the reclaim, with the stop under the pullback low', () => {
    const mp = run().find(s => s.type === 'momentum_pullback')
    expect(mp).toBeTruthy()
    expect(mp!.triggeredRaw).toBe(true)
    expect(mp!.invalidation).toBeLessThan(4.66)   // under the higher-low (~4.63)
    expect(mp!.invalidation).toBeGreaterThan(4.4)  // but a tight stop, not the base
  })

  it('does not fire on a weak non-runner (small day change)', () => {
    expect(run({ changePct: 3 }).some(s => s.type === 'momentum_pullback')).toBe(false)
  })

  it('does not fire once price has lost VWAP', () => {
    expect(run({ sessionLevels: session({ vwap: 5.2 }) }).some(s => s.type === 'momentum_pullback')).toBe(false)
  })

  it('does not fire when 15m structure is broken (lower highs/lows)', () => {
    expect(run({ technical: technical({ atr: 0.08, higherHighsLows: false }) })
      .some(s => s.type === 'momentum_pullback')).toBe(false)
  })
})

describe('detectOpeningDrive — first-15-min gapper drive', () => {
  // Rising into a break of the premarket high (5.1) on the open push, last bar
  // expanding volume. minutesSinceOpen inside the 15-min window.
  function driveBars(): Candle[] {
    const c = [4.90, 4.95, 5.00, 5.05, 5.08, 5.12, 5.15]
    return c.map((x, i) => ({ time: 1_700_000_000 + i * 300, open: x - 0.02, high: x + 0.02, low: x - 0.03, close: x, volume: i === c.length - 1 ? 400_000 : 100_000 }))
  }
  const run = (over = {}) => detectSetups(ctx(driveBars(), 5.15, {
    minutesSinceOpen: 5, changePct: 12, sessionLevels: session({ vwap: 5.0 }), technical: technical({ atr: 0.08 }), ...over,
  }))

  it('fires in the first 15 min on the premarket-high break', () => {
    const od = run().find(s => s.type === 'opening_drive')
    expect(od).toBeTruthy()
    expect(od!.triggeredRaw).toBe(true)
  })

  it('does not fire once past the opening window', () => {
    expect(run({ minutesSinceOpen: 30 }).some(s => s.type === 'opening_drive')).toBe(false)
  })

  it('does not fire premarket (that is premarket_breakout territory)', () => {
    expect(run({ session: 'premarket', minutesSinceOpen: null }).some(s => s.type === 'opening_drive')).toBe(false)
  })
})

describe('runner extension cap — top gainers can trigger further past the break', () => {
  // Price 5.35 sits ~4.7% above the break level (premarket high 5.1).
  function extBars(): Candle[] {
    const c = [5.00, 5.10, 5.20, 5.28, 5.32, 5.30, 5.35]
    return c.map((x, i) => ({ time: 1_700_000_000 + i * 300, open: x - 0.02, high: x + 0.02, low: x - 0.03, close: x, volume: i === c.length - 1 ? 400_000 : 100_000 }))
  }
  const orb = (over = {}) => detectSetups(ctx(extBars(), 5.35, { changePct: 6, ...over }))
    .find(s => s.type === 'opening_range_break')

  it('a normal name is dropped as extended (>4% past the break)', () => {
    const s = orb({ technical: technical({ atr: 0.08, relativeVolume: 3 }) })
    if (s) expect(s.triggeredRaw).toBe(false)
  })

  it('a genuine runner (high RVOL + ATR + day move) still triggers at the same extension', () => {
    const s = orb({ changePct: 25, technical: technical({ atr: 0.2, relativeVolume: 6 }) })
    expect(s).toBeTruthy()
    expect(s!.triggeredRaw).toBe(true)
  })
})

describe('momentum_pullback stop cap (2026-07-31 ZEO fix)', () => {
  // A hyper-ATR runner where one digestion bar wicks 25% below the reclaim.
  function wildBars(): Candle[] {
    const o = [
      [4.60, 4.65, 4.55, 4.62, 100_000],
      [4.70, 4.80, 4.68, 4.78, 120_000],
      [4.85, 4.92, 4.80, 4.90, 150_000], // run high 4.92
      [4.88, 4.90, 4.70, 4.72, 100_000], // red
      [4.72, 4.74, 3.70, 4.66, 110_000], // red with a HUGE low wick to 3.70
      [4.67, 5.00, 4.66, 4.98, 400_000], // green reclaim, new high, vol expands
    ]
    return o.map((b, i) => ({ time: 1_700_000_000 + i * 300, open: b[0], high: b[1], low: b[2], close: b[3], volume: b[4] }))
  }

  it('caps the stop at ~8% below the reclaim instead of 25% under the wick', () => {
    const mp = detectSetups(ctx(wildBars(), 4.98, {
      changePct: 30, sessionLevels: session({ vwap: 4.5 }), technical: technical({ atr: 0.4 }),
    })).find(s => s.type === 'momentum_pullback')
    expect(mp).toBeTruthy()
    // Uncapped the stop would be ~3.6 (26% under the ~4.9 reclaim); the cap holds it ≥ 8% off.
    expect(mp!.invalidation).toBeGreaterThan(4.4)
    expect(mp!.invalidation).toBeLessThan(4.7)
  })
})

describe('faded-name guard on the widened extension cap', () => {
  function extBars(): Candle[] {
    const c = [5.00, 5.10, 5.20, 5.28, 5.32, 5.30, 5.35]
    return c.map((x, i) => ({ time: 1_700_000_000 + i * 300, open: x - 0.02, high: x + 0.02, low: x - 0.03, close: x, volume: i === c.length - 1 ? 400_000 : 100_000 }))
  }
  const orb = (over = {}) => detectSetups(ctx(extBars(), 5.35, { changePct: 25, ...over }))
    .find(s => s.type === 'opening_range_break')

  it('a runner NEAR its high still gets the wide cap and triggers at ~4.7% extension', () => {
    const s = orb({ technical: technical({ atr: 0.2, relativeVolume: 6, distanceFromDayHighPct: -1 }) })
    expect(s!.triggeredRaw).toBe(true)
  })

  it('a faded runner (far below the day high) loses the wide cap and is dropped as extended', () => {
    const s = orb({ technical: technical({ atr: 0.2, relativeVolume: 6, distanceFromDayHighPct: -20 }) })
    if (s) expect(s.triggeredRaw).toBe(false)
  })
})

describe('premarket zero-volume trigger (2026-08-03 feed fix)', () => {
  // Yahoo premarket 1-min bars come back with price but volume: 0 — so premarket is
  // judged on price. A moving gapper triggers; a flat non-mover does not, whatever
  // the volume feed says.
  const pmBars = (vol: number): Candle[] =>
    [4.80, 4.90, 5.00, 5.05, 5.12].map((c, i) =>
      ({ time: 1_700_000_000 + i * 60, open: c - 0.03, high: c + 0.02, low: c - 0.04, close: c, volume: vol }))

  it('premarket_breakout triggers on a zero-volume feed when the name is moving (data gap ≠ no signal)', () => {
    // Default session: premarketHigh 5.1 / premarketLow 4.6 → ~11% premarket range.
    const pb = detectSetups(ctx(pmBars(0), 5.15, {
      session: 'premarket', changePct: 9, sessionLevels: session({ vwap: 4.5 }),
    })).find(s => s.type === 'premarket_breakout')
    expect(pb).toBeTruthy()
    expect(pb!.triggeredRaw).toBe(true)
  })

  it('does NOT trigger a flat, low-gap name even when the feed reports volume', () => {
    // Tight range (premarketLow 5.02) + small gap + unremarkable rvol → not moving.
    const pb = detectSetups(ctx(pmBars(100_000), 5.15, {
      session: 'premarket', changePct: 3,
      sessionLevels: session({ vwap: 4.5, previousClose: 5.0, premarketHigh: 5.1, premarketLow: 5.02 }),
      technical: technical({ relativeVolume: 1 }),
    })).find(s => s.type === 'premarket_breakout')
    if (pb) expect(pb.triggeredRaw).toBe(false)
  })
})
