/**
 * Recall harness — "of the setups we actually wanted, how many did we even SEE?"
 *
 * Everything else we measure is PRECISION (win rate / expectancy of what we fire).
 * This measures RECALL against a labelled set of setups the user asked for
 * (data/target-setups.json, built from their screenshots). Recall is judged on
 * detection, independent of outcome, so it is not biased the way gate policy is
 * when it's inferred from only-the-winners-get-screenshotted evidence.
 *
 * Each labelled setup lands in one of three states:
 *   ALERTED       — a detector fired near that time AND it cleared the gates
 *   DETECTED_GATED— a detector fired but a gate dropped it (policy question)
 *   NOT_DETECTED  — nothing fired at all (a genuine RECOGNITION gap)
 *
 * Rule of the road: any detection change must improve recall here WITHOUT hurting
 * expectancy in scripts/backtest.ts. Improving recall alone is just gate-loosening
 * wearing a different hat.
 *
 * Run:  npx tsx scripts/recall.ts            (all labelled setups)
 *       npx tsx scripts/recall.ts GAUZ       (filter to one symbol)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { BuySignalRecord } from '@/types'
import { replayDay, etDayKey, etStrToUnixSec, type RawRow } from '@/lib/replay-day'
import { classifyBuy, passesTrackingFloor } from '@/lib/buy-log'

const MIN_LEVEL_STRENGTH = 40
const WINDOW_MIN = 25      // a trigger this many minutes either side counts as "seen it"

const FILTER = process.argv[2]?.toUpperCase()
const REPO = process.cwd()
const KEY = readFileSync(join(REPO, '.env.local'), 'utf8').match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/)![1]
const CACHE = '/private/tmp/claude-501/-Users-elonmusk-Companion/e73f584c-b4b9-412c-a4d7-ccaf1e47b222/scratchpad/fmp-cache'
if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })

interface Target { symbol: string; date: string; etTime: string; entry: number; shape: string; movePct: number; note: string }

async function get(name: string, url: string): Promise<unknown> {
  const f = join(CACHE, name + '.json')
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'))
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  writeFileSync(f, JSON.stringify(j))
  return j
}

const hhmmToMin = (s: string) => Math.floor(Number(s) / 100) * 60 + (Number(s) % 100)

interface Outcome { target: Target; state: 'ALERTED' | 'DETECTED_GATED' | 'NOT_DETECTED'; detail: string }

async function evaluate(t: Target): Promise<Outcome> {
  let m5: RawRow[], daily: RawRow[]
  try {
    const from = etDayKey(etStrToUnixSec(t.date) - 14 * 86400)
    m5 = ((await get(`m5_${t.symbol}_${t.date}`, `https://financialmodelingprep.com/stable/historical-chart/5min?symbol=${t.symbol}&from=${from}&to=${t.date}&extended=true&apikey=${KEY}`)) as RawRow[])
      .slice().sort((a, b) => a.date.localeCompare(b.date))
    const dRaw = await get(`daily_${t.symbol}`, `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${t.symbol}&from=2026-06-01&to=${t.date}&apikey=${KEY}`)
    daily = (Array.isArray(dRaw) ? dRaw : (dRaw as { historical?: RawRow[] }).historical ?? []).slice().sort((a, b) => a.date.localeCompare(b.date))
  } catch (e) {
    return { target: t, state: 'NOT_DETECTED', detail: `NO_DATA (${(e as Error).message})` }
  }
  if (m5.filter(r => r.date.slice(0, 10) === t.date).length === 0) {
    return { target: t, state: 'NOT_DETECTED', detail: 'NO_DATA (no intraday bars)' }
  }

  const wantMin = hhmmToMin(t.etTime)
  const dayBuys: BuySignalRecord[] = []
  const near: { et: number; type: string; grade: string; verdict: string; fill: number }[] = []

  for (const bar of replayDay(t.symbol, t.date, m5, daily)) {
    const barMin = Math.floor(bar.etHHMM / 100) * 60 + (bar.etHHMM % 100)
    for (const s of bar.setups) {
      if (!(s.direction === 'long' && s.triggeredRaw)) continue
      // Gate state has to be tracked across the WHOLE day (dedup/cap depend on
      // earlier fires), so classify every trigger — but only score the ones in
      // the window around the labelled entry.
      let verdict = 'DISPLAY_FLOOR'
      if (passesTrackingFloor(s, MIN_LEVEL_STRENGTH)) {
        const res = classifyBuy(s, bar.result, { now: bar.nowTs, priorBuys: dayBuys, priorLogs: [], priorStates: [] })
        verdict = res.verdict
        if (res.verdict === 'logged' && res.buy) dayBuys.push(res.buy)
      }
      if (Math.abs(barMin - wantMin) <= WINDOW_MIN) {
        near.push({ et: bar.etHHMM, type: s.type, grade: String(s.grade), verdict, fill: s.entryFill ?? s.zoneUpper })
      }
    }
  }

  if (near.length === 0) return { target: t, state: 'NOT_DETECTED', detail: 'no long trigger in window' }
  const win = near.find(n => n.verdict === 'logged')
  if (win) return { target: t, state: 'ALERTED', detail: `${String(win.et).padStart(4, '0')} ${win.type} @ ${win.fill.toFixed(2)}` }
  const best = near[0]
  const reasons = [...new Set(near.map(n => n.verdict))].join(',')
  return { target: t, state: 'DETECTED_GATED', detail: `${String(best.et).padStart(4, '0')} ${best.type} (g=${best.grade}) → ${reasons}` }
}

async function main() {
  const raw = JSON.parse(readFileSync(join(REPO, 'data/target-setups.json'), 'utf8')) as { setups: Target[] }
  const targets = raw.setups.filter(t => !FILTER || t.symbol === FILTER)
  console.log(`\nRecall over ${targets.length} labelled setups (±${WINDOW_MIN} min window)\n`)

  const out: Outcome[] = []
  for (const t of targets) {
    const o = await evaluate(t)
    out.push(o)
    const icon = o.state === 'ALERTED' ? '✅' : o.state === 'DETECTED_GATED' ? '🟡' : '❌'
    console.log(`${icon} ${t.symbol.padEnd(5)} ${t.date} ${t.etTime}  +${String(t.movePct).padStart(3)}%  ${o.state.padEnd(14)} ${o.detail}`)
  }

  const n = out.length
  const alerted = out.filter(o => o.state === 'ALERTED').length
  const gated = out.filter(o => o.state === 'DETECTED_GATED').length
  const missed = out.filter(o => o.state === 'NOT_DETECTED').length
  const pct = (x: number) => `${Math.round((x / n) * 100)}%`

  console.log(`\n${'─'.repeat(64)}`)
  console.log(`RECOGNITION (detected at all): ${alerted + gated}/${n}  ${pct(alerted + gated)}`)
  console.log(`  ✅ alerted        ${alerted}/${n}  ${pct(alerted)}`)
  console.log(`  🟡 detected+gated ${gated}/${n}  ${pct(gated)}   ← policy question`)
  console.log(`  ❌ not detected   ${missed}/${n}  ${pct(missed)}   ← RECOGNITION gap (the work)`)
  console.log(`${'─'.repeat(64)}`)
  console.log(`Rule: a detection change must raise RECOGNITION here without hurting`)
  console.log(`expectancy in scripts/backtest.ts. Both, or it doesn't ship.\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
