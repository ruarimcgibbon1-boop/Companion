/**
 * Intraday equity-path engine tests — read-only research reconstruction.
 *
 * Covers the 16 required scenarios (winner/loser/became-green-then-stopped/partial-exit/
 * fragmented fills/overlap/post-peak new loss/open-winner reversal/mixed/never-positive/
 * missing-tape/invalid-risk/frozen-absence/no-silent-fallback/local-vs-broker isolation/
 * terminal-qty-zero) plus a Session-4 regression fixture that asserts STRUCTURE only —
 * never a strategy conclusion.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Candle } from '@/types'
import { etStrToUnixSec } from '@/lib/replay-day'
import {
  buildEquityPath,
  classifyGiveback,
  eqBand,
  etMinuteTimestamp,
  etHHMMStr,
  type BrokerLedger,
  type EquityPathInput,
  type FrozenTradeMeta,
  type LedgerFill,
  type LedgerTrade,
} from '@/lib/research/equity-path'

const DAY = '2026-08-20'
const CLOSE = 16 * 60
const bar = (hhmm: string, o: number, h: number, l: number, c: number): Candle => ({
  time: etStrToUnixSec(`${DAY} ${hhmm}:00`), open: o, high: h, low: l, close: c, volume: 0,
})
const ts = (hhmm: string) => etStrToUnixSec(`${DAY} ${hhmm}:00`) * 1000

interface TradeSpec {
  setupId?: string
  symbol: string
  setupType?: string
  plannedRisk: number | null
  entries: Array<{ hhmm: string; qty: number; price: number; orderId?: string }>
  exits: Array<{ hhmm: string; qty: number; price: number; orderId?: string; reason?: string }>
  tape: Candle[]
  residualQty?: number
}

function fill(side: 'buy' | 'sell', s: { hhmm: string; qty: number; price: number; orderId?: string }, sym: string): LedgerFill {
  return { symbol: sym, side, qty: s.qty, price: s.price, filledAt: ts(s.hhmm), orderId: s.orderId ?? null }
}

function makeInput(specs: TradeSpec[], opts: { maxConc?: number } = {}): EquityPathInput {
  const perTrade: LedgerTrade[] = []
  const tradeMeta = new Map<string, FrozenTradeMeta>()
  const tapes = new Map<string, Candle[]>()
  const exitReasons = new Map<string, string>()
  specs.forEach((sp, i) => {
    const setupId = sp.setupId ?? `${sp.symbol}:setup:${i}`
    const entryFills = sp.entries.map((e) => fill('buy', e, sp.symbol))
    // Real exit fills carry an orderId; the reason is joined by that id. Synthesize one
    // per exit leg (as the daemon does) so the reason reaches the event classifier.
    const exitFills = sp.exits.map((e, j) => {
      const orderId = e.orderId ?? (e.reason ? `oid:${setupId}:x:${j}` : null)
      if (orderId && e.reason) exitReasons.set(orderId, e.reason)
      return fill('sell', { ...e, orderId: orderId ?? undefined }, sp.symbol)
    })
    // avg-cost broker P&L (matches the engine's own reconstruction)
    let qty = 0, cost = 0, realized = 0
    for (const f of [...entryFills, ...exitFills].sort((a, b) => a.filledAt - b.filledAt)) {
      if (f.side === 'buy') { cost = (cost * qty + f.price * f.qty) / (qty + f.qty); qty += f.qty }
      else { realized += (f.price - cost) * f.qty; qty -= f.qty }
    }
    const entryQty = entryFills.reduce((s, f) => s + f.qty, 0)
    const exitQty = exitFills.reduce((s, f) => s + f.qty, 0)
    const brokerR = sp.plannedRisk && sp.plannedRisk > 0 ? realized / sp.plannedRisk : null
    perTrade.push({
      tradeId: `pt:${setupId}`, setupId, symbol: sp.symbol,
      entryFills, exitFills, entryQty, exitQty,
      entryVwap: entryQty ? entryFills.reduce((s, f) => s + f.price * f.qty, 0) / entryQty : 0,
      exitVwap: exitQty ? exitFills.reduce((s, f) => s + f.price * f.qty, 0) / exitQty : 0,
      brokerPnl: Math.round(realized * 100) / 100, brokerR, residualQty: sp.residualQty ?? 0, flags: [],
    })
    if (sp.plannedRisk != null) {
      tradeMeta.set(setupId, {
        setupId, symbol: sp.symbol, setupType: sp.setupType ?? 'break_of_structure',
        intendedEntry: sp.entries[0].price, initialStop: sp.entries[0].price - (sp.plannedRisk / (entryQty || 1)),
        plannedRisk: sp.plannedRisk, qty: entryQty,
      })
    }
    tapes.set(sp.symbol, sp.tape)
    for (const e of sp.exits) if (e.orderId && e.reason) exitReasons.set(e.orderId, e.reason)
  })
  const ledger: BrokerLedger = { day: DAY, source: 'test', retrievalComplete: true, perTrade }
  return {
    sessionDate: DAY, ledger, tradeMeta, tapes, exitReasons,
    config: { sessionCloseEtMinute: CLOSE, maxConcurrentPositions: opts.maxConc ?? 3, openingBrokerEquity: 100000 },
    provenance: { producerHead: 'test', input: {}, brokerLedger: {}, tape: {} },
  }
}

// ── 1. simple winner ──────────────────────────────────────────────────────────
describe('1. simple winner', () => {
  it('books a positive broker R and MFE ≥ realized', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'WIN', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:40', qty: 100, price: 110, reason: 't2' }],
      tape: [bar('09:30', 100, 101, 100, 101), bar('09:35', 101, 112, 101, 110), bar('09:40', 110, 111, 108, 110)],
    }]))
    expect(r.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(1000, 1)
    expect(r.portfolioSummary.finalBrokerR).toBeCloseTo(2, 2)
    const t = r.tradeMetrics[0]
    expect(t.brokerRealizedR).toBeCloseTo(2, 2)
    expect(t.maxUnrealizedRBeforeExit!).toBeGreaterThanOrEqual(2)
    expect(t.isLoser).toBe(false)
    expect(r.portfolioSummary.everPositive).toBe(true)
  })
})

// ── 2. simple loser ───────────────────────────────────────────────────────────
describe('2. simple loser', () => {
  it('books a negative broker R', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'LOS', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:40', qty: 100, price: 95, reason: 'stop' }],
      tape: [bar('09:30', 100, 100, 99, 100), bar('09:35', 100, 100, 95, 96), bar('09:40', 96, 96, 94, 95)],
    }]))
    expect(r.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(-500, 1)
    expect(r.tradeMetrics[0].brokerRealizedR).toBeCloseTo(-1, 2)
    expect(r.tradeMetrics[0].isLoser).toBe(true)
  })
})

// ── 3. +1R then stops -1R ─────────────────────────────────────────────────────
describe('3. trade becomes +1R then stops -1R', () => {
  it('records the green MFE and the full MFE→exit giveback', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'REV', plannedRisk: 500, // risk/sh = 5 over 100 sh
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:32', qty: 100, price: 95, reason: 'stop' }],
      tape: [bar('09:30', 100, 100, 100, 100), bar('09:31', 100, 105, 100, 105), bar('09:32', 105, 105, 95, 95)],
    }]))
    const t = r.tradeMetrics[0]
    expect(t.didTradeBecomeGreen).toBe(true)
    expect(t.maxGreenRBeforeStop).toBeCloseTo(1, 2)
    expect(t.brokerRealizedR).toBeCloseTo(-1, 2)
    expect(t.mfeToExitGivebackR).toBeCloseTo(2, 2)
    expect(t.gaveBackMoreThan1R).toBe(true)
    expect(t.gaveBackMoreThan2R).toBe(false)
    expect(t.minutesFromMFEToExit).toBe(1)
  })
})

// ── 4. partial exit then reversal ─────────────────────────────────────────────
describe('4. partial exit then reversal', () => {
  it('reconstructs realized across a partial then a stop on the remainder', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'PAR', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [
        { hhmm: '09:35', qty: 50, price: 110, reason: 't1' },   // +500 on half
        { hhmm: '09:45', qty: 50, price: 95, reason: 'stop' },  // -250 on the rest
      ],
      tape: [bar('09:30', 100, 101, 100, 101), bar('09:35', 101, 111, 101, 110), bar('09:40', 110, 110, 95, 96), bar('09:45', 96, 96, 94, 95)],
    }]))
    // 50*(110-100) + 50*(95-100) = 500 - 250 = 250
    expect(r.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(250, 1)
    const t = r.tradeMetrics[0]
    const t1 = r.events.find((e) => e.eventType === 'T1_EXIT')
    const stop = r.events.find((e) => e.eventType === 'STOP_EXIT')
    expect(t1).toBeTruthy()
    expect(stop).toBeTruthy()
    expect(t.maxUnrealizedDollarBeforeExit!).toBeGreaterThan(0)
  })
})

// ── 5. fragmented broker fills ────────────────────────────────────────────────
describe('5. fragmented broker fills', () => {
  it('uses volume-weighted average cost across multiple entry fills', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'FRG', plannedRisk: 400,
      entries: [
        { hhmm: '09:30', qty: 40, price: 10 },
        { hhmm: '09:30', qty: 40, price: 10.5 },
        { hhmm: '09:31', qty: 20, price: 11 },
      ],
      exits: [{ hhmm: '09:40', qty: 100, price: 12, reason: 't2' }],
      tape: [bar('09:30', 10, 11, 10, 10.5), bar('09:35', 10.5, 12, 10.5, 12), bar('09:40', 12, 12, 11.8, 12)],
    }]))
    // avg cost = (40*10 + 40*10.5 + 20*11)/100 = 10.4 ; pnl = (12-10.4)*100 = 160
    expect(r.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(160, 1)
    const entries = r.events.filter((e) => e.eventType === 'PARTIAL_ENTRY')
    expect(entries.length).toBe(3)
  })
})

// ── 6. two overlapping positions ──────────────────────────────────────────────
describe('6. two overlapping positions', () => {
  it('counts concurrent open positions and available slots', () => {
    const r = buildEquityPath(makeInput([
      {
        symbol: 'AAA', plannedRisk: 500,
        entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
        exits: [{ hhmm: '10:00', qty: 100, price: 105, reason: 't2' }],
        tape: [bar('09:30', 100, 101, 100, 101), bar('09:45', 101, 106, 101, 105), bar('10:00', 105, 105, 104, 105)],
      },
      {
        symbol: 'BBB', plannedRisk: 500,
        entries: [{ hhmm: '09:40', qty: 100, price: 50 }],
        exits: [{ hhmm: '10:10', qty: 100, price: 48, reason: 'stop' }],
        tape: [bar('09:40', 50, 51, 50, 50), bar('09:50', 50, 50, 47, 48), bar('10:10', 48, 48, 47, 48)],
      },
    ], { maxConc: 3 }))
    const at0945 = r.path.find((p) => p.etTime === '09:45')!
    expect(at0945.openPositions).toBe(2)
    expect(at0945.availableSlots).toBe(1)
    // Portfolio total = sum of both trade contributions.
    expect(typeof at0945.totalDollarPnl).toBe('number')
  })
})

// ── 7. new losing trade admitted after portfolio peak ─────────────────────────
describe('7. post-peak new losses', () => {
  it('classifies giveback as POST_PEAK_NEW_LOSSES when a new trade drives it', () => {
    const r = buildEquityPath(makeInput([
      { // A: clean winner, closed AT the peak (contributes ~0 giveback)
        symbol: 'AWIN', plannedRisk: 500,
        entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
        exits: [{ hhmm: '09:35', qty: 100, price: 105, reason: 't2' }],
        tape: [bar('09:30', 100, 101, 100, 101), bar('09:35', 101, 105, 101, 105), bar('09:36', 105, 105, 105, 105)],
      },
      { // B: enters AFTER the peak and loses
        symbol: 'BNEW', plannedRisk: 500,
        entries: [{ hhmm: '09:45', qty: 100, price: 100 }],
        exits: [{ hhmm: '09:55', qty: 100, price: 92, reason: 'stop' }],
        tape: [bar('09:45', 100, 100, 99, 100), bar('09:50', 100, 100, 92, 93), bar('09:55', 93, 93, 91, 92)],
      },
    ]))
    const ga = r.givebackAttribution
    expect(ga.classification).toBe('POST_PEAK_NEW_LOSSES')
    expect(ga.postPeakNewTradeCount).toBe(1)
    expect(ga.prePeakOpenTradeCount).toBe(0)
    expect(ga.postPeakNewTradePnl!).toBeCloseTo(-800, 1)
  })
})

// ── 8. open winner reversal after peak ────────────────────────────────────────
describe('8. open-winner reversal', () => {
  it('classifies giveback as OPEN_WINNER_REVERSAL when an open winner gives it all back', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'ORV', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:50', qty: 100, price: 95, reason: 'stop' }],
      tape: [bar('09:30', 100, 101, 100, 100), bar('09:35', 100, 110, 100, 110), bar('09:45', 110, 110, 95, 96), bar('09:50', 96, 96, 94, 95)],
    }]))
    const ga = r.givebackAttribution
    expect(r.portfolioSummary.peakTotalDollarPnl!).toBeCloseTo(1000, 0) // unreal +1000 at 09:35
    expect(ga.classification).toBe('OPEN_WINNER_REVERSAL')
    expect(ga.prePeakOpenTradeCount).toBe(1)
    expect(ga.postPeakNewTradeCount).toBe(0)
  })
})

// ── 9. mixed giveback ─────────────────────────────────────────────────────────
describe('9. mixed giveback', () => {
  it('classifies as MIXED_GIVEBACK when both groups contribute materially', () => {
    const r = buildEquityPath(makeInput([
      { // A: open winner reverses (pre-peak giveback ~1000)
        symbol: 'AMX', plannedRisk: 500,
        entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
        exits: [{ hhmm: '09:50', qty: 100, price: 95, reason: 'stop' }],
        tape: [bar('09:30', 100, 101, 100, 100), bar('09:35', 100, 105, 100, 105), bar('09:45', 105, 105, 95, 96), bar('09:50', 96, 96, 94, 95)],
      },
      { // B: enters after peak, loses ~500
        symbol: 'BMX', plannedRisk: 500,
        entries: [{ hhmm: '09:40', qty: 100, price: 100 }],
        exits: [{ hhmm: '09:55', qty: 100, price: 95, reason: 'stop' }],
        tape: [bar('09:40', 100, 100, 99, 100), bar('09:50', 100, 100, 95, 96), bar('09:55', 96, 96, 94, 95)],
      },
    ]))
    expect(r.givebackAttribution.classification).toBe('MIXED_GIVEBACK')
    expect(r.givebackAttribution.prePeakOpenTradeCount).toBe(1)
    expect(r.givebackAttribution.postPeakNewTradeCount).toBe(1)
  })
})

// ── 10. no positive portfolio period ──────────────────────────────────────────
describe('10. never positive', () => {
  it('does not force a green interpretation', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'DWN', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:40', qty: 100, price: 95, reason: 'stop' }],
      tape: [bar('09:30', 100, 100, 98, 99), bar('09:35', 99, 99, 95, 96), bar('09:40', 96, 96, 94, 95)],
    }]))
    expect(r.portfolioSummary.everPositive).toBe(false)
    expect(r.portfolioSummary.peakTotalDollarPnl!).toBeLessThanOrEqual(0)
    expect(r.tradeMetrics[0].didTradeBecomeGreen).toBe(false)
  })
})

// ── 11. missing tape interval ─────────────────────────────────────────────────
describe('11. missing tape interval', () => {
  it('marks unrealized/total UNKNOWN while an open position lacks a mark', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'GAP', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '10:00', qty: 100, price: 105, reason: 't2' }],
      // Tape starts only at 09:45 — 09:30..09:44 held with NO mark ⇒ UNKNOWN.
      tape: [bar('09:45', 104, 106, 104, 105), bar('10:00', 105, 105, 104, 105)],
    }]))
    const early = r.path.find((p) => p.etTime === '09:35')!
    expect(early.openPositions).toBe(1)
    expect(early.unrealizedDollarPnl).toBeNull()
    expect(early.totalDollarPnl).toBeNull()
    expect(r.coverage.minutesUnknownUnrealized).toBeGreaterThan(0)
    expect(r.coverage.unknownIntervals.length).toBeGreaterThan(0)
  })
})

// ── 12. invalid original risk ─────────────────────────────────────────────────
describe('12. invalid original risk', () => {
  it('marks R UNKNOWN and records it, but keeps dollar economics', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'NORISK', plannedRisk: null, // no valid risk denominator
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:40', qty: 100, price: 105, reason: 't2' }],
      tape: [bar('09:30', 100, 101, 100, 101), bar('09:35', 101, 106, 101, 105), bar('09:40', 105, 105, 104, 105)],
    }]))
    expect(r.coverage.everyTradeHasValidRisk).toBe(false)
    expect(r.unknowns.length).toBeGreaterThan(0)
    const held = r.path.find((p) => p.etTime === '09:35')!
    expect(held.totalR).toBeNull()
    expect(held.totalDollarPnl).not.toBeNull() // dollars still known
    expect(r.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(500, 1)
    expect(r.portfolioSummary.finalBrokerR).toBeNull()
  })
})

// ── 13. frozen-input absence fails closed (CLI) ───────────────────────────────
describe('13. frozen-input absence fails closed', () => {
  it('CLI exits non-zero when the frozen snapshot is absent', () => {
    let exitCode = 0
    try {
      execFileSync('npx', ['tsx', 'scripts/session-equity-path.ts', '1990-01-02'], { cwd: process.cwd(), stdio: 'pipe' })
    } catch (e) {
      exitCode = (e as { status?: number }).status ?? 1
    }
    expect(exitCode).not.toBe(0)
  }, 60000)
})

// ── 14. no silent live fallback ───────────────────────────────────────────────
describe('14. no silent live fallback', () => {
  it('never substitutes a fabricated price for a missing mark — it stays null', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'NOFB', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:50', qty: 100, price: 105, reason: 't2' }],
      tape: [], // absolutely no tape
    }]))
    expect(r.coverage.tapeSymbolsMissing).toContain('NOFB')
    const held = r.path.find((p) => p.etTime === '09:40')!
    expect(held.unrealizedDollarPnl).toBeNull()
    expect(held.totalDollarPnl).toBeNull()
    // Final broker P&L is still exact (fills are truth, independent of marks).
    expect(r.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(500, 1)
  })
})

// ── 15. broker/local disagreement doesn't contaminate broker replay ───────────
describe('15. broker replay is independent of local accounting', () => {
  it('reconstructs final P&L from fills only, matching the ledger broker P&L', () => {
    const input = makeInput([{
      symbol: 'ISO', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:35', qty: 60, price: 108, reason: 't1' }, { hhmm: '09:45', qty: 40, price: 96, reason: 'stop' }],
      tape: [bar('09:30', 100, 101, 100, 101), bar('09:35', 101, 109, 101, 108), bar('09:45', 108, 108, 95, 96)],
    }])
    // Corrupt a hypothetical local number: the engine has no field for it, so this is a
    // structural guarantee — but assert the reconstruction equals the ledger broker P&L.
    const r = buildEquityPath(input)
    const expected = 60 * (108 - 100) + 40 * (96 - 100) // 480 - 160 = 320
    expect(r.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(expected, 1)
    expect(input.ledger.perTrade[0].brokerPnl).toBeCloseTo(expected, 1)
  })
})

// ── 16. terminal exit uses broker quantity reaching zero ──────────────────────
describe('16. terminal exit at broker qty zero', () => {
  it('closes the position exactly when cumulative sells reach the entry qty', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'TERM', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:40', qty: 60, price: 105, reason: 't1' }, { hhmm: '09:50', qty: 40, price: 106, reason: 't2' }],
      tape: [bar('09:30', 100, 101, 100, 101), bar('09:40', 101, 106, 101, 105), bar('09:50', 105, 107, 105, 106), bar('10:00', 106, 106, 105, 106)],
    }]))
    const after = r.path.find((p) => p.etTime === '10:00')!
    expect(after.openPositions).toBe(0)
    const last = r.events[r.events.length - 1]
    expect(last.eventType).toBe('FINAL_EXIT')
    expect(last.openPositions).toBe(0)
  })
})

// ── pure helper units ─────────────────────────────────────────────────────────
describe('pure helpers', () => {
  it('classifyGiveback honors the documented bands', () => {
    expect(classifyGiveback(1000, 5, 900, 100)).toBe('OPEN_WINNER_REVERSAL')
    expect(classifyGiveback(1000, 5, 100, 900)).toBe('POST_PEAK_NEW_LOSSES')
    expect(classifyGiveback(1000, 5, 500, 500)).toBe('MIXED_GIVEBACK')
    expect(classifyGiveback(1000, 0.1, 500, 500)).toBe('NO_MEANINGFUL_GIVEBACK')
    expect(classifyGiveback(null, null, null, null)).toBe('UNKNOWN')
  })
  it('eqBand uses descriptive review-only bands', () => {
    expect(eqBand({ rows: 100, quoteFreshRows: 95, tradeFreshRows: 95, droppedRows: 0, errorRows: 0 })).toBe('GOOD')
    expect(eqBand({ rows: 100, quoteFreshRows: 20, tradeFreshRows: 20, droppedRows: 0, errorRows: 0 })).toBe('POOR')
    expect(eqBand({ rows: 100, quoteFreshRows: 70, tradeFreshRows: 70, droppedRows: 0, errorRows: 0 })).toBe('DEGRADED')
    expect(eqBand({ rows: 0, quoteFreshRows: 0, tradeFreshRows: 0, droppedRows: 0, errorRows: 0 })).toBe('UNKNOWN')
  })
  it('etMinuteTimestamp lands on the ET wall-clock minute', () => {
    const t = etMinuteTimestamp(ts('09:30'), CLOSE)
    expect(etHHMMStr(t)).toBe('16:00')
  })
})

// ── peak semantics: minute-close replay, NOT true intraminute maximum ─────────
describe('peak semantics (minute-close replay)', () => {
  it('marks peak on the bar CLOSE, never on an unobservable intrabar high', () => {
    const r = buildEquityPath(makeInput([{
      symbol: 'PK', plannedRisk: 500,
      entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
      exits: [{ hhmm: '09:40', qty: 100, price: 105, reason: 't2' }],
      // 09:35 bar spikes to a HIGH of 130 but CLOSES at 110. The replay must use 110.
      tape: [bar('09:30', 100, 100, 100, 100), bar('09:35', 100, 130, 100, 110), bar('09:40', 110, 111, 104, 105)],
    }]))
    expect(r.portfolioSummary.peakBasis).toBe('minute_close_replay')
    // Close-mark peak = (110-100)*100 = 1000 — NOT the intrabar-high value (130-100)*100 = 3000.
    expect(r.portfolioSummary.peakTotalDollarPnl).toBeCloseTo(1000, 1)
    expect(r.portfolioSummary.peakTotalDollarPnl).not.toBeCloseTo(3000, 1)
    // And the reported peak equals the max over the emitted minute-close path.
    const maxPath = Math.max(...r.path.filter((p) => p.totalDollarPnl != null).map((p) => p.totalDollarPnl as number))
    expect(r.portfolioSummary.peakTotalDollarPnl).toBeCloseTo(maxPath, 6)
  })
})

// ── giveback decomposition sums to total, residual absorbed ───────────────────
describe('giveback decomposition identity', () => {
  it('prePeakOpen + postPeakNew + other == peakToCloseGiveback (within rounding)', () => {
    const r = buildEquityPath(makeInput([
      {
        symbol: 'GA', plannedRisk: 300,
        entries: [{ hhmm: '09:30', qty: 100, price: 100 }],
        exits: [{ hhmm: '09:50', qty: 100, price: 97.33, reason: 'stop' }],
        tape: [bar('09:30', 100, 101, 100, 100), bar('09:35', 100, 103, 100, 102.5), bar('09:45', 102.5, 102.5, 97, 97.7), bar('09:50', 97.7, 97.7, 97, 97.33)],
      },
      {
        symbol: 'GB', plannedRisk: 300,
        entries: [{ hhmm: '09:40', qty: 100, price: 50 }],
        exits: [{ hhmm: '09:55', qty: 100, price: 48.11, reason: 'stop' }],
        tape: [bar('09:40', 50, 50, 49, 50), bar('09:50', 50, 50, 48, 48.5), bar('09:55', 48.5, 48.5, 47, 48.11)],
      },
    ]))
    const ga = r.givebackAttribution
    const total = r.portfolioSummary.peakToCloseGivebackDollar!
    const sum = ga.prePeakOpenTradeGiveback! + ga.postPeakNewTradeGiveback! + ga.otherOrUnknownContribution!
    expect(sum).toBeCloseTo(total, 2)                     // identity holds to the cent
    expect(Math.abs(ga.otherOrUnknownContribution!)).toBeLessThan(0.01) // residual is only rounding
    expect(total).toBeCloseTo(r.portfolioSummary.peakTotalDollarPnl! - r.portfolioSummary.finalBrokerDollarPnl!, 2)
  })
})

// ── freeze-delay math across the ET date boundary ─────────────────────────────
describe('freeze-delay across ET date boundary', () => {
  it('computes 16:00 ET close and the delay to a next-day UTC freeze', () => {
    const refTs = etStrToUnixSec('2026-08-28 05:00:00') * 1000 // premarket same session
    const closeMs = etMinuteTimestamp(refTs, 16 * 60)
    expect(etHHMMStr(closeMs)).toBe('16:00')
    expect(new Date(closeMs).toISOString()).toBe('2026-08-28T20:00:00.000Z') // 16:00 EDT = 20:00Z
    const frozen = Date.parse('2026-08-29T15:25:45.642Z')                     // next calendar day
    const mins = Math.round((frozen - closeMs) / 60000)
    expect(mins).toBe(1166)
    expect(Math.floor(mins / 60)).toBe(19)
    expect(mins % 60).toBe(26)
  })
})

// ── Session-4 regression fixture (STRUCTURE only — no strategy conclusions) ────
describe('Session 4 regression fixture (2026-08-28)', () => {
  const day = '2026-08-28'
  const snap = join(process.cwd(), 'reviews', 'prospective-offhigh', day, 'snapshot')
  const ledgerPath = join(process.cwd(), 'data', 'research-cache', 'broker-ledger', `broker-ledger-${day}.json`)
  const run = existsSync(snap) && existsSync(ledgerPath)
  it.runIf(run)('reconstructs deterministically and reconciles to the broker ledger', () => {
    const out = join(process.cwd(), 'data', 'research-cache', 'equity-path', `equity-path-${day}.json`)
    execFileSync('npx', ['tsx', 'scripts/session-equity-path.ts', day], { cwd: process.cwd(), stdio: 'pipe' })
    const rep = JSON.parse(readFileSync(out, 'utf8'))
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const ledgerSum = Math.round(ledger.perTrade.reduce((s: number, t: { brokerPnl: number }) => s + t.brokerPnl, 0) * 100) / 100
    // Broker-truth reconciliation (structure, not a strategy claim):
    expect(rep.portfolioSummary.finalBrokerDollarPnl).toBeCloseTo(ledgerSum, 1)
    expect(rep.tradeMetrics.length).toBe(ledger.perTrade.length)
    expect(rep.coverage.everyTradeHasValidRisk).toBe(true)
    expect(rep.coverage.tapeSymbolsMissing.length).toBe(0)
    expect(['NO_MEANINGFUL_GIVEBACK', 'OPEN_WINNER_REVERSAL', 'POST_PEAK_NEW_LOSSES', 'MIXED_GIVEBACK', 'UNKNOWN'])
      .toContain(rep.givebackAttribution.classification)
    // Peak-basis is explicit and never claimed to be the true intraminute maximum.
    expect(rep.portfolioSummary.peakBasis).toBe('minute_close_replay')
    // Giveback decomposition identity holds on real data.
    const ga = rep.givebackAttribution
    const total = rep.portfolioSummary.peakToCloseGivebackDollar
    expect(ga.prePeakOpenTradeGiveback + ga.postPeakNewTradeGiveback + ga.otherOrUnknownContribution).toBeCloseTo(total, 2)
    // Freeze-timing provenance: manifest froze on 2026-08-29 ⇒ ~19h26m after the 16:00 ET close.
    expect(rep.processMetrics.marketCloseToFreezeMinutes).toBe(1166)
    // Determinism: a second run yields an identical portfolio summary.
    execFileSync('npx', ['tsx', 'scripts/session-equity-path.ts', day], { cwd: process.cwd(), stdio: 'pipe' })
    const rep2 = JSON.parse(readFileSync(out, 'utf8'))
    expect(rep2.portfolioSummary).toEqual(rep.portfolioSummary)
  }, 120000)
})
