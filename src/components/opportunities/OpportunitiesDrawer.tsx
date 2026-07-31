'use client'

import { useState, useMemo } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { useEodResolution } from '@/hooks/useEodResolution'
import { dataAge } from '@/lib/market-hours'
import { GRADE_DESCRIPTIONS } from '@/lib/scoring-matrix'
import {
  SETUP_TYPE_LABELS, SETUP_STATE_LABELS,
  PATTERN_LABELS,
  type DetectedSetup, type SetupGrade, type SetupState, type MonitorAlert, type SetupLog, type SetupType, type BuySignalRecord, type PatternHit,
} from '@/types'

type Tab = 'opportunities' | 'watchlist' | 'approaching' | 'patterns' | 'roadmap' | 'signals' | 'buylog' | 'review' | 'settings'

const GRADE_COLOR: Record<SetupGrade, string> = {
  'A+': 'text-emerald-300 bg-emerald-900/40 border-emerald-700',
  'A': 'text-green-300 bg-green-900/40 border-green-700',
  'A-': 'text-green-400 bg-green-900/30 border-green-800',
  'B+': 'text-yellow-300 bg-yellow-900/30 border-yellow-800',
  'B': 'text-yellow-400 bg-yellow-900/20 border-yellow-900',
  'C': 'text-orange-400 bg-orange-900/20 border-orange-900',
  'below': 'text-gray-500 bg-gray-800/40 border-gray-700',
}

const SIGNAL_STYLE: Record<string, { bg: string; text: string; dot: string }> = {
  buy:         { bg: 'bg-emerald-600/25 border border-emerald-500', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  sell_short:  { bg: 'bg-red-600/25 border border-red-500', text: 'text-red-300', dot: 'bg-red-400' },
  prep_buy:    { bg: 'bg-green-700/20 border border-green-700', text: 'text-green-300', dot: 'bg-green-500' },
  prep_short:  { bg: 'bg-red-700/20 border border-red-700', text: 'text-red-300', dot: 'bg-red-500' },
  watch:       { bg: 'bg-gray-700/30 border border-gray-600', text: 'text-gray-300', dot: 'bg-gray-400' },
  avoid:       { bg: 'bg-gray-800/60 border border-gray-700', text: 'text-gray-500', dot: 'bg-gray-600' },
}

const STATE_COLOR: Record<SetupState, string> = {
  identified: 'text-gray-400 bg-gray-800',
  approaching: 'text-blue-300 bg-blue-900/40',
  at_level: 'text-cyan-300 bg-cyan-900/40',
  confirming: 'text-yellow-300 bg-yellow-900/40',
  triggered: 'text-emerald-300 bg-emerald-900/50',
  failed: 'text-red-300 bg-red-900/40',
  expired: 'text-gray-600 bg-gray-900',
}

function fmt(n: number, d = 2) { return n.toFixed(d) }

export function OpportunitiesDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('opportunities')
  const monitorAlerts = useTradingStore(s => s.monitorAlerts)
  const unread = monitorAlerts.filter(a => !a.read).length

  const watchlistCount = useTradingStore(s => s.watchlist.length)
  const buySignalCount = useTradingStore(s => s.buySignals.length)
  const patternCount = useTradingStore(s => Object.values(s.symbolPatterns).reduce((n, p) => n + (p?.length ?? 0), 0))
  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: 'opportunities', label: 'Opportunities' },
    { id: 'watchlist', label: `Watchlist${watchlistCount ? ` (${watchlistCount})` : ''}` },
    { id: 'approaching', label: 'Approaching' },
    { id: 'patterns', label: `Patterns${patternCount ? ` (${patternCount})` : ''}` },
    { id: 'roadmap', label: 'Roadmap' },
    { id: 'signals', label: 'Signals', badge: unread },
    { id: 'buylog', label: `Buy Log${buySignalCount ? ` (${buySignalCount})` : ''}` },
    { id: 'review', label: 'Review' },
    { id: 'settings', label: 'Settings' },
  ]

  return (
    <div className="fixed inset-0 z-50 bg-[#0a0d12]/95 backdrop-blur-sm flex flex-col">
      <div className="flex items-center justify-between px-4 h-11 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white">Automatic Opportunities</span>
          <LiveDot />
        </div>
        <div className="flex items-center gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`relative text-xs px-3 py-1 rounded transition-colors ${
                tab === t.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              {t.label}
              {t.badge ? (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center font-bold">
                  {t.badge > 9 ? '9+' : t.badge}
                </span>
              ) : null}
            </button>
          ))}
          <button onClick={onClose} className="ml-2 text-gray-500 hover:text-white text-lg px-2">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === 'opportunities' && <OpportunitiesTab onPick={onClose} />}
        {tab === 'watchlist' && <WatchlistTab onPick={onClose} />}
        {tab === 'approaching' && <ApproachingTab onPick={onClose} />}
        {tab === 'patterns' && <PatternsTab onPick={onClose} />}
        {tab === 'roadmap' && <RoadmapTab />}
        {tab === 'signals' && <SignalsTab onPick={onClose} />}
        {tab === 'buylog' && <BuyLogTab onPick={onClose} />}
        {tab === 'review' && <ReviewTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  )
}

