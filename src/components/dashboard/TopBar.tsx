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
          ? 'text-bull bg-bull/10 ring-1 ring-bull/25'
          : sc === 'text-yellow-400'
          ? 'text-warn bg-warn/10 ring-1 ring-warn/25'
          : sc === 'text-blue-400'
          ? 'text-info bg-info/10 ring-1 ring-info/25'
          : 'text-ink-mute bg-white/5 ring-1 ring-white/10'
      )
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <header className="relative z-30 flex items-center justify-between px-4 h-11 bg-bar border-b border-line flex-shrink-0 shadow-[0_1px_0_rgba(0,0,0,0.4)]">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="h-4 w-1 rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
          <span className="text-[13px] font-semibold text-ink tracking-[0.14em]">INTRADAY COMPANION</span>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded-md font-semibold tracking-wide ${sessionColorClass}`}>
          {session}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 tnum text-[11px] text-ink-mute mr-1">
          <span><span className="text-ink-faint">ET</span> {etTime}</span>
          <span className="text-line-strong">·</span>
          <span><span className="text-ink-faint">LON</span> {londonTime}</span>
        </div>
        <button
          onClick={() => setOppsOpen(true)}
          className="ring-focus relative text-xs px-2.5 py-1.5 rounded-md border border-accent/40 bg-accent/10 text-accent-hi hover:bg-accent/20 hover:border-accent/60 transition-colors font-medium"
        >
          ⚡ Opportunities
          {setupCount > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-px rounded-full bg-accent text-white font-semibold tnum">{setupCount}</span>
          )}
          {unreadSignals > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-bear text-white text-[9px] flex items-center justify-center font-bold ring-2 ring-bar">
              {unreadSignals > 9 ? '9+' : unreadSignals}
            </span>
          )}
        </button>
        <button
          onClick={() => setContOpen(true)}
          className="ring-focus text-xs px-2.5 py-1.5 rounded-md border border-bull/40 bg-bull/10 text-bull hover:bg-bull/20 hover:border-bull/60 transition-colors font-medium"
        >
          🎯 Continuation
        </button>
        <button
          onClick={() => setJournalOpen(true)}
          className="ring-focus text-xs px-2.5 py-1.5 rounded-md border border-line-strong text-ink-soft hover:text-ink hover:border-ink-mute hover:bg-white/5 transition-colors font-medium"
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
