/**
 * Paper-trade executor: turns a logged BUY signal into a real order lifecycle,
 * then manages the position to a close.
 *
 * The exit ladder deliberately mirrors `scaledPnl` in eod-resolver.ts — half at
 * T1, stop to breakeven, remainder at T2, mark-to-close whatever survives — so
 * live results and backtest results are the same measurement taken two ways.
 * Adverse-first within a tick, for the same reason the resolver is adverse-first
 * within a bar: never credit an optimistic outcome we can't prove.
 *
 * Exit *decisions* come from the FMP price feed (the one the signals use). The
 * broker only fills orders. A resting broker stop is placed during regular hours
 * as a safety net for a process crash; premarket positions have no such net,
 * because Alpaca rejects stop orders outside 09:30–16:00.
 *
 * Node-only (the store writes files). Never import from a client component.
 */
import type { BuySignalRecord } from '@/types'
import { getSessionType, etMinutesOfDay } from '@/lib/market-hours'

import type { Broker, PaperTrade, ExitReason, ExitLeg, BrokerPosition, BrokerOrder, BrokerOrderStatus } from './types'
import { newPaperTrade, computeRealized } from './types'
import { sizePosition, entryLimitPrice, exitLimitPrice, DEFAULT_SIZING, type SizingConfig } from './sizing'
import { canOpenPosition, DEFAULT_RISK, realizedPnlToday, openRisk, premarketTrades, type RiskConfig } from './risk'
import type { SessionType } from '@/lib/market-hours'
import { loadTrades, saveTrades, appendEvent, isHalted, etDayKey } from './store'
import type { ProducerProvenance } from './provenance'
import { acquireExecutionAuthority, makeAuthorityMetadata, type ExecutionAuthority, type AuthorityMetadata } from './authority'

/**
 * How many times a graceful shutdown re-reads broker truth for a pending entry after
 * requesting its cancel, before giving up and declaring the shutdown UNRESOLVED. Bounded
 * so shutdown always terminates; fail-closed on exhaustion (never a silent abort).
 */
const SHUTDOWN_SETTLEMENT_POLLS = 5

export interface ExecutorConfig {
  sizing: SizingConfig
  risk: RiskConfig
  /** How far above the signal's entry we'll chase, in %. */
  entrySlipTolerancePct: number
  /** How far below an exit level we'll accept on the way out, in %. */
  exitSlipTolerancePct: number
  /** Cancel an unfilled entry after this long — the move left without us. */
  entryTimeoutMs: number
  /** ET minute-of-day to flatten everything. 15:55, ahead of the close auction. */
  flattenEtMinute: number
  /** Log intent, place nothing. */
  dryRun: boolean
  /** Producer provenance resolved at daemon startup, stamped into the init event for audit. Optional; no trading effect. */
  provenance?: ProducerProvenance
  /**
   * Whether a process-exclusive execution-authority lease is required.
   *   'required'           — (DEFAULT) init() MUST acquire the marker before the executor
   *                          becomes execution-capable. If `authorityLockPath` is missing, or
   *                          the marker is already held, init fails CLOSED: never authorized,
   *                          onSignal can never submit an order. This is the safe default so
   *                          the invariant is enforced by PaperExecutor itself, not merely by
   *                          the current caller.
   *   'disabled_for_test'  — no lease required; the executor is execution-capable without a
   *                          marker. EXPLICIT test-only configuration — it is NEVER inferred
   *                          from NODE_ENV or any ambient signal; a caller must opt in.
   * Undefined is treated as 'required' (fail-closed default).
   */
  authorityMode?: 'required' | 'disabled_for_test'
  /**
   * Path to the process-exclusive execution-authority marker. Required in 'required' mode
   * (production sets it to authorityLockPath()). Injected as a path so tests use a temp
   * marker instead of the real home file. Ignored in 'disabled_for_test'.
   */
  authorityLockPath?: string
}

export const DEFAULT_EXECUTOR: ExecutorConfig = {
  sizing: DEFAULT_SIZING,
  risk: DEFAULT_RISK,
  entrySlipTolerancePct: 0.5,
  exitSlipTolerancePct: 0.5,
  entryTimeoutMs: 90_000,
  flattenEtMinute: 15 * 60 + 55,
  dryRun: false,
  // Authority is REQUIRED BY DEFAULT: an executor built from these defaults is not
  // execution-capable until it acquires the process-exclusive marker.
  authorityMode: 'required',
}

/** Fetches last prices for the symbols we hold. Injected so the executor stays feed-agnostic and testable. */
export type PriceFetcher = (symbols: string[]) => Promise<Map<string, number>>

export interface ExitDecision {
  reason: ExitReason
  qty: number
  /** The level that triggered the exit — what the backtest would book. */
  intendedPrice: number
}

/** A broker order in one of these states will never fill further — safe to stop polling. */
function isTerminalOrder(status: BrokerOrderStatus): boolean {
  return status === 'filled' || status === 'canceled' || status === 'rejected' || status === 'expired'
}

/**
 * Which exit, if any, does this price trigger? Pure — this is the piece worth
 * unit-testing, and it must stay in lockstep with eod-resolver's ladder.
 *
 * Adverse first: a tick that clears both the stop and a target is scored as the
 * stop, because we cannot know which the tape touched first.
 */
export function decideExit(
  trade: PaperTrade,
  price: number,
  etMinute: number,
  flattenEtMinute: number,
): ExitDecision | null {
  if (trade.state !== 'open' || trade.openQty <= 0) return null

  if (price <= trade.currentStop) {
    return { reason: 'stop', qty: trade.openQty, intendedPrice: trade.currentStop }
  }

  const t1 = trade.targets[0] ?? null
  const t2 = trade.targets[1] ?? null

  if (!trade.t1Done && t1 != null && price >= t1) {
    // Half the FILLED size, floored — with a 1-share position there is no half,
    // so it exits whole at T1 rather than silently skipping the leg.
    const half = Math.max(1, Math.floor(trade.entryFillQty / 2))
    return { reason: 't1', qty: Math.min(half, trade.openQty), intendedPrice: t1 }
  }

  if (trade.t1Done && t2 != null && price >= t2) {
    return { reason: 't2', qty: trade.openQty, intendedPrice: t2 }
  }

  if (etMinute >= flattenEtMinute) {
    return { reason: 'time', qty: trade.openQty, intendedPrice: price }
  }

  return null
}

/**
 * Shares reserved by exit legs that are submitted but not yet filled.
 *
 * The broker counts these in `held_for_orders` and subtracts them from the qty
 * available to any *other* sell order — so they cannot also back a protective
 * stop. They are not unprotected: a resting limit is already working them.
 */
export function workingExitQty(trade: PaperTrade): number {
  // A leg reserves its still-WORKING remainder while its order is non-terminal (orderId set),
  // NOT zero once a first partial books a fillPrice (the P1-003 defect). Reserved =
  // orderedQty − cumulativeFilled, floored at 0.
  return trade.exits.reduce((n, l) => (l.orderId ? n + Math.max(0, l.orderedQty - l.qty) : n), 0)
}

/** Signed slippage in %, positive = worse for a buy, negative = worse for a sell. */
export function slippagePct(intended: number, fill: number): number | null {
  if (!(intended > 0)) return null
  return ((fill - intended) / intended) * 100
}

/**
 * Does this broker rejection mean our local qty is ahead of the broker — i.e. we
 * tried to sell more than we hold, or a position that is already flat? These all
 * signal "reconcile, don't retry blind" rather than "try again":
 *   - "cannot be sold short"                (FIGR: sold a position already flat)
 *   - "insufficient qty available"          (FIGR: local 553 vs broker 0/6)
 *   - "stop price must be less than ..."     (WOK: price already through the stop)
 */
export function isQtyOrShortRejection(reason: string | null): boolean {
  if (!reason) return false
  return /cannot be sold short|insufficient qty|must be less than current price|held_for_orders/i.test(reason)
}

export class PaperExecutor {
  private trades: PaperTrade[] = []
  private startingEquity = 0
  private equity = 0
  private brokerBlocked = false
  /** Phase-1 startup exposure guard: true blocks all new entries (see reconcileStartupPositions). */
  private reconciliationUnresolved = false
  /** Set when the governor returns a terminal verdict — no more entries today. */
  private haltedForDay: string | null = null
  /** The process-exclusive execution-authority lease, held while this producer is authoritative. */
  private executionLease: ExecutionAuthority | null = null
  /** True once authority is confirmed (or not enforced). Gate for reconcile + order submission. */
  private executionAuthorized = false
  /** When authority was refused, the current holder's metadata (for a loud, actionable diagnostic). */
  private deniedAuthority: AuthorityMetadata | null = null
  /** True once a shutdown has begun — new execution admission fails closed from here on. */
  private shuttingDown = false

  constructor(
    private readonly broker: Broker,
    private readonly getPrices: PriceFetcher,
    private readonly config: ExecutorConfig = DEFAULT_EXECUTOR,
    private readonly log: (...a: unknown[]) => void = console.log,
  ) {}

