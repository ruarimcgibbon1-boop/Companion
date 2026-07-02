import { describe, it, expect } from 'vitest'
import { transition, type TransitionInput } from '../src/lib/setup-state-machine'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../src/types'
import type { DetectedSetup, SetupState, SetupStateRecord, NotificationSettings } from '../src/types'

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeSetup(over: Partial<DetectedSetup> = {}): DetectedSetup {
  return {
    id: 'TEST:pullback:5.00',
    symbol: 'TEST',
    type: 'pullback',
    direction: 'long',
    state: 'identified',
    score: 80,
    grade: 'A-',
    breakdown: { levelQuality: 16, priceAction: 12, volumeMomentum: 11, trendAlignment: 8, catalyst: 6, rewardRisk: 12, liquidity: 8, confirmation: 3 },
    zoneLower: 4.95,
    zoneUpper: 5.05,
    zoneMidpoint: 5.0,
    rationale: 'test',
    confirmation: ['hold above 5.05', 'higher low'],
    invalidation: 4.9,
    stopReference: 4.9,
    targets: [{ price: 5.3, label: 'T1', rewardRisk: 3 }],
    rewardRisk: 3,
    distanceToZonePct: 0,
    distanceFromVwapPct: 2,
    distanceFromEma9Pct: 1,
    distanceFromEma21Pct: 2,
    approachThresholdPct: 1,
    testCount: 1,
    confidence: 78,
    risks: [],
    keyRisks: [],
    notes: '',
    nextIfHolds: 5.3,
    nextIfFails: 4.7,
    ...over,
  }
}

function baseInput(over: Partial<TransitionInput> = {}): TransitionInput {
  return {
    record: null,
    setup: makeSetup(),
    price: 5.0,
    settings: DEFAULT_NOTIFICATION_SETTINGS,
    session: 'regular',
    dataAgeMs: 5000,
    delayed: false,
    now: 1_000_000,
    ...over,
  }
}

// ── Approaching / early warning ──────────────────────────────────────────────

describe('state machine — approaching', () => {
  it('emits an early warning when a fresh setup is approaching (no manual selection needed)', () => {
    const setup = makeSetup({ state: 'approaching', distanceToZonePct: 0.8 })
    const { record, alert } = transition(baseInput({ setup, price: 5.04 }))
    expect(alert).not.toBeNull()
    expect(alert!.kind).toBe('early_warning')
    expect(record.state).toBe('approaching')
    expect(record.alertedStates).toContain('approaching')
  })

  it('does not re-alert the same approaching state on the next sweep (dedup)', () => {
    const setup = makeSetup({ state: 'approaching', distanceToZonePct: 0.8 })
    const first = transition(baseInput({ setup, price: 5.04 }))
    const second = transition(baseInput({ setup, record: first.record, price: 5.04, now: 1_000_100 }))
    expect(second.alert).toBeNull()
  })
})

// ── At level / confirming / triggered progression ────────────────────────────

describe('state machine — progression', () => {
  it('alerts level_reached when price enters the zone', () => {
    const approaching = makeSetup({ state: 'approaching', distanceToZonePct: 0.8 })
    const r1 = transition(baseInput({ setup: approaching, price: 5.04 }))
    const atLevel = makeSetup({ state: 'at_level', distanceToZonePct: 0 })
    const r2 = transition(baseInput({ setup: atLevel, record: r1.record, price: 5.0, now: 1_000_200 }))
    expect(r2.alert?.kind).toBe('level_reached')
    expect(r2.record.state).toBe('at_level')
  })

  it('progresses at_level → confirming → triggered with distinct alerts', () => {
    let rec: SetupStateRecord | null = null
    const states: SetupState[] = ['at_level', 'confirming', 'triggered']
    const kinds: string[] = []
    let t = 1_000_000
    for (const st of states) {
      const setup = makeSetup({ state: st, distanceToZonePct: 0 })
      const res = transition(baseInput({ setup, record: rec, price: 5.0, now: t }))
      rec = res.record
      if (res.alert) kinds.push(res.alert.kind)
      t += 120_000 // advance past cooldown
    }
    expect(kinds).toEqual(['level_reached', 'confirming', 'triggered'])
  })

  it('triggered bypasses cooldown (critical alert)', () => {
    const atLevel = makeSetup({ state: 'at_level' })
    const r1 = transition(baseInput({ setup: atLevel, price: 5.0, now: 1_000_000 }))
    // 1s later — within cooldown — but triggered must still fire
    const triggered = makeSetup({ state: 'triggered' })
    const r2 = transition(baseInput({ setup: triggered, record: r1.record, price: 5.0, now: 1_001_000 }))
    expect(r2.alert?.kind).toBe('triggered')
  })
})

// ── Invalidation / failure ───────────────────────────────────────────────────

