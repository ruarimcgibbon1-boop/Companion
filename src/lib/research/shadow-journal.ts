/**
 * Shadow Journal foundation — the substrate for counterfactual research.
 *
 * GOAL: let future research ask "how would a candidate rule have done?" over EVERY
 * qualifying setup — ACCEPTED (verdict 'logged') and REJECTED alike — without ever
 * changing production. To compare fairly, each candidate carries the features known
 * AT SIGNAL TIME, and later receives a HYPOTHETICAL outcome (MFE/MAE/R/path).
 *
 * SINGLE SOURCE OF TRUTH: this does NOT create a second store. The daemon decision
 * log already records every triggered setup + its verdict + signal-time features. A
 * ShadowCandidate is a typed projection of it, plus three additive signal-time
 * fields (stop, targets, entryRef) the daemon now logs.
 *
 * IDENTITY & LIFECYCLE (the hardening): the decision log is an EVENT STREAM, not one
 * row per setup — the daemon can record the same `setupId` across many sweeps with
 * changing verdicts (vetoed at 09:31, accepted at 09:36). Counting those as two
 * trades would be wrong. Candidates are therefore keyed on a STABLE identity —
 * `ET-trading-day + setupId` — derived from the event timestamp (NOT the log
 * filename, so it is correct even across a UTC-date rollover or a daemon restart).
 * All underlying events are retained; the lifecycle exposes only states the data can
 * PROVE (first_seen, triggered, vetoed, accepted, re-evaluated). `expired` is not
 * provable from the decision log, so it stays null.
 *
 * FEATURES vs OUTCOMES — the lookahead boundary: features are frozen at the FIRST
 * signal event and never touched by later bars; outcomes are resolved separately
 * from bars at/after the signal instant. Using future bars for an OUTCOME is
 * correct; using them for a FEATURE is the cardinal sin the resolver refuses.
 */
import type { Candle } from '@/types'

/** Verdicts the decision log emits. 'logged' == accepted; the rest are rejections. */
export type ShadowVerdict = 'logged' | 'session' | 'volume' | 'veto' | 'standDown' | 'capped' | 'dup'

/**
 * Rejection LAYERS — different counterfactual questions that must not be pooled.
 * The decision log can supply the first block; the second block lives in the
 * EXECUTOR event stream (canOpenPosition reasons, entry_blocked/entry_timeout,
 * broker rejections) and is joined separately — never inferred from the decision log.
 */
export type RejectionLayer =
  | 'accepted'                 // verdict logged — would alert/trade
  | 'strategy_veto'            // quality/anti-fade veto (admission)
  | 'session'                  // outside the tradeable window
  | 'liquidity_untradeable'    // volume floor
  | 'per_symbol_cap'           // per-symbol log/win cap (admission, NOT portfolio risk)
  | 'duplicate_cooldown'       // entry-cluster dedup or failed-bounce stand-down
  // ── supplied by the executor event stream, NOT the decision log ──
  | 'risk_capacity'            // maxConcurrent / daily-loss-limit / open-risk ceiling — displacing another position
  | 'broker_untradeable'       // Alpaca does not list/permit the symbol
  | 'execution_no_fill'        // signal generated, entry never filled (timeout/reject)

/** Which source can establish each layer — so a reader never mistakes an absence for a zero. */
export const LAYER_SOURCE: Record<RejectionLayer, 'decision_log' | 'executor_events'> = {
  accepted: 'decision_log',
  strategy_veto: 'decision_log',
  session: 'decision_log',
  liquidity_untradeable: 'decision_log',
  per_symbol_cap: 'decision_log',
  duplicate_cooldown: 'decision_log',
  risk_capacity: 'executor_events',
  broker_untradeable: 'executor_events',
  execution_no_fill: 'executor_events',
}

export function rejectionLayer(verdict: ShadowVerdict): RejectionLayer {
  switch (verdict) {
    case 'logged': return 'accepted'
    case 'veto': return 'strategy_veto'
    case 'session': return 'session'
    case 'volume': return 'liquidity_untradeable'
    case 'capped': return 'per_symbol_cap'
    case 'dup': return 'duplicate_cooldown'
    case 'standDown': return 'duplicate_cooldown'
  }
}

/**
 * An executor-stream event (from onSignal). To be joinable DETERMINISTICALLY it
 * must carry `setupId` — the daemon/executor now stamps it on every onSignal-origin
 * event. A join by `symbol` alone would cross-attribute two setups on the same
 * symbol/day, so this type makes `setupId` the join key and treats a missing one as
 * unjoinable rather than guessing.
 */
export interface ExecutorEvent {
  event: string
  setupId?: string | null
  symbol?: string
  reason?: string | null
  terminal?: boolean
  ts?: string
}

/** The executor-layer outcome of a candidate, established from executor events (never the decision log). */
export interface ExecutorOutcome {
  layer: RejectionLayer | null
  event: string | null
  reason: string | null
}

