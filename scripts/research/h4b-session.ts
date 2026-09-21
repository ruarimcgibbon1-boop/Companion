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
import { EXPERIMENT_EPOCH, type ShadowCandidateEvent } from '@/lib/leader/leader-continuation'
import { isAdditiveBaseRelationship } from '@/lib/leader/leader-continuation-policy'
import { readCollectionMarker, classifyOfficial, type OfficialClassification } from '@/lib/leader/h4b-collection-marker'

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

  // ── official collection boundary (STEP 6/7) ──
  // The official epoch begins ONLY at the immutable start marker. Without it we refuse to claim the
  // epoch has started; pre-official events are retained diagnostically but excluded from official counts.
  const marker = readCollectionMarker(EXPERIMENT_EPOCH)
  const classOf = (r: Row): OfficialClassification => classifyOfficial(marker, {
    candidateObservedAt: r.candidate.candidateObservedAt,
    experimentConfigHash: r.candidate.experimentConfigHash,
    experimentEpoch: r.candidate.experimentEpoch,
  })
  const official = rows.filter(r => classOf(r) === 'OFFICIAL')
  const preOfficial = rows.filter(r => classOf(r) === 'PRE_OFFICIAL')
  const hashMismatch = rows.filter(r => classOf(r) === 'HASH_MISMATCH').length
  const epochMismatch = rows.filter(r => classOf(r) === 'EPOCH_MISMATCH').length

  // ── descriptive stats over a supplied row set (15m window) — NO overall score ──
  const group = (set: Row[]) => {
    const g = set.filter(r => r.w[15].scorable)
    const mfe = g.map(r => r.w[15].prospectiveMfePct!).filter(Number.isFinite)
    const mae = g.map(r => r.w[15].prospectiveMaePct!).filter(Number.isFinite)
    const mfeR = g.map(r => r.w[15].prospectiveMfeR!).filter(Number.isFinite)
    const maeR = g.map(r => r.w[15].prospectiveMaeR!).filter(Number.isFinite)
    const symDayCounts = new Map<string, number>()
    for (const r of g) { const k = `${r.day}:${r.candidate.symbol}`; symDayCounts.set(k, (symDayCounts.get(k) ?? 0) + 1) }
    const maxShare = g.length ? Math.max(...symDayCounts.values()) / g.length : null
    return {
      scorableCandidates: g.length,
      symbolDays: symDayCounts.size,
      medProspectiveMfePct: median(mfe), medProspectiveMaePct: median(mae),
      medProspectiveMfeR: median(mfeR), medProspectiveMaeR: median(maeR),
      p75Mfe: pctile(mfe, 75), p90Mfe: pctile(mfe, 90),
      invalidationRate: g.length ? g.filter(r => r.w[15].invalidationHit).length / g.length : null,
      reached0_5RBeforeInval: g.length ? g.filter(r => r.w[15].prospectiveTimeTo0_5RSec != null).length / g.length : null,
      reached1RBeforeInval: g.length ? g.filter(r => r.w[15].prospectiveTimeTo1RSec != null).length / g.length : null,
      reached2RBeforeInval: g.length ? g.filter(r => r.w[15].prospectiveTimeTo2RSec != null).length / g.length : null,
      maxSingleSymbolDaySharePct: maxShare != null ? maxShare * 100 : null,   // concentration denominator = this set's scorable episodes
    }
  }
  // Primary population = OFFICIAL only (or none when no marker). Additive = the EXACT policy set.
  const primary = marker ? official : []
  const additive = primary.filter(r => isAdditiveBaseRelationship(r.candidate.baseRelationship))
  const primaryScorable = primary.filter(r => r.w[15].scorable)

  const summary = {
    experiment: 'LEADER_CONTINUATION', mode: 'shadow',
    experimentConfigHash: '89e8b4e0', experimentEpoch: EXPERIMENT_EPOCH,
    officialCollectionStarted: marker != null,
    officialStartedAtUtc: marker?.startedAtUtc ?? null,
    markerExperimentConfigHash: marker?.experimentConfigHash ?? null,
    markerDecisionPolicyHash: marker?.decisionPolicyHash ?? null,
    days,
    totalCandidateRecords: rows.length,
    counts: { official: official.length, preOfficial: preOfficial.length, hashMismatch, epochMismatch },
    tapeCompletenessByDay: Object.fromEntries(days.map(d => [d, rows.find(r => r.day === d)?.tapeCompleteness ?? 'NO_DATA'])),
    // OFFICIAL epoch-1 primary counts (null + refusal note when collection has not officially started).
    official: marker ? {
      distinctCandidates: primary.length,
      symbolDays: new Set(primary.map(r => `${r.day}:${r.candidate.symbol}`)).size,
      scorablePrimary15m: primaryScorable.length,
      // censor/degraded rate: numerator = not-scorable at 15m; denominator = ALL official distinct candidates.
      censorOrDegradedRate: primary.length ? (primary.length - primaryScorable.length) / primary.length : null,
      subgroups: {
        OFF_HIGH_LEGACY: group(primary.filter(r => r.candidate.offHighGroup === 'OFF_HIGH_LEGACY')),
        NEAR_HIGH: group(primary.filter(r => r.candidate.offHighGroup === 'NEAR_HIGH')),
        role_CORE: group(primary.filter(r => r.candidate.leaderRole === 'CORE')),
        role_CHALLENGER: group(primary.filter(r => r.candidate.leaderRole === 'CHALLENGER')),
        inTop15: group(primary.filter(r => r.candidate.inBaseTop15)),
        outsideTop15: group(primary.filter(r => !r.candidate.inBaseTop15)),
        ADDITIVE: group(additive),              // BASE-missed/rejected OR NOT_IN_BASE (exact policy set)
        basePassed: group(primary.filter(r => r.candidate.baseRelationship === 'BASE_PASSED')),
      },
    } : { refused: 'NO_OFFICIAL_START_MARKER — official epoch-1 counts are not claimed. Run h4b:start-collection first.' },
    note: 'DESCRIPTIVE ONLY — no overall score. PASS/FAIL/INCONCLUSIVE is a separate, later, human-reviewed step (Path A, h4b-decision-2).',
  }
  const sumPath = join(out, `h4b_session_summary_${tag}.json`)
  writeFileSync(sumPath, JSON.stringify(summary, null, 2))
  return { csvPath, sumPath, summary }
}

function main(): void {
  const { days, out } = parseArgs(process.argv)
  const { csvPath, sumPath, summary } = runH4bSession({ days, out })
  const s = summary as Record<string, unknown>
  const c = s.counts as { official: number; preOfficial: number; hashMismatch: number; epochMismatch: number }
  console.log(`H4B session research (${days.length === 1 ? days[0] : `${days[0]}..${days[days.length - 1]}`}) — SHADOW ONLY, descriptive`)
  console.log(`  official collection started: ${summary.officialCollectionStarted}${summary.officialStartedAtUtc ? ` @ ${summary.officialStartedAtUtc}` : ''}`)
  console.log(`  candidates: official=${c.official} preOfficial=${c.preOfficial} hashMismatch=${c.hashMismatch} epochMismatch=${c.epochMismatch}`)
  if (!summary.officialCollectionStarted) console.log('  NOTE: no official start marker — official epoch-1 counts are NOT claimed. Run npm run h4b:start-collection first.')
  console.log(`  wrote ${csvPath}`)
  console.log(`  wrote ${sumPath}`)
}

// Run only when invoked directly as a CLI (keeps the module importable/testable).
const invokedDirectly = (() => { try { return process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false } catch { return false } })()
if (invokedDirectly) main()
