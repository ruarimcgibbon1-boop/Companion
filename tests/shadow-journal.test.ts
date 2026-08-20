import { describe, it, expect } from 'vitest'
import {
  buildShadowCandidates, resolveShadowOutcome, rejectionLayer, LAYER_SOURCE, etTradingDay,
  joinExecutorOutcome, executorEventLayer, type DecisionLogRow, type ExecutorEvent,
} from '@/lib/research/shadow-journal'
import type { Candle } from '@/types'

const row = (over: Partial<DecisionLogRow> = {}): DecisionLogRow => ({
  ts: '2026-08-19T13:34:00Z', etTime: '09:34', symbol: 'CDE', setupId: 'CDE:opening_drive:20',
  setupType: 'opening_drive', grade: 'B', score: 72, verdict: 'logged', fill: 20.08,
  rvol: 10.4, offHighPct: 0, session: 'regular', price: 20.05,
  stop: 19.83, targets: [20.5, 21.0], entryRef: 20.08, ...over,
})

describe('buildShadowCandidates — stable identity, frozen features, no double-count', () => {
  it('one candidate per (ET day, setupId) with signal-time features frozen', () => {
    const [c] = buildShadowCandidates([row()])
    expect(c.candidateId).toBe('2026-08-19:CDE:opening_drive:20')
    expect(c.everAccepted).toBe(true)
    expect(c.entryRef).toBe(20.08)
    expect(c.stop).toBe(19.83)
    expect(c.targets).toEqual([20.5, 21.0])
    expect(c.features).toEqual({ grade: 'B', score: 72, rvol: 10.4, offHighPct: 0, price: 20.05 })
    expect(c.outcome).toBeNull()
  })

  it('VETO → later ACCEPT collapses to ONE candidate with a lifecycle, not two trades', () => {
    const events = [
      row({ ts: '2026-08-19T13:31:00Z', etTime: '09:31', verdict: 'veto', score: 60 }),
      row({ ts: '2026-08-19T13:33:00Z', etTime: '09:33', verdict: 'veto', score: 66 }),
      row({ ts: '2026-08-19T13:36:00Z', etTime: '09:36', verdict: 'logged', score: 72 }),
    ]
    const cands = buildShadowCandidates(events)
    expect(cands).toHaveLength(1)                 // NOT two independent trades
    const c = cands[0]
    expect(c.everAccepted).toBe(true)
    expect(c.terminalVerdict).toBe('logged')
    expect(c.lifecycle.reEvaluations).toBe(3)
    expect(c.lifecycle.vetoedTs).toBe(Date.parse('2026-08-19T13:31:00Z'))   // earliest veto
    expect(c.lifecycle.acceptedTs).toBe(Date.parse('2026-08-19T13:36:00Z'))
    // features are frozen at FIRST sighting (score 60), never the later, more-informed 72.
    expect(c.features.score).toBe(60)
    expect(c.signalTs).toBe(Date.parse('2026-08-19T13:31:00Z'))
    expect(c.events).toHaveLength(3)              // all raw events retained
  })

  it('RESTART IDEMPOTENCE: re-appended identical events do not create duplicates', () => {
    const one = row({ ts: '2026-08-19T13:31:00Z', verdict: 'veto' })
    const two = row({ ts: '2026-08-19T13:36:00Z', verdict: 'logged' })
    // Simulate a restart that re-logs the same day's events (seenDecisions Set was in-memory).
    const afterRestart = [one, two, one, two, one]
    const cands = buildShadowCandidates(afterRestart)
    expect(cands).toHaveLength(1)
    expect(cands[0].lifecycle.reEvaluations).toBe(2)   // deduped to the 2 distinct events
    expect(cands[0].everAccepted).toBe(true)
  })

  it('expiredTs stays null — not provable from the decision log', () => {
    const [c] = buildShadowCandidates([row({ verdict: 'veto' })])
    expect(c.lifecycle.expiredTs).toBeNull()
  })
})