  async init(): Promise<void> {
    // EXECUTION AUTHORITY LEASE — acquired BEFORE the executor becomes execution-capable.
    // A second producer that finds the marker held fails closed here: it never reads the
    // account, never reconciles broker positions, and never submits an order.
    if (!this.acquireAuthority()) {
      appendEvent({
        event: 'execution_authority_refused',
        broker: this.broker.name,
        existingPid: this.deniedAuthority?.pid ?? null,
        existingHost: this.deniedAuthority?.hostname ?? null,
        existingStartedAtUtc: this.deniedAuthority?.startedAtUtc ?? null,
        existingProducerHead: this.deniedAuthority?.producerHead ?? null,
        existingBranch: this.deniedAuthority?.branch ?? null,
        existingMode: this.deniedAuthority?.mode ?? null,
      })
      this.log(
        'EXECUTION AUTHORITY REFUSED — this process is NON-AUTHORITATIVE (no reconciliation, no orders). ' +
        (this.deniedAuthority
          ? `another producer holds the marker: pid=${this.deniedAuthority.pid} host=${this.deniedAuthority.hostname} ` +
            `started=${this.deniedAuthority.startedAtUtc} head=${this.deniedAuthority.producerHead} ` +
            `branch=${this.deniedAuthority.branch} mode=${this.deniedAuthority.mode}`
          : 'authority is required but no lease was acquired (missing authorityLockPath, or acquisition failed)'),
      )
      return
    }

    this.trades = loadTrades()
    const account = await this.broker.getAccount()
    this.equity = account.equity
    this.brokerBlocked = account.blocked
    // Restart-safe: the day's starting equity is whatever the first surviving
    // trade recorded, else today's opening read. Without this a mid-day restart
    // would reset the daily loss limit and hand the loop a fresh budget.
    this.startingEquity = this.trades.length > 0 && this.trades[0].notes.length > 0
      ? this.startingEquityFromNotes() ?? account.equity
      : account.equity
    // Phase-1 startup exposure reconciliation: make broker positions visible and fail
    // closed on anything a loaded active local trade cannot represent (must run before
    // any new entry is admitted).
    await this.reconcileStartupPositions()
    this.log(
      `executor ready · ${this.broker.name} · equity ${account.equity.toFixed(2)} · ` +
      `${this.openTrades().length} open / ${this.trades.length} today` +
      (this.reconciliationUnresolved ? ' · RECONCILIATION_UNRESOLVED (new entries blocked)' : '') +
      (this.config.dryRun ? ' · DRY_RUN' : ''),
    )
    const prov = this.config.provenance
    appendEvent({
      event: 'init', broker: this.broker.name, equity: account.equity, restored: this.trades.length,
      reconciliationUnresolved: this.reconciliationUnresolved,
      ...(prov ? {
        producerHead: prov.producerHead,
        producerBranch: prov.producerBranch,
        producerDirtyTracked: prov.producerDirtyTracked,
        producerDirtyOverride: prov.producerDirtyOverride,
        producerProvenanceResolved: prov.provenanceResolved,
        producerStartedAtUtc: prov.startedAtUtc,
      } : {}),
    })
  }

  /** True while startup exposure is unresolved (positive broker position with no unique
   *  active local owner, or a failed position query) — all new entries are blocked. */
  isReconciliationUnresolved(): boolean {
    return this.reconciliationUnresolved
  }

  /** True when this process holds (or does not need) execution authority — i.e. is order-capable. */
  isExecutionAuthorized(): boolean {
    return this.executionAuthorized
  }

  /** When authority was refused, the current holder's non-secret metadata; else null. */
  deniedAuthorityInfo(): AuthorityMetadata | null {
    return this.deniedAuthority
  }

  /** True once a graceful shutdown has begun — admission is closed. */
  isShuttingDown(): boolean {
    return this.shuttingDown
  }

  /**
   * Acquire the process-exclusive execution-authority lease. Returns true when the process
   * is execution-capable: either the marker was created by us, or enforcement is disabled
   * (no lock path configured). Returns false — fail closed — when the marker is already
   * held or acquisition errored. NEVER steals an existing marker (see authority.ts).
   */
  private acquireAuthority(): boolean {
    const mode = this.config.authorityMode ?? 'required'
    if (mode === 'disabled_for_test') {
      // EXPLICIT test-only bypass — opted into by construction, NEVER inferred from NODE_ENV
      // or any ambient signal. Execution-capable without a lease.
      this.executionAuthorized = true
      return true
    }
    // mode === 'required'
    const lockPath = this.config.authorityLockPath
    if (!lockPath) {
      // FAIL CLOSED: authority is required but no marker path is configured, so no
      // process-exclusive lease can be taken. Never silently become order-capable.
      this.executionAuthorized = false
      this.deniedAuthority = null
      return false
    }
    const prov = this.config.provenance
    const meta = makeAuthorityMetadata({
      producerHead: prov?.producerHead ?? null,
      branch: prov?.producerBranch ?? null,
      mode: this.config.dryRun ? 'DRY_RUN' : 'PAPER_TRADE',
    })
    const lease = acquireExecutionAuthority(meta, { lockPath })
    if (!lease.acquired) {
      this.executionAuthorized = false
      this.deniedAuthority = lease.existing
      return false
    }
    this.executionLease = lease
    this.executionAuthorized = true
    appendEvent({
      event: 'execution_authority_acquired',
      broker: this.broker.name,
      pid: meta.pid, hostname: meta.hostname, startedAtUtc: meta.startedAtUtc,
      producerHead: meta.producerHead, branch: meta.branch, mode: meta.mode,
      markerPath: lease.path,
    })
    return true
  }

  /** Release the authority lease. Only ever called after a shutdown is proven SAFE. */
  private releaseAuthority(): void {
    if (!this.executionLease) return
    const path = this.executionLease.path
    this.executionLease.release()
    this.executionLease = null
    this.executionAuthorized = false
    appendEvent({ event: 'execution_authority_released', broker: this.broker.name, markerPath: path })
  }

  /**
   * PHASE 1 startup exposure reconciliation. Enumerate broker positions and fail closed
   * on any positive exposure the executor cannot confidently represent. A position is
   * REPRESENTED only when EXACTLY ONE loaded active local trade (pending_entry|open)
   * exists for its symbol — meaning the normal tick reconcile() already owns that
   * symbol's lifecycle. This is NOT an ownership claim and rewrites no setupId/tradeId;
   * it does not adopt, mutate, or liquidate any broker position. Zero, or more than one,
   * active local trade — or only closed history — is AMBIGUOUS: audit it and block new
   * risk. A failed/malformed position query is treated as unknown exposure, never flat.
   */
  private async reconcileStartupPositions(): Promise<void> {
    let positions: BrokerPosition[]
    try {
      const raw = await this.broker.getPositions()
      if (!Array.isArray(raw)) throw new Error('getPositions did not return an array')
      positions = raw
    } catch (e) {
      // "Could not fetch positions" is NEVER "broker is flat" — fail closed.
      this.reconciliationUnresolved = true
      this.log(`startup reconciliation ERROR — new entries blocked: ${(e as Error).message}`)
      appendEvent({ event: 'startup_reconciliation_error', broker: this.broker.name, message: (e as Error).message })
      return
    }

    // A position with a non-finite qty is unknown exposure → fail closed.
    const malformed = positions.some(p => !p || typeof p.qty !== 'number' || !Number.isFinite(p.qty))
    // ANY non-zero finite quantity is exposure — long (qty>0) OR short (qty<0). Only a
    // true zero (0 / -0) is flat. A negative/manual short is exposure too and must
    // never be silently ignored.
    const exposed = positions.filter(p => p && typeof p.qty === 'number' && Number.isFinite(p.qty) && p.qty !== 0)

    let represented = 0
    let ambiguous = 0
    for (const pos of exposed) {
      const actives = this.openTrades().filter(t => t.symbol === pos.symbol) // pending_entry | open
      // REPRESENTED only when the local executor can already ACCOUNT for this exact
      // exposure: exactly one active local trade, carrying positive local exposure,
      // whose accounted open quantity EQUALS the broker quantity (same sign & size).
      // This is NOT an ownership claim; it only says the tick reconcile() already owns
      // this symbol's lifecycle at this quantity. Any surplus/deficit/short/pending
      // (openQty 0) is unaccounted identity → AMBIGUOUS. avgEntryPrice is NOT used.
      const only = actives.length === 1 ? actives[0] : null
      if (only && only.openQty > 0 && only.openQty === pos.qty) { represented++; continue }
      ambiguous++
      appendEvent({
        event: 'startup_orphan_detected',
        symbol: pos.symbol, qty: pos.qty, avgEntryPrice: pos.avgEntryPrice,
        activeLocalTradeIds: actives.map(t => t.id),
        activeLocalSetupIds: actives.map(t => t.setupId),
        activeLocalOpenQty: actives.map(t => t.openQty),
        classification: 'AMBIGUOUS_BROKER_POSITION',
      })
      this.log(`AMBIGUOUS broker position ${pos.symbol} ${pos.qty} sh — ${actives.length} active local trade(s), openQty [${actives.map(t => t.openQty).join(',')}]; blocking new entries`)
    }

    this.reconciliationUnresolved = ambiguous > 0 || malformed
    if (malformed) {
      appendEvent({ event: 'startup_reconciliation_error', broker: this.broker.name, message: 'malformed position entry (non-finite qty)' })
    }
    appendEvent({
      event: 'startup_reconciliation',
      brokerPositionCount: exposed.length,
      representedCount: represented,
      ambiguousCount: ambiguous,
      reconciliationUnresolved: this.reconciliationUnresolved,
    })
  }

  private startingEquityFromNotes(): number | null {
    for (const t of this.trades) {
      for (const n of t.notes) {
        const m = n.match(/^startingEquity=([\d.]+)$/)
        if (m) return Number(m[1])
      }
    }
    return null
  }

  openTrades(): PaperTrade[] {
    return this.trades.filter(t => t.state === 'pending_entry' || t.state === 'open')
  }

  /**
   * Trades belonging to the current ET session — the ONLY correct basis for any
   * "today" accounting. `this.trades` accumulates across ET days in a
   * long-running process (and a restart can rehydrate a prior day), so every
   * daily count/P&L/loss-limit input MUST scope by the signal-creation day, not
   * read the raw list. See store.scopeToTradingDay for the 2026-08-18 incident.
   */
  private todaysTrades(): PaperTrade[] {
    const day = etDayKey()
    return this.trades.filter(t => etDayKey(t.createdAt) === day)
  }

  closedToday(): PaperTrade[] {
    return this.todaysTrades().filter(t => t.state === 'closed')
  }

  /**
   * THE LEARNING GATE. Only broker-`verified` closed trades may feed research or
   * post-trade review — a trade whose local record disagreed with Alpaca
   * (discrepancy / manual_review) is not trustworthy evidence and must be excluded
   * until a human confirms it. Any future live→learning ingestion must read from
   * HERE, never from allTrades().
   */
  verifiedClosedTrades(): PaperTrade[] {
    return this.todaysTrades().filter(t => t.state === 'closed' && t.reconciliationStatus === 'verified')
  }

  allTrades(): PaperTrade[] {
    return this.trades
  }

