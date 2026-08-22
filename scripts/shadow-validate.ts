/**
 * SHADOW VALIDATION — off-high rule, prospective paper validation (RESEARCH ONLY).
 *
 * This script has NO order authority and NEVER mutates executor/paper state.
 *
 * FIDELITY MODEL (v2 — anchored to the real executor event log):
 *   CONTROL is NOT re-derived from classifyBuy. It IS the executor's actual admission,
 *   read from ~/.companion-paper-trades-<day>.json (filled trades) with EXACT,
 *   friction-inclusive R = realizedPnl / plannedRisk and REAL entry/exit timestamps
 *   (entryFilledAt → updatedAt). So shadow_control == live by construction.
 *
 *   The full chronological admission-attempt stream is executed fills + entry_blocked
 *   events (~/.companion-paper-events-<day>.jsonl), each carrying the executor's REAL
 *   capacity reason (premarket / concurrent / day / other). EXPERIMENT replays that same
 *   attempt sequence with ONE change — reject offHighPct < OFF_HIGH_THRESHOLD:
 *     • a control-admitted trade with offHighPct < -3  → DIRECT_REMOVAL (frees its slot);
 *     • a control-blocked (capacity) attempt that now fits AND has offHighPct >= -3
 *       → REPLACEMENT_ADMISSION (its R + slot lifetime reconstructed from 1-min tape,
 *       the only frictionless part — flagged);
 *     • a later control-admit that a replacement now crowds out → CASCADE_DIFFERENCE.
 *   Capacity counters (premarket / day / concurrent-by-time-window / per-symbol) use the
 *   committed DEFAULT_RISK values and the REAL executed timestamps.
 *
 *   offHighPct is read verbatim from the decision log — never recomputed.
 *
 * NOT modelled (needs live equity, absent from an R-only shadow): dollarised
 *   dailyLossLimitFraction / premarketLossLimitFraction / maxOpenRiskFraction. Flagged.
 *
 * Run:  SHADOW_DAYS=2026-08-24 npx tsx scripts/shadow-validate.ts
 *       SELF_TEST=1 writes <day>_selftest.json (infra check, excluded from the verdict).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { Candle, SetupLog, SetupType } from '@/types'
import { scaledPnl, resolveLogAgainstCandles, slippageForSession } from '@/lib/eod-resolver'
import { getSessionType } from '@/lib/market-hours'
import { DEFAULT_RISK } from '@/lib/execution/risk'

// ── FROZEN RULE (do not edit during the validation window) ────────────────────
const OFF_HIGH_THRESHOLD = -3
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
const H = homedir()

function apiKey(): string {
  const m = readFileSync(join(REPO, '.env.local'), 'utf8').match(/FMP_API_KEY\s*=\s*"?([^"\s]+)"?/)
  if (!m) throw new Error('FMP_API_KEY not found in .env.local')
  return m[1]
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function tape(symbol: string, day: string): Promise<Candle[] | null> {
  const f = join(CACHE, `m1_${symbol}_${day}.json`)
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
  if (!Array.isArray(raw) || raw.length === 0) return null   // empty = incomplete, NOT valid-empty
  const arr = raw as Array<Record<string, number | string>>
  // Cache is normalized ({time,...}); fresh FMP is ET wall-time strings. Aug–Oct 2026 = EDT (-04:00),
  // matching backtest.ts:215 — keeps the two harnesses in lockstep.
  return arr.map(c => 'time' in c
    ? { time: Number(c.time), open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume }
    : { time: Math.floor(Date.parse(`${String(c.date).replace(' ', 'T')}-04:00`) / 1000), open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume }
  ).sort((a, b) => a.time - b.time)
}

const capReason = (r: string): 'premarket' | 'concurrent' | 'day' | 'other' =>
  /premarket/.test(r) ? 'premarket' : /concurrent/.test(r) ? 'concurrent' : /trades\/day/.test(r) ? 'day' : 'other'

interface DecInfo { offHighPct: number | null; entry: number; stop: number; targets: number[]; session: string; setupType: SetupType }
function decisionsById(day: string): Map<string, DecInfo> {
  const f = join(H, `.companion-decisions-${day}.jsonl`)
  const m = new Map<string, DecInfo>()
  if (!existsSync(f)) return m
  for (const line of readFileSync(f, 'utf8').trim().split('\n')) {
    if (!line) continue
    let d: Record<string, unknown>; try { d = JSON.parse(line) } catch { continue }
    const id = String(d.setupId)
    if (m.has(id)) continue
    m.set(id, {
      offHighPct: d.offHighPct == null ? null : Number(d.offHighPct),
      entry: Number(d.entryRef ?? d.fill), stop: Number(d.stop),
      targets: Array.isArray(d.targets) ? (d.targets as number[]).map(Number).filter(Number.isFinite) : [],
      session: String(d.session ?? ''), setupType: d.setupType as SetupType,
    })
  }
  return m
}

// Reconstruct R + slot-exit time for a REPLACEMENT candidate from tape (frictionless).
function resolveFromTape(info: DecInfo, ts: number, candles: Candle[]): { R: number | null; exitTs: number | null; outcome: string } {
  if (!(info.entry > 0) || !(info.stop > 0) || info.entry <= info.stop || info.targets.length === 0)
    return { R: null, exitTs: null, outcome: 'invalid_geometry' }
  const slip = slippageForSession(getSessionType(ts))
  const pnl = scaledPnl(info.entry, info.stop, info.targets, candles, ts, slip)
  if (!pnl) return { R: null, exitTs: null, outcome: 'no_tape' }
  const stopFrac = (info.entry - info.stop) / info.entry, entryEff = info.entry * (1 + slip)
  let R = 0
  for (const leg of pnl.legs) R += stopFrac > 0 ? ((leg.exitPrice * (1 - slip) - entryEff) / entryEff) * leg.fraction / stopFrac : 0
  const log: SetupLog = {
    id: 'repl', symbol: '', type: info.setupType, direction: 'long', identifiedAt: ts, priceAtIdentification: info.entry,
    zoneLower: info.stop, zoneUpper: info.entry, score: 0, grade: 'C', confirmation: [], invalidation: info.stop,
    targets: info.targets.map((p, i) => ({ price: p, label: `T${i + 1}`, rewardRisk: null })), statesReached: [],
    maxFavorablePrice: info.entry, maxAdversePrice: info.entry, maxFavorablePct: 0, maxAdversePct: 0, outcome: 'open',
    outcomeReason: null, triggeredAt: ts, resolvedAt: null, relativeVolumeAtId: null, sessionAtId: info.session as SetupLog['sessionAtId'], testCount: 0,
  }
  const r = resolveLogAgainstCandles(log, candles)
  const lastTs = candles.length ? candles[candles.length - 1].time * 1000 : ts
  return { R, exitTs: r?.resolvedAt ?? lastTs, outcome: r?.outcome ?? 'open' }
}

interface Attempt {
  setupId: string; symbol: string; ts: number; session: 'premarket' | 'regular' | string
  kind: 'admitted' | 'blocked'; blockReason?: 'premarket' | 'concurrent' | 'day' | 'other'
  terminal?: boolean; R: number | null; entryTs: number | null; exitTs: number | null; offHighPct: number | null
  outcomeNote?: string
}

function buildAttempts(day: string, dec: Map<string, DecInfo>) {
  const trades = JSON.parse(readFileSync(join(H, `.companion-paper-trades-${day}.json`), 'utf8')) as Array<Record<string, unknown>>
  const events = readFileSync(join(H, `.companion-paper-events-${day}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  const dayEndTs = (() => { const anyTs = trades.map(t => Number(t.updatedAt)).filter(Boolean); return anyTs.length ? Math.max(...anyTs) : Date.now() })()

  const admitted: Attempt[] = []
  const liveAdmittedIds: string[] = []
  for (const t of trades) {
    if (t.entryFilledAt == null) continue                 // aborted/timed-out = never admitted
    const id = String(t.setupId); liveAdmittedIds.push(id)
    const risk = Number(t.plannedRisk), pnl = t.realizedPnl == null ? null : Number(t.realizedPnl)
    admitted.push({
      setupId: id, symbol: String(t.symbol), ts: Number(t.entrySubmittedAt ?? t.entryFilledAt), session: String(t.entrySession),
      kind: 'admitted', R: risk > 0 && pnl != null ? pnl / risk : null,
      entryTs: Number(t.entryFilledAt), exitTs: t.state === 'open' ? dayEndTs : Number(t.updatedAt),
      offHighPct: dec.get(id)?.offHighPct ?? null, outcomeNote: String(t.state),
    })
  }
  const blocked: Attempt[] = []
  const seenBlock = new Set<string>()
  for (const e of events) {
    if (e.event !== 'entry_blocked') continue
    const id = String(e.setupId); if (seenBlock.has(id) || liveAdmittedIds.includes(id)) continue
    seenBlock.add(id)
    const info = dec.get(id)
    blocked.push({
      setupId: id, symbol: String(e.symbol), ts: new Date(String(e.ts)).getTime(), session: info?.session ?? 'regular',
      kind: 'blocked', blockReason: capReason(String(e.reason)), terminal: Boolean(e.terminal),
      R: null, entryTs: null, exitTs: null, offHighPct: info?.offHighPct ?? null,
    })
  }
  return { attempts: [...admitted, ...blocked].sort((a, b) => a.ts - b.ts), liveAdmittedIds, dayEndTs }
}

const sum = (a: number[]) => a.reduce((s, x) => s + x, 0)
const pf = (a: number[]) => { const w = sum(a.filter(x => x > 0)), l = Math.abs(sum(a.filter(x => x <= 0))); return l ? +(w / l).toFixed(3) : null }
function metrics(rs: number[]) { return { n: rs.length, netR: +sum(rs).toFixed(3), meanR: rs.length ? +(sum(rs) / rs.length).toFixed(3) : null, winRate: rs.length ? +(100 * rs.filter(x => x > 0).length / rs.length).toFixed(1) : null, pf: pf(rs) } }

async function runDay(day: string) {
  const dec = decisionsById(day)
  const { attempts, liveAdmittedIds } = buildAttempts(day, dec)

  // tape only for replacement candidates (control-blocked with resolvable geometry)
  const replSyms = [...new Set(attempts.filter(a => a.kind === 'blocked').map(a => a.symbol))]
  const tapes = new Map<string, Candle[] | null>()
  for (const s of replSyms) tapes.set(s, await tape(s, day))

  // ── CONTROL = actual executor admission (ground truth) ──
  const controlAdmitted = attempts.filter(a => a.kind === 'admitted')
  const controlR = controlAdmitted.filter(a => a.R != null).map(a => a.R as number)
  const controlOpenNoR = controlAdmitted.filter(a => a.R == null).map(a => a.setupId)  // e.g. still-open

  // ── EXPERIMENT (delta-based, FIRST-ORDER reshuffle) ──
  // Anchored to the executor's REAL block reasons + removed trades' EXACT lifetime windows.
  // off-high removals VACATE capacity; a previously-blocked candidate may fill ONLY the
  // specific capacity a removal actually freed. Replacements never displace a trade the
  // executor really took (no cascade) — the honest choice, since a never-executed
  // replacement's true lifetime is unknown. This avoids recomputing instantaneous
  // concurrency (the part that cannot be faithfully reconstructed).
  const directRemovals = controlAdmitted.filter(a => a.offHighPct != null && a.offHighPct < OFF_HIGH_THRESHOLD)
  const unchanged = controlAdmitted.filter(a => !(a.offHighPct != null && a.offHighPct < OFF_HIGH_THRESHOLD))

  // Freed capacity pools from removals (removed lifetimes are EXACT, from live).
  // GLOBAL: every replacement consumes one day-slot, so total replacements <= removals
  // (never breaches maxTradesPerDay). Sub-gates below ensure the SPECIFIC constraint that
  // blocked a candidate was actually relaxed by a removal.
  const replBudget = directRemovals.length          // = day-slots freed; global cap on replacements
  let replUsed = 0
  let pmFreed = directRemovals.filter(a => a.session === 'premarket').length, pmUsed = 0
  const concWindows = directRemovals.map(a => ({ from: a.entryTs as number, to: a.exitTs as number, used: false }))

  const blockedAttempts = attempts.filter(a => a.kind === 'blocked').sort((a, b) => a.ts - b.ts)
  const replacements: Attempt[] = []
  const capacityReasonDiffs: { setupId: string; controlReason: string; experimentOutcome: string }[] = []
  for (const b of blockedAttempts) {
    if (replUsed >= replBudget) break                                                  // global slot budget exhausted
    if (b.offHighPct != null && b.offHighPct < OFF_HIGH_THRESHOLD) continue            // rejected by the rule anyway
    const info = dec.get(b.setupId)
    if (!info || info.targets.length === 0 || !(info.entry > info.stop)) continue       // unresolvable → cannot admit
    // Was the SPECIFIC constraint that blocked b actually relaxed by a removal?
    let consumeSub: null | (() => void) = null
    if (b.blockReason === 'day') consumeSub = () => {}                                  // day-slot covered by global budget
    else if (b.blockReason === 'premarket') { if (b.session === 'premarket' && pmUsed < pmFreed) consumeSub = () => { pmUsed++ } }
    else if (b.blockReason === 'concurrent') { const w = concWindows.find(w => !w.used && b.ts >= w.from && b.ts <= w.to); if (w) consumeSub = () => { w.used = true } }
    if (!consumeSub) continue
    const res = resolveFromTape(info, b.ts, tapes.get(b.symbol) ?? [])
    if (res.R == null) continue                                                         // no tape → cannot admit faithfully
    consumeSub(); replUsed++
    b.R = res.R; b.entryTs = b.ts; b.exitTs = res.exitTs; b.outcomeNote = res.outcome
    replacements.push(b)
    capacityReasonDiffs.push({ setupId: b.setupId, controlReason: `blocked_${b.blockReason}`, experimentOutcome: 'admitted_replacement' })
  }
  const cascades: Attempt[] = []   // 0 by construction in the first-order model (documented)

  const directOnlyR = unchanged.filter(a => a.R != null).map(a => a.R as number)       // conservative bound
  const expR = [...directOnlyR, ...replacements.map(a => a.R as number)]               // reshuffle-aware

  // ── reconciliation diagnostics (required every session) ──
  const shadowControlIds = controlAdmitted.map(a => a.setupId)
  const recon = {
    shadow_control_admitted: shadowControlIds.length,
    live_admitted: liveAdmittedIds.length,
    admission_count_delta: shadowControlIds.length - liveAdmittedIds.length,
    matched_setupIds: liveAdmittedIds.filter(id => shadowControlIds.includes(id)).length,
    live_only_setupIds: liveAdmittedIds.filter(id => !shadowControlIds.includes(id)),
    shadow_only_setupIds: shadowControlIds.filter(id => !liveAdmittedIds.includes(id)),
    control_open_without_R: controlOpenNoR,
    capacity_reason_differences: capacityReasonDiffs,
  }

  const record = {
    day, resolvedAtUtc: new Date().toISOString(), gitHead: process.env.GIT_HEAD ?? null,
    rule: `offHighPct < ${OFF_HIGH_THRESHOLD}`, caps: CAPS, model: 'v2-event-anchored',
    control: metrics(controlR),
    experimentDirectOnly: metrics(directOnlyR),   // conservative: removals only, slots left empty
    experiment: metrics(expR),                     // reshuffle-aware (first-order)
    reshuffle: {
      DIRECT_REMOVAL: { n: directRemovals.length, netR: +sum(directRemovals.filter(a => a.R != null).map(a => a.R as number)).toFixed(3), setupIds: directRemovals.map(a => a.setupId) },
      REPLACEMENT_ADMISSION: { n: replacements.length, netR: +sum(replacements.map(a => a.R as number)).toFixed(3),
        detail: replacements.map(a => ({ setupId: a.setupId, offHighPct: a.offHighPct, R: a.R, outcome: a.outcomeNote, blockedFor: a.blockReason })) },
      CASCADE_DIFFERENCE: { n: cascades.length, setupIds: cascades.map(a => a.setupId) },
      UNCHANGED: unchanged.length,
    },
    reconciliation: recon,
    fidelityNotes: [
      'CONTROL = actual executor fills (exact friction-inclusive R); shadow_control==live by construction.',
      'Reshuffle is FIRST-ORDER: replacements fill only capacity a removal actually vacated (day/premarket count or a removed trade\'s exact concurrent window); they never displace a trade the executor really took, so CASCADE=0 by construction. This avoids recomputing instantaneous concurrency (unfaithful).',
      'REPLACEMENT_ADMISSION R is a frictionless tape reconstruction (the only non-exact component). experimentDirectOnly is the conservative bound with no replacements.',
      'Dollar gates (daily/premarket loss limit, open-risk fraction) not modeled — applied equally to both arms.',
    ],
  }
  const suffix = process.env.SELF_TEST === '1' ? '_selftest' : ''
  writeFileSync(join(OUT, `${day}${suffix}.json`), JSON.stringify(record, null, 2))
  console.log(`${day}  C:${record.control.n}@${record.control.netR}R(PF ${record.control.pf})  E(direct):${record.experimentDirectOnly.netR}R  E(reshuffle):${record.experiment.n}@${record.experiment.netR}R(PF ${record.experiment.pf})  | direct=${record.reshuffle.DIRECT_REMOVAL.n}(${record.reshuffle.DIRECT_REMOVAL.netR}R) repl=${record.reshuffle.REPLACEMENT_ADMISSION.n}(${record.reshuffle.REPLACEMENT_ADMISSION.netR}R) cascade=${record.reshuffle.CASCADE_DIFFERENCE.n} | recon match ${recon.matched_setupIds}/${recon.live_admitted} shadowOnly=${recon.shadow_only_setupIds.length}`)
}

async function main() {
  const days = (process.env.SHADOW_DAYS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (!days.length) { console.error('SHADOW_DAYS=YYYY-MM-DD[,...] required'); process.exit(1) }
  console.log(`shadow-validate v2  rule="offHighPct < ${OFF_HIGH_THRESHOLD}"  caps=${JSON.stringify(CAPS)}  selfTest=${process.env.SELF_TEST === '1'}`)
  for (const d of days) { try { await runDay(d) } catch (e) { console.log(`${d}  ERROR: ${(e as Error).message}`) } }
}
main()