/** Map an executor event to its rejection layer. These layers live ONLY in the executor stream. */
export function executorEventLayer(ev: ExecutorEvent): RejectionLayer | null {
  switch (ev.event) {
    case 'entry_blocked': return 'risk_capacity'                 // maxConcurrent / loss-limit / open-risk
    case 'entry_skipped': return (ev.reason ?? '').includes('tradable') ? 'broker_untradeable' : 'execution_no_fill'
    case 'entry_rejected': return 'execution_no_fill'           // broker rejected the order
    case 'entry_timeout': return 'execution_no_fill'            // limit never filled
    case 'entry_submitted': return 'accepted'                   // actually taken
    default: return null
  }
}

/**
 * Join a candidate to its executor outcome BY setupId ONLY. Returns the terminal
 * executor event's layer, or a null outcome when no event carries this setup's id —
 * never a symbol-based guess. This is what stops two setups on one symbol from
 * cross-attributing (e.g. a risk-block on XYZ:opening_drive must not land on XYZ:bos).
 */
export function joinExecutorOutcome(candidate: ShadowCandidate, events: ExecutorEvent[]): ExecutorOutcome {
  const mine = events.filter(e => e.setupId != null && e.setupId === candidate.setupId)
  if (mine.length === 0) return { layer: null, event: null, reason: null }
  // Terminal event = the LAST in INPUT (append/log) order. The event streams are
  // append-only and read top-to-bottom, so input order IS occurrence order — the
  // authoritative sequence. We deliberately do NOT sort on `ts`: a missing or
  // malformed timestamp would make Date.parse return NaN and the ordering
  // non-deterministic. Input order is deterministic regardless of ts presence.
  const last = mine[mine.length - 1]
  return { layer: executorEventLayer(last), event: last.event, reason: last.reason ?? null }
}

/** The signal-time decision-log row this projects from (daemon recordDecision + additive fields). */
export interface DecisionLogRow {
  ts: string
  etTime: string
  symbol: string
  setupId: string
  setupType: string
  grade: string | null
  score: number | null
  verdict: ShadowVerdict
  fill: number | null
  rvol: number | null
  offHighPct: number | null
  session: string
  price: number | null
  stop?: number | null
  targets?: number[] | null
  entryRef?: number | null
}

/** Features frozen at the FIRST signal event — the only inputs a fair accepted-vs-rejected comparison may use. */
export interface ShadowFeatures {
  grade: string | null
  score: number | null
  rvol: number | null
  offHighPct: number | null
  price: number | null
}

/** Provable lifecycle timestamps (ms epoch). `null` = not established by the available data. */
export interface ShadowLifecycle {
  firstSeenTs: number          // first decision event for this setup this ET day
  triggeredTs: number          // = firstSeenTs: the row exists only because the setup reached a raw trigger
  vetoedTs: number | null      // earliest 'veto' event, if any
  acceptedTs: number | null    // earliest 'logged' event, if any
  reEvaluations: number        // decision events for this setup (>1 ⇒ re-evaluated across sweeps)
  expiredTs: number | null     // NOT provable from the decision log → always null here
}

/** One underlying decision event, retained so nothing is lost by aggregation. */
export interface ShadowEvent { ts: number; etTime: string; verdict: ShadowVerdict; layer: RejectionLayer }

/** A qualifying setup candidate — ONE per (ET day, setupId) — accepted or rejected. */
export interface ShadowCandidate {
  candidateId: string          // `${etTradingDay}:${setupId}` — stable across sweeps and restarts
  etTradingDay: string         // America/New_York trading day
  setupId: string
  symbol: string
  setup: string
  session: string
  signalTs: number             // = firstSeenTs (frozen)
  /** True if the setup was EVER accepted this day (prevents veto→accept being counted twice). */
  everAccepted: boolean
  /** The verdict of the LAST event — how the setup's day ended. */
  terminalVerdict: ShadowVerdict
  /** All rejection layers seen across the setup's life (deduped). */
  layers: RejectionLayer[]
  lifecycle: ShadowLifecycle
  events: ShadowEvent[]        // every underlying decision event, chronological
  entryRef: number | null
  stop: number | null
  targets: number[]
  features: ShadowFeatures     // frozen at firstSeen
  outcome: ShadowOutcome | null
}

/** Hypothetical outcome, resolved from post-signal bars. Applies to accepted AND rejected candidates. */
export interface ShadowOutcome {
  entered: boolean
  result: 'target' | 'stop' | 'open_at_end' | 'no_fill'
  mfePct: number | null
  maePct: number | null
  hypotheticalR: number | null
  barsToResolve: number | null
  resolvedFromBars: number
}

/** ET (America/New_York) trading day for a ms timestamp — the boundary that scopes a candidate. */
export function etTradingDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms))
}

/**
 * Build deduplicated candidates from a decision-event stream. Deterministic: groups
 * by `${etTradingDay(ts)}:${setupId}`, so re-reading the same (possibly restart-
 * duplicated) log yields exactly one candidate per setup per ET day. Idempotent —
 * feeding the same event twice changes nothing but the retained event list, and
 * `dedupeEvents` collapses byte-identical duplicates a restart may re-append.
 */