  /**
   * READ-ONLY capacity snapshot for observational telemetry (the per-sweep
   * arbitration audit). Pure: it computes from already-loaded local state using the
   * SAME helpers canOpenPosition uses, calls no broker, mutates nothing, and is
   * never consulted by any entry/exit/ordering decision. `equity` is the last value
   * cached at init/onSignal (no fresh broker read here, by design). It exists only
   * so an audit record can explain why a candidate would/would not have fit.
   */
  observeCapacity(session: SessionType, config: RiskConfig = this.config.risk): {
    session: SessionType
    halted: boolean
    brokerBlocked: boolean
    reconciliationUnresolved: boolean
    haltedForDay: string | null
    equity: number
    startingEquity: number
    openCount: number
    maxConcurrentPositions: number
    freeConcurrentSlots: number
    tradesToday: number
    maxTradesPerDay: number
    openPlannedRisk: number
    maxOpenRiskFraction: number
    openRiskCeiling: number
    realizedPnlToday: number
    dailyLossLimit: number
    premarketTradeCount: number | null
    maxPremarketTrades: number | null
    premarketRealizedPnl: number | null
    premarketLossLimit: number | null
  } {
    const open = this.openTrades()
    const closed = this.closedToday()
    const inPremarket = session === 'premarket'
    return {
      session,
      halted: isHalted(),
      brokerBlocked: this.brokerBlocked,
      reconciliationUnresolved: this.reconciliationUnresolved,
      haltedForDay: this.haltedForDay,
      equity: this.equity,
      startingEquity: this.startingEquity,
      openCount: open.length,
      maxConcurrentPositions: config.maxConcurrentPositions,
      freeConcurrentSlots: Math.max(0, config.maxConcurrentPositions - open.length),
      tradesToday: closed.length + open.length,
      maxTradesPerDay: config.maxTradesPerDay,
      openPlannedRisk: openRisk(open),
      maxOpenRiskFraction: config.maxOpenRiskFraction,
      openRiskCeiling: this.equity * config.maxOpenRiskFraction,
      realizedPnlToday: realizedPnlToday(closed),
      dailyLossLimit: -Math.abs(this.startingEquity * config.dailyLossLimitFraction),
      premarketTradeCount: inPremarket ? premarketTrades(closed).length + premarketTrades(open).length : null,
      maxPremarketTrades: inPremarket ? config.maxPremarketTrades : null,
      premarketRealizedPnl: inPremarket ? realizedPnlToday(premarketTrades(closed)) : null,
      premarketLossLimit: inPremarket ? -Math.abs(this.startingEquity * config.premarketLossLimitFraction) : null,
    }
  }

  private persist(): void {
    saveTrades(this.trades)
  }

