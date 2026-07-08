'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { transition } from '@/lib/setup-state-machine'
import type { MonitorResult, DetectedSetup, MonitorAlert, SetupLog, SetupStateRecord, BuySignalRecord } from '@/types'

// Scanner-wide sweep cadence. Aligned to the 15s QUOTE cache TTL: each sweep
// lands on a freshly-expired quote so price-driven triggers react as fast as the
// upstream data allows. Going lower re-reads the same cached quote (no fresher
// price) unless TTL.QUOTE is also shortened — which multiplies API calls.
const MONITOR_INTERVAL = 15_000

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

function ensureLog(setup: DetectedSetup, price: number, session: string, now: number, existing: SetupLog | undefined): SetupLog {
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

// ── Buy-signal de-duplication ────────────────────────────────────────────────
// The scanner re-fires the same idea on every poll and across sibling detectors
// (e.g. JLHL logged 12 near-identical BUYs on 2026-07-07 as ema9/ema21/pullback
// all triggered into the same rollover). Keep the FIRST fire per symbol + entry
// cluster within a cooldown window; suppress the rest so the log reflects one
// tradeable idea, not the poll cadence.
const ENTRY_SIMILARITY_PCT = 0.03            // entries within 3% ⇒ the same idea
const BUY_DEDUP_COOLDOWN_MS = 45 * 60 * 1000 // 45 minutes

function isDuplicateBuy(sym: string, entryHigh: number, now: number, prior: BuySignalRecord[]): boolean {
  for (const b of prior) {
    if (b.symbol !== sym) continue
    if (now - b.timestamp > BUY_DEDUP_COOLDOWN_MS) continue
    if (b.entryHigh > 0 && Math.abs(entryHigh - b.entryHigh) / b.entryHigh < ENTRY_SIMILARITY_PCT) return true
  }
  return false
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useMonitor() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)

  const runSweep = useCallback(async () => {
    if (inFlight.current) return
    // Pause when the tab is backgrounded — no point sweeping what nobody's watching.
    if (typeof document !== 'undefined' && document.hidden) return
    const store = useTradingStore.getState()
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

      // Accumulate the whole sweep locally, then commit in a SINGLE store write
      // (previously this made 500+ set() calls per sweep — the main lag source).
      const keyLevels: Record<string, typeof results[number]['levels']> = {}
      const roadmaps: Record<string, typeof results[number]['roadmap']> = {}
      const meta: Record<string, typeof results[number]['integrity']> = {}
      const symbolSetups: Record<string, DetectedSetup[]> = {}
      const setupStates: Record<string, SetupStateRecord> = {}
      const logMap = new Map(s.setupLogs.map(l => [l.id, l]))
      const changedLogs: SetupLog[] = []
      const newAlerts: MonitorAlert[] = []
      const newBuySignals: BuySignalRecord[] = []

      for (const r of results) {
        keyLevels[r.symbol] = r.levels
        roadmaps[r.symbol] = r.roadmap
        meta[r.symbol] = r.integrity
        symbolSetups[r.symbol] = r.setups

        for (const setup of r.setups) {
          allSetups.push(setup)

          // Only track/alert setups that clear the display floor.
          const meetsLevel = (setup.breakdown.levelQuality / 20) * 100 >= settings.minLevelStrength * 0.2 || setup.confidence >= settings.minLevelStrength
          if (setup.score < 55 && !meetsLevel) continue

          const prevRec = setupStates[setup.id] ?? s.setupStates[setup.id] ?? null
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
          setupStates[setup.id] = record

          // Performance log
          let log = ensureLog(setup, r.price, r.integrity.session, record.firstSeenAt, logMap.get(setup.id))
          log = updateLog(log, setup, record, r.price, now)
          logMap.set(setup.id, log)
          changedLogs.push(log)

          // Buy Log: record EVERY long geometric trigger for end-of-day review —
          // winners and losers alike, independent of the notification session gate
          // and independent of the quality veto (which only shapes what the user is
          // told to ACT on). Vetoed triggers are logged but `flagged` so they can be
          // segmented at review. The per-symbol entry-cluster dedup still collapses
          // the poll/detector spam so one idea logs once.
          if (
            setup.direction === 'long' && setup.triggeredRaw &&
            !isDuplicateBuy(setup.symbol, setup.zoneUpper, now, [...s.buySignals, ...newBuySignals])
          ) {
            // Record the fill you'd get entering on the trigger, and an R/R honest
            // to that entry — not the (often unreachable) zone bottom.
            const fill = setup.entryFill ?? setup.zoneUpper
            const t1 = setup.targets[0]?.price ?? null
            const rr = t1 != null && fill > setup.stopReference
              ? Math.round(((t1 - fill) / (fill - setup.stopReference)) * 10) / 10
              : setup.rewardRisk
            newBuySignals.push({
              id: `${setup.id}:triggered:${Math.floor(now / 1000)}`,
              setupId: setup.id,
              symbol: setup.symbol,
              timestamp: now,
              setupType: setup.type,
              triggerPrice: setup.signal.triggerPrice ?? setup.zoneUpper,
              entryLow: setup.zoneLower,
              entryHigh: fill,
              invalidation: setup.invalidation,
              stop: setup.stopReference,
              targets: setup.targets.map(t => t.price),
              score: setup.score,
              grade: setup.grade,
              rewardRisk: rr,
              priceAtSignal: r.price,
              flagged: setup.qualityVetoed ?? false,
            })
          }

          if (alert) {
            newAlerts.push(alert)
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

      s.ingestMonitorSweep({ keyLevels, roadmaps, meta, symbolSetups, setupStates, logs: changedLogs, alerts: newAlerts, buySignals: newBuySignals, ranked, now })
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
    // Re-sweep immediately when the tab regains focus (it was paused while hidden).
    const onVisible = () => { if (!document.hidden) runSweep() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [runSweep])

  return { runSweep }
}
