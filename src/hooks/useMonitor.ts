'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { transition } from '@/lib/setup-state-machine'
import { patternLogId, shouldLogPattern } from '@/lib/pattern-log-gate'
// The buy-log GATE STACK is imported, never re-declared here. A local copy of the
// gates is exactly how the client and the daemon/backtest drift apart, so this file
// calls the shared classifyBuy / passesTrackingFloor directly (buy-log.ts is
// browser-safe). Every gate's rationale lives there.
import { classifyBuy, passesTrackingFloor, type BuyVerdict } from '@/lib/buy-log'
import type { MonitorResult, DetectedSetup, MonitorAlert, SetupLog, SetupStateRecord, BuySignalRecord, MonitorFunnel, PatternLogRecord } from '@/types'

// Pattern-log admission (dedup on price, close cutoff, falling-knife guard) lives
// in pattern-log-gate.ts. The old ~10-min time bucket re-logged a persisting hit
// every bucket, which against a stale quote never terminated.

// Map a dropped-BUY verdict from classifyBuy to its signal-funnel counter, so a
// 0-signal day stays legible (which gate ate the triggers).
const FUNNEL_BUCKET: Record<Exclude<BuyVerdict, 'logged'>, keyof MonitorFunnel> = {
  session: 'droppedSession', volume: 'droppedVolume', veto: 'droppedVeto',
  standDown: 'droppedStandDown', capped: 'droppedCapped', dup: 'droppedDup',
}

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

// Fire-and-forget: the server route no-ops when Telegram isn't configured and
// dedups replays, so the sweep never blocks or double-texts.
function sendTelegramAlert(b: BuySignalRecord) {
  fetch('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signal: b }),
  }).catch(() => { /* alert delivery is best-effort */ })
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

// Focus the scanner-fed universe on the day's top gainers — that's where the
// momentum edge is, and it keeps the sweep tight (2026-08-03: user "only focus on
// the top 15 gainers"). Explicit picks (watchlist / open positions / selected) are
// still monitored on top.
const TOP_GAINERS_UNIVERSE = 15

