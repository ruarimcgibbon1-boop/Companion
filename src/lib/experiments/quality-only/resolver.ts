/**
 * QUALITY_ONLY_CONTINUATION pending-candidate resolver.
 *
 * Runs against the candidate journal (persistence.ts's append-only NDJSON
 * file) plus the passive research bar journal (src/lib/research/bar-
 * journal.ts). Issues ZERO provider requests — every input is already on
 * disk. Designed to be called from the daemon's own sweep loop (least
 * coupling: no new process, no new timer, reuses the sweep cadence that
 * already produces new bars every ~15-30s via monitor.ts's mirror tap) — see
 * the one-line call added to scripts/alert-daemon.ts's sweep().
 *
 * RESTART RECOVERY: this module keeps no separate cursor/state file of its
 * own. Each call re-derives "pending" by re-reading the whole candidate
 * journal: candidate identities minus identities that already have an
 * outcome event. Because the journal is append-only and identities are
 * deterministic (candidateIdentity() in candidate.ts), this is naturally
 * idempotent — a process restart just re-derives the same pending set from
 * disk, never duplicates an outcome (a resolved identity is skipped because
 * its outcome event is already in the file), and never loses a candidate
 * (the earliest candidate event for an identity is authoritative; later
 * duplicate candidate events for the same identity, if any, are ignored).
 *
 * SCORABLE / PENDING / CENSORED / DEGRADED — precise, deterministic
 * definitions (see classifyCandidate()):
 *
 *   SCORABLE  — outcome.ts's causal bar-walk reached a genuine terminal point:
 *               (a) terminal invalidation fired (this is scorable EVEN IF it
 *                   happens in under a minute — a causal stop is a valid,
 *                   complete outcome, never "too early to count"), OR
 *               (b) entered, and the full 30-minute post-entry horizon has
 *                   been observed with no invalidation, OR
 *               (c) never entered, and the full 30-minute post-observation
 *                   horizon has been observed with no entry trigger at all
 *                   ("no fill within 30m" is itself a real, scorable result).
 *               The official collection minimum counts SCORABLE candidates
 *               only, per the original preregistration.
 *   PENDING   — none of the SCORABLE conditions hold yet, AND the trading
 *               session for that candidate's day has not ended, AND no data
 *               problem was detected. Try again on a later sweep/resolver run.
 *   CENSORED  — a SCORABLE condition would eventually be reached, but the
 *               session ended first (includes: candidate created <30m before
 *               session end; daemon/process was down and no more sweeps ran
 *               before session end). The bar-walk's outcome up to that point
 *               is preserved (not discarded) but flagged CENSORED, not
 *               counted toward the SCORABLE collection minimum.
 *   DEGRADED  — a data-quality problem makes the walk's completeness
 *               unprovable: a >150s gap between consecutive causal bars
 *               (provider/cache gap or missing bars), or the day's bar
 *               journal contains corrupt/torn lines. Never silently treated
 *               as "no candles = quiet market"; the partial outcome is kept
 *               for visibility but excluded from SCORABLE counts.
 *
 * FROZEN: this module calls scoreQualityOnlyOutcome() from outcome.ts
 * UNCHANGED — it wraps the result with resolution metadata, never alters the
 * frozen entry/same-bar-ambiguity/terminal-invalidation semantics.
 *
 * PAPER/RESEARCH ONLY. No broker/PaperExecutor import. Read-only with respect
 * to BASE; the only side effect is appending ONE outcome event per resolved
 * candidate to the SAME journal file candidate.ts's caller already writes to.
 */
import { readFileSync, existsSync, appendFileSync } from 'fs'
import { parseJournal } from './persistence'
import type { QualityOnlyCandidate } from './candidate'
import { scoreQualityOnlyOutcome, type QualityOnlyOutcome } from './outcome'
import { buildProvenance } from './spec'
import { loadResearchBars, toCandleArray, type LoadedBars } from '@/lib/research/bar-journal'
import { etTradingDay } from '@/lib/research/shadow-journal'
import { etMinutesOfDay } from '@/lib/market-hours'

/** 30-minute preregistered horizon — the longest outcome window (30m MFE/MAE)
 *  this experiment scores. Fixed here, matching outcome.ts's field set. */
const HORIZON_MS = 30 * 60_000

