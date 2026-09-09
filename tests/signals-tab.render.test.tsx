// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { SignalsTab } from '../src/components/opportunities/OpportunitiesDrawer'
import { useTradingStore } from '../src/store/trading-store'
import type { DetectedSetup, MonitorAlert, PriceRoadmap, SetupState, SetupType, SetupDirection } from '../src/types'

let sseq = 0
function setup(over: Partial<DetectedSetup> = {}): DetectedSetup {
  sseq += 1
  const base: Omit<DetectedSetup, 'signal'> = {
    id: `S${sseq}`, symbol: 'INDP', type: 'hod_break' as SetupType,
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
    setupType: 'hod_break', direction: 'long', state: 'confirming' as SetupState,
    score: 70, grade: 'B', title: 't', body: 'body text', price: 1.84, zoneLower: 1.82, zoneUpper: 1.86,
    confirmation: ['hold + reclaim above $1.84'], invalidation: 1.81,
    targets: [], risks: [], timestamp: Date.now() - aseq * 1000, dataAgeMs: 0, delayed: false, read: false,
  }
  return { ...base, ...over }
}

function roadmap(symbol: string, price: number): PriceRoadmap {
  return { symbol, currentPrice: price, upside: [], downside: [], updatedAt: Date.now() }
}

function seed(opts: { setups?: DetectedSetup[]; alerts?: MonitorAlert[]; roadmaps?: Record<string, PriceRoadmap> }) {
  useTradingStore.setState({
    monitoredSetups: opts.setups ?? [],
    monitorAlerts: opts.alerts ?? [],
    roadmaps: opts.roadmaps ?? {},
  })
}

beforeEach(() => { sseq = 0; aseq = 0; seed({}) })
afterEach(() => { cleanup(); seed({}) })

const noop = () => {}

describe('SignalsTab — Active is sourced from live monitoredSetups', () => {
  it('shows a current setup in Active', () => {
    seed({ setups: [setup({ symbol: 'INDP', state: 'confirming' })], roadmaps: { INDP: roadmap('INDP', 1.84) } })
    render(<SignalsTab onPick={noop} />)
    expect(screen.getByText('INDP')).toBeTruthy()
    expect(screen.getByText('$1.84')).toBeTruthy() // live price from the roadmap
  })

  it('an old alert for a ticker with NO current setup does not appear in Active', () => {
    seed({
      setups: [setup({ symbol: 'INDP', state: 'confirming' })],
      alerts: [alert({ symbol: 'GHOST', state: 'triggered' })], // stale alert, no live setup
    })
    render(<SignalsTab onPick={noop} />)
    expect(screen.getByText('INDP')).toBeTruthy()
    expect(screen.queryByText('GHOST')).toBeNull()
  })

  it('that same old alert DOES remain in History', () => {
    seed({
      setups: [setup({ symbol: 'INDP' })],
      alerts: [alert({ symbol: 'GHOST', state: 'triggered', body: 'ghost event' })],
    })
    const { container } = render(<SignalsTab onPick={noop} />)
    fireEvent.click(within(container).getByText('History', { selector: 'button' }))
    expect(screen.getByText('GHOST')).toBeTruthy()
    expect(screen.getByText('ghost event')).toBeTruthy()
  })

  it('multiple current setups for one ticker produce ONE top-level card', () => {
    seed({
      setups: [
        setup({ symbol: 'INDP', type: 'hod_break', state: 'confirming' }),
        setup({ symbol: 'INDP', type: 'ema21_bounce', state: 'approaching' }),
        setup({ symbol: 'INDP', type: 'vwap_bounce', state: 'identified' }),
      ],
    })
    render(<SignalsTab onPick={noop} />)
    expect(screen.getAllByText('INDP')).toHaveLength(1)
    // The collapsed expand control names the extra current setups.
    expect(screen.getByText(/2 more setups/)).toBeTruthy()
  })

  it('expanding a card exposes ALL current setups for that ticker, separate from event history', () => {
    seed({
      setups: [
        setup({ symbol: 'INDP', type: 'hod_break', state: 'confirming' }),
        setup({ symbol: 'INDP', type: 'ema21_bounce', state: 'approaching' }),
      ],
      alerts: [alert({ symbol: 'INDP', state: 'approaching', confirmation: ['approaching $1.83'] })],
    })
    render(<SignalsTab onPick={noop} />)
    // Nothing expanded yet.
    expect(screen.queryByText(/Current setups/)).toBeNull()
    fireEvent.click(screen.getByText(/more setup/)) // the collapsed expand control
    // Both current setups listed under the distinct "Current setups" section.
    expect(screen.getByText(/Current setups \(2\)/)).toBeTruthy()
    // HOD Break is the primary (shown in the header too), so it appears ≥ once;
    // the secondary 21 EMA Bounce appears only because expansion lists them all.
    expect(screen.getAllByText('HOD Break').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('21 EMA Bounce')).toBeTruthy()
    // Event history is a separate section, sourced from the alert log.
    expect(screen.getByText(/Signal history/)).toBeTruthy()
    expect(screen.getByText('approaching $1.83')).toBeTruthy()
  })
})