  private touch(trade: PaperTrade, note?: string): void {
    trade.updatedAt = Date.now()
    if (note) trade.notes.push(note)
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  /**
   * Consider a freshly logged BUY. Returns the verdict so the daemon can log it
   * next to the alert — a skip is data (how many signals are untradeable?), not
   * a silent no-op.
   */
  async onSignal(
    signal: BuySignalRecord,
    ctx: { sessionVolume?: number | null } = {},
  ): Promise<{ taken: boolean; reason?: string }> {
    // FAIL CLOSED — a shutdown in progress must never admit a new entry (no race between
    // "flatten everything" and "one more BUY slips in"). Admission closes the instant
    // shutdown begins and never reopens for this process.
    if (this.shuttingDown) {
      return { taken: false, reason: 'shutting down — execution admission closed' }
    }
    // FAIL CLOSED — never submit an order without process-exclusive execution authority.
    if (!this.executionAuthorized) {
      return { taken: false, reason: 'no execution authority (another producer holds the lease)' }
    }
    // One trade per setup per day — classifyBuy can re-fire the same setup across sweeps.
    if (this.trades.some(t => t.setupId === signal.setupId)) {
      return { taken: false, reason: 'already traded this setup' }
    }
    if (this.haltedForDay) {
      return { taken: false, reason: this.haltedForDay }
    }

    const account = await this.broker.getAccount()
    this.equity = account.equity
    this.brokerBlocked = account.blocked

    const sizing = sizePosition({
      equity: account.equity,
      buyingPower: account.buyingPower,
      entry: signal.entryHigh,
      stop: signal.stop,
      sessionVolume: ctx.sessionVolume ?? null,
    }, this.config.sizing)

    if (sizing.qty < 1) {
      appendEvent({ event: 'entry_skipped', symbol: signal.symbol, setupId: signal.setupId, reason: sizing.reason ?? 'zero size' })
      return { taken: false, reason: sizing.reason ?? 'zero size' }
    }

    const verdict = canOpenPosition(signal.symbol, sizing.plannedRisk, {
      equity: account.equity,
      startingEquity: this.startingEquity,
      brokerBlocked: account.blocked,
      openTrades: this.openTrades(),
      closedToday: this.closedToday(),
      halted: isHalted(),
      session: getSessionType(Date.now()),
      reconciliationUnresolved: this.reconciliationUnresolved,
    }, this.config.risk)

    if (!verdict.allowed) {
      if (verdict.terminal) {
        this.haltedForDay = verdict.reason
        this.log(`RISK HALT — ${verdict.reason}`)
      }
      appendEvent({ event: 'entry_blocked', symbol: signal.symbol, setupId: signal.setupId, reason: verdict.reason, terminal: verdict.terminal })
      return { taken: false, reason: verdict.reason }
    }

    // Alpaca lists no OTC names and flags some low-float movers untradable. On
    // this strategy that is a meaningful miss rate, so record it explicitly.
    const asset = await this.broker.getAsset(signal.symbol)
    if (!asset || !asset.tradable) {
      appendEvent({ event: 'entry_skipped', symbol: signal.symbol, setupId: signal.setupId, reason: 'not tradable at broker' })
      return { taken: false, reason: `${signal.symbol} not tradable at ${this.broker.name}` }
    }

    const now = Date.now()
    const limit = entryLimitPrice(signal.entryHigh, this.config.entrySlipTolerancePct)
    const trade = newPaperTrade(signal, sizing.qty, limit, now)
    trade.plannedRisk = sizing.plannedRisk
    trade.notes.push(`size boundBy=${sizing.boundBy}`)
    if (this.trades.length === 0) trade.notes.push(`startingEquity=${this.startingEquity}`)

    if (this.config.dryRun) {
      trade.notes.push('dry-run: no order placed')
      trade.state = 'aborted'
      this.trades.push(trade)
      this.persist()
      this.log(`[dry-run] would buy ${sizing.qty} ${signal.symbol} @ ≤${limit.toFixed(4)} (risk $${sizing.plannedRisk.toFixed(0)})`)
      return { taken: false, reason: 'dry run' }
    }

    const session = getSessionType(now)
    const order = await this.broker.submitLimit({
      symbol: signal.symbol,
      qty: sizing.qty,
      side: 'buy',
      limitPrice: limit,
      extendedHours: session === 'premarket' || session === 'afterhours',
      clientOrderId: trade.id,
    })

    if (order.status === 'rejected') {
      trade.state = 'aborted'
      this.touch(trade, `entry rejected: ${order.rejectReason ?? 'unknown'}`)
      this.trades.push(trade)
      this.persist()
      this.log(`REJECT ${signal.symbol}: ${order.rejectReason}`)
      appendEvent({ event: 'entry_rejected', symbol: signal.symbol, setupId: signal.setupId, tradeId: trade.id, reason: order.rejectReason })
      return { taken: false, reason: `broker rejected: ${order.rejectReason}` }
    }

    trade.entryOrderId = order.id
    trade.entrySubmittedAt = now
    this.trades.push(trade)
    this.persist()
    this.log(`ENTRY ${signal.symbol} ${sizing.qty} sh @ ≤${limit.toFixed(4)} (risk $${sizing.plannedRisk.toFixed(0)}, ${sizing.boundBy})`)
    appendEvent({
      event: 'entry_submitted', symbol: signal.symbol, setupId: signal.setupId, tradeId: trade.id, orderId: order.id,
      qty: sizing.qty, limitPrice: limit, intendedEntry: signal.entryHigh, stop: signal.stop,
      targets: signal.targets, plannedRisk: sizing.plannedRisk, boundBy: sizing.boundBy,
    })
    return { taken: true }
  }

  // ── Lifecycle tick ─────────────────────────────────────────────────────────

  /** Reconcile working orders, then run exits. Safe to call every sweep. */
  async tick(now: number = Date.now()): Promise<void> {
    const live = this.openTrades()
    // A CLOSED invalid-geometry trade (non-positive planned risk) — or any closed
    // trade still pending verification — needs post-close reconciliation even on an
    // otherwise-flat book, because a cancelled entry can fill late at the broker (the
    // 2971c26 residual race). So don't short-circuit the tick when only such trades remain.
    const needsPostClose = this.trades.some(t => t.state === 'closed' && (t.reconciliationStatus === 'pending' || t.reconciliationStatus === 'discrepancy' || !(t.plannedRisk > 0)))
    if (live.length === 0 && !needsPostClose) return

    for (const trade of live) {
      try {
        // Track the entry order until it is TERMINAL — for pending_entry AND for an open
        // trade whose entry order is still filling (P1-002). Folds cumulative entry fills
        // into entry basis; a trade being `open` does not end the entry lifecycle.
        if (trade.entryOrderId && !trade.entryOrderTerminal) await this.reconcileEntry(trade, now)
      } catch (e) {
        this.log(`entry reconcile failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }

    // Settle any exit legs that were working from a previous tick before asking
    // for new ones, so openQty is current when decideExit runs.
    for (const trade of this.openTrades()) {
      try {
        if (trade.state === 'open') await this.reconcileExits(trade)
      } catch (e) {
        this.log(`exit reconcile failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }

    // Still-pending entries need the live price too — not to fill them, but to
    // check whether the market has already invalidated the plan (PENDING-ENTRY
    // GEOMETRY INVALIDATION) while the entry order is still working at the broker.
    const pending = this.openTrades().filter(t => t.state === 'pending_entry')
    const preHolding = this.trades.filter(t => t.state === 'open' && t.openQty > 0)
    // Same guard as the tick head: keep going for post-close reconciliation work,
    // and now also when a pending entry needs a geometry check.
    if (preHolding.length === 0 && pending.length === 0 && !needsPostClose) { this.persist(); return }

    let prices: Map<string, number>
    try {
      prices = await this.getPrices([...new Set([...preHolding.map(t => t.symbol), ...pending.map(t => t.symbol)])])
    } catch (e) {
      this.log(`price fetch failed, holding positions untouched: ${(e as Error).message}`)
      this.persist()
      return
    }

    // PENDING-ENTRY GEOMETRY INVALIDATION. Cancel a still-working long entry once the
    // live market has reached/crossed its ORIGINAL stop — the setup is invalid before
    // we're even filled. This is an EXECUTION-POLICY change (it can drop an entry the
    // producer would otherwise have filled), NOT a strategy change. It trusts exactly the
    // same FMP-derived price the open-position stop (decideExit) already trusts, so a
    // stale/transient sub-stop print carries the same false-trigger risk here as it does
    // for a live stop-out today — no new feed dependency. Broker truth stays authoritative:
    // a fill that raced the cancel is booked (never disowned) and handed to the existing
    // post-fill geometry guard.
    for (const trade of pending) {
      if (trade.state !== 'pending_entry') continue   // reconcileEntry above may have moved it
      const price = prices.get(trade.symbol)
      if (price == null || !(price > 0)) continue
      if (price <= trade.initialStop) {
        try {
          await this.invalidatePendingEntry(trade, price, now)
        } catch (e) {
          this.log(`pending-entry geometry check failed ${trade.symbol}: ${(e as Error).message}`)
        }
      }
    }

    // Recompute holdings AFTER the geometry pass: a raced fill above the stop promotes
    // a pending trade to a valid open one (managed this same tick), and an invalid one
    // has already been flattened/closed by the guard.
    const holding = this.trades.filter(t => t.state === 'open' && t.openQty > 0)
    if (holding.length === 0 && !needsPostClose) { this.persist(); return }

    const etMinute = etMinutesOfDay(now)
    for (const trade of holding) {
      const price = prices.get(trade.symbol)
      if (price == null || !(price > 0)) {
        this.touch(trade, `no price at ${new Date(now).toISOString()}`)
        continue
      }
      try {
        await this.manageOpen(trade, price, etMinute, now)
      } catch (e) {
        this.log(`manage failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }
    // Post-close verification: a trade that closed cleanly this tick is still
    // `pending` until the broker confirms it flat. reconcile stamps it `verified`
    // (or flags a discrepancy) — the gate the learning dataset reads.
    for (const trade of this.trades) {
      // Reconcile a freshly-closed trade (pending → verified/discrepancy). AND keep an
      // INVALID-GEOMETRY closed trade (non-positive planned risk) eligible EVERY tick —
      // even after it verified flat with openQty 0 — because its cancelled entry order
      // can still fill late at the broker (the 2971c26 race). The `plannedRisk <= 0`
      // marker persists, so this re-polls broker truth until the trade rolls over; a
      // late fill promotes it back to open (reconcile), and a broker that stays flat is
      // a harmless no-op. Narrow: only invalid trades poll, and they are rare.
      const invalidResidualWatch = !(trade.plannedRisk > 0)
      // A `discrepancy` is retried too, so a temporary local/broker mismatch that later
      // agrees resolves to verified instead of staying stuck (defect E/F). manual_review
      // is intentionally NOT retried — it needs human resolution.
      if (trade.state === 'closed' && (trade.reconciliationStatus === 'pending' || trade.reconciliationStatus === 'discrepancy' || invalidResidualWatch)) {
        try { await this.reconcile(trade, now) } catch { /* leave pending; retried next tick */ }
      }
    }
    this.persist()
  }

  /**
   * Reconcile the ENTRY ORDER against fresh broker truth. Called every tick while the entry
   * order is non-terminal (pending_entry, AND open trades whose entry order is still working)
   * — a trade being `open` does NOT end the entry lifecycle (P1-002). It folds cumulative
   * entry fills idempotently (order-authoritative basis/VWAP), transitions pending→open on the
   * first partial, and marks `entryOrderTerminal` once the broker order is terminal.
   */
  private async reconcileEntry(trade: PaperTrade, now: number): Promise<void> {
    if (!trade.entryOrderId) { trade.state = 'aborted'; trade.entryOrderTerminal = true; return }
    let order
    try {
      order = await this.broker.getOrder(trade.entryOrderId)
    } catch (e) {
      this.log(`entry order read failed ${trade.symbol}: ${(e as Error).message}`)
      return // transient — retry next tick, never decide from a guess
    }
    if (!order) return

    // Fold any NEW cumulative entry fill (idempotent; never decreases). The broker order's
    // cumulative filled qty and average price are the entry basis — position qty is NOT.
    if (order.filledQty > trade.entryFillQty) {
      await this.bookEntryFill(trade, order.filledQty, order.filledAvgPrice ?? trade.limitPrice, now)
    }

    const timedOut = trade.entrySubmittedAt != null && now - trade.entrySubmittedAt > this.config.entryTimeoutMs

    if (isTerminalOrder(order.status)) {
      // Entry order will fill no further — stop tracking it.
      trade.entryOrderTerminal = true
      if (trade.entryFillQty <= 0) {
        trade.state = 'aborted'
        this.touch(trade, `entry ${order.status} unfilled`)
        appendEvent({ event: 'entry_aborted', symbol: trade.symbol, tradeId: trade.id, status: order.status })
      }
      return
    }

    if (timedOut) {
      // The move left without us. Cancel the (remaining) entry and settle from FRESH broker
      // truth read AFTER the cancel — never from the pre-cancel snapshot (the P0-002 race).
      const outcome = await this.settleCanceledEntry(trade, now, 1)
      if (outcome !== 'unresolved') trade.entryOrderTerminal = true
      if (outcome === 'terminal_unfilled' && trade.entryFillQty <= 0) {
        trade.state = 'aborted'
        this.touch(trade, `entry timed out unfilled after ${Math.round(this.config.entryTimeoutMs / 1000)}s`)
        this.log(`NO FILL ${trade.symbol} — limit ${trade.limitPrice.toFixed(4)} never traded`)
        appendEvent({ event: 'entry_timeout', symbol: trade.symbol, setupId: trade.setupId, tradeId: trade.id, limitPrice: trade.limitPrice })
      }
      // 'filled' → partial/full booked + managed; 'unresolved' → stays live, retried next tick.
    }
    // Non-terminal, not timed out: any partial is booked; keep polling until terminal.
  }

  /**
   * BROKER-TRUTH-AFTER-CANCEL settlement for a working entry order. Request cancellation,
   * then decide ONLY from a FRESH broker read — never a pre-cancel snapshot. This is the one
   * settlement path shared by the entry-timeout tick and graceful shutdown, so there is a
   * single, tested implementation of the cancel/fill race rather than two slightly different
   * ones (invalidatePendingEntry already applies the same pattern for geometry cancels).
   *
   *   'filled'           — fresh cumulative filledQty > 0: the fill is booked (and any
   *                        unfilled remainder cancelled). bookEntryFill manages/flattens it.
   *   'terminal_unfilled'— broker reports a genuinely terminal order with zero fill: safe to abort.
   *   'unresolved'       — broker truth could not be reduced to terminal within `polls`
   *                        (still working, e.g. pending_cancel, or getOrder failing). The
   *                        CALLER must NOT treat this as aborted — fail closed / retry.
   *
   * `polls` bounds the re-reads: 1 for the tick (retry next tick), several for shutdown
   * (which has no next tick and must reach a decision or declare itself unresolved).
   */
  private async settleCanceledEntry(
    trade: PaperTrade,
    now: number,
    polls: number,
  ): Promise<'filled' | 'terminal_unfilled' | 'unresolved'> {
    if (!trade.entryOrderId) return 'terminal_unfilled'
    // Best-effort cancel: the fresh getOrder below, not this call, is authoritative.
    try { await this.broker.cancelOrder(trade.entryOrderId) } catch { /* broker truth decides */ }

    for (let i = 0; i < Math.max(1, polls); i++) {
      let order: BrokerOrder | null
      try {
        order = await this.broker.getOrder(trade.entryOrderId)
      } catch {
        continue // transient read failure — retry within the bound; never abort on a guess
      }
      if (!order) continue // couldn't resolve this pass
      if (order.filledQty > 0) {
        // A fill raced (or completed) — book the ACTUAL cumulative fill, never disown it.
        await this.bookEntryFill(trade, order.filledQty, order.filledAvgPrice ?? trade.limitPrice, now)
        if (order.status !== 'filled') {
          // Cancel any unfilled remainder of a partial. Idempotent, best-effort.
          try { await this.broker.cancelOpenOrders(trade.symbol) } catch { /* best-effort */ }
        }
        return 'filled'
      }
      if (isTerminalOrder(order.status)) return 'terminal_unfilled' // genuinely canceled/rejected/expired, zero fill
      // Still non-terminal (e.g. pending_cancel mapped to open) — poll again within the bound.
    }
    return 'unresolved'
  }

  /**
   * PENDING-ENTRY GEOMETRY INVALIDATION. A long entry is still working at the broker,
   * but the live market has already reached/crossed the trade's ORIGINAL stop — the
   * plan is invalidated before we're even filled (the Session-9 CHPT race: the entry
   * order rested ~93s while price moved through the stop, then filled below it). Cancel
   * the working entry so we don't buy into an already-dead setup, then reconcile broker
   * truth. A fill that raced the cancel is NEVER disowned: it's booked and handed to the
   * existing post-fill geometry guard (bookEntryFill), which flattens invalid geometry.
   * Broker-truth-first throughout — cancellation is best-effort; getOrder is authoritative.
   *
   * Idempotent: the ENTRY_GEOMETRY_INVALIDATED marker makes the cancel + audit fire once;
   * a repeat tick (order not yet acknowledged) only re-reads broker truth.
   */
  private async invalidatePendingEntry(trade: PaperTrade, price: number, now: number): Promise<void> {
    if (!trade.entryOrderId) { trade.state = 'aborted'; return }
    const marker = 'ENTRY_GEOMETRY_INVALIDATED'
    if (!trade.executionWarnings.some(w => w.startsWith(marker))) {
      trade.executionWarnings.push(`${marker}: price ${price} <= stop ${trade.initialStop} while pending (intended ${trade.intendedEntry})`)
      this.touch(trade, `${marker} — cancelling pending entry`)
      this.log(`ENTRY GEOMETRY INVALID ${trade.symbol} — price ${price.toFixed(4)} <= stop ${trade.initialStop.toFixed(4)}; cancelling pending entry ${trade.entryOrderId}`)
      appendEvent({
        event: 'entry_geometry_invalidated',
        symbol: trade.symbol, setupId: trade.setupId, tradeId: trade.id,
        currentPrice: price, initialStop: trade.initialStop, intendedEntry: trade.intendedEntry,
        entryOrderId: trade.entryOrderId, timestamp: now,
      })
      // Best-effort cancel: the getOrder below, not this call, decides what happened.
      try { await this.broker.cancelOrder(trade.entryOrderId) } catch { /* reconcile below is authoritative */ }
    }

    // Reconcile broker truth — a partial/full fill may have raced the cancellation.
    const order = await this.broker.getOrder(trade.entryOrderId)
    if (!order) return   // transient read failure — stays pending, retried next tick

    if (order.filledQty > 0) {
      // CASE B/C: shares filled despite the cancel. Book the ACTUAL fill (never a lost
      // quantity); the post-fill geometry guard inside bookEntryFill flattens it if the
      // fill is at/below the stop, or carries it as a valid open position if somehow above.
      await this.bookEntryFill(trade, order.filledQty, order.filledAvgPrice ?? trade.limitPrice, now)
      // Cancel any unfilled remainder of a partial (handleInvalidPostFillGeometry also
      // sweeps the symbol's open orders; this is a harmless, idempotent belt-and-braces).
      if (order.status !== 'filled') { try { await this.broker.cancelOrder(trade.entryOrderId) } catch { /* best-effort */ } }
      return
    }

    if (order.status === 'canceled' || order.status === 'rejected' || order.status === 'expired') {
      // CASE A: broker confirms no fill — clean abort, no position.
      trade.state = 'aborted'
      this.touch(trade, `entry aborted on geometry invalidation (${order.status}, unfilled)`)
      appendEvent({
        event: 'entry_aborted', symbol: trade.symbol, setupId: trade.setupId, tradeId: trade.id,
        status: order.status, reason: 'geometry_invalidated',
      })
      return
    }
    // Still working (cancel not yet acknowledged, nothing filled) — stay pending; the
    // next tick re-checks broker truth without re-issuing the cancel or the audit event.
  }

  /**
   * Fold a CUMULATIVE entry-order observation into entry accounting. `cumQty`/`cumAvgPrice`
   * are the broker ENTRY ORDER's cumulative filled quantity and average price — order truth,
   * the authority for entry basis (never position qty). Idempotent and monotonic: a repeat or
   * out-of-order LOWER cumulative books nothing and never reduces already-booked accounting
   * (P1-002). Each new increment adds to the open position and re-derives planned risk from
   * the corrected cumulative basis.
   */
  private async bookEntryFill(trade: PaperTrade, cumQty: number, cumAvgPrice: number, now: number): Promise<void> {
    // Never decrease: ignore a flat/lower/out-of-order cumulative observation.
    if (!(cumQty > trade.entryFillQty)) return
    const increment = cumQty - trade.entryFillQty
    const firstFill = trade.entryFillQty === 0

    // Which session the entry FIRST filled in decides which risk budget this trade spends.
    if (firstFill) trade.entrySession = getSessionType(now)
    trade.entryFillQty = cumQty
    trade.entryFillPrice = cumAvgPrice   // broker cumulative VWAP — reconstructed from ORDER truth
    trade.entryFilledAt = now
    trade.openQty += increment           // fold the newly-filled entry shares into the position
    trade.entrySlippagePct = slippagePct(trade.intendedEntry, cumAvgPrice)

    // FAIL CLOSED on post-fill stop inversion. This book is long-only (every exit is a
    // sell), so a valid long fill MUST be strictly above its stop. A favorable fill that
    // prints AT or BELOW the stop (ADXN 2026-08-21: 5.69 vs stop 5.7508) leaves the
    // position already through its invalidation. The old `Math.max(price - stop, 0)`
    // silently clamped planned risk to 0 and admitted it; instead we detect it, cancel
    // any remainder, and flatten the filled shares — never a zero/negative-risk position.
    const riskPerShare = cumAvgPrice - trade.initialStop
    if (!(riskPerShare > 0)) {
      await this.handleInvalidPostFillGeometry(trade, cumQty, cumAvgPrice, riskPerShare, now)
      return
    }

    trade.state = 'open'
    // Risk is re-derived from the real cumulative fill: a worse fill on the same stop is
    // strictly more dollars at risk, and the governor should see the true number.
    trade.plannedRisk = cumQty * riskPerShare
    this.touch(trade)
    const slip = trade.entrySlippagePct
    this.log(
      `FILL ${trade.symbol} +${increment} sh (cum ${cumQty}) @ ${cumAvgPrice.toFixed(4)} ` +
      `(intended ${trade.intendedEntry.toFixed(4)}, slip ${slip == null ? '—' : `${slip >= 0 ? '+' : ''}${slip.toFixed(2)}%`})`,
    )
    appendEvent({
      event: 'entry_filled', symbol: trade.symbol, tradeId: trade.id,
      qty: increment, cumulativeQty: cumQty, fillPrice: cumAvgPrice, intendedEntry: trade.intendedEntry, slippagePct: slip,
    })
  }

  /**
   * INVALID_POST_FILL_GEOMETRY: a filled long whose fill is at/below its stop is already
   * through its invalidation. Fail closed — record deterministic evidence, cancel any
   * unfilled remainder, and flatten the filled shares. Never carry it as a normal open
   * position and never clamp planned risk to zero. Idempotent: repeated fill callbacks
   * re-attempt the flatten but never duplicate the cancel/audit.
   */
  private async handleInvalidPostFillGeometry(trade: PaperTrade, qty: number, price: number, riskPerShare: number, now: number): Promise<void> {
    const marker = 'INVALID_POST_FILL_GEOMETRY'
    if (trade.executionWarnings.some(w => w.startsWith(marker))) { await this.flattenFilledQty(trade, now); return }
    const originalPlannedRisk = trade.plannedRisk
    // Record the REAL (non-positive) per-share risk × qty — never a silent zero.
    trade.plannedRisk = qty * riskPerShare
    trade.state = 'open' // transient: shares are held until the flatten settles
    trade.executionWarnings.push(`${marker}: fill ${price} <= stop ${trade.initialStop} (filled ${qty}, intended ${trade.intendedEntry})`)
    this.touch(trade, `${marker} — flattening ${qty} sh`)
    this.log(`INVALID FILL ${trade.symbol} ${qty} sh @ ${price.toFixed(4)} <= stop ${trade.initialStop.toFixed(4)} — cancel remainder + flatten`)
    appendEvent({
      event: 'entry_invalid_geometry', reason: marker,
      symbol: trade.symbol, setupId: trade.setupId, tradeId: trade.id,
      fillPrice: price, initialStop: trade.initialStop, filledQty: qty,
      intendedEntry: trade.intendedEntry, originalPlannedRisk,
    })
    // Cancel any unfilled remainder of the entry order, then flatten the filled shares. Cancel
    // BY ID (kills a partially_filled remainder that cancelOpenOrders — which only cancels
    // 'open' orders — would miss) UNLESS the geometry-invalidation path already issued the
    // cancel (avoid double-cancel spam); then sweep the symbol's other working orders. The
    // entry order is done once we flatten, so mark its lifecycle terminal.
    if (trade.entryOrderId) {
      const alreadyCancelledByGeometry = trade.executionWarnings.some(w => w.startsWith('ENTRY_GEOMETRY_INVALIDATED'))
      if (!alreadyCancelledByGeometry) { try { await this.broker.cancelOrder(trade.entryOrderId) } catch { /* best-effort */ } }
      try { await this.broker.cancelOpenOrders(trade.symbol) } catch { /* best-effort */ }
      trade.entryOrderTerminal = true
    }
    await this.flattenFilledQty(trade, now)
  }

  /**
   * Flatten this trade's held shares as an invalid-geometry unwind. Idempotent: if an
   * invalid_geometry exit leg is already working, it only settles it (no duplicate sell);
   * when nothing is left to sell it stamps the trade closed.
   */
  private async flattenFilledQty(trade: PaperTrade, now: number): Promise<void> {
    if (trade.openQty <= 0) {
      if (trade.state === 'open') { trade.state = 'closed'; this.touch(trade, 'invalid-geometry flatten complete') }
      return
    }
    const working = trade.exits.find(l => l.reason === 'invalid_geometry' && l.orderId != null && l.fillPrice == null)
    if (working) { await this.reconcileExits(trade); return }
    const prices = await this.getPrices([trade.symbol]).catch(() => new Map<string, number>())
    const price = prices.get(trade.symbol) ?? trade.entryFillPrice ?? trade.initialStop
    const leg: ExitLeg = {
      qty: 0, orderedQty: trade.openQty, reason: 'invalid_geometry', intendedPrice: price, decisionPrice: price,
      orderId: null, fillPrice: null, filledAt: null, slippagePct: null,
    }
    const order = await this.broker.submitLimit({
      symbol: trade.symbol, qty: trade.openQty, side: 'sell',
      limitPrice: exitLimitPrice(price, this.config.exitSlipTolerancePct),
      extendedHours: getSessionType(now) !== 'regular',
      clientOrderId: `${trade.id}:invalidflat:${Math.floor(now / 1000)}`,
    })
    if (order.status === 'rejected') { this.touch(trade, `invalid-geometry flatten rejected: ${order.rejectReason}`); return }
    leg.orderId = order.id
    trade.exits.push(leg)
    await this.reconcileExits(trade)
  }

  /** Settle working exit legs and the protective stop against the broker. */
  private async reconcileExits(trade: PaperTrade): Promise<void> {
    for (const leg of trade.exits) {
      // Keep polling a leg while its order is still live — NOT only until the first
      // partial. A stop that fills 88 then 532 (cumulative) must have all 532 booked;
      // stopping at the first partial (the ZETA/BIAF defect) stranded the residual
      // (it belonged to the same order, so bookExternalClose excluded it as "ours").
      if (!leg.orderId) continue
      const order = await this.broker.getOrder(leg.orderId)
      if (!order) continue
      // Broker is authoritative for the ordered quantity too — keep orderedQty in sync so the
      // still-working reservation (orderedQty − filled) is correct, incl. for legacy legs
      // loaded without it. `order.qty` is a required broker numeric (fails closed if malformed).
      if (order.qty > 0) leg.orderedQty = order.qty
      if (order.filledQty > 0 && order.filledAvgPrice != null) {
        // filledQty is CUMULATIVE — bookExitFill books only the increment.
        this.bookExitFill(trade, leg, order.filledQty, order.filledAvgPrice)
      }
      if (isTerminalOrder(order.status)) {
        // No further fills possible — stop polling this leg. A leg that never filled
        // is dropped below so the level can re-trigger.
        leg.orderId = null
        if (order.filledQty <= 0) this.touch(trade, `exit leg ${leg.reason} ${order.status}, will retry`)
      }
    }

    if (trade.protectiveStopOrderId) {
      const stopOrder = await this.broker.getOrder(trade.protectiveStopOrderId)
      if (stopOrder && stopOrder.filledQty > 0 && stopOrder.filledAvgPrice != null) {
        const leg: ExitLeg = {
          // A broker-side stop fires without us observing a price, so there is no
          // decision price — the gap/concession split doesn't apply to this path.
          qty: 0, orderedQty: stopOrder.qty, reason: 'stop', intendedPrice: trade.currentStop,
          decisionPrice: null,
          orderId: stopOrder.id, fillPrice: null, filledAt: null, slippagePct: null,
        }
        trade.exits.push(leg)
        // Hand the stop leg to the main loop for any further cumulative fills; clear the
        // protective handle so it is not double-counted by both paths.
        trade.protectiveStopOrderId = null
        this.bookExitFill(trade, leg, stopOrder.filledQty, stopOrder.filledAvgPrice)
        if (isTerminalOrder(stopOrder.status)) leg.orderId = null
      } else if (stopOrder && isTerminalOrder(stopOrder.status)) {
        trade.protectiveStopOrderId = null
      }
    }

    trade.exits = trade.exits.filter(l => l.fillPrice != null || l.orderId != null)
    if (trade.openQty <= 0) this.closeTrade(trade)
  }

  /**
   * Book a broker order's fill into an exit leg. `cumQty`/`cumAvgPrice` are the order's
   * CUMULATIVE filled quantity and average price. Only the INCREMENT over what this leg
   * already recorded is applied to openQty and emitted, so repeated polls of a cumulative
   * `filledQty` (88 → 200 → 532 means 532 total, not 88+200+532) never double-count, and a
   * flat cumulative (88, 88, 88) books nothing new.
   */
  private bookExitFill(trade: PaperTrade, leg: ExitLeg, cumQty: number, cumAvgPrice: number): void {
    const prevQty = leg.fillPrice != null ? leg.qty : 0
    const increment = cumQty - prevQty
    // Ignore a flat or (out-of-order) lower cumulative — never let leg.qty regress, and
    // never book negative shares. Only a genuine increase updates the leg.
    if (increment <= 0) return
    // The leg reflects the broker's latest cumulative (qty, average price), so
    // computeRealized (Σ (fillPrice−entry)·qty) stays exact as the order fills.
    leg.qty = cumQty
    leg.fillPrice = cumAvgPrice
    leg.filledAt = Date.now()
    leg.slippagePct = slippagePct(leg.intendedPrice, cumAvgPrice)
    trade.openQty = Math.max(0, trade.openQty - increment)
    if (leg.reason === 't1' && !trade.t1Done) {
      trade.t1Done = true
      // Breakeven stop on the remainder — matches the resolver's ladder exactly.
      if (trade.entryFillPrice != null) trade.currentStop = trade.entryFillPrice
    }
    this.touch(trade)
    this.log(
      `EXIT ${trade.symbol} ${increment} sh @ ${cumAvgPrice.toFixed(4)} (${leg.reason}, ` +
      `level ${leg.intendedPrice.toFixed(4)}, slip ${leg.slippagePct == null ? '—' : `${leg.slippagePct.toFixed(2)}%`}) ` +
      `· ${trade.openQty} left`,
    )
    appendEvent({
      event: 'exit_filled', symbol: trade.symbol, tradeId: trade.id, reason: leg.reason,
      qty: increment, cumulativeQty: cumQty, fillPrice: cumAvgPrice, intendedPrice: leg.intendedPrice, slippagePct: leg.slippagePct,
      decisionPrice: leg.decisionPrice,
      // The actionable split: gap is latency (poll faster), concession is the limit tolerance.
      gapPct: leg.decisionPrice != null ? slippagePct(leg.intendedPrice, leg.decisionPrice) : null,
      concessionPct: leg.decisionPrice != null ? slippagePct(leg.decisionPrice, cumAvgPrice) : null,
      openQtyAfter: trade.openQty,
    })
    if (trade.openQty <= 0) this.closeTrade(trade)
  }

  /**
   * Price the shares an EXTERNAL order closed (dashboard flatten, broker
   * liquidation) from the broker's own fill ledger, so realized P&L reconciles
   * instead of being lost as null. Books one synthetic `external` exit leg for the
   * unaccounted remainder at the volume-weighted price of the sell fills that did
   * NOT come from our own legs. Accounting only — it places no order and changes no
   * exit decision; the trade stays `manual_review` and out of learning.
   */
  private async bookExternalClose(trade: PaperTrade): Promise<void> {
    const remainder = trade.openQty
    if (remainder <= 0 || !this.broker.getRecentFills) return
    const since = trade.entryFilledAt ?? trade.entrySubmittedAt ?? trade.createdAt
    const fills = await this.broker.getRecentFills(trade.symbol, since)
    // Fills already accounted for by our own legs (and the resting stop) must not be
    // double-counted; anything left is the external close.
    const ours = new Set<string>()
    for (const leg of trade.exits) if (leg.orderId) ours.add(leg.orderId)
    if (trade.protectiveStopOrderId) ours.add(trade.protectiveStopOrderId)
    const external = fills.filter(f => f.side === 'sell' && f.qty > 0 && !(f.orderId && ours.has(f.orderId)))
    const extQty = external.reduce((s, f) => s + f.qty, 0)
    if (extQty <= 0) return
    const qty = Math.min(remainder, extQty)
    const vwap = external.reduce((s, f) => s + f.price * f.qty, 0) / extQty
    const leg: ExitLeg = {
      qty, orderedQty: qty, reason: 'external', intendedPrice: trade.currentStop, decisionPrice: null,
      orderId: null, fillPrice: vwap, filledAt: external[external.length - 1]?.filledAt ?? Date.now(),
      slippagePct: null,
    }
    trade.exits.push(leg)
    trade.openQty = Math.max(0, trade.openQty - qty)
    appendEvent({
      event: 'external_close_priced', symbol: trade.symbol, tradeId: trade.id,
      qty, vwap, extFills: external.length,
    })
    this.log(`EXTERNAL CLOSE ${trade.symbol} ${qty} sh @ ${vwap.toFixed(4)} (${external.length} broker fills) — priced for reporting, kept in manual_review`)
  }

  private closeTrade(trade: PaperTrade): void {
    // fullyClosed means LOCALLY FLAT (openQty 0), regardless of which leg did it.
    trade.state = 'closed'
    trade.fullyClosed = trade.openQty <= 0
    // IDEMPOTENT TERMINAL ACCOUNTING. Repeated close/reconcile/tick paths must not
    // emit a second `trade_closed` nor re-book P&L. computeRealized is always run so
    // the trade object stays exact if more legs were incorporated before this call,
    // but the terminal EVENT fires exactly once per close episode.
    const realized = computeRealized(trade)
    trade.realizedPnl = realized?.pnl ?? null
    trade.realizedPnlPct = realized?.pnlPct ?? null
    if (trade.terminalBooked) { this.touch(trade); return }
    trade.terminalBooked = true
    trade.closeCount = (trade.closeCount ?? 0) + 1
    this.touch(trade)
    this.log(
      `CLOSED ${trade.symbol} · P&L ${trade.realizedPnl == null ? '—' : `$${trade.realizedPnl.toFixed(2)}`} ` +
      `(${trade.realizedPnlPct == null ? '—' : `${trade.realizedPnlPct.toFixed(2)}%`})`,
    )
    appendEvent({
      event: 'trade_closed', symbol: trade.symbol, setupId: trade.setupId, tradeId: trade.id,
      realizedPnl: trade.realizedPnl, realizedPnlPct: trade.realizedPnlPct,
      entrySlippagePct: trade.entrySlippagePct, fullyClosed: trade.fullyClosed,
      // >1 marks a re-close after a late-fill reopen — never a silent duplicate.
      closeCount: trade.closeCount,
      legs: trade.exits.map(l => ({ reason: l.reason, qty: l.qty, fill: l.fillPrice, slip: l.slippagePct })),
    })
  }

  /**
   * Broker-authoritative reconciliation — Alpaca is the fact, local state is only
   * intent. Returns the broker's position qty. The single place local qty is
   * allowed to be overwritten. Cheap in the common case (one getPosition, compare);
   * the corrective branches fire only on a real disagreement.
   */
  private async reconcile(trade: PaperTrade, now: number = Date.now()): Promise<number> {
    let brokerQty: number
    try {
      const pos = await this.broker.getPosition(trade.symbol)
      brokerQty = pos?.qty ?? 0
    } catch (e) {
      // Can't reach broker truth → do NOT act on a guess; leave state untouched.
      this.log(`reconcile: broker query failed ${trade.symbol}: ${(e as Error).message}`)
      return trade.openQty
    }
    trade.brokerVerifiedQty = brokerQty
    trade.lastReconciledAt = now
    const localQty = trade.openQty

    // FAIL-CLOSED RESIDUAL RECOVERY. A locally-CLOSED execution trade whose broker
    // truth still shows exposure AND whose planned risk is non-positive (invalid
    // post-fill geometry) must NEVER stay closed/invisible — that is the late-fill-
    // after-close stranding from the 2971c26 review. Promote it back to an explicitly
    // invalid OPEN state so openTrades() sees it (the risk backstop then fails closed)
    // and the next tick's manageOpen invalid-geometry guard flattens it via the
    // existing unwind. Placed BEFORE the equality check on purpose: a restart that
    // rehydrates {closed, discrepancy, openQty=100, plannedRisk<=0} against a broker
    // that also holds 100 has brokerQty === localQty, which a mismatch-only fix misses.
    if (brokerQty > 0 && trade.state === 'closed' && !(trade.plannedRisk > 0)) {
      const priorState = trade.state
      const priorStatus = trade.reconciliationStatus
      trade.openQty = brokerQty
      trade.state = 'open'
      trade.reconciliationStatus = 'discrepancy'
      // Genuinely reopened by a late broker fill → this is a new close episode; allow
      // terminal accounting to book again when it is re-flattened.
      trade.terminalBooked = false
      const warn = `invalid-geometry residual: broker holds ${brokerQty} on a closed trade (plannedRisk ${trade.plannedRisk}) — reopening to flatten`
      trade.executionWarnings.push(warn)
      this.touch(trade, warn)
      appendEvent({
        event: 'invalid_geometry_residual_recovered',
        symbol: trade.symbol, setupId: trade.setupId, tradeId: trade.id,
        brokerQty, priorState, plannedRisk: trade.plannedRisk, reconciliationStatus: priorStatus,
      })
      return brokerQty
    }

    // FAIL CLOSED on an ENTRY-BASIS GAP (P1-002). The broker position holds MORE shares than
    // the ENTRY ORDER ever accounted for, and that order is terminal — so there is no order
    // truth left to reconstruct the cost basis of the extra shares. NEVER fabricate a basis
    // from position quantity: record the exposure for the risk backstop, quarantine the trade
    // (manual_review), and block new entries until a human reconciles it. If the entry order
    // is NOT yet terminal, this is deferred — reconcileEntry folds the order's cumulative fills
    // first, so a transient position>entry lag never trips this.
    if (brokerQty > trade.entryFillQty && trade.entryOrderTerminal) {
      const warn = `entry basis gap: broker holds ${brokerQty} but entry order accounted only ${trade.entryFillQty} — cost basis unreconstructable`
      if (!trade.executionWarnings.includes(warn)) {
        trade.executionWarnings.push(warn)
        this.touch(trade, warn)
        appendEvent({
          event: 'entry_basis_unreconstructable', symbol: trade.symbol, setupId: trade.setupId, tradeId: trade.id,
          brokerQty, entryFillQty: trade.entryFillQty,
        })
      }
      trade.openQty = brokerQty            // exposure is known — surface it to the risk backstop
      trade.reconciliationStatus = 'manual_review'
      this.reconciliationUnresolved = true // fail closed: no new entries until reconciled
      return brokerQty
    }

    if (brokerQty === localQty) {
      // Broker agrees. Promote a finished trade to verified — the only path into
      // the research/learning dataset (see verifiedClosedTrades). A prior `discrepancy`
      // is NOT sticky: once broker truth agrees with the (now fully-accounted) local
      // ledger, it resolves to verified. `manual_review` stays put — its P&L is flagged
      // unreconstructable and needs a human, not an automatic promotion.
      if (trade.state === 'closed' && (trade.reconciliationStatus === 'pending' || trade.reconciliationStatus === 'discrepancy')) {
        trade.reconciliationStatus = 'verified'
      }
      return brokerQty
    }

    if (brokerQty === 0 && localQty > 0) {
      // We believe we hold; the broker is flat. Settle our own working legs first
      // in case one of ours just filled — that turns this into a clean close.
      await this.reconcileExits(trade).catch(() => {})
      if (trade.openQty > 0) {
        // Still unaccounted → closed by an unrecorded or EXTERNAL order (FIGR
        // 2026-08-17; EL/FSM 2026-08-19). Force flat on broker truth. The trade is
        // still quarantined from learning (manual_review), but its P&L is NOT lost:
        // we price the closed remainder from the broker's own fills so the daily
        // $/R report is correct. On 2026-08-19 the naive path booked EL/FSM as $0
        // and understated the session by ~$885. Only if the broker can't report its
        // fills (no getRecentFills, or none found) does P&L stay unreconstructed.
        const warn = `broker flat but local held ${trade.openQty} — closed by an unrecorded/external order`
        trade.executionWarnings.push(warn)
        this.touch(trade, warn)
        appendEvent({ event: 'reconcile_forced_flat', symbol: trade.symbol, tradeId: trade.id, localQty: trade.openQty, brokerQty: 0 })
        await this.bookExternalClose(trade).catch(e => this.log(`external-close pricing failed ${trade.symbol}: ${(e as Error).message}`))
        trade.openQty = 0
        trade.reconciliationStatus = 'manual_review'
        this.closeTrade(trade)
      }
      await this.broker.cancelOpenOrders(trade.symbol).catch(() => {})
      trade.protectiveStopOrderId = null
      return 0
    }

    // Both nonzero but different (e.g. a partial fill we under-recorded, CAPR
    // 2026-08-17) → adopt broker qty, flag the discrepancy.
    const warn = `qty mismatch: local ${localQty}, broker ${brokerQty} — adopting broker`
    trade.executionWarnings.push(warn)
    trade.openQty = brokerQty
    trade.reconciliationStatus = 'discrepancy'
    this.touch(trade, warn)
    appendEvent({ event: 'reconcile_qty_mismatch', symbol: trade.symbol, tradeId: trade.id, localQty, brokerQty })
    if (brokerQty <= 0) this.closeTrade(trade)
    return brokerQty
  }

  private async manageOpen(trade: PaperTrade, price: number, etMinute: number, now: number): Promise<void> {
    // FAIL CLOSED: an open trade with non-positive planned risk is an invariant
    // violation (post-fill stop inversion). Do NOT run normal exit management on it —
    // unwind it via the invalid-geometry flatten instead. A valid fill always has
    // plannedRisk > 0, so this never touches a legitimate position.
    if (!(trade.plannedRisk > 0)) { await this.flattenFilledQty(trade, now); return }
    // BROKER TRUTH FIRST. Never manage a position the broker no longer shows, and
    // never size an exit off a local qty the broker disagrees with. reconcile may
    // close the trade outright (e.g. FIGR closed externally on 2026-08-17).
    const brokerQty = await this.reconcile(trade, now)
    if (trade.state !== 'open' || brokerQty <= 0) return

    const decision = decideExit(trade, price, etMinute, this.config.flattenEtMinute)

    if (!decision) {
      await this.ensureProtectiveStop(trade, now)
      return
    }
    // An exit leg for this reason is already working — don't stack duplicates.
    if (trade.exits.some(l => l.reason === decision.reason && l.fillPrice == null && l.orderId)) return

    // Cancel everything resting first: a live protective stop and a fresh sell
    // would together try to sell more shares than we hold.
    await this.broker.cancelOpenOrders(trade.symbol)
    trade.protectiveStopOrderId = null

    // Sell no more than the broker actually holds (openQty is broker-verified above).
    const sellQty = Math.min(decision.qty, trade.openQty)
    if (sellQty <= 0) return

    const session = getSessionType(now)
    const limit = exitLimitPrice(Math.min(price, decision.intendedPrice), this.config.exitSlipTolerancePct)
    const leg: ExitLeg = {
      qty: 0, orderedQty: sellQty, reason: decision.reason, intendedPrice: decision.intendedPrice,
      decisionPrice: price,
      orderId: null, fillPrice: null, filledAt: null, slippagePct: null,
    }

    const order = await this.broker.submitLimit({
      symbol: trade.symbol,
      qty: sellQty,
      side: 'sell',
      limitPrice: limit,
      extendedHours: session === 'premarket' || session === 'afterhours',
      clientOrderId: `${trade.id}:x:${decision.reason}:${Math.floor(now / 1000)}`,
    })

    if (order.status === 'rejected') {
      this.touch(trade, `exit ${decision.reason} rejected: ${order.rejectReason ?? 'unknown'}`)
      this.log(`EXIT REJECT ${trade.symbol} (${decision.reason}): ${order.rejectReason}`)
      appendEvent({ event: 'exit_rejected', symbol: trade.symbol, tradeId: trade.id, reason: decision.reason, detail: order.rejectReason })
      // A qty/short rejection means our local state is ahead of the broker — the
      // position is smaller or already flat. Reconcile rather than retrying blind.
      if (isQtyOrShortRejection(order.rejectReason)) await this.reconcile(trade, now)
      return
    }

    leg.orderId = order.id
    trade.exits.push(leg)
    this.touch(trade)
    this.log(`EXIT ORDER ${trade.symbol} ${decision.qty} sh (${decision.reason}) @ ≥${limit.toFixed(4)} — price ${price.toFixed(4)}`)
    appendEvent({
      event: 'exit_submitted', symbol: trade.symbol, tradeId: trade.id, reason: decision.reason,
      qty: decision.qty, limitPrice: limit, triggerPrice: price, intendedPrice: decision.intendedPrice,
    })

    // Fills on a marketable limit are usually immediate; settling now keeps the
    // ladder moving within one tick rather than waiting for the next sweep.
    await this.reconcileExits(trade)
  }

  /**
   * Keep a resting broker stop under the position during regular hours, so a
   * crashed daemon leaves a covered position rather than a naked one. Replaced
   * whenever the stop level or share count changes (i.e. after T1).
   *
   * Sized to the shares NOT already reserved by a working exit leg. Asking for
   * the full `openQty` while a T1 limit rests on half of it is rejected outright
   * ("insufficient qty available"), which used to leave the runner with no
   * resting stop at all — exactly the case this exists to cover.
   */
  private async ensureProtectiveStop(trade: PaperTrade, now: number): Promise<void> {
    if (getSessionType(now) !== 'regular') return   // Alpaca rejects stops outside RTH
    if (trade.openQty <= 0) return

    const coverQty = trade.openQty - workingExitQty(trade)

    if (trade.protectiveStopOrderId) {
      const existing = await this.broker.getOrder(trade.protectiveStopOrderId)
      // Anything not still working is replaced: a canceled stop that happens to
      // match on size would otherwise be left standing as phantom cover.
      const good = existing && existing.status === 'open' && existing.qty === coverQty
      if (good) return
      await this.broker.cancelOrder(trade.protectiveStopOrderId)
      trade.protectiveStopOrderId = null
    }

    // Every open share is working an exit leg — covered by that limit, not by a stop.
    if (coverQty <= 0) return

    const order = await this.broker.submitStop({
      symbol: trade.symbol,
      qty: coverQty,
      stopPrice: trade.currentStop,
      clientOrderId: `${trade.id}:stop:${Math.floor(now / 1000)}`,
    })
    if (order.status === 'rejected') {
      this.touch(trade, `protective stop rejected: ${order.rejectReason ?? 'unknown'}`)
      // Two causes, both handled by asking the broker rather than re-submitting an
      // impossible stop: price already crossed the stop, or the position is flat/
      // smaller than we think. If still long, decideExit will fire a marketable
      // exit on the next tick (the WOK path); if flat, reconcile closes the trade.
      if (isQtyOrShortRejection(order.rejectReason)) await this.reconcile(trade, now)
      return
    }
    trade.protectiveStopOrderId = order.id
    this.touch(trade)
    appendEvent({
      event: 'protective_stop', symbol: trade.symbol, tradeId: trade.id,
      qty: coverQty, stopPrice: trade.currentStop, orderId: order.id,
    })
  }

  /**
   * Cancel everything and flatten — the kill switch and the flatten primitive used by
   * graceful shutdown. Handles PENDING ENTRIES FIRST (P0-003): a working entry order is
   * cancelled and settled against FRESH broker truth before any confirmed open exposure is
   * flattened, so a still-working entry is never left live and a fill that races the cancel
   * is booked (then flattened as open exposure), never disowned. A pending entry that cannot
   * be reduced to terminal broker truth sets reconciliationUnresolved — shutdown() reads
   * that to refuse a clean/authority-releasing exit.
   */
  async flattenAll(reason: ExitReason = 'risk_halt'): Promise<void> {
    // 1–5. Pending entries: cancel the working order, settle broker truth, book any raced fill.
    const pending = this.trades.filter(t => t.state === 'pending_entry')
    for (const trade of pending) {
      try {
        const outcome = await this.settleCanceledEntry(trade, Date.now(), SHUTDOWN_SETTLEMENT_POLLS)
        if (outcome === 'terminal_unfilled') {
          // Broker confirmed the entry terminal with zero fill — clean abort of the pending entry.
          trade.state = 'aborted'
          this.touch(trade, 'flatten: pending entry aborted (broker confirms no fill)')
          appendEvent({ event: 'entry_aborted', symbol: trade.symbol, tradeId: trade.id, status: 'canceled', reason: 'shutdown_flatten' })
        } else if (outcome === 'unresolved') {
          // Could not reduce to terminal broker truth — fail closed so shutdown() won't release authority.
          this.reconciliationUnresolved = true
          this.touch(trade, 'flatten: pending entry unresolved — broker truth not terminal')
          appendEvent({ event: 'flatten_pending_unresolved', symbol: trade.symbol, tradeId: trade.id })
        }
        // 'filled' → bookEntryFill already promoted it to open/managed; flattened below.
      } catch (e) {
        this.reconciliationUnresolved = true
        this.log(`flatten pending failed ${trade.symbol}: ${(e as Error).message}`)
      }
      // Stamp broker truth on the settled trade (aborted → confirm flat; filled → confirm qty).
      try { await this.reconcile(trade, Date.now()) } catch { this.reconciliationUnresolved = true }
    }

    // 6–7. Flatten confirmed open exposure (including anything a raced fill just promoted to open).
    const holding = this.trades.filter(t => t.state === 'open' && t.openQty > 0)
    for (const trade of holding) {
      try {
        await this.broker.cancelOpenOrders(trade.symbol)
        trade.protectiveStopOrderId = null
        // Broker truth before flattening — don't sell a position already closed.
        const brokerQty = await this.reconcile(trade, Date.now())
        if (trade.state !== 'open' || brokerQty <= 0) continue
        const prices = await this.getPrices([trade.symbol])
        const price = prices.get(trade.symbol)
        if (price == null) { this.touch(trade, 'flatten: no price'); continue }
        const flatQty = Math.min(trade.openQty, brokerQty)
        const leg: ExitLeg = {
          qty: 0, orderedQty: flatQty, reason, intendedPrice: price, decisionPrice: price,
          orderId: null, fillPrice: null, filledAt: null, slippagePct: null,
        }
        const order = await this.broker.submitLimit({
          symbol: trade.symbol, qty: flatQty, side: 'sell',
          limitPrice: exitLimitPrice(price, this.config.exitSlipTolerancePct),
          extendedHours: getSessionType() !== 'regular',
          clientOrderId: `${trade.id}:flat:${Math.floor(Date.now() / 1000)}`,
        })
        if (order.status === 'rejected') {
          this.touch(trade, `flatten rejected: ${order.rejectReason}`)
          if (isQtyOrShortRejection(order.rejectReason)) await this.reconcile(trade, Date.now())
          continue
        }
        leg.orderId = order.id
        trade.exits.push(leg)
        await this.reconcileExits(trade)
      } catch (e) {
        this.log(`flatten failed ${trade.symbol}: ${(e as Error).message}`)
      }
    }
    this.persist()
  }

  /**
   * GRACEFUL SHUTDOWN — the explicit, ordered exit sequence (P0-003 / F).
   *
   *   1. close execution admission (no new entries can be admitted from here on)
   *   2–5. cancel + settle every pending entry against fresh broker truth (book any raced fill)
   *   6–7. flatten confirmed open exposure and reconcile
   *   8. classify the result SAFE or UNRESOLVED
   *   9. release execution authority ONLY on SAFE
   *
   * SAFE requires all of: no pending entries left, no local open exposure left, the broker
   * confirmed flat for every symbol we touched, and no reconciliation left unresolved. If
   * ANY of those fail, the shutdown is UNRESOLVED: the authority marker is retained, the
   * caller must NOT report a clean shutdown, and the process must NOT exit 0.
   */
  async shutdown(): Promise<{ safe: boolean; reason: string | null }> {
    this.shuttingDown = true // 1. admission closed (fail-closed for any concurrent onSignal)

    // 2–7. Pending entries first, then confirmed open exposure (flattenAll enforces that order).
    await this.flattenAll('risk_halt')

    // 8. Classify. Local truth first…
    const stillPending = this.trades.some(t => t.state === 'pending_entry')
    const stillOpen = this.trades.some(t => t.state === 'open' && t.openQty > 0)

    // …then BROKER truth: confirm flat for every symbol this session touched. A position we
    // still see, or a broker we cannot query, is unresolved — never assume broker-flat.
    let brokerResidual = false
    const symbols = [...new Set(this.trades.map(t => t.symbol))]
    for (const sym of symbols) {
      try {
        const pos = await this.broker.getPosition(sym)
        if (pos && pos.qty > 0) brokerResidual = true
      } catch {
        brokerResidual = true // cannot confirm flat → fail closed
      }
    }

    const safe = !this.reconciliationUnresolved && !stillPending && !stillOpen && !brokerResidual
    if (safe) {
      // 9. Release authority only now that exposure is proven resolved.
      this.releaseAuthority()
      appendEvent({ event: 'shutdown_complete', broker: this.broker.name, safe: true })
      this.log('SHUTDOWN SAFE — exposure reconciled, execution authority released')
      this.persist()
      return { safe: true, reason: null }
    }

    const reason =
      `shutdown UNRESOLVED — ` +
      `reconciliationUnresolved=${this.reconciliationUnresolved} pendingLeft=${stillPending} ` +
      `openLeft=${stillOpen} brokerResidual=${brokerResidual}`
    appendEvent({
      event: 'shutdown_unresolved', broker: this.broker.name, safe: false,
      reconciliationUnresolved: this.reconciliationUnresolved, stillPending, stillOpen, brokerResidual,
    })
    this.log('╔════════════════════════════════════════════════════════════════════╗')
    this.log('  SHUTDOWN UNRESOLVED — authority marker RETAINED (not released)')
    this.log(`  ${reason}`)
    this.log('  A working entry or unreconciled exposure may remain at the broker.')
    this.log('  Do NOT start another paper daemon until this is reconciled by hand.')
    this.log('╚════════════════════════════════════════════════════════════════════╝')
    this.persist()
    return { safe: false, reason }
  }

  /** One-line end-of-session summary — the numbers paper trading exists to produce. */
  summary(): string {
    // Scope every count to the current ET session — `this.trades` can hold prior
    // days (midnight rollover / restart rehydration); see todaysTrades.
    const today = this.todaysTrades()
    const closed = this.closedToday()
    // A closed trade with no reconstructable realizedPnl (e.g. FIGR 2026-08-17:
    // flattened by an EXTERNAL order the daemon never saw → manual_review, P&L
    // null) is NOT a scoreable result. Counting it would tally a phantom loss and
    // dilute the win rate. Score only trades whose P&L is known; report the rest
    // as `unreconciled`, never as W/L.
    const scored = closed.filter(t => t.realizedPnl != null)
    const unreconciled = closed.length - scored.length
    const filled = today.filter(t => t.entryFillPrice != null)
    const aborted = today.filter(t => t.state === 'aborted')
    const pnl = scored.reduce((s, t) => s + (t.realizedPnl ?? 0), 0)
    const wins = scored.filter(t => (t.realizedPnl ?? 0) > 0).length
    const entrySlips = filled.map(t => t.entrySlippagePct).filter((n): n is number => n != null)
    const exitSlips = today.flatMap(t => t.exits.map(l => l.slippagePct)).filter((n): n is number => n != null)
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
    const fmt = (n: number | null) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
    // Split exit slippage into what we can fix by polling faster (gap) vs what the
    // limit tolerance costs (concession). On 2026-08-10 that was −2.35% / −0.50%.
    const legs = today.flatMap(t => t.exits).filter(l => l.fillPrice != null && l.decisionPrice != null)
    const gaps = legs.map(l => slippagePct(l.intendedPrice, l.decisionPrice!)).filter((n): n is number => n != null)
    const concessions = legs.map(l => slippagePct(l.decisionPrice!, l.fillPrice!)).filter((n): n is number => n != null)
    // Reconciliation split — only `verified` closes are trustworthy evidence.
    const byStatus = (s: PaperTrade['reconciliationStatus']) => closed.filter(t => t.reconciliationStatus === s).length
    const flagged = today.filter(t => t.executionWarnings.length > 0)
    return [
      `signals→trades: ${today.length} considered, ${filled.length} filled, ${aborted.length} never filled`,
      `closed ${scored.length} · ${wins}W/${scored.length - wins}L · P&L $${pnl.toFixed(2)}` +
        (unreconciled ? ` · ${unreconciled} unreconciled (P&L unrecoverable, excluded)` : ''),
      `reconciliation — verified ${byStatus('verified')} · discrepancy ${byStatus('discrepancy')} · manual_review ${byStatus('manual_review')} · pending ${byStatus('pending')}`,
      flagged.length ? `  ⚠ ${flagged.length} trade(s) with execution warnings: ${flagged.map(t => t.symbol).join(', ')}` : `  no execution warnings`,
      `mean entry slip ${fmt(mean(entrySlips))} · mean exit slip ${fmt(mean(exitSlips))}`,
      `  exit slip split — market gap ${fmt(mean(gaps))} (latency) · concession ${fmt(mean(concessions))} (limit tolerance)`,
    ].join('\n')
  }
}