/**
 * Session-end boundary for CENSORED determination, in ET minutes-of-day.
 * Deliberately the SAME instant src/lib/execution/executor.ts's
 * `DEFAULT_EXECUTOR.flattenEtMinute` (15:55 ET = 15*60+55 = 955) uses as
 * "the trading day is over" for these same momentum setups — kept as an
 * independent literal (not an import) so this read-only research module has
 * no dependency edge onto the execution/broker module graph at all, matching
 * this experiment's "never touches the broker/PaperExecutor" invariant even
 * at the import level. If executor.ts's flatten minute is ever repreregistered,
 * this constant must be updated to match (documented, not auto-derived).
 */
const SESSION_END_ET_MINUTE = 15 * 60 + 55

export type ResolutionStatus = 'SCORABLE' | 'PENDING' | 'CENSORED' | 'DEGRADED'

export interface ResolvedOutcome extends QualityOnlyOutcome {
  resolutionStatus: ResolutionStatus
  resolutionDetail: string
  resolvedAt: number
}

function sessionEnded(candidateDay: string, nowMs: number): boolean {
  const today = etTradingDay(nowMs)
  if (candidateDay < today) return true   // a past trading day is over; no more bars will ever arrive
  if (candidateDay > today) return false  // should not happen; be conservative
  return etMinutesOfDay(nowMs) >= SESSION_END_ET_MINUTE
}

/** >150s (2.5x a 1-minute bar) between consecutive CAUSAL bars = an
 *  unprovable gap (provider/cache miss, restart window, etc.) — we cannot
 *  tell whether an entry/invalidation happened inside it, so it can never be
 *  silently treated as "no bar = quiet". */
function hasCausalGap(candles: { time: number }[]): boolean {
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time - candles[i - 1].time > 150) return true
  }
  return false
}

export interface ClassifiedCandidate {
  status: ResolutionStatus
  outcome: QualityOnlyOutcome
  detail: string
}

/**
 * Pure classification — no I/O beyond the `bars` already loaded by the
 * caller. Exported separately from resolvePendingCandidates() so unit tests
 * can drive it directly with synthetic bars/timestamps.
 */
export function classifyCandidate(candidate: QualityOnlyCandidate, bars: LoadedBars, nowMs: number): ClassifiedCandidate {
  const causalBars = bars.bars.filter(b => b.barStart >= candidate.candidateObservedAt)
  const candles = toCandleArray(causalBars)
  const gapDetected = hasCausalGap(candles)
  const hasCorruption = bars.corrupt.length > 0

  const outcome = scoreQualityOnlyOutcome(candles, candidate.entryRef, candidate.invalidation, candidate.candidateObservedAt)
  const latestBarMs = candles.length > 0 ? candles[candles.length - 1].time * 1000 : null
  const ended = sessionEnded(candidate.etTradingDay, nowMs)

  // (a) terminal invalidation — scorable the instant it causally fires,
  // regardless of how little time has elapsed. A gap in the CAUSAL bars used
  // to reach it, though, means we cannot be sure nothing favorable/adverse
  // happened first inside that gap, so it degrades instead.
  if (outcome.invalidated) {
    return gapDetected
      ? { status: 'DEGRADED', outcome, detail: 'terminal_invalidation_reached_but_causal_gap_detected' }
      : { status: 'SCORABLE', outcome, detail: 'terminal_invalidation' }
  }

  if (outcome.entered && outcome.entryBarTime != null) {
    const horizonComplete = latestBarMs != null && latestBarMs >= outcome.entryBarTime + HORIZON_MS
    if (horizonComplete) {
      return gapDetected
        ? { status: 'DEGRADED', outcome, detail: 'post_entry_horizon_complete_but_causal_gap_detected' }
        : { status: 'SCORABLE', outcome, detail: 'post_entry_30m_horizon_complete_no_invalidation' }
    }
    if (ended) return { status: 'CENSORED', outcome, detail: 'session_ended_before_30m_post_entry_horizon_complete' }
    return { status: 'PENDING', outcome, detail: 'awaiting_30m_post_entry_horizon' }
  }

  // Never entered.
  const noFillHorizonComplete = latestBarMs != null && latestBarMs >= candidate.candidateObservedAt + HORIZON_MS
  if (noFillHorizonComplete) {
    return gapDetected
      ? { status: 'DEGRADED', outcome, detail: 'no_fill_horizon_complete_but_causal_gap_detected' }
      : { status: 'SCORABLE', outcome, detail: 'no_entry_trigger_within_30m' }
  }
  if (candles.length === 0 && ended) {
    // Session is over and we never observed a single causal bar for this
    // candidate at all — a real data-plane gap (mirror never ran / provider
    // outage), not a legitimate "no fill". Never fabricate a no_fill verdict
    // from the absence of evidence.
    return { status: 'DEGRADED', outcome, detail: 'no_research_bars_observed_before_session_end' }
  }
  if (hasCorruption && candles.length === 0) {
    return { status: 'DEGRADED', outcome, detail: 'corrupt_bar_journal_no_usable_bars' }
  }
  if (ended) return { status: 'CENSORED', outcome, detail: 'session_ended_before_30m_no_fill_horizon_complete' }
  return { status: 'PENDING', outcome, detail: 'awaiting_entry_or_no_fill_horizon' }
}

