/**
 * Paper-trade persistence.
 *
 * Two files, mirroring how the alert daemon already keeps state:
 *   • a per-ET-day snapshot of every trade (rewritten in place) — this is what a
 *     restart reloads, so a daemon crash mid-position doesn't orphan the trade
 *   • an append-only JSONL event log — the audit trail, never rewritten, so
 *     "what did it actually do at 09:31?" is answerable from disk
 *
 * Node-only (fs). Never import from a client component.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { PaperTrade, ExitLeg } from './types'

/** ET day key — the trading day, not the local calendar day. */
export function etDayKey(ts: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts))
}

export function tradesFile(day = etDayKey()): string {
  return join(homedir(), `.companion-paper-trades-${day}.json`)
}

export function eventsFile(day = etDayKey()): string {
  return join(homedir(), `.companion-paper-events-${day}.jsonl`)
}

/**
 * The daemon's decision-audit file for an ET trading day. Call with the DECISION's
 * timestamp (`decisionsFile(etDayKey(now))`) at APPEND time, never once at startup:
 * a daemon running continuously across ET midnight must roll to the new day's file
 * on its own. The default binds to "now", so a call with no argument still rotates.
 */
export function decisionsFile(day = etDayKey()): string {
  return join(homedir(), `.companion-decisions-${day}.jsonl`)
}

/**
 * Per-sweep arbitration-snapshot audit file (one JSONL record per sweep that had
 * ≥1 Stage-1-eligible long). OBSERVATIONAL ONLY — nothing reads it back into a
 * decision. Same ET-trading-day rotation rule as decisionsFile: pass the sweep's
 * own timestamp at append time so a continuously-running daemon rolls at ET midnight.
 */
export function arbitrationFile(day = etDayKey()): string {
  return join(homedir(), `.companion-arbitration-${day}.jsonl`)
}

/** Operator kill switch: `touch ~/.companion-halt` stops all new entries. */
export function haltFile(): string {
  return join(homedir(), '.companion-halt')
}

export function isHalted(): boolean {
  return process.env.HALT === '1' || existsSync(haltFile())
}

// A trade persisted by an earlier build can be missing collection fields added
// since (executionWarnings landed after FIGR opened 2026-08-17). Hydrating them as
// undefined makes the first `.push` in manage/reconcile throw ("Cannot read
// properties of undefined (reading 'push')"), and because it's caught per-trade
// that position is then silently skipped every tick and never recovers. Default
// every collection on load so no future field addition can strand an open trade.
function normalizeTrade(t: PaperTrade): PaperTrade {
  return {
    ...t,
    // Legacy ExitLeg records predate `orderedQty` (P1-003). Migrate WITHOUT fabricating an
    // unsafe quantity: for an unfilled leg the legacy `qty` was the ORDERED amount, so map it
    // to orderedQty and set filled `qty` to 0 (fully reserved). For a leg with a fill booked
    // we cannot know the original order size, so seed orderedQty from the booked qty; any
    // still-working leg has its orderedQty corrected from broker truth (order.qty) on the next
    // reconcileExits — never inferred unsafely here.
    exits: (t.exits ?? []).map(l => {
      if (typeof (l as Partial<ExitLeg>).orderedQty === 'number') return l
      const filled = l.fillPrice != null ? l.qty : 0
      return { ...l, orderedQty: l.qty, qty: filled }
    }),
    notes: t.notes ?? [],
    executionWarnings: t.executionWarnings ?? [],
    targets: t.targets ?? [],
    // Older records predate reconciliation; default to 'pending' so the reconcile
    // loop actually picks them up (FIGR hydrated with a null status and would
    // otherwise never promote to verified or force-flat).
    reconciliationStatus: t.reconciliationStatus ?? 'pending',
    // Legacy records predate entry-order lifecycle tracking (P1-002). A terminal trade's
    // entry order is done; an active trade re-establishes truth from the broker on next tick.
    entryOrderTerminal: t.entryOrderTerminal ?? (t.state === 'closed' || t.state === 'aborted'),
  }
}

/**
 * Records that belong to ET trading `day` (by signal-creation), PLUS any trade
 * still ACTIVE regardless of day so a position opened before an ET-midnight
 * rollover stays managed to flat.
 *
 * A per-ET-day file/report must never mix sessions. On 2026-08-18 it did: the
 * daemon's in-memory list carried Monday's TERMINAL trades across the ET-midnight
 * rollover and a mid-morning restart rehydrated them from the (already
 * contaminated) Tuesday file, so Monday's closed STFS (+$1,782, broker-verified)
 * surfaced in Tuesday's summary, skewed the daily loss-limit math, and would have
 * passed the learning gate. `createdAt` is the signal-creation instant, so its ET
 * day is the trade's true session — the authority for which file/report it belongs
 * to. Only closed/aborted trades from OTHER days are dropped; today's stay, and
 * open/pending stay for management. This self-heals the file on the next save.
 */
export function scopeToTradingDay(trades: PaperTrade[], day = etDayKey()): PaperTrade[] {
  return trades.filter(
    t => etDayKey(t.createdAt) === day || t.state === 'pending_entry' || t.state === 'open',
  )
}

export function loadTrades(day = etDayKey()): PaperTrade[] {
  const file = tradesFile(day)
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PaperTrade[]
    return Array.isArray(parsed) ? scopeToTradingDay(parsed.map(normalizeTrade), day) : []
  } catch {
    return []
  }
}

export function saveTrades(trades: PaperTrade[], day = etDayKey()): void {
  try {
    writeFileSync(tradesFile(day), JSON.stringify(scopeToTradingDay(trades, day), null, 2))
  } catch (e) {
    console.error('paper-trade state save failed:', (e as Error).message)
  }
}

export interface TradeEvent {
  ts: string
  event: string
  symbol?: string
  tradeId?: string
  [k: string]: unknown
}

export function appendEvent(event: Omit<TradeEvent, 'ts'>, day = etDayKey()): void {
  try {
    appendFileSync(eventsFile(day), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')
  } catch {
    /* audit trail is best-effort — never let logging kill a trade loop */
  }
}
