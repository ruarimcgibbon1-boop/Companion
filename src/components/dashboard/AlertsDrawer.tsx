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

  // Flash the panel open briefly when a new alert arrives
  useEffect(() => {
    if (unread > 0) setOpen(true)
  }, [unread])

  return (
    <>
      {/* Bell button — lives in TopBar via portal, but we render inline here */}
      <button
        onClick={() => { setOpen(o => !o); alerts.forEach((_, i) => markAlertRead(i)) }}
        className="relative flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-gray-900 border border-gray-700 hover:border-gray-500 text-gray-400 hover:text-gray-200 transition-colors"
      >
        <span>🔔</span>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center font-bold">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
        <span>Alerts</span>
        {watchlist.length > 0 && (
          <span className="text-gray-600">· {watchlist.length} watching</span>
        )}
      </button>

      {/* Drawer */}
      {open && (
        <div className="absolute top-10 right-0 z-50 w-96 max-h-[70vh] flex flex-col bg-[#0e1117] border border-gray-700 rounded-lg shadow-2xl shadow-black/60 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
            <span className="text-xs font-semibold text-gray-300">Alerts</span>
            <div className="flex items-center gap-2">
              {alerts.length > 0 && (
                <button onClick={clearAlerts} className="text-xs text-gray-600 hover:text-gray-400">
                  Clear all
                </button>
              )}
              <button onClick={() => setOpen(false)} className="text-gray-600 hover:text-gray-300 text-sm">✕</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {alerts.length === 0 && (
              <div className="px-3 py-6 text-center">
                <p className="text-xs text-gray-600 mb-1">No alerts yet.</p>
                {watchlist.length === 0 && (
                  <p className="text-xs text-gray-700">Star a ticker in the right panel to start watching it.</p>
                )}
              </div>
            )}
            {alerts.map((alert, i) => (
              <div
                key={i}
                onClick={() => { selectSymbol(alert.symbol); setOpen(false) }}
                className={`cursor-pointer px-3 py-2.5 border-b border-gray-800/50 border-l-2 hover:bg-gray-800/40 transition-colors ${TYPE_COLORS[alert.type]} ${alert.read ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">{alert.symbol}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                      {TYPE_LABELS[alert.type]}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-600">{dataAge(alert.timestamp)}</span>
                </div>
                <p className="text-xs text-gray-300 leading-snug">{alert.message}</p>
              </div>
            ))}
          </div>

          {watchlist.length > 0 && (
            <div className="px-3 py-2 border-t border-gray-800 bg-gray-900/50">
              <p className="text-[10px] text-gray-600">
                Monitoring: {watchlist.map(w => w.symbol).join(', ')}
              </p>
            </div>
          )}
        </div>
      )}
    </>
  )
}
