/**
 * SHADOW VALIDATION — off-high rule, prospective paper validation (RESEARCH ONLY).
 *
 * This script has NO order authority and NEVER mutates executor/paper state. It:
 *   1. reads a completed session's LIVE decision stream (~/.companion-decisions-<day>.jsonl),
 *   2. reconstructs the executor candidate stream (verdict === 'logged', deduped by setupId),
 *   3. resolves each candidate's R + exit time AFTER the session from 1-minute tape via the
 *      SHARED resolver (scaledPnl / resolveLogAgainstCandles) — the same modules the live
 *      executor's P&L accounting descends from, so shadow and live cannot drift,
 *   4. runs TWO chronological capacity portfolios with the committed caps:
 *        CONTROL     = full logged stream
 *        EXPERIMENT  = identical, minus candidates with offHighPct < OFF_HIGH_THRESHOLD
 *      Rejecting a candidate frees its slot, so a later blocked candidate may be admitted.
 *   5. writes a per-session shadow record to data/research-cache/shadow-offhigh/<day>.json.
 *
 * It reads the EXISTING decision-time offHighPct field verbatim — it does NOT recompute it.
 *
 * Caps modelled faithfully (entry chronology + real tape exit times):
 *   maxTradesPerDay, maxPremarketTrades, maxConcurrentPositions, maxPositionsPerSymbol.
 * NOT modelled (needs live equity/sizing, absent from an R-only shadow): dollarised
 *   dailyLossLimitFraction / premarketLossLimitFraction / maxOpenRiskFraction. Flagged in output.
 *
 * Run:  SHADOW_DAYS=2026-08-25 npx tsx scripts/shadow-validate.ts
 *       SHADOW_DAYS=2026-08-25,2026-08-26  (comma list)
 * Env:  SELF_TEST=1 resolves+reports but writes to a *_selftest.json (infra check, excluded
 *       from the validation ledger).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { Candle, SetupLog, SetupType } from '@/types'
import { scaledPnl, resolveLogAgainstCandles, slippageForSession } from '@/lib/eod-resolver'
import { getSessionType } from '@/lib/market-hours'
import { DEFAULT_RISK } from '@/lib/execution/risk'

// ── FROZEN RULE (do not edit during the validation window) ────────────────────
const OFF_HIGH_THRESHOLD = -3          // reject when offHighPct < -3 (more than 3% below the high)
const CAPS = {
  maxTradesPerDay: DEFAULT_RISK.maxTradesPerDay,
  maxPremarketTrades: DEFAULT_RISK.maxPremarketTrades,
  maxConcurrentPositions: DEFAULT_RISK.maxConcurrentPositions,
  maxPositionsPerSymbol: DEFAULT_RISK.maxPositionsPerSymbol,
}

const REPO = process.cwd()
const CACHE = join(REPO, 'data', 'research-cache')
const OUT = join(CACHE, 'shadow-offhigh')
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

function apiKey(): string {
  const env = readFileSync(join(REPO, '.env.local'), 'utf8')
  const m = env.match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/)
  if (!m) throw new Error('FMP_API_KEY not found in .env.local')
  return m[1]
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function tape(symbol: string, day: string): Promise<Candle[] | null> {
  const cacheName = `m1_${symbol}_${day}.json`
  const f = join(CACHE, cacheName)
  let raw: unknown = null
  if (existsSync(f)) raw = JSON.parse(readFileSync(f, 'utf8'))
  else {
    const url = `https://financialmodelingprep.com/stable/historical-chart/1min?symbol=${symbol}&from=${day}&to=${day}&extended=true&apikey=${apiKey()}`
    for (let a = 0; a < 6; a++) {
      const res = await fetch(url)
      if (res.ok) { raw = await res.json(); writeFileSync(f, JSON.stringify(raw)); break }
      if (res.status !== 429 && res.status < 500) return null
      await sleep(1500 * (a + 1))
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return null   // empty = incomplete, NOT valid-empty tape
  const arr = raw as Array<Record<string, number | string>>
  // Cache is stored normalized ({time,...}); fresh FMP responses are ET wall-time strings.
  // Aug–Oct 2026 is EDT (-04:00), matching backtest.ts:215 — keep the two harnesses in lockstep.
  const norm = arr.map(c => 'time' in c
    ? { time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) }
    : { time: Math.floor(Date.parse(`${String(c.date).replace(' ', 'T')}-04:00`) / 1000), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) })
  return norm.sort((a, b) => a.time - b.time)
}

interface Candidate {
  setupId: string; symbol: string; type: SetupType; grade: string; score: number | null
  offHighPct: number | null; session: string; entry: number; stop: number; targets: number[]
  ts: number; etTime: string
}

function candidateStream(day: string): { cands: Candidate[]; rawLines: number } {
  const f = join(homedir(), `.companion-decisions-${day}.jsonl`)
  if (!existsSync(f)) throw new Error(`no decision log for ${day}`)
  const lines = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
  const seen = new Set<string>()
  const cands: Candidate[] = []
  for (const line of lines) {
    let d: Record<string, unknown>
    try { d = JSON.parse(line) } catch { continue }
    if (d.verdict !== 'logged') continue                 // only executor-bound candidates
    const id = String(d.setupId)
    if (seen.has(id)) continue                            // one trade per setup/day (executor dedups)
    seen.add(id)
    const entry = Number(d.entryRef ?? d.fill)
    const stop = Number(d.stop)
    const targets = Array.isArray(d.targets) ? (d.targets as number[]).map(Number).filter(Number.isFinite) : []
    cands.push({
      setupId: id, symbol: String(d.symbol), type: d.setupType as SetupType,
      grade: String(d.grade ?? '?'), score: d.score == null ? null : Number(d.score),
      offHighPct: d.offHighPct == null ? null : Number(d.offHighPct),
      session: String(d.session ?? ''), entry, stop, targets,
      ts: new Date(String(d.ts)).getTime(), etTime: String(d.etTime ?? ''),
    })
  }
  cands.sort((a, b) => a.ts - b.ts)
  return { cands, rawLines: lines.length }
}

interface Resolved extends Candidate { R: number | null; exitTs: number | null; outcome: string; incomplete?: string }

function resolve(c: Candidate, candles: Candle[]): Resolved {
  if (!(c.entry > 0) || !(c.stop > 0) || c.entry <= c.stop || c.targets.length === 0)
    return { ...c, R: null, exitTs: null, outcome: 'invalid_geometry', incomplete: 'geometry' }
  const slip = slippageForSession(getSessionType(c.ts))
  const pnl = scaledPnl(c.entry, c.stop, c.targets, candles, c.ts, slip)
  if (!pnl) return { ...c, R: null, exitTs: null, outcome: 'no_tape', incomplete: 'no_post_signal_tape' }
  const stopFrac = (c.entry - c.stop) / c.entry
  const entryEff = c.entry * (1 + slip)
  let R = 0
  for (const leg of pnl.legs) {
    const exitEff = leg.exitPrice * (1 - slip)
    R += stopFrac > 0 ? ((exitEff - entryEff) / entryEff) * leg.fraction / stopFrac : 0
  }
  const log: SetupLog = {
    id: c.setupId, symbol: c.symbol, type: c.type, direction: 'long', identifiedAt: c.ts,
    priceAtIdentification: c.entry, zoneLower: c.stop, zoneUpper: c.entry, score: c.score ?? 0,
    grade: c.grade as SetupLog['grade'], confirmation: [], invalidation: c.stop,
    targets: c.targets.map((p, i) => ({ price: p, label: `T${i + 1}`, rewardRisk: null })),
    statesReached: [], maxFavorablePrice: c.entry, maxAdversePrice: c.entry, maxFavorablePct: 0,
    maxAdversePct: 0, outcome: 'open', outcomeReason: null, triggeredAt: c.ts, resolvedAt: null,
    relativeVolumeAtId: null, sessionAtId: c.session as SetupLog['sessionAtId'], testCount: 0,
  }
  const r = resolveLogAgainstCandles(log, candles)
  const lastTs = candles.length ? candles[candles.length - 1].time * 1000 : c.ts
  const exitTs = r?.resolvedAt ?? lastTs                  // slot frees when resolved; else rides to close
  return { ...c, R, exitTs, outcome: r?.outcome ?? 'open' }
}

// Chronological capacity portfolio. Returns admitted setupIds in order.
function portfolio(cands: Resolved[], excludeOffHigh: boolean): { admitted: Set<string>; removedDirect: Set<string> } {
  const admitted = new Set<string>(); const removedDirect = new Set<string>()
  let dayCount = 0, pmCount = 0
  const open: Resolved[] = []
  for (const c of cands) {
    if (c.R == null) continue                             // unresolved candidates cannot enter either book
    if (excludeOffHigh && c.offHighPct != null && c.offHighPct < OFF_HIGH_THRESHOLD) { removedDirect.add(c.setupId); continue }
    // free slots whose position exited before this candidate's entry
    for (let i = open.length - 1; i >= 0; i--) if ((open[i].exitTs ?? Infinity) <= c.ts) open.splice(i, 1)
    if (dayCount >= CAPS.maxTradesPerDay) continue
    if (c.session === 'premarket' && pmCount >= CAPS.maxPremarketTrades) continue
    if (open.length >= CAPS.maxConcurrentPositions) continue
    if (open.filter(o => o.symbol === c.symbol).length >= CAPS.maxPositionsPerSymbol) continue
    admitted.add(c.setupId); dayCount++; if (c.session === 'premarket') pmCount++; open.push(c)
  }
  return { admitted, removedDirect }
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)
const pf = (a: number[]) => { const w = sum(a.filter(x => x > 0)), l = Math.abs(sum(a.filter(x => x <= 0))); return l ? +(w / l).toFixed(3) : null }

function metrics(cands: Resolved[], admitted: Set<string>) {
  const a = cands.filter(c => admitted.has(c.setupId) && c.R != null)
  const R = a.map(c => c.R as number)
  return { n: a.length, netR: +sum(R).toFixed(3), meanR: a.length ? +(sum(R) / a.length).toFixed(3) : null,
    winRate: a.length ? +(100 * a.filter(c => (c.R as number) > 0).length / a.length).toFixed(1) : null, pf: pf(R) }
}

async function runDay(day: string) {
  const { cands, rawLines } = candidateStream(day)
  const symbols = [...new Set(cands.map(c => c.symbol))]
  const tapes = new Map<string, Candle[] | null>()
  for (const s of symbols) tapes.set(s, await tape(s, day))
  const resolved = cands.map(c => resolve(c, tapes.get(c.symbol) ?? []))
  const incomplete = resolved.filter(r => r.incomplete)
  const dayIncomplete = symbols.length > 0 && symbols.every(s => !tapes.get(s))

  const C = portfolio(resolved, false)
  const E = portfolio(resolved, true)
  const idMap = new Map(resolved.map(r => [r.setupId, r]))
  const replacements = [...E.admitted].filter(id => !C.admitted.has(id)).map(id => idMap.get(id)!)
  const cascadeOut = [...C.admitted].filter(id => !E.admitted.has(id) && !E.removedDirect.has(id)).map(id => idMap.get(id)!)
  const directRemovals = [...C.admitted].filter(id => E.removedDirect.has(id)).map(id => idMap.get(id)!)

  const record = {
    day, resolvedAtUtc: new Date().toISOString(), gitHead: process.env.GIT_HEAD ?? null,
    rule: `offHighPct < ${OFF_HIGH_THRESHOLD}`, caps: CAPS,
    rawDecisionLines: rawLines, candidates: cands.length, symbols: symbols.length,
    dataIncomplete: dayIncomplete, incompleteCandidates: incomplete.map(i => ({ setupId: i.setupId, reason: i.incomplete })),
    control: metrics(resolved, C.admitted),
    experiment: metrics(resolved, E.admitted),
    reshuffle: {
      directRemovals: { n: directRemovals.length, netR: +sum(directRemovals.map(r => r.R as number)).toFixed(3) },
      replacementAdmissions: { n: replacements.length, netR: +sum(replacements.map(r => r.R as number)).toFixed(3),
        detail: replacements.map(r => ({ setupId: r.setupId, offHighPct: r.offHighPct, R: r.R, outcome: r.outcome, session: r.session })) },
      cascadeDifferences: cascadeOut.length,
      unchanged: [...C.admitted].filter(id => E.admitted.has(id)).length,
    },
    perCandidate: resolved.map(r => ({ setupId: r.setupId, symbol: r.symbol, type: r.type, grade: r.grade, session: r.session,
      offHighPct: r.offHighPct, R: r.R, outcome: r.outcome, inControl: C.admitted.has(r.setupId), inExperiment: E.admitted.has(r.setupId) })),
  }
  const suffix = process.env.SELF_TEST === '1' ? '_selftest' : ''
  writeFileSync(join(OUT, `${day}${suffix}.json`), JSON.stringify(record, null, 2))
  console.log(`${day}${dayIncomplete ? '  DATA_INCOMPLETE' : ''}  cand=${cands.length}  C:${record.control.n}@${record.control.netR}R(PF ${record.control.pf})  E:${record.experiment.n}@${record.experiment.netR}R(PF ${record.experiment.pf})  directRem=${record.reshuffle.directRemovals.n}(${record.reshuffle.directRemovals.netR}R)  repl=${record.reshuffle.replacementAdmissions.n}(${record.reshuffle.replacementAdmissions.netR}R)`)
}

async function main() {
  const days = (process.env.SHADOW_DAYS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!days.length) { console.error('SHADOW_DAYS=YYYY-MM-DD[,YYYY-MM-DD] required'); process.exit(1) }
  console.log(`shadow-validate  rule="offHighPct < ${OFF_HIGH_THRESHOLD}"  caps=${JSON.stringify(CAPS)}  selfTest=${process.env.SELF_TEST === '1'}`)
  for (const d of days) { try { await runDay(d) } catch (e) { console.log(`${d}  ERROR: ${(e as Error).message}`) } }
}
main()