function LiveDot() {
  const running = useTradingStore(s => s.monitorRunning)
  const last = useTradingStore(s => s.lastMonitorTime)
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
      <span className={`w-2 h-2 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
      {last ? `swept ${dataAge(last)}` : 'starting…'}
    </span>
  )
}

// ── Opportunities ───────────────────────────────────────────────────────────

type SortKey = 'score' | 'distance' | 'type' | 'rr' | 'level' | 'state'

function OpportunitiesTab({ onPick }: { onPick: () => void }) {
  const setups = useTradingStore(s => s.monitoredSetups)
  const selectSymbol = useTradingStore(s => s.selectSymbol)
  const [sort, setSort] = useState<SortKey>('score')
  const [typeFilter, setTypeFilter] = useState<SetupType | 'all'>('all')

  const sorted = useMemo(() => {
    const arr = setups.filter(s => typeFilter === 'all' || s.type === typeFilter)
    const cmp: Record<SortKey, (a: DetectedSetup, b: DetectedSetup) => number> = {
      score: (a, b) => b.score - a.score,
      distance: (a, b) => Math.abs(a.distanceToZonePct) - Math.abs(b.distanceToZonePct),
      type: (a, b) => a.type.localeCompare(b.type),
      rr: (a, b) => (b.rewardRisk ?? 0) - (a.rewardRisk ?? 0),
      level: (a, b) => b.breakdown.levelQuality - a.breakdown.levelQuality,
      state: (a, b) => stateRank(b.state) - stateRank(a.state),
    }
    return [...arr].sort(cmp[sort])
  }, [setups, sort, typeFilter])

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 flex-wrap">
        <span className="text-[11px] text-gray-500">Sort:</span>
        {(['score', 'distance', 'rr', 'level', 'state', 'type'] as SortKey[]).map(k => (
          <button key={k} onClick={() => setSort(k)}
            className={`text-[11px] px-2 py-0.5 rounded ${sort === k ? 'bg-gray-700 text-white' : 'bg-gray-900 text-gray-500 hover:text-gray-300'}`}>
            {k === 'rr' ? 'R/R' : k === 'level' ? 'Level' : k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
        <div className="w-px h-4 bg-gray-700 mx-1" />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as SetupType | 'all')}
          className="text-[11px] bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300">
          <option value="all">All types</option>
          {Object.entries(SETUP_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="ml-auto text-[11px] text-gray-600">{sorted.length} setups</span>
      </div>

      <div className="flex-1 overflow-y-auto p-3 grid grid-cols-1 lg:grid-cols-2 gap-2 auto-rows-min">
        {sorted.length === 0 && (
          <div className="col-span-full text-center text-gray-600 text-sm py-16">
            No qualifying setups yet. The engine sweeps the scanner + watchlist every 25s — setups appear here as levels come into play.
          </div>
        )}
        {sorted.map(s => (
          <SetupCard key={s.id} setup={s} onClick={() => { selectSymbol(s.symbol); onPick() }} />
        ))}
      </div>
    </div>
  )
}

function stateRank(s: SetupState): number {
  return { identified: 0, approaching: 1, at_level: 2, confirming: 3, triggered: 4, failed: -1, expired: -2 }[s]
}

function SetupCard({ setup: s, onClick }: { setup: DetectedSetup; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="text-left bg-gray-900/60 border border-gray-800 hover:border-gray-600 rounded-lg p-3 transition-colors">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">{s.symbol}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${GRADE_COLOR[s.grade]}`}>{s.grade === 'below' ? '<C' : s.grade}</span>
          <span className="text-xs text-gray-400">{SETUP_TYPE_LABELS[s.type]}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>
            {s.direction === 'long' ? '▲ Long' : '▼ Short'}
          </span>
        </div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATE_COLOR[s.state]}`}>{SETUP_STATE_LABELS[s.state]}</span>
      </div>

      <div className="flex items-center gap-3 mb-1.5">
        <div className="text-lg font-bold text-white">{s.score}<span className="text-xs text-gray-600">/100</span></div>
        <div className="flex-1">
          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div className={`h-full ${s.score >= 80 ? 'bg-emerald-500' : s.score >= 70 ? 'bg-yellow-500' : 'bg-orange-500'}`} style={{ width: `${s.score}%` }} />
          </div>
        </div>
        <span className="text-[11px] text-gray-500">{Math.abs(s.distanceToZonePct) < 0.05 ? 'at zone' : `${s.distanceToZonePct > 0 ? '+' : ''}${fmt(s.distanceToZonePct, 1)}%`}</span>
      </div>

      {/* Decisive buy/sell signal */}
      {(() => {
        const st = SIGNAL_STYLE[s.signal.action] ?? SIGNAL_STYLE.watch
        return (
          <div className={`flex items-start gap-2 rounded-md px-2 py-1.5 mb-1.5 ${st.bg}`}>
            <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${st.dot} ${s.signal.urgency === 'now' ? 'animate-pulse' : ''}`} />
            <div className="min-w-0">
              <span className={`text-xs font-bold ${st.text}`}>{s.signal.verb}</span>
              <span className="text-[11px] text-gray-300 ml-1.5">{s.signal.headline}</span>
            </div>
          </div>
        )
      })()}

      <p className="text-[11px] text-gray-500 leading-snug mb-1.5">{s.rationale}</p>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <Row label="Zone" value={`$${fmt(s.zoneLower)}–$${fmt(s.zoneUpper)}`} />
        <Row label="Invalidation" value={`$${fmt(s.invalidation)}`} danger />
        <Row label="R/R" value={s.rewardRisk != null ? `${fmt(s.rewardRisk, 1)}:1` : 'n/a'} />
        <Row label="Targets" value={s.targets.slice(0, 2).map(t => `$${fmt(t.price)}`).join(' → ') || 'n/a'} />
      </div>

      <div className="mt-1.5 pt-1.5 border-t border-gray-800/60">
        <p className="text-[10px] text-gray-500"><span className="text-gray-400">Confirm:</span> {s.confirmation[0]}</p>
        {s.keyRisks.length > 0 && (
          <p className="text-[10px] text-red-400/80 mt-0.5">⚠ {s.keyRisks[0]}</p>
        )}
      </div>
    </button>
  )
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-600">{label}</span>
      <span className={danger ? 'text-red-400' : 'text-gray-300'}>{value}</span>
    </div>
  )
}

// ── Watchlist ───────────────────────────────────────────────────────────────

const ACTION_RANK: Record<string, number> = { buy: 5, prep_buy: 4, watch: 3, sell_short: 2, prep_short: 2, avoid: 1 }

