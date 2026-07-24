'use client'

import { useState, useEffect } from 'react'
import { getSessionType, formatET, formatLondon, sessionLabel, sessionColor } from '@/lib/market-hours'
import { AlertsDrawer } from './AlertsDrawer'
import { TradeJournal } from '@/components/journal/TradeJournal'
import { OpportunitiesDrawer } from '@/components/opportunities/OpportunitiesDrawer'
import { ContinuationDrawer } from '@/components/continuation/ContinuationDrawer'
import { useMonitor } from '@/hooks/useMonitor'
import { useEodResolution } from '@/hooks/useEodResolution'
import { useTradingStore } from '@/store/trading-store'

export function TopBar() {
  const [etTime, setEtTime] = useState('')
  const [londonTime, setLondonTime] = useState('')
  const [session, setSession] = useState('')
  const [sessionColorClass, setSessionColorClass] = useState('text-gray-500 bg-gray-900/20')
  const [journalOpen, setJournalOpen] = useState(false)
  const [oppsOpen, setOppsOpen] = useState(false)
  const [contOpen, setContOpen] = useState(false)

  // Always-on monitoring engine — runs app-wide, independent of the selected ticker.
  useMonitor()
  // Reconcile any open outcomes from sessions that have since closed (the app
  // wasn't live through their close), so the Buy Log reflects the real tape.
  useEodResolution({ auto: true })
  const setupCount = useTradingStore(s => s.monitoredSetups.filter(su => su.score >= 75).length)
  const unreadSignals = useTradingStore(s => s.monitorAlerts.filter(a => !a.read).length)

  useEffect(() => {
    const update = () => {
      const now = Date.now()
      setEtTime(formatET(now, true))
      setLondonTime(formatLondon(now, false))
      const s = getSessionType(now)
      setSession(sessionLabel(s))
      const sc = sessionColor(s)
      setSessionColorClass(
        sc === 'text-green-400'
          ? 'text-green-400 bg-green-900/20'
          : sc === 'text-yellow-400'
          ? 'text-yellow-400 bg-yellow-900/20'
          : sc === 'text-blue-400'
          ? 'text-blue-400 bg-blue-900/20'
          : 'text-gray-500 bg-gray-900/20'
      )
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <header className="relative flex items-center justify-between px-4 h-10 bg-[#080b10] border-b border-gray-800 flex-shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-sm font-bold text-white tracking-wide">INTRADAY COMPANION</span>
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${sessionColorClass}`}>
          {session}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs font-mono text-gray-500">
          <span>ET {etTime}</span>
          <span className="text-gray-700">·</span>
          <span>LON {londonTime}</span>
        </div>
        <button
          onClick={() => setOppsOpen(true)}
          className="relative text-xs px-2.5 py-1 rounded border border-blue-800 bg-blue-950/40 text-blue-300 hover:text-white hover:border-blue-600 transition-colors font-medium"
        >
          ⚡ Opportunities
          {setupCount > 0 && (
            <span className="ml-1.5 text-[10px] px-1 rounded bg-blue-700 text-white">{setupCount}</span>
          )}
          {unreadSignals > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center font-bold">
              {unreadSignals > 9 ? '9+' : unreadSignals}
            </span>
          )}
        </button>
        <button
          onClick={() => setContOpen(true)}
          className="text-xs px-2.5 py-1 rounded border border-emerald-800 bg-emerald-950/40 text-emerald-300 hover:text-white hover:border-emerald-600 transition-colors font-medium"
        >
          🎯 Continuation
        </button>
        <button
          onClick={() => setJournalOpen(true)}
          className="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors font-medium"
        >
          Journal
        </button>
        <AlertsDrawer />
      </div>
      {journalOpen && <TradeJournal onClose={() => setJournalOpen(false)} />}
      {oppsOpen && <OpportunitiesDrawer onClose={() => setOppsOpen(false)} />}
      {contOpen && <ContinuationDrawer onClose={() => setContOpen(false)} />}
    </header>
  )
}
