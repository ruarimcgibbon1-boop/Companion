/**
 * MIKE'S STRATEGY — standalone OBSERVATIONAL scanner (v0.2).
 *
 * Runs Mike over the SAME live top-gainer/momentum universe as REGULAR, on the same
 * safe cadence, and persists stateful candidate lifecycles + events + shadow. It is
 * SHADOW-ONLY:
 *   - it NEVER imports or calls the paper executor or a broker,
 *   - it submits no orders and consumes no REGULAR portfolio slots,
 *   - it writes ONLY Mike files (never a REGULAR decision/event/trade log),
 *   - it never touches REGULAR signals/state.
 *
 * State survives restart via the per-ET-day lifecycle snapshot; events are deduped by
 * fingerprint so a restart or duplicate sweep never double-logs.
 *
 *   npx tsx scripts/mike-scan.ts            # continuous
 *   ONCE=1 npx tsx scripts/mike-scan.ts     # single sweep (testing)
 */
import { loadEnvLocal } from '@/lib/execution/env'
import { getTopGainers, getMostActive, getIntradayCandles, getExtendedIntradayCandles } from '@/lib/fmp-client'
import { getYFScreener } from '@/lib/yahoo-client'
import { cached, TTL } from '@/lib/cache'
import { buildMonitorBatch } from '@/lib/monitor'
import { getSessionType, isPremarket, parseEtTimestampSec, type SessionType } from '@/lib/market-hours'
import { etDayKey } from '@/lib/execution/store'
import { evaluateMike, fiveMinAcceptance } from '@/lib/mike/engine'
import { resolveMikeShadow, mikeShadowReference, mikeShadowStop } from '@/lib/mike/shadow'
import {
  completedFiveMin, completedOneMin, computeRejectionTelemetry, activeLifecycle, priorForEngine, ingestCandidate,
} from '@/lib/mike/driver'
import {
  loadMikeState, saveMikeState, appendMikeEvent, appendMikeCandidate, appendMikeShadow, type MikeShadowRow,
} from '@/lib/mike/store'
import type { MikeInput } from '@/lib/mike/types'
import type { Candle, MonitorResult } from '@/types'

loadEnvLocal()

const ONCE = process.env.ONCE === '1'
const SWEEP_MS = 15_000          // same active cadence as the REGULAR daemon
const IDLE_MS = 5 * 60_000       // slow poll when the market is closed
const UNIVERSE_SIZE = 15
const log = (...a: unknown[]) => console.log(new Date().toISOString(), '[mike]', ...a)

