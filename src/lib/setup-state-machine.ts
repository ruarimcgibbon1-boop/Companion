/**
 * Setup state machine.
 *
 * Pure, deterministic transition logic. Given the previous persisted record for
 * a setup and the newest detection, it decides the new state and whether an
 * alert should fire — distinguishing:
 *   approaching (early warning) → at level → confirming → triggered → failed.
 *
 * Deduplication rules ensure we don't repeat the same notification while price
 * sits in a zone. A new alert is generated only when:
 *   - the state advances,
 *   - the score changes materially,
 *   - the setup invalidates,
 *   - or price leaves and later re-enters the zone.
 */

import type {
  DetectedSetup, SetupStateRecord, MonitorAlert, MonitorAlertKind,
  NotificationSettings, SetupState,
} from '@/types'
import { SETUP_TYPE_LABELS, SETUP_STATE_LABELS } from '@/types'

const ORDER: Record<SetupState, number> = {
  identified: 0, approaching: 1, at_level: 2, confirming: 3, triggered: 4,
  failed: -1, expired: -2,
}

export interface TransitionInput {
  record: SetupStateRecord | null
  setup: DetectedSetup
  price: number
  settings: NotificationSettings
  session: string           // SessionType
  dataAgeMs: number
  delayed: boolean
  now: number
}

export interface TransitionResult {
  record: SetupStateRecord
  alert: MonitorAlert | null
}

function sessionAllowed(session: string, s: NotificationSettings): boolean {
  if (session === 'premarket') return s.premarketAlerts
  if (session === 'regular') return s.regularHoursAlerts
  if (session === 'afterhours' || session === 'overnight') return s.afterHoursAlerts
  return false
}

function passesFilters(setup: DetectedSetup, s: NotificationSettings, session: string): boolean {
  if (!s.enabled) return false
  if (!s.setupTypes[setup.type]) return false
  if (setup.direction === 'long' && !s.allowLong) return false
  if (setup.direction === 'short' && !s.allowShort) return false
  if (setup.score < s.minScore) return false
  if (!sessionAllowed(session, s)) return false
  return true
}

function invalidationBreached(setup: DetectedSetup, price: number): boolean {
  return setup.direction === 'long'
    ? price < setup.invalidation
    : price > setup.invalidation
}

function alertKindFor(state: SetupState): MonitorAlertKind | null {
  switch (state) {
    case 'approaching': return 'early_warning'
    case 'at_level': return 'level_reached'
    case 'confirming': return 'confirming'
    case 'triggered': return 'triggered'
    case 'failed': return 'failed'
    default: return null
  }
}

function buildAlertText(setup: DetectedSetup, kind: MonitorAlertKind, price: number): { title: string; body: string } {
  const typeLabel = SETUP_TYPE_LABELS[setup.type]
  const zone = `$${setup.zoneLower.toFixed(2)}–$${setup.zoneUpper.toFixed(2)}`
  const grade = setup.grade === 'below' ? '' : ` (${setup.grade})`
  switch (kind) {
    case 'early_warning':
      return {
        title: `${setup.symbol} approaching ${typeLabel} zone`,
        body: `${setup.symbol} is approaching the ${zone} ${typeLabel.toLowerCase()} zone. ${setup.rationale} Score ${setup.score}/100${grade}. ${setup.confirmation[0]}.`,
      }
    case 'level_reached':
      return {
        title: `${setup.symbol} at ${typeLabel} level`,
        body: `${setup.symbol} entered ${zone}. Price $${price.toFixed(2)}. Confirmation needed: ${setup.confirmation.join('; ')}. Invalidation: $${setup.invalidation.toFixed(2)}.`,
      }
    case 'confirming':
      return {
        title: `${setup.symbol} ${typeLabel} confirming`,
        body: `${setup.symbol} is beginning to confirm at ${zone}. Score ${setup.score}/100${grade}. Next: $${(setup.targets[0]?.price ?? setup.nextIfHolds ?? price).toFixed(2)}.`,
      }
    case 'triggered':
      return {
        title: `${setup.symbol} ${typeLabel} TRIGGERED`,
        body: `${setup.symbol} ${typeLabel.toLowerCase()} triggered at $${price.toFixed(2)}. Targets: ${setup.targets.slice(0, 2).map(t => `$${t.price.toFixed(2)}`).join(' → ') || 'n/a'}. Stop ref $${setup.stopReference.toFixed(2)}.`,
      }
    case 'failed':
      return {
        title: `${setup.symbol} ${typeLabel} invalidated`,
        body: `${setup.symbol} ${typeLabel.toLowerCase()} invalidated — lost $${setup.invalidation.toFixed(2)}. ${setup.nextIfFails ? `Next level: $${setup.nextIfFails.toFixed(2)}.` : ''}`,
      }
    case 'score_upgrade':
      return {
        title: `${setup.symbol} ${typeLabel} upgraded`,
        body: `${setup.symbol} ${typeLabel.toLowerCase()} score upgraded to ${setup.score}/100${grade} — ${SETUP_STATE_LABELS[setup.state]}.`,
      }
  }
}