function WatchlistTab({ onPick }: { onPick: () => void }) {
  const watchlist = useTradingStore(s => s.watchlist)
  const symbolSetups = useTradingStore(s => s.symbolSetups)
  const roadmaps = useTradingStore(s => s.roadmaps)
  const meta = useTradingStore(s => s.monitorMeta)
  const selectSymbol = useTradingStore(s => s.selectSymbol)
  const addToWatchlist = useTradingStore(s => s.addToWatchlist)
  const addSearchedSymbol = useTradingStore(s => s.addSearchedSymbol)
  const removeFromWatchlist = useTradingStore(s => s.removeFromWatchlist)
  const [input, setInput] = useState('')

  const rows = useMemo(() => {
    return watchlist.map(w => {
      const setups = symbolSetups[w.symbol] ?? []
      const best = setups.filter(s => s.direction === 'long').sort((a, b) => b.score - a.score)[0] ?? null
      return { symbol: w.symbol, best, price: roadmaps[w.symbol]?.currentPrice ?? null, integrity: meta[w.symbol] ?? null, road: roadmaps[w.symbol] ?? null }
    }).sort((a, b) => {
      const ra = a.best ? ACTION_RANK[a.best.signal.action] ?? 0 : 0
      const rb = b.best ? ACTION_RANK[b.best.signal.action] ?? 0 : 0
      return rb - ra || (b.best?.score ?? 0) - (a.best?.score ?? 0)
    })
  }, [watchlist, symbolSetups, roadmaps, meta])

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const sym = input.trim().toUpperCase()
    if (sym) { addToWatchlist(sym); addSearchedSymbol(sym); setInput('') }
  }

  return (
    <div className="h-full flex flex-col">
      <form onSubmit={add} className="flex gap-2 px-4 py-2 border-b border-gray-800">
        <input value={input} onChange={e => setInput(e.target.value.toUpperCase())} placeholder="Add instrument… e.g. AAPL"
          className="flex-1 max-w-xs bg-gray-900 border border-gray-700 focus:border-blue-500 rounded px-2.5 py-1 text-sm text-white placeholder-gray-600 focus:outline-none font-mono"
          autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
        <button type="submit" disabled={!input.trim()} className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-medium">Add</button>
        <span className="ml-auto self-center text-[11px] text-gray-600">Clean buy signal per instrument · updates every sweep</span>
      </form>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {rows.length === 0 && (
          <div className="text-center text-gray-600 text-sm py-16">
            Your watchlist is empty. Add instruments above, or star a ticker from the companion panel. Each one gets a clean BUY / WAIT signal here, monitored every 25s.
          </div>
        )}
        {rows.map(r => <WatchlistRow key={r.symbol} row={r} onOpen={() => { selectSymbol(r.symbol); onPick() }} onRemove={() => removeFromWatchlist(r.symbol)} />)}
      </div>
    </div>
  )
}

function WatchlistRow({ row, onOpen, onRemove }: {
  row: { symbol: string; best: DetectedSetup | null; price: number | null; integrity: import('@/types').DataIntegrity | null; road: import('@/types').PriceRoadmap | null }
  onOpen: () => void
  onRemove: () => void
}) {
  const { symbol, best, price, integrity, road } = row
  const st = best ? (SIGNAL_STYLE[best.signal.action] ?? SIGNAL_STYLE.watch) : { bg: 'bg-gray-800/40 border border-gray-700', text: 'text-gray-500', dot: 'bg-gray-600' }
  const verb = best ? best.signal.verb : 'NO SETUP'
  const nextUp = road?.upside?.[0]

  return (
    <div className="flex items-stretch gap-3 bg-gray-900/60 border border-gray-800 hover:border-gray-600 rounded-lg overflow-hidden">
      <button onClick={onOpen} className="flex-1 text-left flex items-center gap-3 px-3 py-2.5 min-w-0">
        {/* Instrument + price */}
        <div className="w-20 flex-shrink-0">
          <div className="text-sm font-bold text-white">{symbol}</div>
          <div className="text-[11px] text-gray-400">{price != null ? `$${price.toFixed(price < 1 ? 3 : 2)}` : '—'}</div>
          {integrity && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${integrity.delayed ? 'bg-orange-500' : 'bg-green-500'}`} />
              <span className="text-[9px] text-gray-600">{integrity.delayed ? 'delayed' : `${Math.round(integrity.ageMs / 1000)}s`}</span>
            </div>
          )}
        </div>

        {/* Big signal verb */}
        <div className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 w-32 flex-shrink-0 ${st.bg}`}>
          <span className={`w-2 h-2 rounded-full ${st.dot} ${best?.signal.urgency === 'now' ? 'animate-pulse' : ''}`} />
          <span className={`text-sm font-bold ${st.text}`}>{verb}</span>
        </div>

        {/* Directive + numbers */}
        <div className="flex-1 min-w-0">
          {best ? (
            <>
              <p className="text-[11px] text-gray-300 leading-snug truncate">{best.signal.headline}</p>
              <div className="flex items-center gap-3 mt-0.5 text-[10px] text-gray-500">
                <span>{SETUP_TYPE_LABELS[best.type]}</span>
                <span className="text-gray-600">·</span>
                <span>score {best.score} {best.grade !== 'below' ? best.grade : ''}</span>
                {best.rewardRisk != null && <><span className="text-gray-600">·</span><span>R/R {best.rewardRisk.toFixed(1)}:1</span></>}
                <span className="text-gray-600">·</span>
                <span className="text-red-400/80">stop ${best.invalidation.toFixed(best.invalidation < 1 ? 3 : 2)}</span>
              </div>
            </>
          ) : (
            <p className="text-[11px] text-gray-500 leading-snug">
              No buy setup yet — watching.{nextUp ? ` Next resistance $${nextUp.zoneLower.toFixed(2)}–$${nextUp.zoneUpper.toFixed(2)} (${nextUp.label}).` : ' Analysing on next sweep…'}
            </p>
          )}
        </div>
      </button>

      <button onClick={onRemove} title="Remove from watchlist" className="px-2 text-gray-600 hover:text-red-400 hover:bg-gray-800/60 flex-shrink-0">✕</button>
    </div>
  )
}

// ── Approaching ─────────────────────────────────────────────────────────────