function toCandles(raw: Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>): Candle[] {
  return raw.map(c => ({ time: parseEtTimestampSec(c.date), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .filter(c => Number.isFinite(c.time))
}

async function universe(): Promise<string[]> {
  const [g, a, yf] = await Promise.all([
    cached('gainers', TTL.GAINERS, getTopGainers).catch(() => []),
    cached('mostActive', TTL.GAINERS, getMostActive).catch(() => []),
    cached('yfGainers', TTL.GAINERS, () => getYFScreener('day_gainers', 50)).catch(() => []),
  ])
  const seen = new Set<string>()
  return [...g, ...a].map(x => ({ symbol: x.symbol, changePct: Number(x.changesPercentage) }))
    .concat(yf.map(x => ({ symbol: x.symbol, changePct: x.changePct })))
    .filter(r => r.symbol && !seen.has(r.symbol) && (seen.add(r.symbol), true))
    .sort((x, y) => (y.changePct || 0) - (x.changePct || 0))
    .slice(0, UNIVERSE_SIZE).map(r => r.symbol)
}

async function fiveMin(symbol: string, premarket: boolean, now: number): Promise<Candle[]> {
  const raw = premarket
    ? await cached(`xcandles5m:${symbol}`, TTL.CANDLES_5M, () => getExtendedIntradayCandles(symbol))
    : await cached(`candles5m:${symbol}`, TTL.CANDLES_5M, () => getIntradayCandles(symbol, '5min'))
  return completedFiveMin(toCandles(raw), now)   // deterministic: completed bars only
}

/** Completed 1-minute bars (for rejection telemetry only — never for the veto). */
async function oneMin(symbol: string, premarket: boolean, now: number): Promise<Candle[]> {
  const raw = premarket
    ? await cached(`xcandles1m:${symbol}`, TTL.CANDLES_1M, () => getExtendedIntradayCandles(symbol))
    : await cached(`candles1m:${symbol}`, TTL.CANDLES_1M, () => getIntradayCandles(symbol, '1min'))
  return completedOneMin(toCandles(raw), now)
}

function buildInput(r: MonitorResult, candles5m: Candle[], now: number, prior: MikeInput['prior']): MikeInput {
  const t = r.technicals
  return {
    symbol: r.symbol, session: r.integrity.session, now, price: r.price, candles5m,
    indicators: { vwap: t?.vwap ?? null, ema9: t?.ema9 ?? null, ema21: t?.ema20 ?? null, rvol: r.relativeVolume ?? null },
    levels: r.levels,
    refs: { previousDayHigh: t?.previousDayHigh ?? null, premarketHigh: t?.premarketHigh ?? null, dayHigh: t?.dayHigh ?? null, twentyDayHigh: t?.twentyDayHigh ?? null },
    prior,
  }
}

async function sweep(): Promise<void> {
  const now = Date.now()
  const day = etDayKey(now)
  const premarket = isPremarket(now)
  const syms = await universe()
  if (syms.length === 0) { log('empty universe'); return }

  let state = loadMikeState(day)   // restart-safe recovery
  const results = await buildMonitorBatch(syms)
  let events = 0

  for (const r of results) {
    const lc = activeLifecycle(state, r.symbol)
    const prior = lc ? priorForEngine(lc) : null
    const candles5m = await fiveMin(r.symbol, premarket, now)
    const cand = evaluateMike(buildInput(r, candles5m, now, prior))

    // Telemetry drawn from the same completed tape.
    const level = cand.breakoutLevel?.price ?? null
    const accIdx = level != null ? fiveMinAcceptance(candles5m, level).index : -1
    const acceptanceCandle = accIdx >= 0 ? candles5m[accIdx] : null
    // Completed 1m bars strictly after the acceptance 5m candle (evidence only).
    let oneMinPost: Candle[] | null = null
    if (accIdx >= 0 && acceptanceCandle) {
      const accEndSec = acceptanceCandle.time + 300
      oneMinPost = (await oneMin(r.symbol, premarket, now)).filter(c => c.time >= accEndSec)
    }
    const rejection = level != null ? computeRejectionTelemetry(candles5m, level, accIdx, r.price, oneMinPost) : null
    const ref = mikeShadowReference(cand)
    const since = cand.breakoutLevel?.establishedAt ?? now
    const shadow = ref != null ? resolveMikeShadow(ref, mikeShadowStop(cand), candles5m, since) : null

    const res = ingestCandidate(state, cand, { acceptanceCandle, rejection, shadow }, now)
    state = res.state
    if (res.event) {
      events++
      appendMikeEvent(res.event, now)
      appendMikeCandidate(cand, now)   // full candidate snapshot at each material change
      if (shadow && shadow.resolved) {
        const row: MikeShadowRow = {
          strategy: 'mike', ts: new Date(now).toISOString(), symbol: cand.symbol,
          breakoutLevel: level, state: cand.state, outcome: cand.outcome,
          vetoReason: cand.veto?.reason ?? null, shadow,
        }
        appendMikeShadow(row, now)
      }
    }
  }

  saveMikeState(state, day)         // recovery snapshot
  log(`swept ${results.length} names · ${state.candidates.filter(c => !c.terminal).length} active · ${events} events`)
}

async function main(): Promise<void> {
  log(`mike observational scanner up (SHADOW ONLY, no orders) · state → ${etDayKey()}`)
  for (;;) {
    const session: SessionType = getSessionType()
    if (session === 'overnight' || session === 'closed') {
      if (ONCE) { log('market closed — nothing to sweep'); return }
      await new Promise(r => setTimeout(r, IDLE_MS)); continue
    }
    try { await sweep() } catch (e) { log('sweep error:', (e as Error).message) }
    if (ONCE) return
    await new Promise(r => setTimeout(r, SWEEP_MS))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