describe('ET trading-day boundary (America/New_York), independent of UTC/filename', () => {
  it('an afterhours event past UTC midnight still belongs to the ET trading day', () => {
    // 2026-08-20T01:30:00Z == 2026-08-19 21:30 ET (afterhours of the 19th).
    const [c] = buildShadowCandidates([row({ ts: '2026-08-20T01:30:00Z', etTime: '21:30' })])
    expect(c.etTradingDay).toBe('2026-08-19')
    expect(c.candidateId.startsWith('2026-08-19:')).toBe(true)
  })

  it('premarket and RTH events on the same ET day share one candidate across the UTC boundary', () => {
    const pre = row({ ts: '2026-08-19T11:00:00Z', etTime: '07:00', verdict: 'session' })  // 07:00 ET
    const rth = row({ ts: '2026-08-19T14:00:00Z', etTime: '10:00', verdict: 'logged' })    // 10:00 ET
    const cands = buildShadowCandidates([pre, rth])
    expect(cands).toHaveLength(1)
    expect(cands[0].etTradingDay).toBe('2026-08-19')
  })

  it('etTradingDay maps a post-20:00-ET instant to the correct ET day', () => {
    expect(etTradingDay(Date.parse('2026-08-20T02:00:00Z'))).toBe('2026-08-19')  // 22:00 ET on the 19th
    expect(etTradingDay(Date.parse('2026-08-20T13:00:00Z'))).toBe('2026-08-20')  // 09:00 ET on the 20th
  })
})

describe('rejection layers — different counterfactual questions, not pooled', () => {
  it('maps decision-log verdicts to distinct layers', () => {
    expect(rejectionLayer('logged')).toBe('accepted')
    expect(rejectionLayer('veto')).toBe('strategy_veto')
    expect(rejectionLayer('session')).toBe('session')
    expect(rejectionLayer('volume')).toBe('liquidity_untradeable')
    expect(rejectionLayer('capped')).toBe('per_symbol_cap')
    expect(rejectionLayer('dup')).toBe('duplicate_cooldown')
    expect(rejectionLayer('standDown')).toBe('duplicate_cooldown')
  })

  it('a per-symbol cap (admission) is NOT the same layer as portfolio risk capacity', () => {
    const [c] = buildShadowCandidates([row({ verdict: 'capped' })])
    expect(c.layers).toContain('per_symbol_cap')
    expect(c.layers).not.toContain('risk_capacity')
    // risk_capacity / no_fill / broker_untradeable can ONLY come from executor events.
    expect(LAYER_SOURCE.risk_capacity).toBe('executor_events')
    expect(LAYER_SOURCE.execution_no_fill).toBe('executor_events')
    expect(LAYER_SOURCE.per_symbol_cap).toBe('decision_log')
  })
})