describe('SignalsTab — Triggered uses current setup state, not the latest alert', () => {
  it('excludes a ticker whose live setup is not triggered even if its latest alert was', () => {
    seed({
      setups: [setup({ symbol: 'INDP', state: 'confirming' })],       // live: confirming
      alerts: [alert({ symbol: 'INDP', state: 'triggered' })],        // history: triggered
    })
    render(<SignalsTab onPick={noop} />)
    // [0] = the view sub-nav 'Triggered' (the Active filter chip shares the word).
    fireEvent.click(screen.getAllByText('Triggered', { selector: 'button' })[0])
    expect(screen.getByText(/Nothing triggered/)).toBeTruthy()
    expect(screen.queryByText('INDP')).toBeNull()
  })

  it('includes a ticker whose current setup state is triggered', () => {
    seed({ setups: [setup({ symbol: 'AAA', state: 'triggered' })], roadmaps: { AAA: roadmap('AAA', 2.5) } })
    render(<SignalsTab onPick={noop} />)
    // [0] = the view sub-nav 'Triggered' (the Active filter chip shares the word).
    fireEvent.click(screen.getAllByText('Triggered', { selector: 'button' })[0])
    expect(screen.getByText('AAA')).toBeTruthy()
  })
})

describe('SignalsTab — read/unread + immutability preserved', () => {
  it('clicking a ticker card does not mark events read', () => {
    seed({ setups: [setup({ symbol: 'INDP' })], alerts: [alert({ symbol: 'INDP', read: false })] })
    render(<SignalsTab onPick={noop} />)
    fireEvent.click(screen.getByText('INDP'))
    expect(useTradingStore.getState().monitorAlerts.every(a => a.read === false)).toBe(true)
  })

  it('"Mark all read" is the only path that marks events read; badge count unchanged otherwise', () => {
    seed({ setups: [setup({ symbol: 'INDP' })], alerts: [alert({ read: false }), alert({ read: false })] })
    render(<SignalsTab onPick={noop} />)
    const unreadBefore = useTradingStore.getState().monitorAlerts.filter(a => !a.read).length
    expect(unreadBefore).toBe(2)
    fireEvent.click(screen.getByText('Mark all read'))
    expect(useTradingStore.getState().monitorAlerts.every(a => a.read === true)).toBe(true)
  })

  it('state filters are display-only and do not mutate monitoredSetups or monitorAlerts', () => {
    const setups = [setup({ symbol: 'AAA', state: 'triggered' }), setup({ symbol: 'BBB', state: 'confirming' })]
    const alerts = [alert({ symbol: 'AAA' })]
    seed({ setups, alerts })
    render(<SignalsTab onPick={noop} />)
    const setupsRef = useTradingStore.getState().monitoredSetups
    const alertsRef = useTradingStore.getState().monitorAlerts
    // [0] = view sub-nav 'Triggered', [1] = filter chip 'Triggered'.
    fireEvent.click(screen.getAllByText('Triggered', { selector: 'button' })[1])
    expect(screen.getAllByText('AAA')).toHaveLength(1)
    expect(screen.queryByText('BBB')).toBeNull()
    expect(useTradingStore.getState().monitoredSetups).toBe(setupsRef)
    expect(useTradingStore.getState().monitorAlerts).toBe(alertsRef)
  })
})

describe('SignalsTab — empty + History', () => {
  it('renders an empty Active state when there are no current setups', () => {
    seed({ setups: [], alerts: [alert({ symbol: 'GHOST' })] })
    render(<SignalsTab onPick={noop} />)
    expect(screen.getByText(/No active setups right now/)).toBeTruthy()
  })

  it('History keeps every event, including repeats per ticker', () => {
    seed({
      setups: [],
      alerts: [
        alert({ symbol: 'INDP', timestamp: 6000 }),
        alert({ symbol: 'INDP', timestamp: 5000 }),
        alert({ symbol: 'INDP', timestamp: 4000 }),
      ],
    })
    const { container } = render(<SignalsTab onPick={noop} />)
    fireEvent.click(within(container).getByText('History', { selector: 'button' }))
    expect(screen.getByText('3 events · newest first · repeats per ticker are the audit trail')).toBeTruthy()
    expect(screen.getAllByText('body text')).toHaveLength(3)
  })
})
