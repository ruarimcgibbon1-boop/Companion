'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { transition } from '@/lib/setup-state-machine'
import type { MonitorResult, DetectedSetup, MonitorAlert, SetupLog, SetupStateRecord, BuySignalRecord, SetupType, MonitorFunnel } from '@/types'

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

// After a long bounce on a symbol hits its invalidation, the *next* bounce on
// that name is disproportionately another failure (2026-07-09: SKYQ/DCX/IOTR
// each bounced again after failing and lost again — ~38% of the day's losses
// were chop names re-bounced). Stand the symbol's bounce setups down for a
// cooldown; momentum breakouts are unaffected (a name can break out after a
// failed bounce).
// 2h covers the observed same-session re-fire gaps (today's chop re-bounces were
// 47–97 min after the first failure); the overnight gap keeps a prior-day failure
// from carrying into a new session.
const STANDDOWN_MS = 120 * 60 * 1000
const BOUNCE_TYPES = new Set<SetupType>(['pullback', 'vwap_bounce', 'vwap_reclaim', 'ema9_bounce', 'ema21_bounce'])

function recentlyFailedBounce(sym: string, now: number, states: SetupStateRecord[]): boolean {
  return states.some(r =>
    r.symbol === sym && r.state === 'failed' && BOUNCE_TYPES.has(r.type) &&
    now - r.updatedAt < STANDDOWN_MS)
}

// ── Per-symbol trade cap ─────────────────────────────────────────────────────
// The failed-bounce stand-down above only arms on *bounce* failures and only
// blocks *bounce* re-fires. 2026-07-13 BRAI slipped straight through it: BRAI
// isn't a bounce name, it fired 6× as momentum, blew off to $11.33, and after
// its 11:07 entry was flagged-then-failed the scanner still re-fired at 11:16
// and 11:17 for −5.7% / −4.5%. So cap re-firing on the *symbol*, any setup type:
//   • one losing entry — INCLUDING an entry we only flagged (qualityVetoed) —
//     stands the whole name down (gap A: a flag that then hits its stop is still
//     a loss and must arm the stand-down),
//   • or two banked wins stand it down too (gap C: stop pressing a name that's
//     already paid out twice — the third+ fire is the late chase that gives it
//     back).
// The loss/win memory is read from the LATCHED setup LOG (outcome freezes once
// it goes 'invalidated'/'target_hit'), not the live setup STATE. 2026-07-14 LEDS
// showed why: it failed at 10:20/10:24, then ran back up so its setup re-armed
// OUT of 'failed' — a live-state check lost the loss memory and the 11:24 chase
// (−2.1%) slipped the cap 59 min later. The log outcome survives the re-arm, so
// the cap now holds for the whole cooldown regardless of what the name does next.
const SYMBOL_CAP_MS = 120 * 60 * 1000 // same session window as the bounce stand-down
const SYMBOL_WIN_CAP = 2

