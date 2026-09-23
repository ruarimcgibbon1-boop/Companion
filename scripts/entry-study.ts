/**
 * Descriptive entry-behaviour study (no strategy change, no filter test).
 *
 * For every RESOLVED trade in a baseline signals CSV, this walks that symbol-day's
 * 1-minute tape forward from the entry bar and measures what price actually did
 * afterwards — at +1/+2/+3/+5/+10 minutes and to the first ±0.5R/±1R touch —
 * separating eventual winners from losers. It is purely observational: it reports
 * how winners and losers behave differently, so a rule can later be proposed with
 * evidence. It does NOT gate, filter, or change any decision.
 *
 * Everything is measured in R (risk units): R = entry − stop. That is the only
 * scale comparable across a $1 runner and a $35 name.
 *
 *   npx tsx scripts/entry-study.ts <signals.csv>
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Candle } from '@/types'
import { etDayKey, etHHMM, toCandles, type RawRow } from '@/lib/replay-day'
import { getSessionType } from '@/lib/market-hours'

const HORIZONS = [1, 2, 3, 5, 10] as const   // minutes after entry
const RESEARCH_CACHE = process.env.FMP_CACHE_DIR ||
  '/private/tmp/claude-501/-Users-elonmusk-Companion/e73f584c-b4b9-412c-a4d7-ccaf1e47b222/scratchpad/fmp-cache'
const SCRATCH = process.env.SCRATCH_DIR ||
  '/private/tmp/claude-501/-Users-elonmusk-Companion/e73f584c-b4b9-412c-a4d7-ccaf1e47b222/scratchpad'

// ── Load baseline signals ──────────────────────────────────────────────────
interface Sig {
  day: string; time: string; symbol: string; setup: string; grade: string
  entry: number; stop: number; t1: number | null; outcome: string; pnl: number
  session: string; win: boolean
}
function loadSignals(path: string): Sig[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const h = lines[0].split(',')
  const ix = (n: string) => h.indexOf(n)
  const out: Sig[] = []
  for (const ln of lines.slice(1)) {
    const c = ln.split(',')
    const outcome = (c[ix('outcome')] || '').trim()
    if (outcome !== 'target_hit' && outcome !== 'invalidated') continue   // resolved only
    const entry = +c[ix('entry')], stop = +c[ix('stop')]
    if (!(entry > 0) || !(stop > 0) || stop >= entry) continue
    out.push({
      day: c[ix('day')], time: c[ix('time_ET')], symbol: c[ix('symbol')], setup: c[ix('setup')],
      grade: c[ix('grade')], entry, stop, t1: c[ix('t1')] ? +c[ix('t1')] : null,
      outcome, pnl: +c[ix('scaled_pnl_pct')], session: '', win: outcome === 'target_hit',
    })
  }
  return out
}

// ── Tape loader (cached 1m tape only) ───────────────────────────────────────
const tapeCache = new Map<string, Candle[]>()
function dayCandles(symbol: string, day: string): Candle[] | null {
  const key = `${symbol}_${day}`
  if (tapeCache.has(key)) return tapeCache.get(key)!
  const f = join(RESEARCH_CACHE, `m1_${symbol}_${day}.json`)
  if (!existsSync(f)) { tapeCache.set(key, []); return null }
  const rows = JSON.parse(readFileSync(f, 'utf8')) as RawRow[]
  const all = toCandles(Array.isArray(rows) ? rows : [])
  const day1 = all.filter(c => etDayKey(c.time) === day)
  tapeCache.set(key, day1)
  return day1.length ? day1 : null
}

// ── Per-trade behaviour ─────────────────────────────────────────────────────
interface Behaviour {
  sig: Sig
  entryIdx: number
  // per-horizon (R and flags)
  closeR: Record<number, number | null>       // (close − entry)/R at +Nm
  mfeR: Record<number, number | null>          // best (high) through +Nm, in R
  maeR: Record<number, number | null>          // worst (low) through +Nm, in R
  triggerHold: Record<number, boolean | null>  // close still ≥ entry at +Nm
  breakoutHold: Record<number, boolean | null> // never traded below entry (low) through +Nm
  aboveVwap: Record<number, boolean | null>
  aboveEma9: Record<number, boolean | null>
  volRatio: Record<number, number | null>      // avg vol [entry+1..+N] ÷ avg vol of 5 bars pre-entry
  // timing (minutes to first touch), null = not within the walked window
  tPlus05: number | null; tPlus1: number | null; tMinus05: number | null; tMinus1: number | null
  maxInitialPullbackR: number | null           // worst MAE before first reaching +0.5R
  reclaimedAfterFailure: boolean | null         // dipped ≤ −0.5R then later closed ≥ entry
  // Recovery behaviour measured FROM the first −0.5R touch (for the D1 recovery study).
  tReclaimHalf: number | null    // minutes (from entry) to first close back above −0.5R after the touch
  tReclaimEntry: number | null   // minutes (from entry) to first close ≥ entry after the touch
  grn3AfterTouch: number | null  // green closes (close>open) in the 3 bars after the −0.5R touch
  volRatioTouch3: number | null  // avg vol of 3 bars after touch ÷ avg vol of 5 pre-entry bars
  aboveEma9Touch3: boolean | null
  aboveVwapTouch3: boolean | null
  reclaimHalf3: boolean | null   // reclaimed −0.5R within 3 bars of the touch
  reclaimEntry5: boolean | null  // closed ≥ entry within 5 bars of the touch
}

function vwapSeries(cs: Candle[]): number[] {
  let ctpv = 0, cvol = 0; const out: number[] = []
  for (const c of cs) { const tp = (c.high + c.low + c.close) / 3; ctpv += tp * c.volume; cvol += c.volume; out.push(cvol > 0 ? ctpv / cvol : c.close) }
  return out
}
function ema9Series(cs: Candle[]): (number | null)[] {
  const p = 9, k = 2 / (p + 1); const out: (number | null)[] = []
  let e: number | null = null, sum = 0
  for (let i = 0; i < cs.length; i++) {
    sum += cs[i].close
    if (i === p - 1) e = sum / p
    else if (i >= p) e = cs[i].close * k + (e as number) * (1 - k)
    out.push(i >= p - 1 ? e : null)
  }
  return out
}

function analyze(sig: Sig): Behaviour | null {
  const cs = dayCandles(sig.symbol, sig.day)
  if (!cs) return null
  // Entry bar = the bar whose CLOSE time (bar.time+60) prints the logged ET time.
  const entryIdx = cs.findIndex(c => etHHMM((c.time + 60) * 1000) === Number(sig.time.replace(':', '')))
  if (entryIdx < 0) return null
  sig.session = getSessionType((cs[entryIdx].time + 60) * 1000)

  const R = sig.entry - sig.stop
  if (!(R > 0)) return null

  // Session-anchored VWAP/EMA over the entry's session frame (regular if the entry
  // is regular, else premarket) — the same base the production indicators use.
  const frame = cs.filter(c => {
    const s = getSessionType((c.time + 60) * 1000)
    return sig.session === 'regular' ? s === 'regular' : s === 'premarket'
  })
  const frameIdxOf = new Map(frame.map((c, i) => [c.time, i]))
  const vw = vwapSeries(frame)
  const em = ema9Series(frame)

  const b: Behaviour = {
    sig, entryIdx,
    closeR: {}, mfeR: {}, maeR: {}, triggerHold: {}, breakoutHold: {},
    aboveVwap: {}, aboveEma9: {}, volRatio: {},
    tPlus05: null, tPlus1: null, tMinus05: null, tMinus1: null,
    maxInitialPullbackR: null, reclaimedAfterFailure: null,
    tReclaimHalf: null, tReclaimEntry: null, grn3AfterTouch: null, volRatioTouch3: null,
    aboveEma9Touch3: null, aboveVwapTouch3: null, reclaimHalf3: null, reclaimEntry5: null,
  }

  const preVol = (() => { const s = cs.slice(Math.max(0, entryIdx - 5), entryIdx); return s.length ? s.reduce((a, c) => a + c.volume, 0) / s.length : null })()

  for (const H of HORIZONS) {
    const end = entryIdx + H
    if (end >= cs.length) { b.closeR[H] = null; b.mfeR[H] = null; b.maeR[H] = null; b.triggerHold[H] = null; b.breakoutHold[H] = null; b.aboveVwap[H] = null; b.aboveEma9[H] = null; b.volRatio[H] = null; continue }
    let mfe = -Infinity, mae = Infinity, tradedBelow = false
    for (let i = entryIdx + 1; i <= end; i++) {
      mfe = Math.max(mfe, (cs[i].high - sig.entry) / R)
      mae = Math.min(mae, (cs[i].low - sig.entry) / R)
      if (cs[i].low < sig.entry) tradedBelow = true
    }
    const cl = cs[end].close
    b.closeR[H] = (cl - sig.entry) / R
    b.mfeR[H] = mfe; b.maeR[H] = mae
    b.triggerHold[H] = cl >= sig.entry
    b.breakoutHold[H] = !tradedBelow
    const fi = frameIdxOf.get(cs[end].time)
    b.aboveVwap[H] = fi != null ? cl >= vw[fi] : null
    b.aboveEma9[H] = fi != null && em[fi] != null ? cl >= (em[fi] as number) : null
    const postVol = cs.slice(entryIdx + 1, end + 1)
    const avgPost = postVol.length ? postVol.reduce((a, c) => a + c.volume, 0) / postVol.length : null
    b.volRatio[H] = avgPost != null && preVol ? avgPost / preVol : null
  }

  // Timing to first ±0.5R / ±1R touch, and pullback/reclaim, walking to EOD.
  let reachedHalf = false, worstBeforeHalf = 0, dippedHalfDown = false
  for (let i = entryIdx + 1; i < cs.length; i++) {
    const hiR = (cs[i].high - sig.entry) / R, loR = (cs[i].low - sig.entry) / R
    const mins = i - entryIdx
    if (b.tPlus05 == null && hiR >= 0.5) b.tPlus05 = mins
    if (b.tPlus1 == null && hiR >= 1) b.tPlus1 = mins
    if (b.tMinus05 == null && loR <= -0.5) b.tMinus05 = mins
    if (b.tMinus1 == null && loR <= -1) b.tMinus1 = mins
    if (!reachedHalf) { worstBeforeHalf = Math.min(worstBeforeHalf, loR); if (hiR >= 0.5) reachedHalf = true }
    if (loR <= -0.5) dippedHalfDown = true
    if (dippedHalfDown && b.reclaimedAfterFailure == null && cs[i].close >= sig.entry) b.reclaimedAfterFailure = true
  }
  b.maxInitialPullbackR = worstBeforeHalf
  if (dippedHalfDown && b.reclaimedAfterFailure == null) b.reclaimedAfterFailure = false

  // Recovery behaviour anchored at the FIRST −0.5R touch (D1 recovery study).
  const halfLevel = sig.entry - 0.5 * R
  const touchIdx = cs.findIndex((c, i) => i > entryIdx && c.low <= halfLevel)
  if (touchIdx >= 0) {
    for (let i = touchIdx + 1; i < cs.length; i++) {
      if (b.tReclaimHalf == null && cs[i].close > halfLevel) b.tReclaimHalf = i - entryIdx
      if (b.tReclaimEntry == null && cs[i].close >= sig.entry) b.tReclaimEntry = i - entryIdx
      if (b.tReclaimHalf != null && b.tReclaimEntry != null) break
    }
    const post = cs.slice(touchIdx + 1, touchIdx + 4)   // next 3 bars after the touch
    b.grn3AfterTouch = post.filter(c => c.close > c.open).length
    const avgPost = post.length ? post.reduce((a, c) => a + c.volume, 0) / post.length : null
    b.volRatioTouch3 = avgPost != null && preVol ? avgPost / preVol : null
    const t3 = cs[touchIdx + 3]
    if (t3) {
      const fi = frameIdxOf.get(t3.time)
      b.aboveEma9Touch3 = fi != null && em[fi] != null ? t3.close >= (em[fi] as number) : null
      b.aboveVwapTouch3 = fi != null ? t3.close >= vw[fi] : null
    }
    b.reclaimHalf3 = b.tReclaimHalf != null && b.tReclaimHalf <= (touchIdx + 3 - entryIdx)
    b.reclaimEntry5 = b.tReclaimEntry != null && b.tReclaimEntry <= (touchIdx + 5 - entryIdx)
  }
  return b
}

// ── Aggregation helpers ─────────────────────────────────────────────────────
const median = (xs: number[]) => { if (!xs.length) return NaN; const b = xs.slice().sort((x, y) => x - y); const n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2 }
const frac = (xs: (boolean | null)[]) => { const v = xs.filter(x => x != null) as boolean[]; return v.length ? v.filter(Boolean).length / v.length : NaN }
const nn = (xs: (number | null)[]) => xs.filter(x => x != null && isFinite(x as number)) as number[]
const fmt = (x: number, d = 2) => Number.isNaN(x) ? '  —  ' : (x >= 0 ? '+' : '') + x.toFixed(d)

function main() {
  const path = process.argv[2]
  if (!path || !existsSync(path)) { console.error('usage: entry-study.ts <signals.csv>'); process.exit(1) }
  const sigs = loadSignals(path)
  const bs = sigs.map(analyze).filter((b): b is Behaviour => b != null)
  const wins = bs.filter(b => b.sig.win), losses = bs.filter(b => !b.sig.win)
  console.log(`\nEntry-behaviour study — ${bs.length} resolved trades with 1m tape (${wins.length}W / ${losses.length}L)`)
  console.log(`source: ${path}\n`)

  // Save the per-trade dataset for auditing / downstream.
  const cols = ['day', 'time', 'symbol', 'setup', 'grade', 'session', 'win', 'entry', 'stop',
    ...HORIZONS.flatMap(H => [`closeR_${H}`, `mfeR_${H}`, `maeR_${H}`, `trigHold_${H}`, `brkHold_${H}`, `aboveVwap_${H}`, `aboveEma9_${H}`, `volRatio_${H}`]),
    'tPlus05', 'tPlus1', 'tMinus05', 'tMinus1', 'maxInitPullbackR', 'reclaimedAfterFail',
    'tReclaimHalf', 'tReclaimEntry', 'grn3AfterTouch', 'volRatioTouch3', 'aboveEma9Touch3', 'aboveVwapTouch3', 'reclaimHalf3', 'reclaimEntry5']
  const rows = bs.map(b => [b.sig.day, b.sig.time, b.sig.symbol, b.sig.setup, b.sig.grade, b.sig.session, b.sig.win ? 'W' : 'L', b.sig.entry, b.sig.stop,
    ...HORIZONS.flatMap(H => [b.closeR[H], b.mfeR[H], b.maeR[H], b.triggerHold[H], b.breakoutHold[H], b.aboveVwap[H], b.aboveEma9[H], b.volRatio[H]]),
    b.tPlus05, b.tPlus1, b.tMinus05, b.tMinus1, b.maxInitialPullbackR, b.reclaimedAfterFailure,
    b.tReclaimHalf, b.tReclaimEntry, b.grn3AfterTouch, b.volRatioTouch3, b.aboveEma9Touch3, b.aboveVwapTouch3, b.reclaimHalf3, b.reclaimEntry5].map(v => v == null ? '' : typeof v === 'number' ? (isFinite(v) ? v.toFixed(3) : '') : String(v)).join(','))
  writeFileSync(join(SCRATCH, 'entry-study.csv'), [cols.join(','), ...rows].join('\n'))

  const line = (label: string, wv: number, lv: number, d = 2) => {
    const eff = wv - lv
    console.log(`  ${label.padEnd(30)} W ${fmt(wv, d).padStart(8)}   L ${fmt(lv, d).padStart(8)}   Δ ${fmt(eff, d).padStart(8)}`)
  }
  console.log('=== Close vs entry (R) by horizon ===')
  for (const H of HORIZONS) line(`+${H}m close (R)`, median(nn(wins.map(b => b.closeR[H]))), median(nn(losses.map(b => b.closeR[H]))))
  console.log('=== MFE through horizon (R, median) ===')
  for (const H of HORIZONS) line(`+${H}m MFE (R)`, median(nn(wins.map(b => b.mfeR[H]))), median(nn(losses.map(b => b.mfeR[H]))))
  console.log('=== MAE through horizon (R, median) ===')
  for (const H of HORIZONS) line(`+${H}m MAE (R)`, median(nn(wins.map(b => b.maeR[H]))), median(nn(losses.map(b => b.maeR[H]))))
  console.log('=== Trigger-level hold (close ≥ entry, fraction) ===')
  for (const H of HORIZONS) line(`+${H}m trigger hold`, frac(wins.map(b => b.triggerHold[H])), frac(losses.map(b => b.triggerHold[H])))
  console.log('=== Breakout hold (never traded below entry, fraction) ===')
  for (const H of HORIZONS) line(`+${H}m breakout hold`, frac(wins.map(b => b.breakoutHold[H])), frac(losses.map(b => b.breakoutHold[H])))
  console.log('=== Above VWAP (fraction) ===')
  for (const H of HORIZONS) line(`+${H}m above VWAP`, frac(wins.map(b => b.aboveVwap[H])), frac(losses.map(b => b.aboveVwap[H])))
  console.log('=== Above 9EMA (fraction) ===')
  for (const H of HORIZONS) line(`+${H}m above 9EMA`, frac(wins.map(b => b.aboveEma9[H])), frac(losses.map(b => b.aboveEma9[H])))
  console.log('=== Post-entry volume ratio (vs 5 pre-entry bars, median) ===')
  for (const H of HORIZONS) line(`+${H}m vol ratio`, median(nn(wins.map(b => b.volRatio[H]))), median(nn(losses.map(b => b.volRatio[H]))))
  console.log('=== Timing (minutes, median; blank = never) ===')
  line('time to +0.5R', median(nn(wins.map(b => b.tPlus05))), median(nn(losses.map(b => b.tPlus05))), 1)
  line('time to +1R', median(nn(wins.map(b => b.tPlus1))), median(nn(losses.map(b => b.tPlus1))), 1)
  line('time to −0.5R', median(nn(wins.map(b => b.tMinus05))), median(nn(losses.map(b => b.tMinus05))), 1)
  line('time to −1R', median(nn(wins.map(b => b.tMinus1))), median(nn(losses.map(b => b.tMinus1))), 1)
  console.log('=== Pullback / reclaim ===')
  line('max initial pullback (R)', median(nn(wins.map(b => b.maxInitialPullbackR))), median(nn(losses.map(b => b.maxInitialPullbackR))))
  line('reached +0.5R w/o −0.5R first (frac)', frac(wins.map(b => b.tMinus05 == null || (b.tPlus05 != null && b.tPlus05 <= b.tMinus05))), frac(losses.map(b => b.tMinus05 == null || (b.tPlus05 != null && b.tPlus05 <= b.tMinus05))))
  line('reclaimed after −0.5R dip (frac)', frac(wins.map(b => b.reclaimedAfterFailure)), frac(losses.map(b => b.reclaimedAfterFailure)))
  console.log(`\nper-trade dataset → ${join(SCRATCH, 'entry-study.csv')}`)
}
main()
