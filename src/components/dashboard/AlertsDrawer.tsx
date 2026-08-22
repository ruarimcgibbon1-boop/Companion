'use client'

import { useState, useEffect } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { useAlerts } from '@/hooks/useAlerts'
import { dataAge } from '@/lib/market-hours'
import type { Alert } from '@/types'

const TYPE_COLORS: Record<Alert['type'], string> = {
  enters_zone: 'border-l-blue-400',
  vwap_reclaim: 'border-l-green-400',
  vwap_lost: 'border-l-red-400',
  hod_break: 'border-l-yellow-400',
  score_above: 'border-l-purple-400',
  new_news: 'border-l-cyan-400',
}

const TYPE_LABELS: Record<Alert['type'], string> = {
  enters_zone: 'Entry Zone',
  vwap_reclaim: 'VWAP Reclaim',
  vwap_lost: 'VWAP Lost',
  hod_break: 'HOD Break',
  score_above: 'Score Alert',
  new_news: 'New News',
}

export function AlertsDrawer() {
  // Mount the alerts hook here so it runs whenever the drawer is in the tree
  useAlerts()

  const { alerts, markAlertRead, clearAlerts, watchlist, selectSymbol } = useTradingStore()
  const [open, setOpen] = useState(false)
  const unread = alerts.filter(a => !a.read).length

  // Flash the panel open briefly when a new alert arrives — intentional UI sync
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (unread > 0) setOpen(true)
  }, [unread])

  return (
    <>
      {/* Bell button — lives in TopBar via portal, but we render inline here */}
      <button
        onClick={() => { setOpen(o => !o); alerts.forEach((_, i) => markAlertRead(i)) }}
        className="ring-focus relative flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-raised border border-line-strong hover:border-ink-mute text-ink-soft hover:text-ink transition-colors font-medium"
      >
        <span>🔔</span>
        {unread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-bear text-white text-[10px] flex items-center justify-center font-bold ring-2 ring-bar">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
        <span>Alerts</span>
        {watchlist.length > 0 && (
          <span className="text-ink-faint">· {watchlist.length} watching</span>
        )}
      </button>

      {/* Drawer */}
      {open && (
        <div className="absolute top-12 right-0 z-50 w-96 max-h-[70vh] flex flex-col bg-panel border border-line-strong rounded-xl shadow-pop overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-line">
            <span className="eyebrow">Alerts</span>
            <div className="flex items-center gap-3">
              {alerts.length > 0 && (
                <button onClick={clearAlerts} className="text-xs text-ink-mute hover:text-ink-soft transition-colors">
                  Clear all
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-ink-mute hover:text-ink text-sm transition-colors">✕</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {alerts.length === 0 && (
              <div className="px-3 py-8 text-center">
                <p className="text-xs text-ink-mute mb-1">No alerts yet.</p>
                {watchlist.length === 0 && (
                  <p className="text-xs text-ink-faint">Star a ticker in the right panel to start watching it.</p>
                )}
              </div>
            )}
            {alerts.map((alert, i) => (
              <div
                key={i}
                onClick={() => { selectSymbol(alert.symbol); setOpen(false) }}
                className={`cursor-pointer px-3.5 py-2.5 border-b border-line/60 border-l-2 hover:bg-hover transition-colors ${TYPE_COLORS[alert.type]} ${alert.read ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-ink tracking-wide">{alert.symbol}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-raised text-ink-mute font-medium">
                      {TYPE_LABELS[alert.type]}
                    </span>
                  </div>
                  <span className="text-[10px] text-ink-faint tnum">{dataAge(alert.timestamp)}</span>
                </div>
                <p className="text-xs text-ink-soft leading-snug">{alert.message}</p>
              </div>
            ))}
          </div>

          {watchlist.length > 0 && (
            <div className="px-3.5 py-2 border-t border-line bg-surface/50">
              <p className="text-[10px] text-ink-mute">
                Monitoring: {watchlist.map(w => w.symbol).join(', ')}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  )
}
