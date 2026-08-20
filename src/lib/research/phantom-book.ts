/**
 * Phantom-book runner CORE — read-only counterfactual accounting.
 *
 * Pure + side-effect-free (except the isolated `loadTape` file-cache helper). It
 * submits no orders, mutates no strategy state, and writes no production logs. The
 * thin CLI `scripts/phantom-book.ts` supplies IO (log files, FMP 1m fetch) and the
 * canonical flatten minute (`DEFAULT_EXECUTOR.flattenEtMinute`); everything
 * decision-relevant lives here so it is unit-testable without the executor, the
 * broker, or the network.
 *
 * THREE BOOKS, one resolver:
 *   IDEAL_ACCEPTED  — accepted candidates run through resolveShadowOutcome
 *   IDEAL_PHANTOM   — primary phantom candidates run through the SAME resolver + bars
 *   ACTUAL_EXECUTED — realized R from the paper-trade records (join by setupId only)
 * Primary gate-quality comparison is IDEAL_ACCEPTED vs IDEAL_PHANTOM; execution
 * quality is IDEAL_ACCEPTED vs ACTUAL_EXECUTED. No slippage is modelled here.
 *
 * SESSION BOUNDARY — non-lookahead (the correctness-critical rule):
 *   FMP intraday timestamps are BAR OPEN times (see replay-day.ts: "bar close =
 *   bar.time + barSeconds"). The executor flattens AT `flattenEtMinute` (15:55 ET).
 *   A 1-minute bar whose OPEN minute == 15:55 spans 15:55:00–15:56:00, so its
 *   high/low/close occur AFTER the flatten and must never drive a touch or the mark.
 *   Therefore touch/entry detection uses ONLY bars whose open-minute is STRICTLY
 *   BEFORE the flatten minute, and an unresolved trade is marked at the 15:55 bar's
 *   OPEN (the price exactly at the flatten instant). If that bar is absent, the mark
 *   falls back to the last pre-flatten bar's close (also ≤ 15:55:00). Neither path
 *   reads a price after 15:55:00.
 */
import type { Candle } from '@/types'
import { etMinutesOfDay } from '@/lib/market-hours'
import { sameEtDay } from '@/lib/eod-resolver'
import {
  resolveShadowOutcome,
  etTradingDay,
  rejectionLayer,
  type ShadowCandidate,
  type ShadowOutcome,
} from '@/lib/research/shadow-journal'

const round = (v: number) => Math.round(v * 100) / 100

// ── Tape provenance ──────────────────────────────────────────────────────────

export type TapeState = 'PROVISIONAL' | 'FINAL'

/**
 * Same-day (or future-dated) tape is PROVISIONAL because FMP revises the current
 * session's intraday bars after the fact; only a settled prior day is FINAL. ET-day
 * strings compare lexically, so `>=` is the correct "today or later" test.
 */
export function tapeState(targetDay: string, nowMs: number = Date.now()): TapeState {
  return targetDay >= etTradingDay(nowMs) ? 'PROVISIONAL' : 'FINAL'
}

// ── Non-lookahead session window ─────────────────────────────────────────────

export interface BoundedWindow {
  /** Bars usable for entry/stop/target detection: same ET day, at/after the signal, open-minute < flatten. */
  scanBars: Candle[]
  /** OPEN of the flatten-minute bar (the price at the flatten instant), or null if that bar is absent. */
  flattenOpen: number | null
}

/**
 * Bound a symbol's tape to the candidate's non-lookahead session window. `signalTs`
 * is ms; the ET trading day is derived from it, so a multi-day tape cannot leak.
 */
export function boundWindow(
  candles: Candle[],
  signalTs: number,
  flattenEtMinute: number,
): BoundedWindow {
  const sameDay = candles.filter((c) => sameEtDay(c.time * 1000, signalTs))
  const scanBars = sameDay
    .filter((c) => c.time * 1000 >= signalTs && etMinutesOfDay(c.time * 1000) < flattenEtMinute)
    .sort((a, b) => a.time - b.time)
  const flattenBar = sameDay
    .filter((c) => etMinutesOfDay(c.time * 1000) === flattenEtMinute)
    .sort((a, b) => a.time - b.time)[0]
  return { scanBars, flattenOpen: flattenBar ? flattenBar.open : null }
}

/** Where the end-of-window mark came from, for transparency in the report. */
export type MarkSource = 'target' | 'stop' | 'no_fill' | 'flatten_open' | 'last_close'

export interface PhantomOutcome extends ShadowOutcome {
  markSource: MarkSource
}

/**
 * Resolve a candidate over FMP 1m bars using the canonical resolver for the
 * entry/stop/target touch logic, then apply the non-lookahead flatten mark. The
 * resolver stays the single source of truth for touches; only the open-at-end mark
 * is repriced here to the flatten-instant OPEN.
 */
