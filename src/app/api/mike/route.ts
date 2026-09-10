/**
 * MIKE'S STRATEGY — read-only inspection endpoint (v0.2).
 *
 * Runs Mike over the SAME live top-gainer/momentum universe the REGULAR scanner
 * uses (buildMonitorBatch), plus the completed 5-minute tape from the EXISTING FMP
 * client — no separate market-data stack. It places NO orders and writes NO REGULAR
 * log. Returns Mike candidates (state, frozen level, loading zone, confirmations,
 * veto, intended trade plan) and an inline shadow outcome for triggered/vetoed ones.
 *
 *   GET /api/mike?symbols=AAA,BBB      (specific names)
 *   GET /api/mike                      (auto: current gainers/actives universe)
 */
import { NextResponse } from 'next/server'
import { getTopGainers, getMostActive, getIntradayCandles, getExtendedIntradayCandles } from '@/lib/fmp-client'
import { getYFScreener } from '@/lib/yahoo-client'
import { cached, TTL } from '@/lib/cache'
import { buildMonitorBatch } from '@/lib/monitor'
import { getSessionType, isPremarket, parseEtTimestampSec } from '@/lib/market-hours'
import { evaluateMike } from '@/lib/mike/engine'
import { completedFiveMin } from '@/lib/mike/driver'
import { resolveMikeShadow, mikeShadowReference, mikeShadowStop } from '@/lib/mike/shadow'
import type { MikeInput } from '@/lib/mike/types'
import type { Candle, MonitorResult } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 60

function toCandles(raw: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): Candle[] {
  return raw
    .map(c => ({ time: parseEtTimestampSec(c.date), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .filter(c => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time)
}

/** Completed 5m bars only (deterministic rule shared with the driver) — the acceptance gate never sees a partial. */
async function fiveMin(symbol: string, premarket: boolean, now: number): Promise<Candle[]> {
  const raw = premarket
    ? await cached(`xcandles5m:${symbol}`, TTL.CANDLES_5M, () => getExtendedIntradayCandles(symbol))
    : await cached(`candles5m:${symbol}`, TTL.CANDLES_5M, () => getIntradayCandles(symbol, '5min'))
  return completedFiveMin(toCandles(raw), now)
}

function mikeInputFrom(r: MonitorResult, candles5m: Candle[], now: number): MikeInput {
  const t = r.technicals
  return {
    symbol: r.symbol,
    session: r.integrity.session,
    now,
    price: r.price,
    candles5m,
    indicators: { vwap: t?.vwap ?? null, ema9: t?.ema9 ?? null, ema21: t?.ema20 ?? null, rvol: r.relativeVolume ?? null },
    levels: r.levels,
    refs: {
      previousDayHigh: t?.previousDayHigh ?? null,
      premarketHigh: t?.premarketHigh ?? null,
      dayHigh: t?.dayHigh ?? null,
      twentyDayHigh: t?.twentyDayHigh ?? null,
    },
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const now = Date.now()
  const session = getSessionType()
  const premarket = isPremarket(now)

  try {
    let symbols = (searchParams.get('symbols') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    if (symbols.length === 0) {
      const [g, a, yf] = await Promise.all([
        cached('gainers', TTL.GAINERS, getTopGainers).catch(() => []),
        cached('mostActive', TTL.GAINERS, getMostActive).catch(() => []),
        cached('yfGainers', TTL.GAINERS, () => getYFScreener('day_gainers', 50)).catch(() => []),
      ])
      const seen = new Set<string>()
      symbols = [...g.map(x => x.symbol), ...a.map(x => x.symbol), ...yf.map(x => x.symbol)]
        .filter(s => s && !seen.has(s) && (seen.add(s), true))
        .slice(0, 20)
    }
    if (symbols.length === 0) return NextResponse.json({ session, candidates: [], meta: { note: 'empty universe' } })

    const results = await buildMonitorBatch(symbols)
    const candidates = await Promise.all(results.map(async r => {
      const candles5m = await fiveMin(r.symbol, premarket, now)
      const cand = evaluateMike(mikeInputFrom(r, candles5m, now))
      // Inline shadow (evidence only): resolve from acceptance/veto time forward.
      const ref = mikeShadowReference(cand)
      const since = cand.breakoutLevel?.establishedAt ?? now
      const shadow = ref != null ? resolveMikeShadow(ref, mikeShadowStop(cand), candles5m, since) : null
      return { ...cand, shadow }
    }))

    return NextResponse.json({
      session,
      candidates,
      meta: { universeSize: symbols.length, analysed: results.length, timestamp: now },
    })
  } catch (err) {
    console.error('mike route error:', err)
    return NextResponse.json({ error: 'Failed to build Mike scan' }, { status: 500 })
  }
}
