/**
 * Missed-setup diagnostic — the "why didn't we alert on this?" tool.
 *
 * Point it at a symbol + date (a setup you'd have liked to take) and it walks that
 * day's real FMP tape through the CURRENT pipeline (detectSetups + the useMonitor
 * gate stack) bar by bar, printing every long trigger and the exact gate that
 * logged or dropped it. Turns a screenshot into a root cause in seconds.
 *
 * Run:  npx tsx scripts/diagnose.ts YXT 2026-08-05          (whole day)
 *       npx tsx scripts/diagnose.ts YXT 2026-08-05 1040     (focus near 10:40 ET)
 *
 * Root-cause categories it surfaces:
 *   NO_DATA        — FMP has no intraday tape (discovery/feed gap, not a logic gap)
 *   NO_TRIGGER     — setups were seen but none reached a long trigger
 *   DISPLAY_FLOOR  — trigger too low score/level to be tracked
 *   VOLUME         — killed by the liquidity floor
 *   GRADE_FLOOR    — below-grade, non-exempt
 *   QUALITY_VETO   — anti-fade / rollover veto in the detector
 *   LATE_CUTOFF    — regular-hours entry after 14:00 ET
 *   CAP / DUP      — per-symbol cap or entry-cluster dedup
 *   LOGS ✅        — would have fired an alert (+ Telegram)
 *
 * Gate constants below MIRROR src/hooks/useMonitor.ts — keep them in sync.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { Candle, SetupType } from '@/types'
import { calculateSessionLevels, calculateTechnical } from '@/lib/technical'
import { buildKeyLevels } from '@/lib/levels-engine'
import { detectSetups, type DetectionContext } from '@/lib/setup-detectors'
import { premarketVolumeProfile } from '@/lib/premarket-volume'
import { getSessionType, minutesSinceOpen } from '@/lib/market-hours'

// ── mirror of useMonitor gate stack (keep in sync) ──
const MIN_SCORE_FLOOR = 55, MIN_LEVEL_STRENGTH = 40
const MIN_BUY_VOLUME = 100_000, MIN_PREMARKET_BUY_VOLUME = 50_000, PREMARKET_SURGE_RVOL = 10
const GRADE_FLOOR_EXEMPT = new Set<SetupType>(['opening_drive'])
const LATE_LOG_CUTOFF_HHMM = 1400
const MAX_LOGS_PER_SYMBOL = 2
const ENTRY_SIMILARITY_PCT = 0.03, BUY_DEDUP_COOLDOWN_MS = 45 * 60 * 1000

const [SYM, DAY, FOCUS] = [process.argv[2]?.toUpperCase(), process.argv[3], process.argv[4]]
if (!SYM || !DAY) { console.error('usage: npx tsx scripts/diagnose.ts <SYMBOL> <YYYY-MM-DD> [HHMM]'); process.exit(1) }

const KEY = readFileSync('.env.local', 'utf8').match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/)![1]
const CACHE = '/private/tmp/claude-501/-Users-elonmusk-Companion/e73f584c-b4b9-412c-a4d7-ccaf1e47b222/scratchpad/fmp-cache'
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })

interface Raw { date: string; open: number; high: number; low: number; close: number; volume: number }
async function get(name: string, url: string): Promise<any> {
  const f = join(CACHE, name + '.json')
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json(); writeFileSync(f, JSON.stringify(j)); return j
}
const etUnix = (s: string) => Math.floor(Date.parse((s.length <= 10 ? `${s}T00:00:00` : s.replace(' ', 'T')) + '-04:00') / 1000)
const etDay = (u: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(u * 1000))
const etHHMM = (ms: number) => { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)); const [h, m] = s.split(':').map(Number); return h * 100 + m }
const toC = (r: Raw[]): Candle[] => r.map(x => ({ time: etUnix(x.date), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0 })).sort((a, b) => a.time - b.time)

interface Logged { entry: number; ts: number }

async function main() {
  let m5: Raw[], dRaw: any
  try {
    m5 = (await get(`m5_${SYM}_${DAY}`, `https://financialmodelingprep.com/stable/historical-chart/5min?symbol=${SYM}&from=${etDay(etUnix(DAY) - 14 * 86400)}&to=${DAY}&extended=true&apikey=${KEY}`) as Raw[]).slice().sort((a, b) => a.date.localeCompare(b.date))
    dRaw = await get(`daily_${SYM}`, `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${SYM}&from=2026-06-01&to=${DAY}&apikey=${KEY}`)
  } catch (e) { console.log(`>>> NO_DATA: FMP fetch failed for ${SYM} (${(e as Error).message}). Discovery/feed gap, not a logic gap.`); return }

  const daily: Raw[] = (Array.isArray(dRaw) ? dRaw : dRaw.historical ?? []).slice().sort((a: Raw, b: Raw) => a.date.localeCompare(b.date))
  const dayRows = m5.filter(r => r.date.slice(0, 10) === DAY)
  if (dayRows.length === 0) { console.log(`>>> NO_DATA: FMP has no ${DAY} intraday bars for ${SYM}. It may be a name no feed covers (board-only) or the date is wrong.`); return }

  const dailyUpTo = daily.filter(r => r.date.slice(0, 10) <= DAY)
  const dailyC = toC(dailyUpTo)
  const di = dailyUpTo.findIndex(r => r.date.slice(0, 10) === DAY)
  const prevClose = di > 0 ? dailyUpTo[di - 1].close : (dailyUpTo[dailyUpTo.length - 2]?.close ?? dailyUpTo[dailyUpTo.length - 1]?.close ?? 0)
  const pIdx = di < 0 ? dailyUpTo.length : di
  const prior = dailyUpTo.slice(Math.max(0, pIdx - 20), pIdx)
  const avgVol = prior.length ? prior.reduce((s, r) => s + r.volume, 0) / prior.length : 0
  const all = toC(m5)
  const walk = all.filter(c => etDay(c.time) >= etDay(etUnix(DAY) - 2 * 86400) && etDay(c.time) <= DAY)

  console.log(`\n=== ${SYM} ${DAY} ===`)
  console.log(`prevClose ${prevClose} · avg daily vol(20d) ${avgVol.toFixed(0)} · ${dayRows.length} intraday bars${FOCUS ? ` · focus ~${FOCUS} ET` : ''}\n`)

  const logged: Logged[] = []
  let anyTrigger = false, anyLog = false
  const focusMin = FOCUS ? Math.floor(+FOCUS / 100) * 60 + (+FOCUS % 100) : null

  for (let i = 0; i < walk.length; i++) {
    const bar = walk[i]
    if (etDay(bar.time) !== DAY) continue
    const nowTs = (bar.time + 300) * 1000
    const session = getSessionType(nowTs)
    if (session !== 'premarket' && session !== 'regular') continue
    const soFar = walk.slice(0, i + 1)
    const price = bar.close
    if (!(price > 0)) continue
    const todayVol = soFar.filter(c => etDay(c.time) === DAY).reduce((s, c) => s + c.volume, 0)
    const sl = calculateSessionLevels(soFar, dailyC, undefined, undefined, nowTs)
    const tech = calculateTechnical(soFar, dailyC, todayVol, avgVol, sl, undefined, nowTs)
    let pmVolGate: number | null = null
    if (session === 'premarket') {
      const p = premarketVolumeProfile(m5, { todayEt: DAY, throughHHMM: etHHMM(nowTs) })
      if (p.relativeVolume != null) tech.relativeVolume = p.relativeVolume
      pmVolGate = p.measured ? p.todayVolume : null
    }
    const changePct = prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0
    const levels = buildKeyLevels({ intraday: soFar, daily: dailyC, sessionLevels: sl, technical: tech, currentPrice: price, nowTs })
    const ctx: DetectionContext = { symbol: SYM, price, candles: soFar, sessionLevels: sl, technical: tech, levels, catalystScore: 0, hasCatalyst: false, spreadPct: null, changePct, session, minutesSinceOpen: minutesSinceOpen(nowTs), float: null }
    const setups = detectSetups(ctx)
    const et = etHHMM(nowTs), etM = Math.floor(et / 100) * 60 + (et % 100)
    if (focusMin != null && Math.abs(etM - focusMin) > 20) continue

    for (const s of setups) {
      if (!(s.direction === 'long' && s.triggeredRaw)) continue
      anyTrigger = true
      const fill = s.entryFill ?? s.zoneUpper
      const meetsLevel = (s.breakdown.levelQuality / 20) * 100 >= MIN_LEVEL_STRENGTH * 0.2 || s.confidence >= MIN_LEVEL_STRENGTH
      const surge = tech.relativeVolume != null && tech.relativeVolume >= PREMARKET_SURGE_RVOL
      const volOk = session === 'premarket' ? (pmVolGate == null || pmVolGate >= MIN_PREMARKET_BUY_VOLUME || surge) : (todayVol === 0 || todayVol >= MIN_BUY_VOLUME)
      const late = session === 'regular' && et >= LATE_LOG_CUTOFF_HHMM
      const gradeFail = s.grade === 'below' && !GRADE_FLOOR_EXEMPT.has(s.type)
      const dup = logged.some(l => nowTs - l.ts <= BUY_DEDUP_COOLDOWN_MS && l.entry > 0 && Math.abs(fill - l.entry) / l.entry < ENTRY_SIMILARITY_PCT)
      const capped = logged.filter(l => nowTs - l.ts < 12 * 3600 * 1000).length >= MAX_LOGS_PER_SYMBOL

      let verdict: string
      if (s.score < MIN_SCORE_FLOOR && !meetsLevel) verdict = 'DISPLAY_FLOOR'
      else if (late) verdict = 'LATE_CUTOFF'
      else if (!volOk) verdict = `VOLUME (pm ${pmVolGate ?? '—'}, rvol ${tech.relativeVolume?.toFixed(0) ?? '—'})`
      else if (s.qualityVetoed) verdict = 'QUALITY_VETO (anti-fade/rollover)'
      else if (gradeFail) verdict = 'GRADE_FLOOR (below)'
      else if (capped) verdict = 'CAP (per-symbol)'
      else if (dup) verdict = 'DUP (entry cluster)'
      else { verdict = 'LOGS ✅'; anyLog = true; logged.push({ entry: fill, ts: nowTs }) }

      const offHigh = tech.distanceFromDayHighPct?.toFixed(1) ?? '—'
      console.log(`[${String(et).padStart(4, '0')}] ${s.type.padEnd(20)} g=${String(s.grade).padEnd(5)} sc=${s.score} rvol=${(tech.relativeVolume ?? 0).toFixed(0).padStart(3)}× fill=${fill.toFixed(2)} offHi=${offHigh}%  → ${verdict}`)
    }
  }
  console.log('')
  if (!anyTrigger) console.log('>>> NO_TRIGGER: setups were detected but none reached a long trigger on this tape (often a 5-min-vs-1-min granularity gap — the user trades 1-min).')
  else if (!anyLog) console.log('>>> BLOCKED: triggers fired but every one was gated out (see reasons above).')
  else console.log('>>> Would have alerted — see LOGS ✅ rows above.')
}
main().catch(e => { console.error(e); process.exit(1) })