function ApproachingTab({ onPick }: { onPick: () => void }) {
  const setups = useTradingStore(s => s.monitoredSetups)
  const selectSymbol = useTradingStore(s => s.selectSymbol)
  const approaching = useMemo(
    () => setups
      .filter(s => s.state === 'approaching' || s.state === 'at_level' || Math.abs(s.distanceToZonePct) <= s.approachThresholdPct * 1.5)
      .sort((a, b) => Math.abs(a.distanceToZonePct) - Math.abs(b.distanceToZonePct)),
    [setups]
  )
  return (
    <div className="h-full overflow-y-auto p-3">
      <p className="text-[11px] text-gray-500 mb-2">Stocks nearing an important level. Distance is shown both in % and relative to the stock&apos;s adaptive early-warning band.</p>
      {approaching.length === 0 && <div className="text-center text-gray-600 text-sm py-16">Nothing approaching a level right now.</div>}
      <div className="space-y-1.5">
        {approaching.map(s => {
          const within = Math.abs(s.distanceToZonePct) / s.approachThresholdPct
          return (
            <button key={s.id} onClick={() => { selectSymbol(s.symbol); onPick() }}
              className="w-full text-left flex items-center gap-3 bg-gray-900/60 border border-gray-800 hover:border-gray-600 rounded-lg px-3 py-2">
              <div className="w-16">
                <div className="text-sm font-bold text-white">{s.symbol}</div>
                <div className={`text-[10px] ${STATE_COLOR[s.state]} inline-block px-1 rounded`}>{SETUP_STATE_LABELS[s.state]}</div>
              </div>
              <div className="flex-1">
                <div className="text-xs text-gray-300">{SETUP_TYPE_LABELS[s.type]} · zone ${fmt(s.zoneLower)}–${fmt(s.zoneUpper)}</div>
                <div className="h-1 bg-gray-800 rounded-full mt-1 overflow-hidden">
                  <div className="h-full bg-blue-500" style={{ width: `${Math.max(4, 100 - Math.min(100, within * 100))}%` }} />
                </div>
              </div>
              <div className="text-right w-24">
                <div className="text-xs text-gray-300">{s.distanceToZonePct > 0 ? '+' : ''}{fmt(s.distanceToZonePct, 1)}%</div>
                <div className="text-[10px] text-gray-600">{within <= 1 ? 'in band' : `${fmt(within, 1)}× band`}</div>
              </div>
              <div className="text-right w-12">
                <div className="text-sm font-bold text-white">{s.score}</div>
                <div className="text-[10px] text-gray-600">score</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Roadmap ─────────────────────────────────────────────────────────────────

function RoadmapTab() {
  const selected = useTradingStore(s => s.selectedSymbol)
  const roadmaps = useTradingStore(s => s.roadmaps)
  const roadmap = selected ? roadmaps[selected] : null

  if (!selected) return <div className="text-center text-gray-600 text-sm py-16">Select a ticker to see its price roadmap.</div>
  if (!roadmap) return <div className="text-center text-gray-600 text-sm py-16">Building roadmap for {selected}…</div>

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="text-center mb-4">
        <span className="text-xs text-gray-500">{roadmap.symbol} current price</span>
        <div className="text-2xl font-bold text-white">${fmt(roadmap.currentPrice)}</div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-xs font-semibold text-green-400 mb-2 uppercase tracking-wide">Upside roadmap</h3>
          <div className="space-y-1.5">
            {roadmap.upside.length === 0 && <p className="text-[11px] text-gray-600">No mapped resistance above.</p>}
            {roadmap.upside.map((l, i) => <RoadmapRow key={i} l={l} side="up" idx={i + 1} />)}
          </div>
        </div>
        <div>
          <h3 className="text-xs font-semibold text-red-400 mb-2 uppercase tracking-wide">Downside roadmap</h3>
          <div className="space-y-1.5">
            {roadmap.downside.length === 0 && <p className="text-[11px] text-gray-600">No mapped support below.</p>}
            {roadmap.downside.map((l, i) => <RoadmapRow key={i} l={l} side="down" idx={i + 1} />)}
          </div>
        </div>
      </div>
    </div>
  )
}

function RoadmapRow({ l, side, idx }: { l: import('@/types').RoadmapLevel; side: 'up' | 'down'; idx: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`border rounded-lg px-3 py-2 ${side === 'up' ? 'border-green-900/50 bg-green-900/10' : 'border-red-900/50 bg-red-900/10'}`}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-600">{idx}</span>
          <span className="text-sm font-bold text-white">${fmt(l.zoneLower)}–${fmt(l.zoneUpper)}</span>
          <span className="text-[11px] text-gray-400">{l.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-500">str {l.strength}</span>
          <span className="text-[11px] text-gray-400">{l.distancePct > 0 ? '+' : ''}{fmt(l.distancePct, 1)}%</span>
        </div>
      </button>
      {open && (
        <div className="mt-2 pt-2 border-t border-gray-800/60 space-y-1 text-[11px]">
          <p className="text-gray-400"><span className="text-gray-600">Why:</span> {l.why}</p>
          {l.possibleSetup && <p className="text-gray-400"><span className="text-gray-600">Setup:</span> {SETUP_TYPE_LABELS[l.possibleSetup]}</p>}
          <p className="text-gray-400"><span className="text-gray-600">Confirm:</span> {l.confirmationNeeded}</p>
          <p className="text-green-400/80"><span className="text-gray-600">If holds:</span> {l.ifHolds}</p>
          <p className="text-red-400/80"><span className="text-gray-600">If fails:</span> {l.ifFails}</p>
        </div>
      )}
    </div>
  )
}

// ── Signals ─────────────────────────────────────────────────────────────────

const KIND_COLOR: Record<MonitorAlert['kind'], string> = {
  take_profit: 'border-l-emerald-300',
  early_warning: 'border-l-blue-400',
  level_reached: 'border-l-cyan-400',
  confirming: 'border-l-yellow-400',
  triggered: 'border-l-emerald-400',
  failed: 'border-l-red-400',
  score_upgrade: 'border-l-purple-400',
}

function SignalsTab({ onPick }: { onPick: () => void }) {
  const alerts = useTradingStore(s => s.monitorAlerts)
  const selectSymbol = useTradingStore(s => s.selectSymbol)
  const clear = useTradingStore(s => s.clearMonitorAlerts)
  const markAll = useTradingStore(s => s.markAllMonitorAlertsRead)

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <span className="text-[11px] text-gray-500">{alerts.length} signals · newest first</span>
        <div className="flex gap-2">
          <button onClick={markAll} className="text-[11px] text-gray-500 hover:text-gray-300">Mark all read</button>
          <button onClick={clear} className="text-[11px] text-gray-500 hover:text-gray-300">Clear</button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {alerts.length === 0 && <div className="text-center text-gray-600 text-sm py-16">No signals yet.</div>}
        {alerts.map(a => (
          <button key={a.id} onClick={() => { selectSymbol(a.symbol); onPick() }}
            className={`w-full text-left px-4 py-2.5 border-b border-gray-800/50 border-l-2 hover:bg-gray-800/40 ${KIND_COLOR[a.kind]} ${a.read ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between mb-0.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white">{a.symbol}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{a.kind.replace('_', ' ')}</span>
                {a.delayed && <span className="text-[10px] px-1 rounded bg-orange-900/40 text-orange-400">delayed</span>}
              </div>
              <span className="text-[10px] text-gray-600">{dataAge(a.timestamp)}</span>
            </div>
            <p className="text-xs text-gray-300 leading-snug">{a.body}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Buy Log ─────────────────────────────────────────────────────────────────

function etTime(ts: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts))
}

const OUTCOME_STYLE: Record<string, { label: string; cls: string }> = {
  target_hit: { label: 'Target hit', cls: 'text-emerald-300 bg-emerald-900/40' },
  invalidated: { label: 'Stopped', cls: 'text-red-300 bg-red-900/40' },
  expired: { label: 'Expired', cls: 'text-gray-400 bg-gray-800' },
  open: { label: 'Open', cls: 'text-blue-300 bg-blue-900/30' },
}

function BuyLogTab({ onPick }: { onPick: () => void }) {
  const buySignals = useTradingStore(s => s.buySignals)
  const setupLogs = useTradingStore(s => s.setupLogs)
  const roadmaps = useTradingStore(s => s.roadmaps)
  const selectSymbol = useTradingStore(s => s.selectSymbol)
  const clear = useTradingStore(s => s.clearBuySignals)
  const { resolveNow, status, lastResolved, pendingCount } = useEodResolution()
  const logById = useMemo(() => new Map(setupLogs.map(l => [l.id, l])), [setupLogs])
  const pnl = useMemo(() => computeBuyPnl(buySignals), [buySignals])

  const exportCsv = () => {
    const head = ['time_ET', 'symbol', 'setup', 'trigger', 'entry_low', 'entry_high', 'invalidation', 'stop', 'targets', 'score', 'grade', 'rr', 'price_at_signal', 'flagged', 'trend15m', 'dist_vwap_pct', 'dist_dayhigh_pct', 'rvol', 'hhll', 'atr_pct', 'outcome', 'mfe_pct', 'mae_pct', 'pnl_pct', 'pnl_closed']
    const n1 = (v: number | null | undefined) => (v == null ? '' : v.toFixed(1))
    const rows = buySignals.map(b => {
      const log = logById.get(b.setupId)
      return [etTime(b.timestamp), b.symbol, b.setupType, b.triggerPrice, b.entryLow, b.entryHigh, b.invalidation, b.stop, b.targets.join(' '), b.score, b.grade, b.rewardRisk ?? '', b.priceAtSignal, b.flagged ? 'flagged' : '', b.ctxTrend15m ?? '', n1(b.ctxDistVwapPct), n1(b.ctxDistDayHighPct), n1(b.ctxRelVol), b.ctxHigherHighsLows == null ? '' : (b.ctxHigherHighsLows ? 'HH' : 'no'), n1(b.ctxAtrPct), log?.outcome ?? 'open', log?.maxFavorablePct?.toFixed(1) ?? '', log?.maxAdversePct?.toFixed(1) ?? '', b.pnlPct == null ? '' : b.pnlPct.toFixed(2), b.pnlPct == null ? '' : (b.pnlFullyClosed === false ? 'open_at_close' : 'closed')].join(',')
    })
    const csv = [head.join(','), ...rows].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url; a.download = `buy-signals-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <span className="text-[11px] text-gray-500">
          {buySignals.length} buy signals logged · newest first · timestamps in ET
          {status === 'done' && lastResolved > 0 && <span className="text-emerald-400"> · resolved {lastResolved}</span>}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => resolveNow()}
            disabled={status === 'running' || pendingCount === 0}
            title="Replay closed-day tapes: resolve open outcomes and price the scaled-out P/L"
            className="text-[11px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40"
          >
            {status === 'running' ? 'Resolving…' : `Resolve open${pendingCount ? ` (${pendingCount})` : ''}`}
          </button>
          <button onClick={exportCsv} disabled={!buySignals.length} className="text-[11px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40">Export CSV</button>
          <button onClick={clear} disabled={!buySignals.length} className="text-[11px] text-gray-500 hover:text-red-400 disabled:opacity-40">Clear</button>
        </div>
      </div>

      {pnl.n > 0 && (
        <div className="px-4 py-2.5 border-b border-gray-800 bg-gray-900/30">
          <div className="flex items-center gap-4 text-[11px]">
            <span className="text-gray-500">Realized P/L <span className="text-gray-600">(½ T1 · ½ T2 · b/e stop)</span></span>
            <span className={pnl.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>Net <b>{pnl.net >= 0 ? '+' : ''}{pnl.net.toFixed(1)}%</b></span>
            <span className={pnl.avg >= 0 ? 'text-emerald-400/90' : 'text-red-400/90'}>Avg {pnl.avg >= 0 ? '+' : ''}{pnl.avg.toFixed(2)}%/trade</span>
            <span className="text-gray-400">Green {pnl.winRate}%</span>
            <span className="text-gray-600">{pnl.n} priced{pnl.pending > 0 ? ` · ${pnl.pending} pending` : ''}</span>
          </div>
          {pnl.byType.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-gray-500">
              {pnl.byType.map(t => (
                <span key={t.label}>{t.label} <span className={t.net >= 0 ? 'text-emerald-400/80' : 'text-red-400/80'}>{t.net >= 0 ? '+' : ''}{t.net.toFixed(1)}%</span> <span className="text-gray-600">({t.n})</span></span>
              ))}
            </div>
          )}
        </div>
      )}

      {buySignals.length === 0 ? (
        <div className="text-center text-gray-600 text-sm py-16">
          No buy signals yet today. Every time the engine fires a BUY, it&apos;s logged here with its level, invalidation, targets, and timestamp — so you can review the day&apos;s calls at the close.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-[4.5rem_3.5rem_1fr_5rem_5rem_6rem_3rem_5rem] gap-2 px-4 py-1.5 text-[10px] text-gray-600 border-b border-gray-800 sticky top-0 bg-[#0a0d12]">
            <span>Time ET</span><span>Sym</span><span>Setup</span><span className="text-right">Trigger</span><span className="text-right">Stop</span><span className="text-right">Targets</span><span className="text-right">Score</span><span className="text-right">Result</span>
          </div>
          {buySignals.map(b => {
            const log = logById.get(b.setupId)
            const cur = roadmaps[b.symbol]?.currentPrice ?? null
            const movePct = cur != null && b.priceAtSignal > 0 ? ((cur - b.priceAtSignal) / b.priceAtSignal) * 100 : null
            const oc = OUTCOME_STYLE[log?.outcome ?? 'open']
            return (
              <button key={b.id} onClick={() => { selectSymbol(b.symbol); onPick() }}
                className="w-full text-left grid grid-cols-[4.5rem_3.5rem_1fr_5rem_5rem_6rem_3rem_5rem] gap-2 px-4 py-2 border-b border-gray-800/50 hover:bg-gray-800/40 items-center">
                <span className="text-[11px] text-gray-400 font-mono">{etTime(b.timestamp)}</span>
                <span className="text-xs font-bold text-white">{b.symbol}</span>
                <div className="min-w-0">
                  <div className="text-[11px] text-gray-300">{SETUP_TYPE_LABELS[b.setupType]} <span className="text-gray-600">{b.grade !== 'below' ? b.grade : ''}</span></div>
                  <div className="text-[10px] text-gray-600">entry ${fmt(b.entryLow)}–${fmt(b.entryHigh)} · inval ${fmt(b.invalidation)}{b.rewardRisk != null ? ` · R/R ${b.rewardRisk.toFixed(1)}:1` : ''}</div>
                </div>
                <span className="text-[11px] text-right text-gray-300">${fmt(b.triggerPrice)}</span>
                <span className="text-[11px] text-right text-red-400">${fmt(b.stop)}</span>
                <span className="text-[11px] text-right text-emerald-400/90">{b.targets.slice(0, 2).map(t => `$${fmt(t)}`).join(' ') || '—'}</span>
                <span className="text-[11px] text-right text-gray-300">{b.score}</span>
                <div className="text-right">
                  {b.pnlPct != null ? (
                    <span className={`text-[11px] font-semibold ${b.pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {b.pnlPct >= 0 ? '+' : ''}{b.pnlPct.toFixed(1)}%{b.pnlFullyClosed === false ? '*' : ''}
                    </span>
                  ) : (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${oc.cls}`}>{oc.label}</span>
                  )}
                  <div className="text-[10px] mt-0.5">
                    {log ? (
                      <span className="text-gray-500">+{log.maxFavorablePct.toFixed(1)}% / {log.maxAdversePct.toFixed(1)}%</span>
                    ) : movePct != null ? (
                      <span className={movePct >= 0 ? 'text-green-400/80' : 'text-red-400/80'}>{movePct >= 0 ? '+' : ''}{movePct.toFixed(1)}%</span>
                    ) : null}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Review ──────────────────────────────────────────────────────────────────

function FunnelCard() {
  const f = useTradingStore(s => s.monitorFunnel)
  if (!f) return null
  const st = f.byState
  const arrow = <span className="text-gray-700">→</span>
  return (
    <div className="text-[11px] bg-gray-900/60 border border-gray-800 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-semibold text-gray-400">Live signal funnel</span>
        <span className="text-gray-600">latest sweep · {dataAge(f.timestamp)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-gray-300">
        <span>{f.scanned} scanned</span>{arrow}
        <span>{f.symbolsWithSetups} with setups</span>{arrow}
        <span>{f.rawSetups} detected</span>{arrow}
        <span className="text-gray-500">{f.tracked} tracked</span>{arrow}
        <span className={f.triggered ? 'text-amber-300' : 'text-gray-500'}>{f.triggered} triggered</span>{arrow}
        <span className={f.logged ? 'text-emerald-400 font-semibold' : 'text-gray-500'}>{f.logged} logged</span>
      </div>
      {f.triggered > 0 && f.logged < f.triggered && (
        <div className="mt-1 text-[10px] text-gray-500">
          Triggered but dropped: <span className="text-red-400/80">veto {f.droppedVeto}</span> · after-close {f.droppedSession} · stand-down {f.droppedStandDown} · capped {f.droppedCapped} · dup {f.droppedDup}
        </div>
      )}
      <div className="mt-1 text-[10px] text-gray-600">
        States: identified {st.identified ?? 0} · approaching {st.approaching ?? 0} · at-level {st.at_level ?? 0} · confirming {st.confirming ?? 0} · triggered {st.triggered ?? 0}
        {f.belowFloor > 0 ? ` · (${f.belowFloor} below floor)` : ''}
      </div>
    </div>
  )
}

// ── Pattern Scan (top-10 gainers) ────────────────────────────────────────────

const TOP_GAINERS_N = 10

function PatternsTab({ onPick }: { onPick: () => void }) {
  const scannerRows = useTradingStore(s => s.scannerRows)
  const symbolPatterns = useTradingStore(s => s.symbolPatterns)
  const selectSymbol = useTradingStore(s => s.selectSymbol)

  // The day's top gainers = the scanner ranked by change, top N.
  const top = useMemo(() =>
    [...scannerRows].sort((a, b) => b.changePct - a.changePct).slice(0, TOP_GAINERS_N),
    [scannerRows])

  const rows = top
    .map(g => ({ g, hits: (symbolPatterns[g.symbol] ?? []).slice().sort((a, b) => b.strength - a.strength) }))
    .filter(r => r.hits.length > 0)

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-gray-800">
        <span className="text-[11px] text-gray-500">
          Bullish candlestick patterns on the day&apos;s top {TOP_GAINERS_N} gainers · scored by location (at support), volume, and trend
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="text-center text-gray-600 text-sm py-16 px-6">
          No patterns on the top gainers right now. As a gainer forms a hammer, engulfing, morning star, or three-white-soldiers — especially pulled back to support on volume — it shows here.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto divide-y divide-gray-800/60">
          {rows.map(({ g, hits }) => (
            <button key={g.symbol} onClick={() => { selectSymbol(g.symbol); onPick() }}
              className="w-full text-left px-4 py-2.5 hover:bg-gray-800/40 flex items-start gap-3">
              <div className="w-20 flex-shrink-0">
                <div className="text-xs font-bold text-white">{g.symbol}</div>
                <div className="text-[11px] font-mono text-green-400">+{g.changePct.toFixed(0)}%</div>
              </div>
              <div className="flex flex-wrap gap-1.5 min-w-0">
                {hits.map((h, i) => <PatternChip key={i} hit={h} />)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function PatternChip({ hit }: { hit: PatternHit }) {
  const strong = hit.strength >= 75
  const mid = hit.strength >= 55
  const cls = strong ? 'text-emerald-300 bg-emerald-900/40 border-emerald-800'
    : mid ? 'text-yellow-300 bg-yellow-900/30 border-yellow-900'
    : 'text-gray-400 bg-gray-800/60 border-gray-700'
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded border ${cls}`} title={`strength ${hit.strength}`}>
      {PATTERN_LABELS[hit.pattern]}
      <span className="font-mono text-[10px] opacity-80"> {hit.strength}</span>
      {hit.atSupport && <span className="text-[9px] ml-1 opacity-70">@supp</span>}
      {hit.volumeConfirmed && <span className="text-[9px] ml-0.5 opacity-70">·vol</span>}
    </span>
  )
}

function ReviewTab() {
  const logs = useTradingStore(s => s.setupLogs)
  const funnel = useTradingStore(s => s.monitorFunnel)
  const stats = useMemo(() => computeReview(logs), [logs])

  if (logs.length === 0 && !funnel) return <div className="text-center text-gray-600 text-sm py-16">No setups logged yet. As the engine identifies and tracks setups, their outcomes accumulate here for calibration.</div>

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <FunnelCard />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Stat label="Entered / tracked" value={`${stats.entered} / ${stats.total}`} />
        <Stat label="Resolved" value={String(stats.resolved)} />
        <Stat label="Hit T1" value={`${stats.winRate}%`} good />
        <Stat label="Avg MFE / MAE" value={`+${fmt(stats.avgMfe, 1)}% / ${fmt(stats.avgMae, 1)}%`} />
      </div>

      <p className="text-[11px] text-gray-500">
        Performance below is over <span className="text-gray-300">entered (triggered)</span> setups only — watches that never triggered are excluded, so per-type win-rates reflect trades you&apos;d actually take.
      </p>

      <ReviewTable title="By setup type" rows={stats.byType} />
      <ReviewTable title="By score range" rows={stats.byScore} />
      <ReviewTable title="By session" rows={stats.bySession} />
      <ReviewTable title="First test vs repeat (EMA/VWAP)" rows={stats.byTest} />

      <div className="text-[11px] text-gray-500 bg-gray-900/60 border border-gray-800 rounded-lg p-3">
        <p className="font-semibold text-gray-400 mb-1">Calibration read-out</p>
        <p>False-breakout frequency: <span className="text-gray-300">{stats.falseBreakoutPct}%</span> of breakout entries invalidated after triggering.</p>
        <p>Most reliable setup type by T1 hit-rate: <span className="text-gray-300">{stats.bestType}</span>.</p>
        <p className="mt-1 text-gray-600">These outcomes are the basis for tuning the scoring weights from real results rather than assumptions.</p>
      </div>
    </div>
  )
}

function Stat({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-lg p-2.5">
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold ${good ? 'text-green-400' : 'text-white'}`}>{value}</div>
    </div>
  )
}

function ReviewTable({ title, rows }: { title: string; rows: { label: string; n: number; win: number; mfe: number; mae: number }[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 mb-1.5">{title}</h3>
      <div className="bg-gray-900/40 border border-gray-800 rounded-lg overflow-hidden">
        <div className="grid grid-cols-[1fr_3rem_4rem_4rem_4rem] gap-1 px-3 py-1.5 text-[10px] text-gray-600 border-b border-gray-800">
          <span>Bucket</span><span className="text-right">N</span><span className="text-right">T1%</span><span className="text-right">MFE</span><span className="text-right">MAE</span>
        </div>
        {rows.length === 0 && <div className="px-3 py-2 text-[11px] text-gray-600">No data</div>}
        {rows.map(r => (
          <div key={r.label} className="grid grid-cols-[1fr_3rem_4rem_4rem_4rem] gap-1 px-3 py-1.5 text-[11px] border-b border-gray-800/40">
            <span className="text-gray-300">{r.label}</span>
            <span className="text-right text-gray-400">{r.n}</span>
            <span className={`text-right ${r.win >= 50 ? 'text-green-400' : 'text-gray-400'}`}>{r.n ? Math.round(r.win) : 0}%</span>
            <span className="text-right text-green-400/80">+{fmt(r.mfe, 1)}%</span>
            <span className="text-right text-red-400/80">{fmt(r.mae, 1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface Bucket { label: string; n: number; win: number; mfe: number; mae: number }
function computeReview(logs: SetupLog[]) {
  // Performance is judged over ENTERED trades only. The log tracks every setup
  // that clears the display floor — hundreds of watches (identified/approaching)
  // per handful of real triggers — so counting all of them swamps every per-type
  // win-rate with setups that were never bought. triggeredAt is set the moment a
  // setup reaches the (non-vetoed) triggered state, i.e. the trades you'd take.
  const entered = logs.filter(l => l.triggeredAt != null)
  const resolved = entered.filter(l => l.outcome !== 'open')
  const wins = entered.filter(l => l.outcome === 'target_hit')
  const winRate = resolved.length ? Math.round((wins.length / resolved.length) * 100) : 0
  const avgMfe = avg(entered.map(l => l.maxFavorablePct))
  const avgMae = avg(entered.map(l => l.maxAdversePct))

  const bucketize = (keyFn: (l: SetupLog) => string): Bucket[] => {
    const map = new Map<string, SetupLog[]>()
    for (const l of entered) {
      const k = keyFn(l)
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(l)
    }
    return [...map.entries()].map(([label, ls]) => {
      const res = ls.filter(l => l.outcome !== 'open')
      const w = ls.filter(l => l.outcome === 'target_hit')
      return { label, n: ls.length, win: res.length ? (w.length / res.length) * 100 : 0, mfe: avg(ls.map(l => l.maxFavorablePct)), mae: avg(ls.map(l => l.maxAdversePct)) }
    }).sort((a, b) => b.n - a.n)
  }

  const byType = bucketize(l => SETUP_TYPE_LABELS[l.type])
  const byScore = bucketize(l => l.score >= 85 ? '85+' : l.score >= 75 ? '75–84' : l.score >= 65 ? '65–74' : '<65')
  const bySession = bucketize(l => l.sessionAtId)
  const emaVwap = entered.filter(l => l.type.includes('ema') || l.type.includes('vwap'))
  const byTest = [
    testBucket('First test', emaVwap.filter(l => l.testCount <= 1)),
    testBucket('Repeat test', emaVwap.filter(l => l.testCount >= 2)),
  ].filter(b => b.n > 0)

  const breakouts = entered.filter(l => l.type === 'breakout')
  const falseBreakouts = breakouts.filter(l => l.outcome === 'invalidated')
  const falseBreakoutPct = breakouts.length ? Math.round((falseBreakouts.length / breakouts.length) * 100) : 0
  const bestType = byType.filter(b => b.n >= 2).sort((a, b) => b.win - a.win)[0]?.label ?? '—'

  return { total: logs.length, entered: entered.length, resolved: resolved.length, winRate, avgMfe, avgMae, byType, byScore, bySession, byTest, falseBreakoutPct, bestType }
}
function testBucket(label: string, ls: SetupLog[]): Bucket {
  const res = ls.filter(l => l.outcome !== 'open')
  const w = ls.filter(l => l.outcome === 'target_hit')
  return { label, n: ls.length, win: res.length ? (w.length / res.length) * 100 : 0, mfe: avg(ls.map(l => l.maxFavorablePct)), mae: avg(ls.map(l => l.maxAdversePct)) }
}
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }

// Realized scaled-out P/L summary over the buy signals that have been priced.
function computeBuyPnl(buys: BuySignalRecord[]) {
  const priced = buys.filter(b => b.pnlPct != null)
  const pending = buys.filter(b => b.pnlPct == null).length
  const pcts = priced.map(b => b.pnlPct as number)
  const net = pcts.reduce((a, b) => a + b, 0)
  const wins = pcts.filter(p => p > 0).length
  const byTypeMap = new Map<string, number[]>()
  for (const b of priced) {
    const k = SETUP_TYPE_LABELS[b.setupType]
    if (!byTypeMap.has(k)) byTypeMap.set(k, [])
    byTypeMap.get(k)!.push(b.pnlPct as number)
  }
  const byType = [...byTypeMap.entries()]
    .map(([label, ps]) => ({ label, n: ps.length, net: ps.reduce((a, b) => a + b, 0), avg: avg(ps) }))
    .sort((a, b) => b.net - a.net)
  return { n: priced.length, pending, net, avg: avg(pcts), winRate: priced.length ? Math.round((wins / priced.length) * 100) : 0, byType }
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsTab() {
  const settings = useTradingStore(s => s.notificationSettings)
  const update = useTradingStore(s => s.updateNotificationSettings)

  return (
    <div className="h-full overflow-y-auto p-4 max-w-2xl mx-auto space-y-4">
      <Toggle label="Monitoring enabled" checked={settings.enabled} onChange={v => update({ enabled: v })} />
      <div className="grid grid-cols-2 gap-3">
        <NumberField label="Min setup score" value={settings.minScore} min={0} max={100} onChange={v => update({ minScore: v })} />
        <NumberField label="Min level strength" value={settings.minLevelStrength} min={0} max={100} onChange={v => update({ minLevelStrength: v })} />
        <NumberField label="Early-warning ×" value={settings.earlyWarningMultiplier} min={0.25} max={3} step={0.25} onChange={v => update({ earlyWarningMultiplier: v })} />
        <NumberField label="Cooldown (s)" value={Math.round(settings.cooldownMs / 1000)} min={0} max={600} onChange={v => update({ cooldownMs: v * 1000 })} />
        <NumberField label="Max alerts / ticker" value={settings.maxAlertsPerTicker} min={1} max={50} onChange={v => update({ maxAlertsPerTicker: v })} />
        <NumberField label="Re-alert score Δ" value={settings.scoreChangeThreshold} min={1} max={30} onChange={v => update({ scoreChangeThreshold: v })} />
      </div>

      <div className="flex gap-2">
        <ScopeButton active={settings.scope === 'scanner'} label="Scanner-wide" onClick={() => update({ scope: 'scanner' })} />
        <ScopeButton active={settings.scope === 'watchlist'} label="Watchlist only" onClick={() => update({ scope: 'watchlist' })} />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <Toggle label="Browser notifications" checked={settings.browserNotifications} onChange={v => update({ browserNotifications: v })} />
        <Toggle label="Alert sound" checked={settings.sound} onChange={v => update({ sound: v })} />
        <Toggle label="In-app signals" checked={settings.inApp} onChange={v => update({ inApp: v })} />
        <Toggle label="Longs" checked={settings.allowLong} onChange={v => update({ allowLong: v })} />
        <Toggle label="Shorts" checked={settings.allowShort} onChange={v => update({ allowShort: v })} />
        <Toggle label="Premarket alerts" checked={settings.premarketAlerts} onChange={v => update({ premarketAlerts: v })} />
        <Toggle label="Regular-hours alerts" checked={settings.regularHoursAlerts} onChange={v => update({ regularHoursAlerts: v })} />
        <Toggle label="After-hours alerts" checked={settings.afterHoursAlerts} onChange={v => update({ afterHoursAlerts: v })} />
      </div>

      <div>
        <h3 className="text-xs font-semibold text-gray-400 mb-1.5">Setup types</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          {Object.entries(SETUP_TYPE_LABELS).map(([k, label]) => (
            <Toggle key={k} label={label} checked={settings.setupTypes[k as SetupType]}
              onChange={v => update({ setupTypes: { ...settings.setupTypes, [k]: v } })} />
          ))}
        </div>
      </div>

      <p className="text-[11px] text-gray-600">
        Grade scale: {(Object.entries(GRADE_DESCRIPTIONS) as [SetupGrade, string][]).filter(([g]) => g !== 'below').map(([g, d]) => `${g} ${d}`).join(' · ')}.
      </p>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex items-center gap-2 text-xs text-gray-300 py-1">
      <span className={`w-8 h-4 rounded-full relative transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-700'}`}>
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${checked ? 'left-4' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  )
}

function NumberField({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <label className="text-[11px] text-gray-500">
      {label}
      <input type="number" value={value} min={min} max={max} step={step ?? 1}
        onChange={e => onChange(Number(e.target.value))}
        className="block w-full mt-0.5 px-2 py-1 bg-gray-900 border border-gray-700 rounded text-gray-200 text-xs" />
    </label>
  )
}

function ScopeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex-1 text-xs px-3 py-1.5 rounded border ${active ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-gray-200'}`}>{label}</button>
  )
}
