/**
 * H4B — LEADER_CONTINUATION shadow session research tool (READ-ONLY; no trading action).
 *
 * Reads the funnel candidate events + the H4B-PREP 1m tape for one ET date (or range), runs the
 * pure terminal-causal outcome evaluator per distinct candidate, and writes a candidate-level
 * research table + a session summary under an ignored research-output path. It NEVER submits an
 * order, mutates state, or changes any decision.
 *
 *   npx tsx scripts/research/h4b-session.ts <YYYY-MM-DD> [YYYY-MM-DD] [--out <dir>]
 *
 * Env overrides (research only): COMPANION_FUNNEL_DIR, COMPANION_1M_TAPE_DIR.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parseTape, assessTapeFile, type TapeEvent, type TapeCompleteness } from '@/lib/research/tape-1m-replay'
import { evaluateCandidateOutcome, type WindowOutcome, type CandidateOutcome } from '@/lib/leader/leader-continuation-outcome'
import type { ShadowCandidateEvent } from '@/lib/leader/leader-continuation'

function parseArgs(argv: string[]): { days: string[]; out: string } {
  const rest = argv.slice(2)
  const outIdx = rest.indexOf('--out')
  const out = outIdx >= 0 ? rest[outIdx + 1] : join(process.cwd(), 'data', 'research-cache', 'h4b')
  const dates = rest.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1))
  if (dates.length === 0) { console.error('usage: h4b-session.ts <YYYY-MM-DD> [YYYY-MM-DD] [--out <dir>]'); process.exit(1) }
  const [start, end] = [dates[0], dates[1] ?? dates[0]]
  const days: string[] = []
  const d = new Date(start + 'T12:00:00Z'); const last = new Date(end + 'T12:00:00Z')
  while (d <= last) { days.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1) }
  return { days, out }
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
}

const median = (xs: number[]): number | null => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (s.length === 0) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const pctile = (xs: number[], p: number): number | null => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  if (s.length === 0) return null
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]
}

interface Row {
  day: string
  candidate: ShadowCandidateEvent
  tapeCompleteness: TapeCompleteness
  w: Record<number, WindowOutcome>
  outcome: CandidateOutcome
}

export function runH4bSession(cfg: { days: string[]; out: string; funnelDir?: string; tapeDir?: string }): { csvPath: string; sumPath: string; summary: Record<string, unknown> } {
  const { days, out } = cfg
  const funnelDir = cfg.funnelDir || process.env.COMPANION_FUNNEL_DIR || homedir()
  const tapeDir = cfg.tapeDir || process.env.COMPANION_1M_TAPE_DIR || homedir()
  const rows: Row[] = []

  for (const day of days) {
    const funnelPath = join(funnelDir, `.companion-funnel-${day}.jsonl`)
    const tapePath = join(tapeDir, `.companion-1m-tape-${day}.jsonl`)
    const rawFunnel = readJsonl(funnelPath)
    const candidates = rawFunnel.filter(e => e.eventType === 'leader_continuation_candidate') as unknown as ShadowCandidateEvent[]
    // Deterministic dedup by the COLLISION-SAFE canonical key. The retained record is the EARLIEST
    // causal observation of that candidate (a later restart re-emission never overwrites first facts).
    const byId = new Map<string, ShadowCandidateEvent>()
    for (const c of candidates) {
      const key = c.canonicalCandidateKey ?? c.shadowCandidateId
      const prev = byId.get(key)
      if (!prev || Date.parse(c.candidateObservedAt) < Date.parse(prev.candidateObservedAt)) byId.set(key, c)
    }

    const tapeText = existsSync(tapePath) ? readFileSync(tapePath, 'utf8') : ''
    const tapeCompleteness = tapeText ? assessTapeFile(tapeText).completeness : 'INCOMPLETE'
    const tapeEventsAll: TapeEvent[] = tapeText ? parseTape(tapeText).events : []
    const tapeBySymbol = new Map<string, TapeEvent[]>()
    for (const e of tapeEventsAll) {
      const sym = typeof (e as Record<string, unknown>).symbol === 'string' ? ((e as Record<string, unknown>).symbol as string).toUpperCase() : null
      if (!sym) continue
      const arr = tapeBySymbol.get(sym) ?? []; arr.push(e); tapeBySymbol.set(sym, arr)
    }

    for (const c of byId.values()) {
      const evs = tapeBySymbol.get(c.symbol.toUpperCase()) ?? []
      const outcome = evaluateCandidateOutcome(c, evs, { tapeCompleteness })
      const w: Record<number, WindowOutcome> = {}
      for (const wo of outcome.windows) w[wo.windowMin] = wo
      rows.push({ day, candidate: c, tapeCompleteness, w, outcome })
    }
  }

  mkdirSync(out, { recursive: true })
  const tag = days.length === 1 ? days[0] : `${days[0]}_to_${days[days.length - 1]}`

  // ── candidate-level CSV ──
  const cols = [
    'day', 'shadowCandidateId', 'symbol', 'leaderEpisodeId', 'setupId', 'candidateObservedAt',
    'leaderRole', 'leaderLifecycle', 'historyComplete',
    'offHighGroup', 'globalOffHighPct', 'dayChangePct',
    'baseRelationship', 'inBaseTop15', 'monitoredRank', 'inTop30', 'inTop60',
    'impulsePct', 'pullbackPct', 'baseRangePct', 'baseDurationBars', 'localExtensionPct', 'spaceToSessionHighPct',
    'referencePrice', 'invalidationPrice', 'riskUnitPct',
    'tapeCompleteness',
    'outcomeReferencePrice', 'primaryOutcomeStartSec', 'structuralExtensionAtObsPct',
    ...[5, 15, 30].flatMap(m => [
      `w${m}_terminal`, `w${m}_scorable`, `w${m}_prospMfePct`, `w${m}_prospMaePct`, `w${m}_prospMfeR`, `w${m}_prospMaeR`,
      `w${m}_t0_5R`, `w${m}_t1R`, `w${m}_t2R`, `w${m}_invalidated`, `w${m}_tToInval`, `w${m}_ambiguous`, `w${m}_cfPostTermMfePct`,
    ]),
  ]
  const csv = [cols.join(',')]
  for (const r of rows) {
    const c = r.candidate
    const vals: (string | number | boolean | null)[] = [
      r.day, c.shadowCandidateId, c.symbol, c.leaderEpisodeId, c.setupId ?? '', c.candidateObservedAt,
      c.leaderRole, c.leaderLifecycle, c.historyComplete,
      c.offHighGroup, c.globalOffHighPct, c.dayChangePct,
      c.baseRelationship, c.inBaseTop15, c.monitoredRank, c.inTop30, c.inTop60,
      c.impulsePct, c.pullbackPct, c.baseRangePct, c.baseDurationBars, c.localExtensionPct, c.spaceToSessionHighPct,
      c.referencePrice, c.invalidationPrice, c.riskUnitPct,
      r.tapeCompleteness,
      r.outcome.outcomeReferencePrice, r.outcome.primaryOutcomeStartSec, r.outcome.structuralExtensionAtObsPct,
      ...[5, 15, 30].flatMap(m => {
        const wo = r.w[m]
        return [wo.terminalState, wo.scorable, wo.prospectiveMfePct, wo.prospectiveMaePct, wo.prospectiveMfeR, wo.prospectiveMaeR,
          wo.prospectiveTimeTo0_5RSec, wo.prospectiveTimeTo1RSec, wo.prospectiveTimeTo2RSec, wo.invalidationHit, wo.timeToInvalidationSec, wo.ambiguousSameBar, wo.counterfactualPostTerminalMfePct]
      }),
    ]
    csv.push(vals.map(v => v === null || v === undefined ? '' : String(v)).join(','))
  }
  const csvPath = join(out, `h4b_candidates_${tag}.csv`)
  writeFileSync(csvPath, csv.join('\n') + '\n')

  // ── session summary (descriptive; NO overall score) ──
  const scorable15 = rows.filter(r => r.w[15].scorable)
  const group = (pred: (r: Row) => boolean) => {
    const g = scorable15.filter(pred)
    const mfe = g.map(r => r.w[15].prospectiveMfePct!).filter(Number.isFinite)
    const mae = g.map(r => r.w[15].prospectiveMaePct!).filter(Number.isFinite)
    const mfeR = g.map(r => r.w[15].prospectiveMfeR!).filter(Number.isFinite)
    const inval = g.filter(r => r.w[15].invalidationHit).length
    const r1 = g.filter(r => r.w[15].prospectiveTimeTo1RSec != null).length
    const r05 = g.filter(r => r.w[15].prospectiveTimeTo0_5RSec != null).length
    const r2 = g.filter(r => r.w[15].prospectiveTimeTo2RSec != null).length
    return {
      candidates: g.length,
      symbolDays: new Set(g.map(r => `${r.day}:${r.candidate.symbol}`)).size,
      medMfePct: median(mfe), medMaePct: median(mae), medMfeR: median(mfeR),
      p75Mfe: pctile(mfe, 75), p90Mfe: pctile(mfe, 90),
      invalidationRate: g.length ? inval / g.length : null,
      reached0_5RBeforeInval: g.length ? r05 / g.length : null,
      reached1RBeforeInval: g.length ? r1 / g.length : null,
      reached2RBeforeInval: g.length ? r2 / g.length : null,
    }
  }
  const summary = {
    experiment: 'LEADER_CONTINUATION', mode: 'shadow',
    days, totalCandidateRecords: rows.length, distinctCandidates: rows.length,
    symbolDays: new Set(rows.map(r => `${r.day}:${r.candidate.symbol}`)).size,
    tapeCompletenessByDay: Object.fromEntries(days.map(d => [d, rows.find(r => r.day === d)?.tapeCompleteness ?? 'NO_DATA'])),
    scorablePrimary15m: scorable15.length,
    censoredOrDegraded15m: rows.length - scorable15.length,
    // Pre-registered subgroups (comparison only) — 15m window
    subgroups: {
      OFF_HIGH_LEGACY: group(r => r.candidate.offHighGroup === 'OFF_HIGH_LEGACY'),
      NEAR_HIGH: group(r => r.candidate.offHighGroup === 'NEAR_HIGH'),
      role_CORE: group(r => r.candidate.leaderRole === 'CORE'),
      role_CHALLENGER: group(r => r.candidate.leaderRole === 'CHALLENGER'),
      inTop15: group(r => r.candidate.inBaseTop15),
      outsideTop15: group(r => !r.candidate.inBaseTop15),
      baseMissedOrVetoed: group(r => r.candidate.baseRelationship !== 'BASE_PASSED'),
      basePassed: group(r => r.candidate.baseRelationship === 'BASE_PASSED'),
    },
    note: 'DESCRIPTIVE ONLY — no overall score; sample/stopping/promotion AWAIT HUMAN RATIFICATION.',
  }
  const sumPath = join(out, `h4b_session_summary_${tag}.json`)
  writeFileSync(sumPath, JSON.stringify(summary, null, 2))
  return { csvPath, sumPath, summary }
}

function main(): void {
  const { days, out } = parseArgs(process.argv)
  const { csvPath, sumPath, summary } = runH4bSession({ days, out })
  const sg = summary.subgroups as Record<string, { candidates: number; medMfePct: number | null; invalidationRate: number | null }>
  console.log(`H4B session research (${days.length === 1 ? days[0] : `${days[0]}..${days[days.length - 1]}`}) — SHADOW ONLY, descriptive`)
  console.log(`  distinct candidates: ${summary.distinctCandidates} · scorable(15m primary): ${summary.scorablePrimary15m} · symbol-days: ${summary.symbolDays}`)
  console.log(`  OFF_HIGH_LEGACY: n=${sg.OFF_HIGH_LEGACY.candidates} medMFE%=${sg.OFF_HIGH_LEGACY.medMfePct ?? '—'} invalRate=${sg.OFF_HIGH_LEGACY.invalidationRate ?? '—'}`)
  console.log(`  NEAR_HIGH:       n=${sg.NEAR_HIGH.candidates} medMFE%=${sg.NEAR_HIGH.medMfePct ?? '—'} invalRate=${sg.NEAR_HIGH.invalidationRate ?? '—'}`)
  console.log(`  wrote ${csvPath}`)
  console.log(`  wrote ${sumPath}`)
}

// Run only when invoked directly as a CLI (keeps the module importable/testable).
const invokedDirectly = (() => { try { return process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false } catch { return false } })()
if (invokedDirectly) main()