describe('deterministic shadow ↔ executor join — by setupId, never symbol', () => {
  it('two setups on the SAME symbol/day do not cross-attribute a risk block', () => {
    const drive = buildShadowCandidates([row({ setupId: 'XYZ:opening_drive:9', setupType: 'opening_drive', verdict: 'logged' })])[0]
    const bos = buildShadowCandidates([row({ setupId: 'XYZ:break_of_structure:9', setupType: 'break_of_structure', verdict: 'logged' })])[0]
    const events: ExecutorEvent[] = [
      // Only the opening_drive got risk-blocked. The BOS was submitted.
      { event: 'entry_blocked', symbol: 'XYZ', setupId: 'XYZ:opening_drive:9', reason: 'max concurrent positions (3)' },
      { event: 'entry_submitted', symbol: 'XYZ', setupId: 'XYZ:break_of_structure:9' },
    ]
    const driveOut = joinExecutorOutcome(drive, events)
    const bosOut = joinExecutorOutcome(bos, events)
    expect(driveOut.layer).toBe('risk_capacity')          // correct candidate gets the block
    expect(bosOut.layer).toBe('accepted')                 // the other is NOT contaminated
    expect(bosOut.reason).toBeNull()
  })

  it('TERMINAL selection is deterministic with mixed/missing/malformed timestamps (input order wins)', () => {
    const c = buildShadowCandidates([row({ setupId: 'XYZ:opening_drive:9' })])[0]
    // Same setupId, several events; some lack ts, one is malformed. Input order = occurrence order.
    const events: ExecutorEvent[] = [
      { event: 'entry_blocked', setupId: 'XYZ:opening_drive:9', reason: 'max concurrent', ts: '2026-08-19T13:31:00Z' },
      { event: 'entry_blocked', setupId: 'XYZ:opening_drive:9', reason: 'still blocked' },              // no ts
      { event: 'entry_submitted', setupId: 'XYZ:opening_drive:9', ts: 'not-a-date' },                    // malformed ts, TERMINAL
    ]
    // Run repeatedly — must be stable and always pick the LAST input event.
    for (let i = 0; i < 20; i++) {
      const out = joinExecutorOutcome(c, events)
      expect(out.layer).toBe('accepted')       // the terminal entry_submitted
      expect(out.event).toBe('entry_submitted')
    }
    // Reordering the input changes the terminal deterministically (proves it's input-order, not ts-sorted).
    const reordered = [events[2], events[0], events[1]]
    expect(joinExecutorOutcome(c, reordered).event).toBe('entry_blocked')
  })

  it('an event with no setupId is unjoinable (never guessed by symbol)', () => {
    const c = buildShadowCandidates([row({ setupId: 'XYZ:opening_drive:9' })])[0]
    const out = joinExecutorOutcome(c, [{ event: 'entry_blocked', symbol: 'XYZ', reason: 'x' }])  // no setupId
    expect(out.layer).toBeNull()
  })

  it('maps executor events to the executor-only layers', () => {
    expect(executorEventLayer({ event: 'entry_blocked' })).toBe('risk_capacity')
    expect(executorEventLayer({ event: 'entry_skipped', reason: 'not tradable at broker' })).toBe('broker_untradeable')
    expect(executorEventLayer({ event: 'entry_skipped', reason: 'zero size' })).toBe('execution_no_fill')
    expect(executorEventLayer({ event: 'entry_timeout' })).toBe('execution_no_fill')
    expect(executorEventLayer({ event: 'entry_rejected' })).toBe('execution_no_fill')
    expect(executorEventLayer({ event: 'entry_submitted' })).toBe('accepted')
    // These layers are declared executor-sourced — the decision log cannot establish them.
    expect(LAYER_SOURCE.risk_capacity).toBe('executor_events')
    expect(LAYER_SOURCE.broker_untradeable).toBe('executor_events')
  })
})

const bar = (base: number, offsetSec: number, o: number, h: number, l: number, c: number): Candle =>
  ({ time: Math.floor(base / 1000) + offsetSec, open: o, high: h, low: l, close: c, volume: 1000 })

describe('resolveShadowOutcome — outcomes look forward, features never do', () => {
  const cand = (over: Partial<DecisionLogRow> = {}) => buildShadowCandidates([row(over)])[0]

  it('NO LOOKAHEAD: bars before the signal instant are ignored for entry', () => {
    const c = cand()
    const candles = [
      bar(c.signalTs, -120, 20.0, 21.5, 19.9, 21.4),   // pre-signal: would enter+target — ignored
      bar(c.signalTs, 60, 20.0, 20.09, 19.95, 20.0),
      bar(c.signalTs, 120, 20.0, 20.6, 19.9, 20.5),
    ]
    const o = resolveShadowOutcome(c, candles)
    expect(o.result).toBe('target')
    expect(o.resolvedFromBars).toBe(2)   // pre-signal bar excluded
  })

  it('resolves a STOP (conservative on same-bar stop+target tie)', () => {
    const c = cand()
    const o = resolveShadowOutcome(c, [
      bar(c.signalTs, 60, 20.0, 20.1, 19.95, 20.0),
      bar(c.signalTs, 120, 20.0, 20.6, 19.80, 19.9),  // spans stop 19.83 AND target 20.5 → STOP
    ])
    expect(o.result).toBe('stop')
  })

  it('resolves a REJECTED candidate too — the whole point of the shadow journal', () => {
    const c = cand({ verdict: 'veto' })
    const o = resolveShadowOutcome(c, [
      bar(c.signalTs, 60, 20.0, 20.1, 19.95, 20.0),
      bar(c.signalTs, 120, 20.0, 20.6, 19.9, 20.5),
    ])
    expect(o.result).toBe('target')   // "the veto skipped a name that would have hit T1" — descriptive
  })

  it('no_fill when entry is never reached', () => {
    const c = cand()
    expect(resolveShadowOutcome(c, [bar(c.signalTs, 60, 19.9, 20.0, 19.85, 19.95)]).result).toBe('no_fill')
  })
})