function gatherUniverse(): string[] {
  const s = useTradingStore.getState()
  const set = new Set<string>()
  const scope = s.notificationSettings.scope

  // Watchlist + open positions + selected + recent searches are always monitored.
  for (const w of s.watchlist) set.add(w.symbol)
  for (const p of s.positions) if (p.status !== 'closed') set.add(p.symbol)
  if (s.selectedSymbol) set.add(s.selectedSymbol)
  for (const sym of s.searchedSymbols.slice(0, 10)) set.add(sym)

  // Scanner-wide mode folds in the TOP N gainers by day change — not every row.
  if (scope === 'scanner') {
    const topGainers = [...s.scannerRows].sort((a, b) => b.changePct - a.changePct).slice(0, TOP_GAINERS_UNIVERSE)
    for (const r of topGainers) set.add(r.symbol)
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

/**
 * Advance a setup log with the latest price.
 *
 * A RESOLVED log is frozen: once the stop or T1 is hit, its result fields stop
 * moving. Without this the excursion metrics kept ratcheting on every later sweep,
 * so a stopped-out trade on a name that then ran showed a huge maxFavorablePct and
 * read at review time like a missed winner rather than a loss (2026-08-13: FGI
 * stopped at −6.5% and then ran ~100%, which would have logged a ~100% MFE against
 * a trade we were never in). The trade is over; what price did afterwards is not
 * part of its record.
 *
 * The resolving sweep itself still counts — `favor`/`adverse` include the bar that
 * triggered the exit, matching eod-resolver, which walks up to and including the
 * stop bar before breaking. Only LATER sweeps are ignored.
 */
export function updateLog(log: SetupLog, setup: DetectedSetup, rec: SetupStateRecord, price: number, now: number): SetupLog {
  // Already resolved on entry → freeze everything but the state trail.
  if (log.outcome !== 'open') {
    const seen = log.statesReached.includes(rec.state)
      ? log.statesReached
      : [...log.statesReached, rec.state]
    return seen === log.statesReached ? log : { ...log, statesReached: seen }
  }
  const dir = setup.direction === 'long' ? 1 : -1
  const favor = dir === 1 ? Math.max(log.maxFavorablePrice, price) : Math.min(log.maxFavorablePrice, price)
  const adverse = dir === 1 ? Math.min(log.maxAdversePrice, price) : Math.max(log.maxAdversePrice, price)
  const base = log.priceAtIdentification || price
  const statesReached = log.statesReached.includes(rec.state) ? log.statesReached : [...log.statesReached, rec.state]

  // Explicitly typed: the early return above narrows log.outcome to 'open', so an
  // inferred type would reject the assignments below.
  let outcome: SetupLog['outcome'] = log.outcome
  let outcomeReason: SetupLog['outcomeReason'] = log.outcomeReason
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

// The buy-signal dedup, failed-bounce stand-down, and per-symbol trade cap that
// used to be re-declared here now live (with their full evidence trail) in
// buy-log.ts and run inside classifyBuy. Removing the local copies is the point of
// this refactor: one decision engine, no drift.

// ── Hook ────────────────────────────────────────────────────────────────────

export function useMonitor() {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inFlight = useRef(false)

  const runSweep = useCallback(async () => {
    if (inFlight.current) return
    // Runs even when the tab is backgrounded — this is an always-on alerting
    // engine, so it MUST keep detecting (and firing browser notifications) while
    // you're looking elsewhere. Previously it paused on document.hidden, which
    // meant a Companion sitting in a background tab did zero sweeps all session
    // and printed 0 signals (2026-07-24/27). Browsers throttle background timers
    // to ~once/minute on their own, which is plenty for signal detection.
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
      const symbolPatterns: Record<string, typeof results[number]['patterns']> = {}
      const setupStates: Record<string, SetupStateRecord> = {}
      const logMap = new Map(s.setupLogs.map(l => [l.id, l]))
      const changedLogs: SetupLog[] = []
      const newAlerts: MonitorAlert[] = []
      const newBuySignals: BuySignalRecord[] = []
      const newPatternLogs: PatternLogRecord[] = []
      const loggedPatternIds = new Set(s.patternLog.map(r => r.id))

      // Signal funnel: count where candidates die this sweep, so a 0-signal day
      // is legible (scanned → detected → cleared floor → triggered → logged).
      const funnel: MonitorFunnel = {
        timestamp: now, scanned: results.length, symbolsWithSetups: 0, rawSetups: 0,
        belowFloor: 0, tracked: 0, byState: {}, triggered: 0,
        droppedSession: 0, droppedVolume: 0, droppedVeto: 0, droppedStandDown: 0, droppedCapped: 0, droppedDup: 0, logged: 0,
      }

      for (const r of results) {
        keyLevels[r.symbol] = r.levels
        roadmaps[r.symbol] = r.roadmap
        meta[r.symbol] = r.integrity
        symbolSetups[r.symbol] = r.setups
        if (r.patterns && r.patterns.length > 0) {
          symbolPatterns[r.symbol] = r.patterns
          // Log each occurrence to build the dataset — but only occurrences worth
          // something at review time. Admission rules live in pattern-log-gate.ts
          // so they're testable; see there for the evidence behind each one.
          for (const p of r.patterns) {
            const id = patternLogId(r.symbol, p.pattern, r.price)
            const verdict = shouldLogPattern(id, { now, changePct: r.changePct, loggedIds: loggedPatternIds })
            if (!verdict.log) continue
            loggedPatternIds.add(id)
            newPatternLogs.push({
              id, timestamp: now, symbol: r.symbol, pattern: p.pattern,
              strength: p.strength, atSupport: p.atSupport, volumeConfirmed: p.volumeConfirmed,
              price: r.price, changePct: r.changePct, rvol: r.relativeVolume,
              outcome: 'open', mfePct: null, maePct: null, resolvedAt: null,
            })
          }
        }
        if (r.setups.length > 0) funnel.symbolsWithSetups++
        funnel.rawSetups += r.setups.length

        for (const setup of r.setups) {
          allSetups.push(setup)

          // Only track/alert setups that clear the display floor (shared with the replay).
          if (!passesTrackingFloor(setup, settings.minLevelStrength)) { funnel.belowFloor++; continue }
          funnel.tracked++
          funnel.byState[setup.state] = (funnel.byState[setup.state] ?? 0) + 1

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

          // Buy Log: classify every triggered long through the SHARED gate stack
          // (classifyBuy in buy-log.ts) — the exact same module the alert daemon,
          // backtest, diagnose, and recall call, so the client's BUY/drop decision
          // cannot drift from the replay's. The full rationale for each gate (the
          // dropped-veto policy, the reverted strong-continuation override, the
          // restored per-symbol cap, the late-session cutoff) lives in buy-log.ts.
          if (setup.direction === 'long' && setup.triggeredRaw) {
            funnel.triggered++
            const allBuys = [...s.buySignals, ...newBuySignals]
            const allStates = [...Object.values(s.setupStates), ...Object.values(setupStates)]
            const { verdict, buy } = classifyBuy(setup, r, {
              now, priorBuys: allBuys, priorLogs: [...logMap.values()], priorStates: allStates,
            })
            if (verdict === 'logged' && buy) {
              funnel.logged++
              newBuySignals.push(buy)
              sendTelegramAlert(buy)
            } else if (verdict !== 'logged') {
              funnel[FUNNEL_BUCKET[verdict]]++
            }
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

      s.ingestMonitorSweep({ keyLevels, roadmaps, meta, symbolSetups, symbolPatterns, setupStates, logs: changedLogs, alerts: newAlerts, buySignals: newBuySignals, ranked, funnel, patternLogs: newPatternLogs, now })
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
    // Re-sweep immediately on refocus so you see fresh data the instant you look
    // back (the background interval is throttled to ~1/min, so this closes the gap).
    const onVisible = () => { if (!document.hidden) runSweep() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [runSweep])

  return { runSweep }
}