describe('state machine — invalidation', () => {
  it('marks a setup failed when price breaches invalidation after engagement', () => {
    const atLevel = makeSetup({ state: 'at_level' })
    const r1 = transition(baseInput({ setup: atLevel, price: 5.0 }))
    const stillDetected = makeSetup({ state: 'at_level' })
    const r2 = transition(baseInput({ setup: stillDetected, record: r1.record, price: 4.85, now: 1_000_500 }))
    expect(r2.record.state).toBe('failed')
    expect(r2.alert?.kind).toBe('failed')
  })

  it('short setup fails when price rises above invalidation', () => {
    const short = makeSetup({ direction: 'short', type: 'resistance_rejection', invalidation: 5.1, state: 'at_level' })
    const r1 = transition(baseInput({ setup: short, price: 5.0 }))
    const r2 = transition(baseInput({ setup: makeSetup({ direction: 'short', type: 'resistance_rejection', invalidation: 5.1, state: 'at_level' }), record: r1.record, price: 5.2, now: 1_000_500 }))
    expect(r2.record.state).toBe('failed')
  })
})

// ── Zone leave / return re-alert ─────────────────────────────────────────────

describe('state machine — zone re-entry', () => {
  it('re-alerts level_reached after price leaves and returns to the zone', () => {
    const atLevel = makeSetup({ state: 'at_level' })
    const r1 = transition(baseInput({ setup: atLevel, price: 5.0 }))
    expect(r1.alert?.kind).toBe('level_reached')
    // Price leaves the zone (above), state falls back to approaching
    const away = makeSetup({ state: 'approaching', distanceToZonePct: 1.2 })
    const r2 = transition(baseInput({ setup: away, record: r1.record, price: 5.12, now: 1_000_200 }))
    expect(r2.record.inZone).toBe(false)
    // Price returns to the zone → level_reached should fire again
    const back = makeSetup({ state: 'at_level' })
    const r3 = transition(baseInput({ setup: back, record: r2.record, price: 5.0, now: 1_200_000 }))
    expect(r3.alert?.kind).toBe('level_reached')
  })
})

// ── Score upgrade ────────────────────────────────────────────────────────────

describe('state machine — score upgrade', () => {
  it('emits a score_upgrade when score jumps materially in the same state', () => {
    const atLevel = makeSetup({ state: 'at_level', score: 78 })
    const r1 = transition(baseInput({ setup: atLevel, price: 5.0, now: 1_000_000 }))
    const upgraded = makeSetup({ state: 'at_level', score: 86, grade: 'A' })
    const r2 = transition(baseInput({ setup: upgraded, record: r1.record, price: 5.0, now: 1_200_000 }))
    expect(r2.alert?.kind).toBe('score_upgrade')
    expect(r2.alert?.score).toBe(86)
  })
})

// ── Filters / caps / stale data ──────────────────────────────────────────────

describe('state machine — gating', () => {
  it('suppresses alerts below the minimum score but still tracks state', () => {
    const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, minScore: 90 }
    const setup = makeSetup({ state: 'at_level', score: 80 })
    const { record, alert } = transition(baseInput({ setup, settings, price: 5.0 }))
    expect(alert).toBeNull()
    expect(record.state).toBe('at_level') // state advances even when alert gated
  })

  it('respects maxAlertsPerTicker', () => {
    const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, maxAlertsPerTicker: 1 }
    const r1 = transition(baseInput({ setup: makeSetup({ state: 'approaching', distanceToZonePct: 0.8 }), settings, price: 5.04, now: 1_000_000 }))
    expect(r1.alert).not.toBeNull()
    const r2 = transition(baseInput({ setup: makeSetup({ state: 'at_level' }), record: r1.record, settings, price: 5.0, now: 1_200_000 }))
    expect(r2.alert).toBeNull() // cap reached
  })

  it('propagates the delayed flag into alerts so the UI can label stale data', () => {
    const setup = makeSetup({ state: 'at_level' })
    const { alert } = transition(baseInput({ setup, price: 5.0, delayed: true, dataAgeMs: 200_000 }))
    expect(alert?.delayed).toBe(true)
    expect(alert?.dataAgeMs).toBe(200_000)
  })

  it('does not alert outside the configured session window', () => {
    const settings: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, premarketAlerts: false }
    const setup = makeSetup({ state: 'approaching', distanceToZonePct: 0.8 })
    const { alert } = transition(baseInput({ setup, settings, session: 'premarket', price: 5.04 }))
    expect(alert).toBeNull()
  })
})

// ── Restart restoration ──────────────────────────────────────────────────────

describe('state machine — restart restoration', () => {
  it('continues from a persisted record after an app restart', () => {
    // Simulate a record rehydrated from localStorage
    const persisted: SetupStateRecord = {
      id: 'TEST:pullback:5.00',
      symbol: 'TEST',
      type: 'pullback',
      state: 'at_level',
      score: 78,
      grade: 'B+',
      zoneMidpoint: 5.0,
      inZone: true,
      lastState: 'approaching',
      lastScore: 78,
      lastAlertAt: 1_000_000,
      alertsSent: 2,
      firstSeenAt: 999_000,
      updatedAt: 1_000_000,
      alertedStates: ['approaching', 'at_level'],
    }
    // After restart the same setup is re-detected and confirms
    const confirming = makeSetup({ state: 'confirming', score: 84, grade: 'A-' })
    const { record, alert } = transition(baseInput({ setup: confirming, record: persisted, price: 5.0, now: 1_500_000 }))
    expect(record.alertsSent).toBe(3)
    expect(alert?.kind).toBe('confirming')
    // Prior alerted states preserved (no duplicate level_reached)
    expect(record.alertedStates).toContain('approaching')
    expect(record.alertedStates).toContain('at_level')
    expect(record.alertedStates).toContain('confirming')
  })
})