export interface ResolverRunResult {
  scanned: number
  resolved: number
  scorable: number
  censored: number
  degraded: number
  stillPending: number
  errors: number
}

/**
 * One resolver pass. Reads `candidateJournalPath` (the SAME file
 * candidate/outcome events are already appended to — see JournalWriter in
 * persistence.ts), classifies every not-yet-resolved identity, and appends
 * ONE outcome event per candidate that leaves PENDING this pass. Never
 * duplicates an outcome (skips any identity already carrying one). Never
 * rewrites a candidate event. Never issues a provider request — reads only
 * local files (`candidateJournalPath` + the bar journal files
 * `loadResearchBars` resolves internally).
 */
export function resolvePendingCandidates(
  candidateJournalPath: string,
  nowMs: number = Date.now(),
  /** Injectable for tests only — production never passes this, so the real
   *  daemon always resolves against the real on-disk bar journal. */
  loadBars: (day: string, symbol: string) => LoadedBars = loadResearchBars,
): ResolverRunResult {
  const result: ResolverRunResult = { scanned: 0, resolved: 0, scorable: 0, censored: 0, degraded: 0, stillPending: 0, errors: 0 }
  try {
    if (!existsSync(candidateJournalPath)) return result
    const raw = readFileSync(candidateJournalPath, 'utf8')
    const { events } = parseJournal(raw)

    const candidatesByIdentity = new Map<string, QualityOnlyCandidate>()
    const resolvedIdentities = new Set<string>()
    for (const ev of events) {
      if (ev.kind === 'candidate') {
        // Earliest candidate event for an identity is authoritative — a
        // later duplicate (e.g. a restart re-observing the same setup before
        // the journal write landed) changes nothing.
        if (!candidatesByIdentity.has(ev.identity)) candidatesByIdentity.set(ev.identity, ev.payload as QualityOnlyCandidate)
      } else if (ev.kind === 'outcome') {
        resolvedIdentities.add(ev.identity)
      }
    }

    const pending = [...candidatesByIdentity.values()].filter(c => !resolvedIdentities.has(c.identity))
    result.scanned = pending.length

    const barsCache = new Map<string, LoadedBars>()
    for (const candidate of pending) {
      try {
        const cacheKey = `${candidate.etTradingDay}:${candidate.symbol}`
        let bars = barsCache.get(cacheKey)
        if (!bars) {
          bars = loadBars(candidate.etTradingDay, candidate.symbol)
          barsCache.set(cacheKey, bars)
        }
        const { status, outcome, detail } = classifyCandidate(candidate, bars, nowMs)
        if (status === 'PENDING') { result.stillPending++; continue }

        const resolved: ResolvedOutcome = { ...outcome, resolutionStatus: status, resolutionDetail: detail, resolvedAt: nowMs }
        const provenance = buildProvenance()
        appendFileSync(candidateJournalPath, `${JSON.stringify({
          kind: 'outcome', identity: candidate.identity, payload: resolved, provenance, preOfficial: true,
        })}\n`)
        result.resolved++
        if (status === 'SCORABLE') result.scorable++
        else if (status === 'CENSORED') result.censored++
        else result.degraded++
      } catch {
        result.errors++
      }
    }
  } catch {
    result.errors++
  }
  return result
}