export function resolveWithFlatten(
  candidate: ShadowCandidate,
  candles: Candle[],
  flattenEtMinute: number,
): PhantomOutcome {
  const { scanBars, flattenOpen } = boundWindow(candles, candidate.signalTs, flattenEtMinute)
  const base = resolveShadowOutcome(candidate, scanBars)

  if (base.result !== 'open_at_end') {
    return { ...base, markSource: base.result === 'no_fill' ? 'no_fill' : base.result }
  }
  // Open at the flatten. Prefer the 15:55 bar OPEN (price at the flatten instant);
  // fall back to the resolver's last pre-flatten close if that bar is missing.
  if (flattenOpen == null || candidate.entryRef == null || candidate.stop == null) {
    return { ...base, markSource: 'last_close' }
  }
  const riskDist = candidate.entryRef - candidate.stop
  const markPct = ((flattenOpen - candidate.entryRef) / candidate.entryRef) * 100
  return {
    ...base,
    // The flatten print is the last observed price ≤ 15:55:00 — fold it into MFE/MAE.
    mfePct: base.mfePct == null ? round(markPct) : round(Math.max(base.mfePct, markPct)),
    maePct: base.maePct == null ? round(markPct) : round(Math.min(base.maePct, markPct)),
    hypotheticalR: riskDist > 0 ? round((flattenOpen - candidate.entryRef) / riskDist) : null,
    markSource: 'flatten_open',
  }
}

// ── Classification ───────────────────────────────────────────────────────────

export type CandidateClass = 'accepted' | 'phantom_primary' | 'phantom_dup' | 'not_simulatable'

/**
 * Classify a candidate for the books. Executed OR ever-accepted ⇒ accepted (its
 * later re-logs as dup/veto do not demote it). A never-accepted candidate whose
 * terminal block was the entry-cluster/stand-down cooldown is a duplicate — not an
 * independent opportunity — and is excluded from the primary phantom aggregate.
 * Missing entry or stop ⇒ not-simulatable (never guessed).
 */
export function classifyCandidate(c: ShadowCandidate, executedSetupIds: Set<string>): CandidateClass {
  if (executedSetupIds.has(c.setupId) || c.everAccepted) return 'accepted'
  if (c.entryRef == null || c.stop == null) return 'not_simulatable'
  if (rejectionLayer(c.terminalVerdict) === 'duplicate_cooldown') return 'phantom_dup'
  return 'phantom_primary'
}

// ── Book aggregation ─────────────────────────────────────────────────────────

export interface BookSummary {
  n: number
  netR: number
  avgR: number | null
  medianR: number | null
  winRatePct: number | null
}

/** Summarize a set of R values (wins are R > 0). Excludes nothing — callers pre-filter nulls. */
export function summarizeR(rs: number[]): BookSummary {
  if (rs.length === 0) return { n: 0, netR: 0, avgR: null, medianR: null, winRatePct: null }
  const sorted = rs.slice().sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
  const net = rs.reduce((s, r) => s + r, 0)
  const wins = rs.filter((r) => r > 0).length
  return { n: rs.length, netR: round(net), avgR: round(net / rs.length), medianR: round(median), winRatePct: round((wins / rs.length) * 100) }
}

export interface PhantomRow {
  candidate: ShadowCandidate
  klass: CandidateClass
  outcome: PhantomOutcome
  /** Broker-realized R (realizedPnl ÷ plannedRisk), joined by setupId. Null when unavailable. */
  actualR: number | null
  hasTarget: boolean
}

export interface PhantomBooks {
  idealAccepted: BookSummary
  idealPhantom: BookSummary
  actualExecuted: BookSummary
  /** Target-missing subgroup (accepted + primary phantom, hasTarget === false) — reported separately. */
  idealTargetMissing: BookSummary
  /** dup_cooldown rows — kept for the raw table, excluded from every aggregate above. */
  duplicates: PhantomRow[]
  /** Candidates with insufficient evidence to simulate. */
  notSimulatable: PhantomRow[]
  counts: { accepted: number; phantomPrimary: number; phantomDup: number; notSimulatable: number; noFill: number; targetMissing: number }
}

const enteredR = (r: PhantomRow): number | null =>
  r.outcome.entered && r.outcome.hypotheticalR != null ? r.outcome.hypotheticalR : null

/**
 * Partition rows into the three books. dup_cooldown is excluded from all aggregates
 * (not an independent opportunity) but returned raw. Only entered candidates with a
 * defined R feed the ideal aggregates; no-fills are counted, never scored.
 */
export function buildBooks(rows: PhantomRow[]): PhantomBooks {
  const accepted = rows.filter((r) => r.klass === 'accepted')
  const phantom = rows.filter((r) => r.klass === 'phantom_primary')
  const duplicates = rows.filter((r) => r.klass === 'phantom_dup')
  const notSimulatable = rows.filter((r) => r.klass === 'not_simulatable')

  const rOf = (rs: PhantomRow[]) => rs.map(enteredR).filter((r): r is number => r != null)

  const idealAccepted = summarizeR(rOf(accepted))
  const idealPhantom = summarizeR(rOf(phantom))
  const actualExecuted = summarizeR(accepted.map((r) => r.actualR).filter((r): r is number => r != null))
  const idealTargetMissing = summarizeR(rOf([...accepted, ...phantom].filter((r) => !r.hasTarget)))

  const noFill = rows.filter((r) => r.klass !== 'phantom_dup' && r.klass !== 'not_simulatable' && !r.outcome.entered).length
  const targetMissing = [...accepted, ...phantom].filter((r) => !r.hasTarget).length

  return {
    idealAccepted,
    idealPhantom,
    actualExecuted,
    idealTargetMissing,
    duplicates,
    notSimulatable,
    counts: {
      accepted: accepted.length,
      phantomPrimary: phantom.length,
      phantomDup: duplicates.length,
      notSimulatable: notSimulatable.length,
      noFill,
      targetMissing,
    },
  }
}
