'use client'

import { useState } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { usePositionTracker } from '@/hooks/usePositionTracker'
import { dataAge } from '@/lib/market-hours'
import type { Position, PositionDirection, TrailingStopMode, PositionTarget } from '@/types'

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function fmtPnl(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`
}

function fmtPnlPct(v: number | null | undefined): string {
  if (v == null) return ''
  return `(${v >= 0 ? '+' : ''}${v.toFixed(2)}%)`
}

function pnlColor(v: number | null | undefined): string {
  if (v == null) return 'text-gray-400'
  if (v > 0) return 'text-green-400'
  if (v < 0) return 'text-red-400'
  return 'text-gray-400'
}

const STATUS_LABELS: Record<Position['status'], string> = {
  open: 'OPEN',
  t1_hit: 'T1 ✓',
  t2_hit: 'T2 ✓',
  t3_hit: 'T3 ✓',
  stopped: 'STOPPED',
  closed: 'CLOSED',
}

const STATUS_COLORS: Record<Position['status'], string> = {
  open: 'text-blue-400',
  t1_hit: 'text-yellow-400',
  t2_hit: 'text-orange-400',
  t3_hit: 'text-green-400',
  stopped: 'text-red-400',
  closed: 'text-gray-500',
}

// ── Add Position Form ──────────────────────────────────────────────────────

interface AddFormProps {
  defaultSymbol?: string
  defaultEntry?: number
  onClose: () => void
}

function AddPositionForm({ defaultSymbol = '', defaultEntry, onClose }: AddFormProps) {
  const { addPosition, snapshot } = useTradingStore()

  const suggestedStop = snapshot?.pullbacks[0]?.invalidation
  const suggestedT1 = snapshot?.pullbacks[0]?.target1
  const suggestedT2 = snapshot?.pullbacks[0]?.target2
  const atr = snapshot?.technical?.atr

  const [symbol, setSymbol] = useState(defaultSymbol || snapshot?.symbol || '')
  const [direction, setDirection] = useState<PositionDirection>('long')
  const [shares, setShares] = useState('')
  const [entry, setEntry] = useState(defaultEntry?.toFixed(2) ?? snapshot?.quote?.price?.toFixed(2) ?? '')
  const [stop, setStop] = useState(suggestedStop?.toFixed(2) ?? '')
  const [t1, setT1] = useState(suggestedT1?.toFixed(2) ?? '')
  const [t2, setT2] = useState(suggestedT2?.toFixed(2) ?? '')
  const [t3, setT3] = useState('')
  const [trailingMode, setTrailingMode] = useState<TrailingStopMode>('none')
  const [trailingValue, setTrailingValue] = useState(atr ? (atr * 1.5).toFixed(3) : '2')

  const entryN = parseFloat(entry)
  const stopN = parseFloat(stop)
  const sharesN = parseInt(shares, 10)
  const valid = symbol && !isNaN(entryN) && !isNaN(stopN) && !isNaN(sharesN) && sharesN > 0 && entryN !== stopN

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return

    const targets: PositionTarget[] = []
    if (t1 && !isNaN(parseFloat(t1))) targets.push({ label: 'T1', price: parseFloat(t1), hit: false, hitAt: null })
    if (t2 && !isNaN(parseFloat(t2))) targets.push({ label: 'T2', price: parseFloat(t2), hit: false, hitAt: null })
    if (t3 && !isNaN(parseFloat(t3))) targets.push({ label: 'T3', price: parseFloat(t3), hit: false, hitAt: null })

    const trailN = parseFloat(trailingValue) || 0

    const pos: Position = {
      id: uid(),
      symbol: symbol.toUpperCase(),
      direction,
      shares: sharesN,
      entry: entryN,
      stop: stopN,
      initialStop: stopN,
      targets,
      trailingMode,
      trailingValue: trailN,
      trailingHigh: entryN,
      status: 'open',
      openedAt: Date.now(),
      closedAt: null,
      closePrice: null,
      notes: '',
      tags: [],
      rating: null,
      plannedEntry: true,
      setupType: '',
      currentPrice: null,
      unrealizedPnl: null,
      unrealizedPnlPct: null,
      lastPriceUpdate: null,
    }
    addPosition(pos)
    onClose()
  }

  const riskPerShare = !isNaN(entryN) && !isNaN(stopN) ? Math.abs(entryN - stopN) : null
  const totalRisk = riskPerShare && sharesN ? riskPerShare * sharesN : null
  const rrT1 = riskPerShare && t1 && !isNaN(parseFloat(t1))
    ? Math.abs(parseFloat(t1) - entryN) / riskPerShare
    : null

  return (
    <form onSubmit={submit} className="bg-[#0e1117] border border-gray-700 rounded-xl p-4 w-[420px] shadow-2xl shadow-black/60">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">Add Position</h3>
        <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Symbol</label>
          <input
            value={symbol}
            onChange={e => setSymbol(e.target.value.toUpperCase())}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none"
            placeholder="AAPL"
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Direction</label>
          <div className="flex gap-1">
            {(['long', 'short'] as const).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={`flex-1 py-1.5 rounded text-xs font-semibold border transition-colors ${
                  direction === d
                    ? d === 'long' ? 'bg-green-800 border-green-600 text-white' : 'bg-red-800 border-red-600 text-white'
                    : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                {d.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="text-xs text-gray-500 block mb-1">Shares</label>
          <input type="number" value={shares} onChange={e => setShares(e.target.value)} min="1"
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none" placeholder="100" />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Entry $</label>
          <input type="number" value={entry} onChange={e => setEntry(e.target.value)} step="0.01"
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-white font-mono focus:border-blue-500 focus:outline-none" placeholder="0.00" />
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-1">Stop $</label>
          <input type="number" value={stop} onChange={e => setStop(e.target.value)} step="0.01"
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-red-300 font-mono focus:border-red-500 focus:outline-none" placeholder="0.00" />
        </div>
      </div>

      {/* Targets */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        {[['T1', t1, setT1], ['T2', t2, setT2], ['T3', t3, setT3]].map(([label, val, setter]) => (
          <div key={label as string}>
            <label className="text-xs text-gray-500 block mb-1">{label as string} $</label>
            <input type="number" value={val as string} onChange={e => (setter as (v: string) => void)(e.target.value)} step="0.01"
              className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-green-300 font-mono focus:border-green-500 focus:outline-none" placeholder="—" />
          </div>
        ))}
      </div>

      {/* Trailing stop */}
      <div className="mb-3">
        <label className="text-xs text-gray-500 block mb-1">Trailing Stop</label>
        <div className="flex gap-1 mb-1.5">
          {(['none', 'pct', 'atr'] as const).map(m => (
            <button key={m} type="button" onClick={() => setTrailingMode(m)}
              className={`flex-1 py-1 rounded text-xs border transition-colors ${
                trailingMode === m
                  ? 'bg-blue-800 border-blue-600 text-white'
                  : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-500'
              }`}>
              {m === 'none' ? 'Off' : m === 'pct' ? '% Trail' : 'ATR Trail'}
            </button>
          ))}
        </div>
        {trailingMode !== 'none' && (
          <div className="flex items-center gap-2">
            <input type="number" value={trailingValue} onChange={e => setTrailingValue(e.target.value)} step="0.01" min="0.01"
              className="w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono focus:border-blue-500 focus:outline-none" />
            <span className="text-xs text-gray-600">
              {trailingMode === 'pct' ? '% below high' : '$ below high (ATR × mult)'}
            </span>
          </div>
        )}
      </div>

      {/* Risk summary */}
      {riskPerShare && (
        <div className="bg-gray-900 rounded p-2 mb-3 text-xs grid grid-cols-3 gap-2">
          <div>
            <div className="text-gray-600">Risk/share</div>
            <div className="text-red-400 font-mono">${riskPerShare.toFixed(3)}</div>
          </div>
          <div>
            <div className="text-gray-600">Total risk</div>
            <div className="text-red-400 font-mono">{totalRisk ? `$${totalRisk.toFixed(2)}` : '—'}</div>
          </div>
          <div>
            <div className="text-gray-600">T1 R/R</div>
            <div className="text-green-400 font-mono">{rrT1 ? `${rrT1.toFixed(1)}:1` : '—'}</div>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onClose}
          className="flex-1 py-2 rounded bg-gray-800 border border-gray-700 text-xs text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
        <button type="submit" disabled={!valid}
          className="flex-1 py-2 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors">
          Add Position
        </button>
      </div>
    </form>
  )
}

// ── Position Card ──────────────────────────────────────────────────────────

function PositionCard({ pos }: { pos: Position }) {
  const { updatePosition, closePosition, removePosition, selectSymbol } = useTradingStore()
  const [editStop, setEditStop] = useState(false)
  const [stopDraft, setStopDraft] = useState(pos.stop.toFixed(2))
  const [expanded, setExpanded] = useState(false)

  const isClosed = pos.status === 'closed' || pos.status === 'stopped'
  const pnl = isClosed && pos.closePrice != null
    ? (pos.closePrice - pos.entry) * pos.shares * (pos.direction === 'long' ? 1 : -1)
    : pos.unrealizedPnl
  const pnlPct = isClosed && pos.closePrice != null
    ? ((pos.closePrice - pos.entry) / pos.entry) * 100 * (pos.direction === 'long' ? 1 : -1)
    : pos.unrealizedPnlPct

  function applyStopEdit() {
    const v = parseFloat(stopDraft)
    if (!isNaN(v) && v > 0) updatePosition(pos.id, { stop: v })
    setEditStop(false)
  }

  const currentP = pos.currentPrice ?? (isClosed ? pos.closePrice : null)

  return (
    <div
      className={`border rounded-lg overflow-hidden transition-all ${
        isClosed
          ? 'border-gray-800 bg-gray-900/30 opacity-70'
          : pos.status === 't1_hit' || pos.status === 't2_hit' || pos.status === 't3_hit'
          ? 'border-yellow-800/50 bg-yellow-900/10'
          : 'border-gray-700 bg-gray-900/60'
      }`}
    >
      {/* Main row */}
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Symbol + direction */}
        <div className="flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              onClick={e => { e.stopPropagation(); selectSymbol(pos.symbol) }}
              className="text-sm font-bold text-white hover:text-blue-400 transition-colors"
            >
              {pos.symbol}
            </button>
            <span className={`text-[10px] px-1 rounded font-semibold ${pos.direction === 'long' ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}`}>
              {pos.direction.toUpperCase()}
            </span>
          </div>
          <div className="text-[10px] text-gray-600">{pos.shares.toLocaleString()} sh @ ${pos.entry.toFixed(2)}</div>
        </div>

        {/* Current price */}
        <div className="flex-shrink-0">
          <div className="text-sm font-mono text-gray-200">{currentP ? `$${currentP.toFixed(2)}` : '—'}</div>
          {pos.lastPriceUpdate && !isClosed && (
            <div className="text-[10px] text-gray-600">{dataAge(pos.lastPriceUpdate)}</div>
          )}
        </div>

        {/* P&L */}
        <div className="flex-shrink-0 min-w-[80px]">
          <div className={`text-sm font-mono font-semibold ${pnlColor(pnl)}`}>{fmtPnl(pnl)}</div>
          <div className={`text-[10px] ${pnlColor(pnl)}`}>{fmtPnlPct(pnlPct)}</div>
        </div>

        {/* Stop */}
        <div className="flex-shrink-0 min-w-[60px]" onClick={e => e.stopPropagation()}>
          {editStop ? (
            <input
              type="number"
              value={stopDraft}
              onChange={e => setStopDraft(e.target.value)}
              onBlur={applyStopEdit}
              onKeyDown={e => { if (e.key === 'Enter') applyStopEdit(); if (e.key === 'Escape') setEditStop(false) }}
              autoFocus
              step="0.01"
              className="w-16 bg-gray-800 border border-red-600 rounded px-1 py-0.5 text-xs text-red-300 font-mono focus:outline-none"
            />
          ) : (
            <button
              onClick={() => { setStopDraft(pos.stop.toFixed(2)); setEditStop(true) }}
              className="text-xs font-mono text-red-400 hover:text-red-300 border-b border-dashed border-red-800 hover:border-red-400 transition-colors"
              title="Click to edit stop"
              disabled={isClosed}
            >
              ✕ ${pos.stop.toFixed(2)}
            </button>
          )}
          {pos.trailingMode !== 'none' && !isClosed && (
            <div className="text-[10px] text-blue-500">⟳ trailing</div>
          )}
        </div>

        {/* Status */}
        <div className={`text-xs font-semibold flex-shrink-0 ${STATUS_COLORS[pos.status]}`}>
          {STATUS_LABELS[pos.status]}
        </div>

        {/* Expand toggle */}
        <div className="ml-auto text-gray-600 text-xs">{expanded ? '▲' : '▼'}</div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-gray-800/50">
          <div className="grid grid-cols-2 gap-3 mt-2">
            {/* Targets */}
            <div>
              <div className="text-xs text-gray-600 mb-1.5">Profit Targets</div>
              {pos.targets.length === 0 ? (
                <div className="text-xs text-gray-700">No targets set</div>
              ) : (
                pos.targets.map((t, i) => (
                  <div key={i} className="flex items-center justify-between mb-1">
                    <span className={`text-xs ${t.hit ? 'text-green-400 line-through' : 'text-gray-400'}`}>{t.label}</span>
                    <span className={`text-xs font-mono ${t.hit ? 'text-green-400' : 'text-gray-300'}`}>${t.price.toFixed(2)}</span>
                    {t.hit && t.hitAt && <span className="text-[10px] text-gray-600">{dataAge(t.hitAt)}</span>}
                    {!t.hit && pos.entry && (
                      <span className="text-[10px] text-gray-600">
                        {(Math.abs(t.price - pos.entry) / pos.entry * 100).toFixed(1)}%
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Details */}
            <div>
              <div className="text-xs text-gray-600 mb-1.5">Details</div>
              <div className="space-y-0.5">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-600">Initial stop</span>
                  <span className="font-mono text-gray-400">${pos.initialStop.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-600">Risk/sh</span>
                  <span className="font-mono text-red-400">${Math.abs(pos.entry - pos.stop).toFixed(3)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-600">Total risk</span>
                  <span className="font-mono text-red-400">${(Math.abs(pos.entry - pos.stop) * pos.shares).toFixed(2)}</span>
                </div>
                {pos.trailingMode !== 'none' && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-600">Trail high</span>
                    <span className="font-mono text-blue-400">${pos.trailingHigh.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-gray-600">Opened</span>
                  <span className="font-mono text-gray-500">{dataAge(pos.openedAt)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          {!isClosed && (
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => {
                  const cp = pos.currentPrice ?? pos.entry
                  closePosition(pos.id, cp)
                }}
                className="flex-1 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
              >
                Close at market
              </button>
              <button
                onClick={() => {
                  if (pos.currentPrice) updatePosition(pos.id, { stop: pos.currentPrice })
                }}
                className="flex-1 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
                disabled={!pos.currentPrice}
              >
                Move stop to current
              </button>
              <button
                onClick={() => updatePosition(pos.id, { stop: pos.entry })}
                className="flex-1 py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-300 hover:text-white hover:border-gray-500 transition-colors"
              >
                Stop to breakeven
              </button>
            </div>
          )}

          {isClosed && (
            <button
              onClick={() => removePosition(pos.id)}
              className="mt-3 w-full py-1.5 rounded bg-gray-800 border border-gray-700 text-xs text-gray-500 hover:text-red-400 hover:border-red-800 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export function PositionTracker() {
  usePositionTracker()
  const { positions, snapshot, selectedSymbol } = useTradingStore()
  const [open, setOpen] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  const openPositions = positions.filter(p => p.status !== 'closed' && p.status !== 'stopped')
  const closedPositions = positions.filter(p => p.status === 'closed' || p.status === 'stopped')
  const totalPnl = openPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)
  const hasPositions = positions.length > 0

  return (
    <>
      {/* Add position modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) setShowAdd(false) }}>
          <AddPositionForm
            defaultSymbol={selectedSymbol ?? ''}
            defaultEntry={snapshot?.quote?.price}
            onClose={() => setShowAdd(false)}
          />
        </div>
      )}

      {/* Bottom bar */}
      <div className="flex-shrink-0 border-t border-gray-800 bg-[#080b10]">
        {/* Header row */}
        <div
          className="flex items-center gap-3 px-4 py-1.5 cursor-pointer select-none"
          onClick={() => setOpen(o => !o)}
        >
          <span className="text-xs font-semibold text-gray-400">POSITIONS</span>
          {openPositions.length > 0 && (
            <span className="text-xs bg-blue-900/40 text-blue-400 px-1.5 py-0.5 rounded">{openPositions.length} open</span>
          )}
          {openPositions.length > 0 && (
            <span className={`text-xs font-mono font-semibold ${totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} unrealised
            </span>
          )}
          <button
            onClick={e => { e.stopPropagation(); setShowAdd(true) }}
            className="ml-auto text-xs px-2.5 py-0.5 rounded bg-blue-800 hover:bg-blue-700 text-white font-medium transition-colors"
          >
            + Add
          </button>
          <span className="text-gray-600 text-xs ml-1">{open ? '▼' : '▲'}</span>
        </div>

        {/* Positions list */}
        {open && hasPositions && (
          <div className="px-3 pb-3 max-h-64 overflow-y-auto space-y-2">
            {openPositions.map(p => <PositionCard key={p.id} pos={p} />)}
            {closedPositions.length > 0 && (
              <>
                <div className="text-[10px] text-gray-700 uppercase tracking-wider pt-1">Closed / Stopped</div>
                {closedPositions.slice(0, 5).map(p => <PositionCard key={p.id} pos={p} />)}
              </>
            )}
          </div>
        )}

        {open && !hasPositions && (
          <div className="px-4 pb-3 text-xs text-gray-700">
            No positions. Hit <span className="text-gray-500">+ Add</span> to track a trade.
          </div>
        )}
      </div>
    </>
  )
}
