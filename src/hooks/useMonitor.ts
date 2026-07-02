'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { transition } from '@/lib/setup-state-machine'
import type { MonitorResult, DetectedSetup, MonitorAlert, SetupLog, SetupStateRecord } from '@/types'

const MONITOR_INTERVAL = 25_000  // 25s — scanner-wide sweep

// ── Notification side-effects ───────────────────────────────────────────────

function sendBrowserNotification(a: MonitorAlert) {
  if (typeof window === 'undefined') return
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  new Notification(a.title, {
    body: a.body,
    icon: '/favicon.ico',
    tag: `${a.symbol}-${a.setupType}-${a.kind}`,
    requireInteraction: a.kind === 'triggered',
  })
}

let audioCtx: AudioContext | null = null
function playAlertSound(kind: MonitorAlert['kind']) {
  if (typeof window === 'undefined') return
  try {
    audioCtx = audioCtx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain); gain.connect(audioCtx.destination)
    osc.frequency.value = kind === 'triggered' ? 880 : kind === 'failed' ? 300 : 620
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35)
    osc.start(); osc.stop(audioCtx.currentTime + 0.36)
  } catch { /* audio unavailable */ }
}

// ── Universe gathering ──────────────────────────────────────────────────────

function gatherUniverse(): string[] {
  const s = useTradingStore.getState()
  const set = new Set<string>()
  const scope = s.notificationSettings.scope

  // Watchlist + open positions + selected + recent searches are always monitored.
  for (const w of s.watchlist) set.add(w.symbol)
  for (const p of s.positions) if (p.status !== 'closed') set.add(p.symbol)
  if (s.selectedSymbol) set.add(s.selectedSymbol)
  for (const sym of s.searchedSymbols.slice(0, 10)) set.add(sym)

  // Scanner-wide mode also folds in every scanner row.
  if (scope === 'scanner') {
    for (const r of s.scannerRows) set.add(r.symbol)
  }
  return [...set].slice(0, 40)
}

// ── Setup log helpers ───────────────────────────────────────────────────────

function ensureLog(setup: DetectedSetup, price: number, session: string, now: number): SetupLog {
  const existing = useTradingStore.getState().setupLogs.find(l => l.id === setup.id)
  if (existing) return existing
  return {
    id: setup.id,
    symbol: setup.symbol,
    type: setup.type,
    direction: setup.direction,
    identifiedAt: now,
    priceAtIdentification: price,
    zoneLower: setup.zoneLower,
    zoneUpper: setup.zoneUpper,
    score: setup.score,
    grade: setup.grade,
    confirmation: setup.confirmation,
    invalidation: setup.invalidation,
    targets: setup.targets,
    statesReached: [setup.state],
    maxFavorablePrice: price,
    maxAdversePrice: price,
    maxFavorablePct: 0,
    maxAdversePct: 0,
    outcome: 'open',
    outcomeReason: null,
    triggeredAt: null,
    resolvedAt: null,
    relativeVolumeAtId: null,
    sessionAtId: session,
    testCount: setup.testCount,
  }
}

function updateLog(log: SetupLog, setup: DetectedSetup, rec: SetupStateRecord, price: number, now: number): SetupLog {
  const dir = setup.direction === 'long' ? 1 : -1
  const favor = dir === 1 ? Math.max(log.maxFavorablePrice, price) : Math.min(log.maxFavorablePrice, price)
  const adverse = dir === 1 ? Math.min(log.maxAdversePrice, price) : Math.max(log.maxAdversePrice, price)
  const base = log.priceAtIdentification || price
  const statesReached = log.statesReached.includes(rec.state) ? log.statesReached : [...log.statesReached, rec.state]

  let outcome = log.outcome
  let outcomeReason = log.outcomeReason
  let resolvedAt = log.resolvedAt
  let triggeredAt = log.triggeredAt

  if (rec.state === 'triggered' && !triggeredAt) triggeredAt = now
  if (outcome === 'open') {
    const firstTarget = setup.targets[0]?.price
    const hitTarget = firstTarget != null && (dir === 1 ? price >= firstTarget : price <= firstTarget)
    if (rec.state === 'failed') { outcome = 'invalidated'; outcomeReason = `Lost ${setup.invalidation.toFixed(2)}`; resolvedAt = now }
    else if (hitTarget) { outcome = 'target_hit'; outcomeReason = `Reached T1 ${firstTarget!.toFixed(2)}`; resolvedAt = now }
  }

  return {
    ...log,
    score: setup.score,
    grade: setup.grade,
    statesReached,
    maxFavorablePrice: favor,
    maxAdversePrice: adverse,
    maxFavorablePct: base > 0 ? ((favor - base) / base) * 100 * dir : 0,
    maxAdversePct: base > 0 ? ((adverse - base) / base) * 100 * dir : 0,
    outcome,
    outcomeReason,
    triggeredAt,
    resolvedAt,
  }
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useMonitor() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)

  const runSweep = useCallback(async () => {
    if (inFlight.current) return
    const store = useTradingStore.getState()
    if (!store.notificationSettings.enabled && store.notificationSettings.scope !== 'scanner') {
      // still run for panels, but skip if fully disabled + not needed — keep running for panels
    }
    const symbols = gatherUniverse()
    if (symbols.length === 0) return

    inFlight.current = true
    store.setMonitorRunning(true)
    try {
      const res = await fetch('/api/monitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
      })
      if (!res.ok) return
      const data = await res.json() as { results: MonitorResult[]; timestamp: number }
      const results = data.results ?? []

      const s = useTradingStore.getState()
      const settings = s.notificationSettings
      const now = Date.now()
      const allSetups: DetectedSetup[] = []

      for (const r of results) {
        s.setKeyLevels(r.symbol, r.levels)
        s.setRoadmap(r.symbol, r.roadmap)
        s.setMonitorMeta(r.symbol, r.integrity)

        for (const setup of r.setups) {
          allSetups.push(setup)

          // Only track/alert setups that clear the display floor.
          const meetsLevel = (setup.breakdown.levelQuality / 20) * 100 >= settings.minLevelStrength * 0.2 || setup.confidence >= settings.minLevelStrength
          if (setup.score < 55 && !meetsLevel) continue

          const prevRec = s.setupStates[setup.id] ?? null
          const { record, alert } = transition({
            record: prevRec,
            setup,
            price: r.price,
            settings,
            session: r.integrity.session,
            dataAgeMs: r.integrity.ageMs,
            delayed: r.integrity.delayed,
            now,
          })
          s.setSetupState(setup.id, record)

          // Performance log
          let log = ensureLog(setup, r.price, r.integrity.session, record.firstSeenAt)
          log = updateLog(log, setup, record, r.price, now)
          s.upsertSetupLog(log)

          if (alert) {
            s.addMonitorAlert(alert)
            if (settings.inApp) { /* already stored */ }
            if (settings.browserNotifications && !alert.delayed) sendBrowserNotification(alert)
            if (settings.sound) playAlertSound(alert.kind)
          }
        }
      }

      // Publish the ranked opportunity list (display floor: score ≥ minScore-ish / C+).
      const ranked = allSetups
        .filter(su => su.score >= Math.min(settings.minScore, 60))
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
      s.setMonitoredSetups(ranked)
      s.setLastMonitorTime(now)
    } catch {
      /* network error — keep last state */
    } finally {
      inFlight.current = false
      useTradingStore.getState().setMonitorRunning(false)
    }
  }, [])

  // Request notification permission once.
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [])

  useEffect(() => {
    runSweep()
    timerRef.current = setInterval(runSweep, MONITOR_INTERVAL)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [runSweep])

  return { runSweep }
}
