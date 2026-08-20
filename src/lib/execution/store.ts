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

import type { PaperTrade } from './types'

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
    exits: t.exits ?? [],
    notes: t.notes ?? [],
    executionWarnings: t.executionWarnings ?? [],
    targets: t.targets ?? [],
    // Older records predate reconciliation; default to 'pending' so the reconcile
    // loop actually picks them up (FIGR hydrated with a null status and would
    // otherwise never promote to verified or force-flat).
    reconciliationStatus: t.reconciliationStatus ?? 'pending',
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
