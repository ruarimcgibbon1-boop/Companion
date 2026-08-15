/**
 * Support/resistance level report — descriptive structure only, no trade calls.
 *
 * Walks the real FMP tape for one or more symbols through the SAME levels engine
 * the live monitor uses (calculateSessionLevels -> calculateTechnical ->
 * buildKeyLevels) and dumps candles + ranked KeyLevel zones as JSON for charting.
 *
 * Run:  npx tsx scripts/levels-report.ts OFAL BAOS BOXL
 *       npx tsx scripts/levels-report.ts OFAL --day 2026-08-11
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Candle } from '@/types'
import { calculateSessionLevels, calculateTechnical } from '@/lib/technical'
import { buildKeyLevels } from '@/lib/levels-engine'

const args = process.argv.slice(2)
const dayFlag = args.indexOf('--day')
const DAY = dayFlag >= 0 ? args[dayFlag + 1] : null
const SYMS = args.filter((a, i) => !a.startsWith('--') && !(dayFlag >= 0 && i === dayFlag + 1)).map(s => s.toUpperCase())
if (SYMS.length === 0) { console.error('usage: npx tsx scripts/levels-report.ts <SYM...> [--day YYYY-MM-DD]'); process.exit(1) }

const KEY = readFileSync('.env.local', 'utf8').match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/)![1]
const CACHE = '/private/tmp/claude-501/-Users-elonmusk-Companion/acde1c63-5ee8-4010-b3e4-c6ba6c93b209/scratchpad/fmp-cache'
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })

interface Raw { date: string; open: number; high: number; low: number; close: number; volume: number }
async function get(name: string, url: string): Promise<unknown> {
  const f = join(CACHE, name + '.json')
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json(); writeFileSync(f, JSON.stringify(j)); return j
}
const etUnix = (s: string) => Math.floor(Date.parse((s.length <= 10 ? `${s}T00:00:00` : s.replace(' ', 'T')) + '-04:00') / 1000)
const etDay = (u: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(u * 1000))
const toC = (r: Raw[]): Candle[] => r.map(x => ({ time: etUnix(x.date), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0 })).sort((a, b) => a.time - b.time)

const today = etDay(Math.floor(Date.now() / 1000))
const asOf = DAY ?? today

async function run(SYM: string) {
  let m5: Raw[], dRaw: unknown
  try {
    m5 = (await get(`m5_${SYM}_${asOf}`, `https://financialmodelingprep.com/stable/historical-chart/5min?symbol=${SYM}&from=${etDay(etUnix(asOf) - 14 * 86400)}&to=${asOf}&extended=true&apikey=${KEY}`) as Raw[]).slice().sort((a, b) => a.date.localeCompare(b.date))
    dRaw = await get(`daily_${SYM}_${asOf}`, `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${SYM}&from=${etDay(etUnix(asOf) - 200 * 86400)}&to=${asOf}&apikey=${KEY}`)
  } catch (e) { return { symbol: SYM, error: `FMP fetch failed: ${(e as Error).message}` } }

  const daily: Raw[] = (Array.isArray(dRaw) ? dRaw : (dRaw as { historical?: Raw[] }).historical ?? []).slice().sort((a, b) => a.date.localeCompare(b.date))
  if (!m5.length || !daily.length) return { symbol: SYM, error: 'no tape returned by FMP' }

  // Most recent session present in the intraday tape.
  const lastDay = etDay(etUnix(m5[m5.length - 1].date))
  const dailyC = toC(daily.filter(r => r.date.slice(0, 10) <= lastDay))
  const di = daily.findIndex(r => r.date.slice(0, 10) === lastDay)
  const pIdx = di < 0 ? daily.length : di
  const prevClose = pIdx > 0 ? daily[pIdx - 1].close : dailyC[dailyC.length - 1]?.close ?? 0
  const prior = daily.slice(Math.max(0, pIdx - 20), pIdx)
  const avgVol = prior.length ? prior.reduce((s, r) => s + r.volume, 0) / prior.length : 0

  const all = toC(m5)
  // Keep ~3 sessions of intraday context for swing/consolidation detection.
  const sessions = [...new Set(all.map(c => etDay(c.time)))].slice(-3)
  const intraday = all.filter(c => sessions.includes(etDay(c.time)))
  const last = intraday[intraday.length - 1]
  const price = last.close
  const nowTs = (last.time + 300) * 1000

  const todayVol = intraday.filter(c => etDay(c.time) === lastDay).reduce((s, c) => s + c.volume, 0)
  const sl = calculateSessionLevels(intraday, dailyC, undefined, undefined, nowTs)
  const tech = calculateTechnical(intraday, dailyC, todayVol, avgVol, sl, undefined, nowTs)
  const levels = buildKeyLevels({ intraday, daily: dailyC, sessionLevels: sl, technical: tech, currentPrice: price, nowTs })

  return {
    symbol: SYM, asOf: lastDay, price, prevClose,
    changePct: prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0,
    dayVolume: todayVol, avgDailyVol20: avgVol,
    atr: tech.atr, rsi: tech.rsi14, relativeVolume: tech.relativeVolume,
    sessionLevels: sl,
    ema9: tech.ema9, ema20: tech.ema20, ma50: tech.ma50Daily, ma200: tech.ma200Daily,
    levels,
    candles: intraday.filter(c => etDay(c.time) === lastDay),
    dailyCandles: dailyC.slice(-60),
  }
}

async function main() {
  const out = []
  for (const s of SYMS) out.push(await run(s))
  const dest = join(CACHE, '..', 'levels-report.json')
  writeFileSync(dest, JSON.stringify(out, null, 2))
  for (const r of out) {
    if ('error' in r && r.error) { console.log(`\n=== ${r.symbol} === ERROR: ${r.error}`); continue }
    const d = r as Extract<typeof r, { levels: unknown[] }>
    console.log(`\n=== ${d.symbol}  ${d.asOf} ===`)
    console.log(`price ${d.price}  prevClose ${d.prevClose}  chg ${d.changePct.toFixed(1)}%  vol ${(d.dayVolume / 1e6).toFixed(2)}M (20d avg ${(d.avgDailyVol20 / 1e6).toFixed(2)}M)`)
    console.log(`ATR ${d.atr?.toFixed(3)}  RSI ${d.rsi?.toFixed(1)}  RVOL ${d.relativeVolume?.toFixed(2)}`)
    console.log(`PMH ${d.sessionLevels.premarketHigh}  PML ${d.sessionLevels.premarketLow}  HOD ${d.sessionLevels.regularHigh}  LOD ${d.sessionLevels.regularLow}  VWAP ${d.sessionLevels.vwap?.toFixed(3)}`)
    console.log(`-- levels (strength desc) --`)
    for (const l of d.levels as unknown as Array<{ kind: string; midpoint: number; lower: number; upper: number; strength: number; touches: number; sourceLabels: string[] }>) {
      console.log(`  ${l.kind.padEnd(10)} ${l.midpoint.toFixed(3).padStart(9)}  [${l.lower.toFixed(3)}–${l.upper.toFixed(3)}]  str ${String(l.strength).padStart(3)}  touches ${l.touches}  ${l.sourceLabels.join(', ')}`)
    }
  }
  console.log(`\nJSON -> ${dest}`)
}
main()