function makeAlert(
  setup: DetectedSetup, kind: MonitorAlertKind, price: number, now: number,
  dataAgeMs: number, delayed: boolean
): MonitorAlert {
  const { title, body } = buildAlertText(setup, kind, price)
  return {
    id: `${setup.id}:${kind}:${Math.floor(now / 1000)}`,
    symbol: setup.symbol,
    setupId: setup.id,
    kind,
    setupType: setup.type,
    direction: setup.direction,
    state: setup.state,
    score: setup.score,
    grade: setup.grade,
    title,
    body,
    price,
    zoneLower: setup.zoneLower,
    zoneUpper: setup.zoneUpper,
    confirmation: setup.confirmation,
    invalidation: setup.invalidation,
    targets: setup.targets,
    risks: setup.keyRisks,
    timestamp: now,
    dataAgeMs,
    delayed,
    read: false,
  }
}

export function transition(input: TransitionInput): TransitionResult {
  const { record, setup, price, settings, session, dataAgeMs, delayed, now } = input

  const inZone = price >= setup.zoneLower && price <= setup.zoneUpper

  // Base new state = detector's observed state, unless invalidation breached after engagement.
  let newState: SetupState = setup.state
  const wasEngaged = record ? ORDER[record.state] >= ORDER.at_level : false
  if ((wasEngaged || setup.state === 'triggered') && invalidationBreached(setup, price)) {
    newState = 'failed'
  }

  // Initialise record if new.
  const base: SetupStateRecord = record ?? {
    id: setup.id,
    symbol: setup.symbol,
    type: setup.type,
    state: 'identified',
    score: setup.score,
    grade: setup.grade,
    zoneMidpoint: setup.zoneMidpoint,
    inZone: false,
    lastState: 'identified',
    lastScore: setup.score,
    lastAlertAt: null,
    alertsSent: 0,
    firstSeenAt: now,
    updatedAt: now,
    alertedStates: [],
  }

  // Zone re-entry: if price left the zone since we last engaged, clear the
  // "engaged" alerted states so they can fire again on return.
  let alertedStates = [...base.alertedStates]
  if (base.inZone && !inZone) {
    alertedStates = alertedStates.filter(s => ORDER[s] < ORDER.at_level)
  }

  // Decide whether to emit an alert.
  let alert: MonitorAlert | null = null
  const gated = !passesFilters(setup, settings, session)
  const overCap = base.alertsSent >= settings.maxAlertsPerTicker
  const kind = alertKindFor(newState)

  const withinCooldown = base.lastAlertAt != null && now - base.lastAlertAt < settings.cooldownMs

  // A genuine forward transition to a state we haven't alerted yet is always
  // meaningful new information — it fires regardless of cooldown (each state
  // still alerts at most once per zone visit via alertedStates dedup). The
  // cooldown only throttles same-state score re-alerts, which can otherwise
  // repeat while price sits in the zone.
  const advanced = ORDER[newState] > ORDER[base.state] || newState === 'failed'
  const alreadyAlertedThisState = alertedStates.includes(newState)
  const materialScoreJump = newState === base.state && ORDER[newState] >= ORDER.at_level &&
    setup.score - base.lastScore >= settings.scoreChangeThreshold

  if (kind && !gated && !overCap) {
    if (advanced && !alreadyAlertedThisState) {
      alert = makeAlert(setup, kind, price, now, dataAgeMs, delayed)
      alertedStates.push(newState)
    } else if (materialScoreJump && !withinCooldown) {
      alert = makeAlert(setup, 'score_upgrade', price, now, dataAgeMs, delayed)
    }
  }

  const updated: SetupStateRecord = {
    ...base,
    state: newState,
    score: setup.score,
    grade: setup.grade,
    zoneMidpoint: setup.zoneMidpoint,
    inZone,
    lastState: base.state,
    lastScore: alert ? setup.score : base.lastScore,
    lastAlertAt: alert ? now : base.lastAlertAt,
    alertsSent: base.alertsSent + (alert ? 1 : 0),
    updatedAt: now,
    alertedStates,
  }

  return { record: updated, alert }
}
