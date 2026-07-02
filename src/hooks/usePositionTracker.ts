'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { Position, Alert } from '@/types'

const POLL_MS = 10_000

function calcPnl(pos: Position, currentPrice: number) {
  const multiplier = pos.direction === 'long' ? 1 : -1
  const pnl = (currentPrice - pos.entry) * pos.shares * multiplier
  const pnlPct = ((currentPrice - pos.entry) / pos.entry) * 100 * multiplier
  return { pnl, pnlPct }
}

function applyTrailingStop(pos: Position, currentPrice: number): Partial<Position> | null {
  if (pos.trailingMode === 'none' || pos.status !== 'open') return null

  const isLong = pos.direction === 'long'
  const newHigh = isLong
    ? Math.max(pos.trailingHigh, currentPrice)
    : Math.min(pos.trailingHigh, currentPrice)

  let newStop = pos.stop
  if (pos.trailingMode === 'pct') {
    const trailPct = pos.trailingValue / 100
    newStop = isLong
      ? newHigh * (1 - trailPct)
      : newHigh * (1 + trailPct)
  } else if (pos.trailingMode === 'atr') {
    // ATR-based: we store trailingValue as a dollar amount (ATR × multiplier)
    newStop = isLong
      ? newHigh - pos.trailingValue
      : newHigh + pos.trailingValue
  }

  // Only ever move stop in the favourable direction
  const stopImproved = isLong ? newStop > pos.stop : newStop < pos.stop
  const highMoved = isLong ? newHigh > pos.trailingHigh : newHigh < pos.trailingHigh

  if (highMoved || stopImproved) {
    return {
      stop: stopImproved ? newStop : pos.stop,
      trailingHigh: newHigh,
    }
  }
  return null
}

function checkTargets(pos: Position, currentPrice: number): { targets: typeof pos.targets; newStatus: typeof pos.status; newStop: number } {
  const targets = pos.targets.map(t => ({ ...t }))
  let newStatus = pos.status
  let newStop = pos.stop
  const isLong = pos.direction === 'long'

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    if (t.hit) continue
    const hit = isLong ? currentPrice >= t.price : currentPrice <= t.price
    if (!hit) continue

    targets[i] = { ...t, hit: true, hitAt: Date.now() }
    newStatus = (['t1_hit', 't2_hit', 't3_hit'] as const)[i] ?? 't1_hit'

    // Auto-advance stop to breakeven when T1 hits
    if (i === 0) {
      const be = pos.entry
      newStop = isLong ? Math.max(pos.stop, be) : Math.min(pos.stop, be)
    }
    // Auto-advance stop to T1 when T2 hits
    if (i === 1 && targets[0]) {
      newStop = isLong
        ? Math.max(pos.stop, targets[0].price)
        : Math.min(pos.stop, targets[0].price)
    }
  }

  return { targets, newStatus, newStop }
}

function isStopHit(pos: Position, currentPrice: number): boolean {
  return pos.direction === 'long'
    ? currentPrice <= pos.stop
    : currentPrice >= pos.stop
}

export function usePositionTracker() {
  const { positions, updatePosition, addAlert } = useTradingStore()
  const firedRef = useRef<Set<string>>(new Set())

  const pollPositions = useCallback(async () => {
    const open = positions.filter(p => p.status !== 'closed')
    if (!open.length) return

    await Promise.allSettled(
      open.map(async (pos) => {
        try {
          const res = await fetch(`/api/snapshot?symbol=${pos.symbol}`)
          if (!res.ok) return
          const snap = await res.json()
          const currentPrice: number = snap?.quote?.price
          if (!currentPrice) return

          const { pnl, pnlPct } = calcPnl(pos, currentPrice)
          const patch: Partial<Position> = {
            currentPrice,
            unrealizedPnl: pnl,
            unrealizedPnlPct: pnlPct,
            lastPriceUpdate: Date.now(),
          }

          // Trailing stop
          const trailPatch = applyTrailingStop(pos, currentPrice)
          if (trailPatch) Object.assign(patch, trailPatch)

          // Target checks
          if (pos.status === 'open' || pos.status === 't1_hit') {
            const { targets, newStatus, newStop } = checkTargets({ ...pos, ...patch }, currentPrice)
            if (newStatus !== pos.status) {
              patch.targets = targets
              patch.status = newStatus
              patch.stop = newStop

              const targetLabel = newStatus === 't1_hit' ? 'T1' : newStatus === 't2_hit' ? 'T2' : 'T3'
              const alertKey = `target:${pos.id}:${newStatus}`
              if (!firedRef.current.has(alertKey)) {
                firedRef.current.add(alertKey)
                const a: Alert = {
                  symbol: pos.symbol,
                  message: `${pos.symbol} hit ${targetLabel} at $${currentPrice.toFixed(2)}. Stop auto-advanced to $${newStop.toFixed(2)}.`,
                  type: 'hod_break',
                  timestamp: Date.now(),
                  read: false,
                }
                addAlert(a)
                sendNotification(a)
              }
            }
          }

          // Stop hit check
          if ((pos.status === 'open' || pos.status === 't1_hit' || pos.status === 't2_hit') && isStopHit({ ...pos, ...patch } as Position, currentPrice)) {
            const alertKey = `stop:${pos.id}`
            if (!firedRef.current.has(alertKey)) {
              firedRef.current.add(alertKey)
              patch.status = 'stopped'
              const a: Alert = {
                symbol: pos.symbol,
                message: `${pos.symbol} STOP HIT at $${currentPrice.toFixed(2)}. Stop was $${pos.stop.toFixed(2)}. P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}.`,
                type: 'vwap_lost',
                timestamp: Date.now(),
                read: false,
              }
              addAlert(a)
              sendNotification(a)
            }
          }

          updatePosition(pos.id, patch)
        } catch { /* skip */ }
      })
    )
  }, [positions, updatePosition, addAlert])

  useEffect(() => {
    if (!positions.filter(p => p.status !== 'closed').length) return
    pollPositions()
    const id = setInterval(pollPositions, POLL_MS)
    return () => clearInterval(id)
  }, [positions, pollPositions])
}

function sendNotification(alert: Alert) {
  if (typeof window === 'undefined') return
  if (Notification.permission !== 'granted') return
  new Notification(`${alert.symbol}`, {
    body: alert.message,
    icon: '/favicon.ico',
    tag: `pos-${alert.symbol}-${alert.type}`,
  })
}
