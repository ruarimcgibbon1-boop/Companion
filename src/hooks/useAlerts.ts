'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { TickerSnapshot, Alert } from '@/types'

const POLL_INTERVAL = 20_000 // check watchlist every 20s

// Track which alerts have already fired this session to avoid re-notifying
const firedAlerts = new Set<string>()

function priceInZone(price: number, low: number, high: number): boolean {
  return price >= low * 0.998 && price <= high * 1.002
}

function checkSnapshot(snap: TickerSnapshot): Alert[] {
  const alerts: Alert[] = []
  const price = snap.quote.price
  const sym = snap.symbol
  const now = Date.now()

  // 1. Price entering a pullback entry zone
  for (const pb of snap.pullbacks) {
    const key = `entry:${sym}:${pb.name}:${pb.entryZoneLow.toFixed(2)}`
    if (!firedAlerts.has(key) && priceInZone(price, pb.entryZoneLow, pb.entryZoneHigh)) {
      firedAlerts.add(key)
      alerts.push({
        symbol: sym,
        message: `${sym} is in the ${pb.name} entry zone $${pb.entryZoneLow.toFixed(2)}–$${pb.entryZoneHigh.toFixed(2)}. Confirmation has not yet occurred. Invalidation: $${pb.invalidation.toFixed(2)}.`,
        type: 'enters_zone',
        timestamp: now,
        read: false,
      })
    }
    // Reset key when price leaves the zone so it can fire again on next entry
    if (firedAlerts.has(key) && !priceInZone(price, pb.entryZoneLow * 0.99, pb.entryZoneHigh * 1.01)) {
      firedAlerts.delete(key)
    }
  }

  // 2. VWAP reclaim / loss
  const vwap = snap.sessionLevels.vwap
  if (vwap) {
    const aboveKey = `vwap_above:${sym}`
    const belowKey = `vwap_below:${sym}`
    const isAbove = price > vwap * 1.001
    const isBelow = price < vwap * 0.999

    if (isAbove && firedAlerts.has(belowKey)) {
      firedAlerts.delete(belowKey)
      firedAlerts.add(aboveKey)
      alerts.push({
        symbol: sym,
        message: `${sym} has reclaimed VWAP ($${vwap.toFixed(2)}). Price is now $${price.toFixed(2)}.`,
        type: 'vwap_reclaim',
        timestamp: now,
        read: false,
      })
    }
    if (isBelow && firedAlerts.has(aboveKey)) {
      firedAlerts.delete(aboveKey)
      firedAlerts.add(belowKey)
      alerts.push({
        symbol: sym,
        message: `${sym} has lost VWAP ($${vwap.toFixed(2)}). Price is now $${price.toFixed(2)}.`,
        type: 'vwap_lost',
        timestamp: now,
        read: false,
      })
    }
    // Seed initial state silently
    if (!firedAlerts.has(aboveKey) && !firedAlerts.has(belowKey)) {
      if (isAbove) firedAlerts.add(aboveKey)
      else if (isBelow) firedAlerts.add(belowKey)
    }
  }

  // 3. High-of-day break
  const hod = snap.sessionLevels.regularHigh
  if (hod) {
    const hodKey = `hod:${sym}:${hod.toFixed(2)}`
    if (!firedAlerts.has(hodKey) && price >= hod * 1.001) {
      firedAlerts.add(hodKey)
      alerts.push({
        symbol: sym,
        message: `${sym} is breaking the high of day at $${hod.toFixed(2)}. Current price $${price.toFixed(2)}.`,
        type: 'hod_break',
        timestamp: now,
        read: false,
      })
    }
  }

  // 4. Setup score above 75
  const scoreKey = `score75:${sym}`
  if (!firedAlerts.has(scoreKey) && snap.setupScore.total >= 75) {
    firedAlerts.add(scoreKey)
    alerts.push({
      symbol: sym,
      message: `${sym} setup score reached ${snap.setupScore.total}/100 — ${snap.setupScore.status}.`,
      type: 'score_above',
      timestamp: now,
      read: false,
    })
  }

  return alerts
}

function sendBrowserNotification(alert: Alert) {
  if (typeof window === 'undefined') return
  if (Notification.permission !== 'granted') return
  new Notification(`${alert.symbol} Alert`, {
    body: alert.message,
    icon: '/favicon.ico',
    tag: `${alert.symbol}-${alert.type}`,
    requireInteraction: false,
  })
}

export function useAlerts() {
  const { watchlist, addAlert } = useTradingStore()
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const requestPermission = useCallback(async () => {
    if (typeof window === 'undefined') return
    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
  }, [])

  const pollWatchlist = useCallback(async () => {
    if (!watchlist.length) return
    const symbols = watchlist.map(w => w.symbol)

    await Promise.allSettled(
      symbols.map(async sym => {
        try {
          const res = await fetch(`/api/snapshot?symbol=${sym}`)
          if (!res.ok) return
          const snap: TickerSnapshot = await res.json()
          const newAlerts = checkSnapshot(snap)
          for (const alert of newAlerts) {
            addAlert(alert)
            sendBrowserNotification(alert)
          }
        } catch { /* network error — skip */ }
      })
    )
  }, [watchlist, addAlert])

  useEffect(() => {
    requestPermission()
  }, [requestPermission])

  // NOTE: the legacy watchlist poller is retired — the always-on monitoring
  // engine (useMonitor) already analyses every watchlist symbol and produces
  // richer, deduped signals. Running both duplicated /api/snapshot calls every
  // 20s and was a needless load. Kept `pollWatchlist` for reference / manual use.
  void pollWatchlist
  void timerRef
  void POLL_INTERVAL
}