export function buildShadowCandidates(rows: DecisionLogRow[]): ShadowCandidate[] {
  const groups = new Map<string, DecisionLogRow[]>()
  for (const row of rows) {
    const day = etTradingDay(Date.parse(row.ts))
    const key = `${day}:${row.setupId}`
    const arr = groups.get(key) ?? []
    arr.push(row)
    groups.set(key, arr)
  }
  const out: ShadowCandidate[] = []
  for (const [candidateId, groupRaw] of groups) {
    const group = dedupeEvents(groupRaw).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
    const first = group[0]
    const day = candidateId.split(':')[0]
    const events: ShadowEvent[] = group.map(r => ({
      ts: Date.parse(r.ts), etTime: r.etTime, verdict: r.verdict, layer: rejectionLayer(r.verdict),
    }))
    const acceptedEvent = group.find(r => r.verdict === 'logged') ?? null
    const vetoEvent = group.find(r => r.verdict === 'veto') ?? null
    const firstSeenTs = Date.parse(first.ts)
    out.push({
      candidateId,
      etTradingDay: day,
      setupId: first.setupId,
      symbol: first.symbol,
      setup: first.setupType,
      session: first.session,
      signalTs: firstSeenTs,
      everAccepted: acceptedEvent != null,
      terminalVerdict: group[group.length - 1].verdict,
      layers: [...new Set(events.map(e => e.layer))],
      lifecycle: {
        firstSeenTs,
        triggeredTs: firstSeenTs,
        vetoedTs: vetoEvent ? Date.parse(vetoEvent.ts) : null,
        acceptedTs: acceptedEvent ? Date.parse(acceptedEvent.ts) : null,
        reEvaluations: group.length,
        expiredTs: null,   // not provable from the decision log
      },
      events,
      // Geometry/features frozen at the FIRST event — never a later, more-informed value.
      entryRef: first.entryRef ?? first.fill ?? null,
      stop: first.stop ?? null,
      targets: first.targets ?? [],
      features: { grade: first.grade, score: first.score, rvol: first.rvol, offHighPct: first.offHighPct, price: first.price },
      outcome: null,
    })
  }
  return out
}

/** Collapse byte-identical events (same setup, ts, verdict) a daemon restart may re-append. */
function dedupeEvents(rows: DecisionLogRow[]): DecisionLogRow[] {
  const seen = new Set<string>()
  const out: DecisionLogRow[] = []
  for (const r of rows) {
    const k = `${r.ts}|${r.verdict}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

/**
 * Resolve a candidate's HYPOTHETICAL outcome from the tape — for accepted and
 * rejected alike. Uses ONLY bars at/after the signal instant; a bar before the
 * signal cannot define the entry. Outcomes legitimately look forward; features never do.
 * Conservative on same-bar stop+target ambiguity (counts as STOP).
 */
export function resolveShadowOutcome(candidate: ShadowCandidate, candles: Candle[]): ShadowOutcome {
  const { entryRef, stop, targets, signalTs } = candidate
  const t1 = targets[0] ?? null
  const post = candles
    .filter(c => c.time * 1000 >= signalTs)
    .sort((a, b) => a.time - b.time)
  const none: ShadowOutcome = {
    entered: false, result: 'no_fill', mfePct: null, maePct: null,
    hypotheticalR: null, barsToResolve: null, resolvedFromBars: post.length,
  }
  if (entryRef == null || stop == null || post.length === 0) return none

  let entered = false, entryBarIdx = -1
  let mfe = -Infinity, mae = Infinity
  const riskDist = entryRef - stop
  for (let i = 0; i < post.length; i++) {
    const bar = post[i]
    if (!entered) {
      if (bar.high >= entryRef) { entered = true; entryBarIdx = i }
      else continue
    }
    mfe = Math.max(mfe, (bar.high - entryRef) / entryRef * 100)
    mae = Math.min(mae, (bar.low - entryRef) / entryRef * 100)
    if (bar.low <= stop) {
      return { entered: true, result: 'stop', mfePct: round(mfe), maePct: round(mae),
        hypotheticalR: riskDist > 0 ? round((stop - entryRef) / riskDist) : null,
        barsToResolve: i - entryBarIdx, resolvedFromBars: post.length }
    }
    if (t1 != null && bar.high >= t1) {
      return { entered: true, result: 'target', mfePct: round(mfe), maePct: round(mae),
        hypotheticalR: riskDist > 0 ? round((t1 - entryRef) / riskDist) : null,
        barsToResolve: i - entryBarIdx, resolvedFromBars: post.length }
    }
  }
  if (!entered) return none
  const lastClose = post[post.length - 1].close
  return {
    entered: true, result: 'open_at_end', mfePct: round(mfe), maePct: round(mae),
    hypotheticalR: riskDist > 0 ? round((lastClose - entryRef) / riskDist) : null,
    barsToResolve: null, resolvedFromBars: post.length,
  }
}

const round = (v: number) => Math.round(v * 100) / 100