function symbolCapReached(
  sym: string,
  now: number,
  logs: SetupLog[],
  buys: BuySignalRecord[],
): boolean {
  // A loss: an entry we actually logged (present in `buys`) whose setup log has
  // since latched to 'invalidated' within the cooldown.
  const lostSetupIds = new Set(
    logs
      .filter(l => l.outcome === 'invalidated' && l.resolvedAt != null && now - l.resolvedAt < SYMBOL_CAP_MS)
      .map(l => l.id),
  )
  const hasLoss = buys.some(b => b.symbol === sym && lostSetupIds.has(b.setupId))
  if (hasLoss) return true

  const wins = logs.filter(
    l => l.symbol === sym && l.outcome === 'target_hit' && l.resolvedAt != null && now - l.resolvedAt < SYMBOL_CAP_MS,
  ).length
  return wins >= SYMBOL_WIN_CAP
}

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
      const setupStates: Record<string, SetupStateRecord> = {}
      const logMap = new Map(s.setupLogs.map(l => [l.id, l]))
      const changedLogs: SetupLog[] = []
      const newAlerts: MonitorAlert[] = []
      const newBuySignals: BuySignalRecord[] = []

      // Signal funnel: count where candidates die this sweep, so a 0-signal day
      // is legible (scanned → detected → cleared floor → triggered → logged).
      const funnel: MonitorFunnel = {
        timestamp: now, scanned: results.length, symbolsWithSetups: 0, rawSetups: 0,
        belowFloor: 0, tracked: 0, byState: {}, triggered: 0,
        droppedSession: 0, droppedVeto: 0, droppedStandDown: 0, droppedCapped: 0, droppedDup: 0, logged: 0,
      }

      for (const r of results) {
        keyLevels[r.symbol] = r.levels
        roadmaps[r.symbol] = r.roadmap
        meta[r.symbol] = r.integrity
        symbolSetups[r.symbol] = r.setups
        if (r.setups.length > 0) funnel.symbolsWithSetups++
        funnel.rawSetups += r.setups.length

        for (const setup of r.setups) {
          allSetups.push(setup)

          // Only track/alert setups that clear the display floor.
          const meetsLevel = (setup.breakdown.levelQuality / 20) * 100 >= settings.minLevelStrength * 0.2 || setup.confidence >= settings.minLevelStrength
          if (setup.score < 55 && !meetsLevel) { funnel.belowFloor++; continue }
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

          // Buy Log: record long geometric triggers for end-of-day review.
          // Quality-vetoed (flagged) triggers are NO LONGER logged: across the
          // 7/13–7/14 review every flagged entry that filled was a loss (7/14:
          // 5/5 flagged = losers, −15.4% combined), so the veto graduates from
          // "flag for review" to "drop". The per-symbol entry-cluster dedup still
          // collapses the poll/detector spam so one idea logs once.
          // Stand down a symbol's bounce setups after a bounce on it just failed.
          const allStates = [...Object.values(s.setupStates), ...Object.values(setupStates)]
          const allBuys = [...s.buySignals, ...newBuySignals]
          const standDown = BOUNCE_TYPES.has(setup.type) &&
            recentlyFailedBounce(setup.symbol, now, allStates)
          const capped = symbolCapReached(setup.symbol, now, [...logMap.values()], allBuys)
          // The fill you'd actually get entering on the trigger — not the (often
          // unreachable) zone bottom. Computed BEFORE the dedup because the dedup
          // must compare like for like: it previously passed `zoneUpper` while the
          // record stored `entryFill`, so once price ran above the zone the two
          // differed by more than the 3% similarity window and nothing deduped.
          // 2026-07-20 GMM logged 7 signals — ema9 three times in 28 seconds, plus
          // ORB + ema21 + pullback all on the same 12:44:35 fill.
          const fill = setup.entryFill ?? setup.zoneUpper
          // Classify every triggered long: logged, or which gate dropped it — so
          // the funnel shows whether triggers are firing but getting eaten. The
          // BUY is logged only in the clean (else) branch — same gate as before.
          if (setup.direction === 'long' && setup.triggeredRaw) {
            funnel.triggered++
            const dup = isDuplicateBuy(setup.symbol, fill, now, allBuys)
            // After-close gate: a trigger printed once the market's shut (or
            // overnight) is untradeable — you can't act on it, and it fired off the
            // closing print (2026-07-29 logged 3 at 16:01). Premarket + regular stay.
            const tradeable = r.integrity.session === 'premarket' || r.integrity.session === 'regular'
            if (!tradeable) funnel.droppedSession++
            else if (setup.qualityVetoed) funnel.droppedVeto++
            else if (standDown) funnel.droppedStandDown++
            else if (capped) funnel.droppedCapped++
            else if (dup) funnel.droppedDup++
            else {
              funnel.logged++
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
                flagged: false, // vetoed triggers are dropped above, so a logged entry is never flagged

                ctxTrend15m: r.technicals?.trend15m,
                ctxDistVwapPct: r.technicals?.distanceFromVwapPct ?? null,
                ctxDistDayHighPct: r.technicals?.distanceFromDayHighPct ?? null,
                ctxRelVol: r.relativeVolume,
                ctxHigherHighsLows: r.technicals?.higherHighsLows ?? null,
                ctxAtrPct: r.technicals?.atrPct ?? null,
              })
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

      s.ingestMonitorSweep({ keyLevels, roadmaps, meta, symbolSetups, setupStates, logs: changedLogs, alerts: newAlerts, buySignals: newBuySignals, ranked, funnel, now })
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
