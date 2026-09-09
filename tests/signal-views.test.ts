import { describe, it, expect } from 'vitest'
import {
  groupSetupsByTicker,
  filterSetupTickers,
  triggeredSetupTickers,
  matchesSetupFilter,
  summarizeSetupTickers,
  setupSummaryText,
  eventsForTicker,
  unreadForTicker,
} from '../src/lib/signal-views'
import type { DetectedSetup, MonitorAlert, SetupState, SetupType, SetupDirection } from '../src/types'

let sseq = 0
function setup(over: Partial<DetectedSetup> = {}): DetectedSetup {
  sseq += 1
  const base: Omit<DetectedSetup, 'signal'> = {
    id: `S${sseq}`, symbol: 'INDP', type: 'pullback' as SetupType,
    direction: 'long' as SetupDirection, state: 'confirming' as SetupState,
    score: 70, grade: 'B',
    breakdown: { levelQuality: 16, priceAction: 12, volumeMomentum: 11, trendAlignment: 8, catalyst: 6, rewardRisk: 12, liquidity: 8, confirmation: 3 },
    zoneLower: 1.82, zoneUpper: 1.86, zoneMidpoint: 1.84,
    rationale: 'r', confirmation: ['hold + reclaim above $1.84'], invalidation: 1.81, stopReference: 1.81,
    targets: [{ price: 2.0, label: 'T1', rewardRisk: 2 }], rewardRisk: 2,
    distanceToZonePct: 0, distanceFromVwapPct: 1, distanceFromEma9Pct: 1, distanceFromEma21Pct: 1,
    approachThresholdPct: 1, testCount: 1, confidence: 70, risks: [], keyRisks: [], notes: '',
    nextIfHolds: 2.0, nextIfFails: 1.7,
  }
  return { ...base, signal: { triggerCondition: 'reclaim $1.86' } as DetectedSetup['signal'], ...over }
}

let aseq = 0
function alert(over: Partial<MonitorAlert> = {}): MonitorAlert {
  aseq += 1
  const base: MonitorAlert = {
    id: `A${aseq}`, symbol: 'INDP', setupId: 'S1', kind: 'confirming',
    setupType: 'pullback', direction: 'long', state: 'confirming' as SetupState,
    score: 70, grade: 'B', title: 't', body: 'b', price: 1.84, zoneLower: 1.82, zoneUpper: 1.86,
    confirmation: ['hold + reclaim above $1.84'], invalidation: 1.81,
    targets: [], risks: [], timestamp: aseq * 1000, dataAgeMs: 0, delayed: false, read: false,
  }
  return { ...base, ...over }
}

