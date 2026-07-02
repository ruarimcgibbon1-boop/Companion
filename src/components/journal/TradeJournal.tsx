'use client'

import { useState, useMemo } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { Position, TradeTag } from '@/types'

// ── Stats helpers ──────────────────────────────────────────────────────────

function realizedPnl(pos: Position): number | null {
  if (pos.status !== 'closed' && pos.status !== 'stopped') return null
  if (pos.closePrice == null) return null
  const mult = pos.direction === 'long' ? 1 : -1
  return (pos.closePrice - pos.entry) * pos.shares * mult
}

function rMultiple(pos: Position): number | null {
  const pnl = realizedPnl(pos)
  if (pnl == null) return null
  const risk = Math.abs(pos.entry - pos.initialStop) * pos.shares
  if (risk === 0) return null
  return pnl / risk
}

function duration(pos: Position): string {
  const end = pos.closedAt ?? Date.now()
  const ms = end - pos.openedAt
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: '2-digit',
    timeZone: 'America/New_York',
  })
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/New_York',
  })
}

interface Stats {
  total: number
  wins: number
  losses: number
  winRate: number
  totalPnl: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  avgR: number
  largestWin: number
  largestLoss: number
  avgDurationMins: number
  followedPlanPct: number
}

function calcStats(trades: Position[]): Stats {
  const closed = trades.filter(p => realizedPnl(p) !== null)
  const pnls = closed.map(p => realizedPnl(p)!)
  const wins = pnls.filter(p => p > 0)
  const losses = pnls.filter(p => p <= 0)
  const rs = closed.map(p => rMultiple(p)).filter(Boolean) as number[]

  const totalGross = wins.reduce((s, v) => s + v, 0)
  const totalLoss = Math.abs(losses.reduce((s, v) => s + v, 0))
  const durations = closed.map(p => ((p.closedAt ?? Date.now()) - p.openedAt) / 60000)
  const plannedCount = closed.filter(p => p.plannedEntry).length

  return {
    total: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    totalPnl: pnls.reduce((s, v) => s + v, 0),
    avgWin: wins.length ? totalGross / wins.length : 0,
    avgLoss: losses.length ? totalLoss / losses.length : 0,
    profitFactor: totalLoss > 0 ? totalGross / totalLoss : totalGross > 0 ? Infinity : 0,
    avgR: rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : 0,
    largestWin: wins.length ? Math.max(...wins) : 0,
    largestLoss: losses.length ? Math.max(...losses.map(Math.abs)) : 0,
    avgDurationMins: durations.length ? durations.reduce((s, v) => s + v, 0) / durations.length : 0,
    followedPlanPct: closed.length ? (plannedCount / closed.length) * 100 : 0,
  }
}

// ── Equity curve (SVG) ─────────────────────────────────────────────────────

function EquityCurve({ trades }: { trades: Position[] }) {
  const closed = trades
    .filter(p => realizedPnl(p) !== null)
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))

  if (closed.length < 2) {
    return <div className="h-24 flex items-center justify-center text-xs text-gray-700">Need at least 2 closed trades for curve</div>
  }

  // Build cumulative P&L series
  let running = 0
  const points = [0, ...closed.map(p => { running += realizedPnl(p)!; return running })]
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1

  const W = 400
  const H = 80
  const pad = 4

  const coords = points.map((v, i) => ({
    x: pad + (i / (points.length - 1)) * (W - pad * 2),
    y: H - pad - ((v - min) / range) * (H - pad * 2),
  }))

  const pathD = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const fillD = `${pathD} L${coords[coords.length - 1].x},${H} L${coords[0].x},${H} Z`

  const isPositive = running >= 0
  const color = isPositive ? '#22c55e' : '#ef4444'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24" preserveAspectRatio="none">
      <defs>
        <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* Zero line */}
      {min < 0 && max > 0 && (
        <line
          x1={pad} x2={W - pad}
          y1={H - pad - ((0 - min) / range) * (H - pad * 2)}
          y2={H - pad - ((0 - min) / range) * (H - pad * 2)}
          stroke="#374151" strokeWidth="1" strokeDasharray="4,4"
        />
      )}
      <path d={fillD} fill="url(#equityGrad)" />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" />
      {/* Last point dot */}
      <circle cx={coords[coords.length - 1].x} cy={coords[coords.length - 1].y} r="3" fill={color} />
    </svg>
  )
}

// ── Tag picker ─────────────────────────────────────────────────────────────

const ALL_TAGS: TradeTag[] = [
  'Breakout', 'Pullback', 'VWAP Reclaim', 'Reclaim', 'Momentum', 'Reversal', 'Gap Fill', 'News Play',
  'Good Execution', 'Followed Plan', 'Early Entry', 'Late Entry', 'Held Too Long', 'Exited Too Early',
  'Overtraded', 'Revenge Trade', 'FOMO', 'Broke Rules',
]

const TAG_COLORS: Partial<Record<TradeTag, string>> = {
  'Good Execution': 'border-green-700 text-green-400 bg-green-900/20',
  'Followed Plan': 'border-green-700 text-green-400 bg-green-900/20',
  'Overtraded': 'border-red-700 text-red-400 bg-red-900/20',
  'Revenge Trade': 'border-red-700 text-red-400 bg-red-900/20',
  'FOMO': 'border-red-700 text-red-400 bg-red-900/20',
  'Broke Rules': 'border-red-700 text-red-400 bg-red-900/20',
}

function tagColor(t: TradeTag): string {
  return TAG_COLORS[t] ?? 'border-gray-700 text-gray-400 bg-gray-900/30'
}

// ── Trade row ──────────────────────────────────────────────────────────────

function TradeRow({ pos, onSelect, selected }: { pos: Position; selected: boolean; onSelect: () => void }) {
  const pnl = realizedPnl(pos)
  const r = rMultiple(pos)
  const isOpen = pnl === null
  const pnlColor = isOpen ? 'text-blue-400' : pnl! >= 0 ? 'text-green-400' : 'text-red-400'

  return (
    <div
      onClick={onSelect}
      className={`grid grid-cols-[6rem_3.5rem_2.5rem_4rem_4rem_4rem_4rem_1fr] gap-2 px-4 py-2 text-xs cursor-pointer border-b border-gray-800/60 hover:bg-gray-800/30 transition-colors ${selected ? 'bg-blue-900/10 border-l-2 border-l-blue-500' : ''}`}
    >
      <span className="text-gray-400">{fmtDate(pos.openedAt)} <span className="text-gray-600">{fmtTime(pos.openedAt)}</span></span>
      <span className="font-bold text-white">{pos.symbol}</span>
      <span className={`font-semibold ${pos.direction === 'long' ? 'text-green-400' : 'text-red-400'}`}>{pos.direction === 'long' ? 'L' : 'S'}</span>
      <span className="font-mono text-gray-300">${pos.entry.toFixed(2)}</span>
      <span className="font-mono text-gray-300">{pos.closePrice != null ? `$${pos.closePrice.toFixed(2)}` : '—'}</span>
      <span className={`font-mono font-semibold ${pnlColor}`}>{isOpen ? 'OPEN' : pnl! >= 0 ? `+$${pnl!.toFixed(2)}` : `-$${Math.abs(pnl!).toFixed(2)}`}</span>
      <span className={`font-mono ${r == null ? 'text-gray-600' : r >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r != null ? `${r >= 0 ? '+' : ''}${r.toFixed(2)}R` : '—'}</span>
      <span className="text-gray-600 truncate">{pos.setupType || pos.tags.slice(0, 2).join(', ') || '—'}</span>
    </div>
  )
}

// ── Trade detail panel ─────────────────────────────────────────────────────

function TradeDetail({ pos }: { pos: Position }) {
  const { updatePosition, selectSymbol } = useTradingStore()
  const [notes, setNotes] = useState(pos.notes)
  const [rating, setRating] = useState<typeof pos.rating>(pos.rating)
  const [tags, setTags] = useState<TradeTag[]>(pos.tags)
  const [setupType, setSetupType] = useState(pos.setupType)
  const [plannedEntry, setPlannedEntry] = useState(pos.plannedEntry)

  const pnl = realizedPnl(pos)
  const r = rMultiple(pos)

  function save() {
    updatePosition(pos.id, { notes, rating, tags, setupType, plannedEntry })
  }

  function toggleTag(t: TradeTag) {
    setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto px-5 py-4 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <button onClick={() => selectSymbol(pos.symbol)} className="text-xl font-bold text-white hover:text-blue-400 transition-colors">
              {pos.symbol}
            </button>
            <span className={`text-sm font-semibold px-2 py-0.5 rounded ${pos.direction === 'long' ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'}`}>
              {pos.direction.toUpperCase()}
            </span>
            <span className="text-sm text-gray-500">{pos.shares.toLocaleString()} shares</span>
          </div>
          <div className="text-xs text-gray-600 mt-0.5">{fmtDate(pos.openedAt)} {fmtTime(pos.openedAt)} ET · {duration(pos)}</div>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-mono font-bold ${pnl == null ? 'text-blue-400' : pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {pnl == null ? 'OPEN' : pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`}
          </div>
          {r != null && (
            <div className={`text-sm font-mono ${r >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r >= 0 ? '+' : ''}{r.toFixed(2)}R</div>
          )}
        </div>
      </div>

      {/* Trade stats grid */}
      <div className="grid grid-cols-3 gap-3">
        {[
          ['Entry', `$${pos.entry.toFixed(2)}`],
          ['Exit', pos.closePrice != null ? `$${pos.closePrice.toFixed(2)}` : '—'],
          ['Initial Stop', `$${pos.initialStop.toFixed(2)}`],
          ['Risk/Share', `$${Math.abs(pos.entry - pos.initialStop).toFixed(3)}`],
          ['Total Risk', `$${(Math.abs(pos.entry - pos.initialStop) * pos.shares).toFixed(2)}`],
          ['Duration', duration(pos)],
        ].map(([label, value]) => (
          <div key={label} className="bg-gray-900 rounded p-2 border border-gray-800">
            <div className="text-[10px] text-gray-600 mb-0.5">{label}</div>
            <div className="text-xs font-mono text-gray-200">{value}</div>
          </div>
        ))}
      </div>

      {/* Targets */}
      {pos.targets.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Targets</div>
          <div className="flex gap-2">
            {pos.targets.map((t, i) => (
              <div key={i} className={`flex-1 rounded p-2 border text-center ${t.hit ? 'border-green-800 bg-green-900/20' : 'border-gray-800 bg-gray-900'}`}>
                <div className="text-[10px] text-gray-600">{t.label}</div>
                <div className={`text-xs font-mono ${t.hit ? 'text-green-400' : 'text-gray-400'}`}>${t.price.toFixed(2)}</div>
                {t.hit && <div className="text-[10px] text-green-600">Hit ✓</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Setup type */}
      <div>
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">Setup Type</label>
        <input
          value={setupType}
          onChange={e => setSetupType(e.target.value)}
          onBlur={save}
          placeholder="e.g. VWAP Pullback, Breakout, Reclaim..."
          className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500 focus:outline-none placeholder-gray-700"
        />
      </div>

      {/* Rating */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Trade Rating</div>
        <div className="flex gap-1.5">
          {([1, 2, 3, 4, 5] as const).map(n => (
            <button
              key={n}
              onClick={() => { setRating(n); setTimeout(save, 0) }}
              className={`flex-1 py-1.5 rounded text-sm border transition-colors ${
                rating === n
                  ? 'bg-yellow-700/50 border-yellow-500 text-yellow-300'
                  : 'bg-gray-900 border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
              }`}
            >
              {'★'.repeat(n)}
            </button>
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-gray-700 mt-0.5 px-1">
          <span>Poor</span><span>Average</span><span>Excellent</span>
        </div>
      </div>

      {/* Followed plan */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setPlannedEntry(v => !v); setTimeout(save, 0) }}
          className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors ${
            plannedEntry
              ? 'bg-green-900/30 border-green-700 text-green-400'
              : 'bg-red-900/20 border-red-800 text-red-400'
          }`}
        >
          {plannedEntry ? '✓ Followed the plan' : '✕ Deviated from plan'}
        </button>
        <span className="text-xs text-gray-600">Click to toggle</span>
      </div>

      {/* Tags */}
      <div>
        <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tags</div>
        <div className="flex flex-wrap gap-1.5">
          {ALL_TAGS.map(t => (
            <button
              key={t}
              onClick={() => { toggleTag(t); setTimeout(save, 0) }}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                tags.includes(t)
                  ? tagColor(t)
                  : 'border-gray-800 text-gray-600 hover:border-gray-600 hover:text-gray-400'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div className="flex-1">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider block mb-1.5">Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onBlur={save}
          placeholder="What went well? What would you do differently? What did the tape tell you?"
          rows={5}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-2 text-xs text-gray-300 placeholder-gray-700 focus:border-blue-500 focus:outline-none resize-none leading-relaxed"
        />
        <div className="text-[10px] text-gray-700 mt-1">Auto-saves on blur</div>
      </div>
    </div>
  )
}

// ── Summary stats bar ──────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = 'text-gray-200' }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
      <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-base font-mono font-semibold ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-600 mt-0.5">{sub}</div>}
    </div>
  )
}

function StatsPanel({ stats, trades }: { stats: Stats; trades: Position[] }) {
  const pnlColor = stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'
  const pfStr = isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'
  const pfColor = stats.profitFactor >= 1.5 ? 'text-green-400' : stats.profitFactor >= 1 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="px-5 py-4 border-b border-gray-800">
      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCard label="Total P&L" value={`${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`} sub={`${stats.total} trades`} color={pnlColor} />
        <StatCard label="Win Rate" value={`${stats.winRate.toFixed(0)}%`} sub={`${stats.wins}W / ${stats.losses}L`} color={stats.winRate >= 50 ? 'text-green-400' : 'text-red-400'} />
        <StatCard label="Profit Factor" value={pfStr} sub={`Avg R: ${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`} color={pfColor} />
        <StatCard label="Avg Win / Loss" value={`$${stats.avgWin.toFixed(0)} / $${stats.avgLoss.toFixed(0)}`} sub={`Followed plan: ${stats.followedPlanPct.toFixed(0)}%`} />
      </div>
      <div>
        <div className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">Equity Curve</div>
        <EquityCurve trades={trades} />
      </div>
    </div>
  )
}

// ── Main Journal ───────────────────────────────────────────────────────────

type FilterMode = 'all' | 'open' | 'wins' | 'losses' | 'today'

export function TradeJournal({ onClose }: { onClose: () => void }) {
  const { positions } = useTradingStore()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterMode>('all')
  const [search, setSearch] = useState('')

  const allClosed = useMemo(
    () => positions.filter(p => p.status === 'closed' || p.status === 'stopped'),
    [positions]
  )

  const filtered = useMemo(() => {
    let list = [...positions].sort((a, b) => b.openedAt - a.openedAt)
    if (filter === 'open') list = list.filter(p => p.status !== 'closed' && p.status !== 'stopped')
    if (filter === 'wins') list = list.filter(p => (realizedPnl(p) ?? -1) > 0)
    if (filter === 'losses') list = list.filter(p => { const pnl = realizedPnl(p); return pnl != null && pnl <= 0 })
    if (filter === 'today') {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      list = list.filter(p => p.openedAt >= todayStart.getTime())
    }
    if (search) list = list.filter(p => p.symbol.includes(search.toUpperCase()))
    return list
  }, [positions, filter, search])

  const stats = useMemo(() => calcStats(allClosed), [allClosed])
  const selected = positions.find(p => p.id === selectedId) ?? null

  return (
    <div className="fixed inset-0 z-50 bg-[#080b10] flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-bold text-white tracking-wide">TRADE JOURNAL</h1>
          <span className="text-xs text-gray-600">{positions.length} total · {allClosed.length} closed</span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-lg px-2 transition-colors">✕</button>
      </div>

      {/* Stats */}
      {allClosed.length > 0 && <StatsPanel stats={stats} trades={allClosed} />}

      {/* Filters + search */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-800 flex-shrink-0">
        {(['all', 'open', 'wins', 'losses', 'today'] as FilterMode[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-2.5 py-1 rounded capitalize transition-colors border ${
              filter === f ? 'bg-blue-800 border-blue-600 text-white' : 'border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
            }`}
          >
            {f}
          </button>
        ))}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search symbol..."
          className="ml-auto w-32 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:border-blue-500 focus:outline-none placeholder-gray-700"
        />
      </div>

      {/* Table header */}
      <div className="grid grid-cols-[6rem_3.5rem_2.5rem_4rem_4rem_4rem_4rem_1fr] gap-2 px-4 py-1.5 border-b border-gray-800 text-[10px] text-gray-600 uppercase tracking-wider flex-shrink-0">
        <span>Date</span><span>Symbol</span><span>Dir</span>
        <span>Entry</span><span>Exit</span><span>P&L</span><span>R</span><span>Setup</span>
      </div>

      {/* Content */}
      <div className="flex flex-1 min-h-0">
        {/* Trade list */}
        <div className={`overflow-y-auto ${selected ? 'w-1/2 border-r border-gray-800' : 'w-full'}`}>
          {filtered.length === 0 ? (
            <div className="px-5 py-12 text-center text-xs text-gray-600">
              No trades match this filter. Add a position from the main dashboard to get started.
            </div>
          ) : (
            filtered.map(pos => (
              <TradeRow
                key={pos.id}
                pos={pos}
                selected={selectedId === pos.id}
                onSelect={() => setSelectedId(selectedId === pos.id ? null : pos.id)}
              />
            ))
          )}
        </div>

        {/* Trade detail */}
        {selected && (
          <div className="w-1/2 overflow-y-auto">
            <TradeDetail key={selected.id} pos={selected} />
          </div>
        )}
      </div>
    </div>
  )
}