describe('groupSetupsByTicker', () => {
  it('collapses multiple current setups for one ticker into a single row', () => {
    const rows = groupSetupsByTicker([
      setup({ symbol: 'INDP', type: 'hod_break', state: 'confirming' }),
      setup({ symbol: 'INDP', type: 'ema21_bounce', state: 'approaching' }),
      setup({ symbol: 'INDP', type: 'vwap_bounce', state: 'identified' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].symbol).toBe('INDP')
    // All current setups preserved under the one row.
    expect(rows[0].setups).toHaveLength(3)
  })

  it('keeps two different tickers as two rows', () => {
    const rows = groupSetupsByTicker([setup({ symbol: 'INDP' }), setup({ symbol: 'GTE' })])
    expect(rows.map(r => r.symbol).sort()).toEqual(['GTE', 'INDP'])
  })

  it('chooses the furthest-progressed setup as primary, score as tie-break', () => {
    const [row] = groupSetupsByTicker([
      setup({ symbol: 'INDP', type: 'ema21_bounce', state: 'approaching', score: 90 }),
      setup({ symbol: 'INDP', type: 'hod_break', state: 'triggered', score: 71 }),
      setup({ symbol: 'INDP', type: 'vwap_bounce', state: 'confirming', score: 95 }),
    ])
    // triggered outranks confirming/approaching regardless of score.
    expect(row.primary.state).toBe('triggered')
    expect(row.primary.type).toBe('hod_break')
  })

  it('ties within the same state break by higher score', () => {
    const [row] = groupSetupsByTicker([
      setup({ symbol: 'INDP', type: 'ema9_bounce', state: 'confirming', score: 72 }),
      setup({ symbol: 'INDP', type: 'hod_break', state: 'confirming', score: 88 }),
    ])
    expect(row.primary.score).toBe(88)
    expect(row.primary.type).toBe('hod_break')
  })

  it('does not mutate the input array or its setups', () => {
    const input = [
      setup({ symbol: 'INDP', state: 'approaching', score: 60 }),
      setup({ symbol: 'INDP', state: 'triggered', score: 80 }),
    ]
    const idsBefore = input.map(s => s.id)
    const statesBefore = input.map(s => s.state)
    groupSetupsByTicker(input)
    expect(input.map(s => s.id)).toEqual(idsBefore)
    expect(input.map(s => s.state)).toEqual(statesBefore)
  })

  it('returns an empty array when there are no current setups', () => {
    expect(groupSetupsByTicker([])).toEqual([])
  })
})

describe('filterSetupTickers (display-only, by primary state)', () => {
  const rows = groupSetupsByTicker([
    setup({ symbol: 'AAA', state: 'triggered' }),
    setup({ symbol: 'BBB', state: 'confirming' }),
    setup({ symbol: 'CCC', state: 'approaching' }),
    setup({ symbol: 'DDD', state: 'failed' }),
  ])

  it('all returns every row', () => {
    expect(filterSetupTickers(rows, 'all')).toHaveLength(4)
  })

  it('maps invalidated to the failed state', () => {
    expect(filterSetupTickers(rows, 'invalidated').map(r => r.symbol)).toEqual(['DDD'])
  })

  it('narrows to the requested state only', () => {
    expect(filterSetupTickers(rows, 'triggered').map(r => r.symbol)).toEqual(['AAA'])
    expect(filterSetupTickers(rows, 'confirming').map(r => r.symbol)).toEqual(['BBB'])
    expect(filterSetupTickers(rows, 'approaching').map(r => r.symbol)).toEqual(['CCC'])
  })

  it('does not mutate the input rows', () => {
    const before = rows.map(r => r.symbol)
    filterSetupTickers(rows, 'triggered')
    expect(rows.map(r => r.symbol)).toEqual(before)
  })

  it('matchesSetupFilter treats all as pass-through', () => {
    const s = setup({ state: 'failed' })
    expect(matchesSetupFilter(s, 'all')).toBe(true)
    expect(matchesSetupFilter(s, 'invalidated')).toBe(true)
    expect(matchesSetupFilter(s, 'triggered')).toBe(false)
  })
})

describe('triggeredSetupTickers', () => {
  it('uses current setup state, not the latest historical alert', () => {
    // The ticker has NO triggered current setup, even if an old alert said triggered.
    const rows = groupSetupsByTicker([
      setup({ symbol: 'AAA', state: 'triggered' }),
      setup({ symbol: 'BBB', state: 'confirming' }),
    ])
    expect(triggeredSetupTickers(rows).map(r => r.symbol)).toEqual(['AAA'])
  })
})

describe('summary strip', () => {
  it('tallies one vote per ticker by its primary state', () => {
    const rows = groupSetupsByTicker([
      setup({ symbol: 'AAA', state: 'confirming' }),
      setup({ symbol: 'BBB', state: 'confirming' }),
      setup({ symbol: 'CCC', state: 'approaching' }),
    ])
    const s = summarizeSetupTickers(rows)
    expect(s.tickers).toBe(3)
    expect(s.confirming).toBe(2)
    expect(s.approaching).toBe(1)
    expect(setupSummaryText(s)).toBe('3 tickers active · 2 confirming · 1 approaching')
  })

  it('shows just the ticker count when no decision states are present', () => {
    const rows = groupSetupsByTicker([setup({ symbol: 'AAA', state: 'identified' })])
    expect(setupSummaryText(summarizeSetupTickers(rows))).toBe('1 ticker active')
  })
})

describe('eventsForTicker (event history slice from monitorAlerts)', () => {
  it('returns only that ticker\'s events, newest first, without mutating the log', () => {
    const log = [
      alert({ symbol: 'INDP', timestamp: 1000 }),
      alert({ symbol: 'GTE', timestamp: 2000 }),
      alert({ symbol: 'INDP', timestamp: 3000 }),
    ]
    const order = log.map(a => a.id)
    const indp = eventsForTicker(log, 'INDP')
    expect(indp.map(a => a.timestamp)).toEqual([3000, 1000])
    expect(log.map(a => a.id)).toEqual(order) // source untouched
  })

  it('counts unread events for a ticker without changing them', () => {
    const log = [
      alert({ symbol: 'INDP', read: false }),
      alert({ symbol: 'INDP', read: true }),
      alert({ symbol: 'GTE', read: false }),
    ]
    expect(unreadForTicker(log, 'INDP')).toBe(1)
    expect(log.map(a => a.read)).toEqual([false, true, false])
  })
})
