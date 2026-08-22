'use client'

import { useState } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { usePositionTracker } from '@/hooks/usePositionTracker'
import { useBrokerPositions } from '@/hooks/useBrokerPositions'
import { dataAge } from '@/lib/market-hours'
import type { BrokerPositionView, ReconciliationStatus } from '@/lib/execution/positions-view'
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
  if (v == null) return 'text-ink-mute'
  if (v > 0) return 'text-bull'
  if (v < 0) return 'text-bear'
  return 'text-ink-mute'
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
  open: 'text-info',
  t1_hit: 'text-warn',
  t2_hit: 'text-warn',
  t3_hit: 'text-bull',
  stopped: 'text-bear',
  closed: 'text-ink-mute',
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
      className={`rounded-lg overflow-hidden transition-all ring-1 ring-inset ${
        isClosed
          ? 'ring-line bg-surface/40 opacity-70'
          : pos.status === 't1_hit' || pos.status === 't2_hit' || pos.status === 't3_hit'
          ? 'ring-warn/30 bg-warn/[0.06]'
          : 'ring-line-strong bg-surface'
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

// ── Broker (Alpaca) Position Row ───────────────────────────────────────────
// READ-ONLY. Broker positions reflect Alpaca truth; they carry no local-mutation
// controls (no close / move-stop / breakeven) — those would only alter Zustand,
// never the broker. Trade controls will later be wired through the executor.

const RECON_META: Record<ReconciliationStatus, { label: string; cls: string; title: string }> = {
  verified:      { label: 'VERIFIED',      cls: 'text-bull ring-bull/30 bg-bull/10',   title: 'Broker position matches the Companion ledger' },
  pending:       { label: 'PENDING',       cls: 'text-ink-mute ring-line-strong bg-raised', title: 'Not yet reconciled against the broker' },
  discrepancy:   { label: 'DISCREPANCY',   cls: 'text-bear ring-bear/40 bg-bear/15',   title: 'Broker and local ledger disagreed — local was corrected to broker truth' },
  manual_review: { label: 'MANUAL REVIEW', cls: 'text-warn ring-warn/40 bg-warn/15',   title: 'Closed on broker truth but P&L could not be reconstructed — needs a human' },
}

const SOURCE_BADGE: Record<BrokerPositionView['source'], { label: string; cls: string }> = {
  companion:    { label: 'COMPANION',    cls: 'bg-accent/10 text-accent-hi ring-accent/25' },
  external:     { label: 'EXTERNAL',     cls: 'bg-raised text-ink-mute ring-line-strong' },
  unattributed: { label: 'UNATTRIBUTED', cls: 'bg-warn/10 text-warn ring-warn/30' },
}

function TargetChip({ label, price, hit }: { label: string; price: number | null; hit: boolean }) {
  if (price == null) return null
  return (
    <span className={`tnum text-[11px] ${hit ? 'text-bull' : 'text-ink-soft'}`}>
      {label} ${price.toFixed(2)}{hit ? ' ✓' : ''}
    </span>
  )
}

function BrokerPositionRow({ pos }: { pos: BrokerPositionView }) {
  const { selectSymbol } = useTradingStore()
  const [expanded, setExpanded] = useState(false)

  const isCompanion = pos.source === 'companion'
  const t1Hit = pos.targetState === 't1_hit' || pos.targetState === 't2_hit'
  const t2Hit = pos.targetState === 't2_hit'
  const recon = pos.reconciliationStatus ? RECON_META[pos.reconciliationStatus] : null
  // A discrepancy/manual-review row gets an unmissable left edge without breaking layout.
  const flagged = pos.reconciliationStatus === 'discrepancy' || pos.reconciliationStatus === 'manual_review'

  return (
    <div className={`rounded-lg overflow-hidden transition-all ring-1 ring-inset ${flagged ? 'ring-bear/40 bg-bear/[0.05]' : 'ring-line-strong bg-surface'}`}>
      <div className="flex items-center gap-3 px-3 py-2 cursor-pointer" onClick={() => setExpanded(e => !e)}>
        {/* Symbol + direction + source */}
        <div className="flex-shrink-0 min-w-[132px]">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={e => { e.stopPropagation(); selectSymbol(pos.symbol) }}
              className="text-sm font-bold text-ink hover:text-accent-hi transition-colors"
            >
              {pos.symbol}
            </button>
            <span className={`text-[10px] px-1 rounded font-semibold ${pos.direction === 'long' ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear'}`}>
              {pos.direction.toUpperCase()}
            </span>
            <span className={`text-[10px] px-1 rounded font-semibold ring-1 ring-inset ${SOURCE_BADGE[pos.source].cls}`}>
              {SOURCE_BADGE[pos.source].label}
            </span>
          </div>
          <div className="text-[10px] text-ink-mute tnum">{pos.qty.toLocaleString()} sh @ ${pos.avgEntryPrice.toFixed(2)}</div>
        </div>

        {/* Current price */}
        <div className="flex-shrink-0">
          <div className="text-sm tnum text-ink-soft">{pos.currentPrice != null ? `$${pos.currentPrice.toFixed(2)}` : '—'}</div>
          <div className="text-[10px] text-ink-faint">current</div>
        </div>

        {/* Unrealised P&L */}
        <div className="flex-shrink-0 min-w-[84px]">
          <div className={`text-sm tnum font-semibold ${pnlColor(pos.unrealizedPnl)}`}>{fmtPnl(pos.unrealizedPnl)}</div>
          <div className={`text-[10px] tnum ${pnlColor(pos.unrealizedPnlPct)}`}>{fmtPnlPct(pos.unrealizedPnlPct)}</div>
        </div>

        {/* Reconciliation status */}
        {recon && (
          <div className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ring-1 ring-inset flex-shrink-0 ${recon.cls}`} title={recon.title}>
            {recon.label}
          </div>
        )}

        <div className="ml-auto text-ink-mute text-xs">{expanded ? '▲' : '▼'}</div>
      </div>

      {/* Expanded detail — Companion-linked metadata (read-only) */}
      {expanded && isCompanion && (
        <div className="px-3 pb-3 border-t border-line/60">
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div className="space-y-1">
              {pos.setupType && (
                <div className="flex justify-between text-xs">
                  <span className="text-ink-mute">Setup</span>
                  <span className="text-ink-soft">{pos.setupType}</span>
                </div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-ink-mute">Stop</span>
                <span className="tnum text-bear">{pos.currentStop != null ? `$${pos.currentStop.toFixed(2)}` : '—'}</span>
              </div>
              {pos.initialStop != null && pos.currentStop != null && pos.initialStop !== pos.currentStop && (
                <div className="flex justify-between text-xs">
                  <span className="text-ink-mute">Initial stop</span>
                  <span className="tnum text-ink-faint">${pos.initialStop.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between text-xs">
                <span className="text-ink-mute">Free to trade</span>
                <span className="tnum text-ink-soft">{pos.qtyAvailable.toLocaleString()} sh</span>
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-xs text-ink-mute">Targets</div>
              <div className="flex flex-col gap-0.5">
                <TargetChip label="T1" price={pos.t1} hit={t1Hit} />
                <TargetChip label="T2" price={pos.t2} hit={t2Hit} />
                {pos.t1 == null && pos.t2 == null && <span className="text-xs text-ink-faint">No targets on ledger</span>}
              </div>
            </div>
          </div>
          <div className="mt-2 text-[10px] text-ink-faint">
            Broker-synced · read-only · updated {dataAge(pos.lastUpdatedAt)}
            {pos.tradeId && <span className="ml-1 text-ink-faint/80">· {pos.tradeId}</span>}
          </div>
        </div>
      )}
      {expanded && !isCompanion && (
        <div className="px-3 pb-3 border-t border-line/60 text-[10px] text-ink-faint mt-2">
          {pos.source === 'unattributed'
            ? 'Broker position could not be uniquely bound to an active Companion trade — not treated as strategy evidence. Read-only; no strategy metadata.'
            : 'External Alpaca position — not created by Companion. Read-only; no strategy metadata.'}
          <span className="ml-1">Free to trade {pos.qtyAvailable.toLocaleString()} sh.</span>
        </div>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export function PositionTracker() {
  usePositionTracker()
  const { positions, snapshot, selectedSymbol } = useTradingStore()
  const broker = useBrokerPositions()
  const [open, setOpen] = useState(true)
  const [showAdd, setShowAdd] = useState(false)

  // Manual/local tracker positions (existing behaviour, retained).
  const openPositions = positions.filter(p => p.status !== 'closed' && p.status !== 'stopped')
  const closedPositions = positions.filter(p => p.status === 'closed' || p.status === 'stopped')
  const manualPnl = openPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)

  // Broker (Alpaca) positions — authoritative exposure.
  const brokerPositions = broker.positions
  const brokerPnl = broker.counts?.unrealizedPnl ?? 0
  const brokerCount = brokerPositions.length

  const hasAnything = brokerCount > 0 || positions.length > 0

  // Collapsed blotter summary line.
  const syncLabel = broker.lastSuccessAt != null ? dataAge(broker.lastSuccessAt) : null
  const feedDotCls = broker.error
    ? 'bg-bear'
    : broker.stale
      ? 'bg-warn'
      : broker.loading && broker.lastSuccessAt == null
        ? 'bg-ink-faint animate-pulse'
        : 'bg-bull'

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
      <div className="flex-shrink-0 border-t border-line bg-bar">
        {/* Header row — compact blotter summary */}
        <div
          className="flex items-center gap-2.5 px-4 py-2 cursor-pointer select-none"
          onClick={() => setOpen(o => !o)}
        >
          <span className="eyebrow">Positions</span>
          <span className={`w-1.5 h-1.5 rounded-full ${feedDotCls}`} />
          <span className="text-[10px] tnum text-ink-soft font-semibold">
            {brokerCount} OPEN
          </span>
          {brokerCount > 0 && (
            <span className={`text-xs tnum font-semibold ${brokerPnl >= 0 ? 'text-bull' : 'text-bear'}`}>
              {brokerPnl >= 0 ? '+' : ''}${brokerPnl.toFixed(2)}
            </span>
          )}
          <span className="text-[10px] text-ink-mute">ALPACA</span>
          {broker.error ? (
            <span className="text-[10px] text-bear">
              unavailable{syncLabel ? ` — last synced ${syncLabel}` : ''}
            </span>
          ) : (
            <span className={`text-[10px] ${broker.stale ? 'text-warn' : 'text-ink-faint'}`}>
              {syncLabel ? `synced ${syncLabel}` : broker.loading ? 'connecting…' : ''}
            </span>
          )}

          <button
            onClick={e => { e.stopPropagation(); setShowAdd(true) }}
            className="ring-focus ml-auto text-xs px-2.5 py-1 rounded-md bg-accent hover:bg-accent-hi text-white font-semibold transition-colors"
          >
            + Add
          </button>
          <span className="text-ink-mute text-xs ml-1">{open ? '▼' : '▲'}</span>
        </div>

        {open && (
          <div className="px-3 pb-3 max-h-72 overflow-y-auto space-y-2">
            {/* ── Broker positions (Alpaca) ── */}
            {brokerCount > 0 && (
              <>
                <div className="flex items-center gap-2">
                  <div className="eyebrow pt-0.5">Alpaca — Broker</div>
                  {broker.stale && !broker.error && (
                    <span className="text-[10px] text-warn">stale</span>
                  )}
                </div>
                {brokerPositions.map(p => <BrokerPositionRow key={`${p.symbol}-${p.tradeId ?? 'ext'}`} pos={p} />)}
              </>
            )}

            {/* Broker feed empty/offline states — never conflate error with flat. */}
            {brokerCount === 0 && (
              broker.error ? (
                <div className="text-xs text-bear/90">
                  Alpaca positions unavailable{syncLabel ? ` — last synced ${syncLabel}` : ''}. Showing last known state.
                </div>
              ) : broker.loading && broker.lastSuccessAt == null ? (
                <div className="text-xs text-ink-mute">Connecting to Alpaca…</div>
              ) : broker.brokerFlat ? (
                <div className="text-xs text-ink-mute">No open Alpaca positions.</div>
              ) : null
            )}

            {/* ── Manual tracker (local) ── */}
            {(openPositions.length > 0 || closedPositions.length > 0) && (
              <div className="eyebrow pt-1.5">Manual Tracker — Local</div>
            )}
            {openPositions.length > 0 && (
              <div className="flex items-center gap-2 pb-0.5">
                <span className="text-[10px] text-ink-mute tnum">{openPositions.length} open</span>
                <span className={`text-[10px] tnum ${manualPnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {manualPnl >= 0 ? '+' : ''}${manualPnl.toFixed(2)} unrealised
                </span>
              </div>
            )}
            {openPositions.map(p => <PositionCard key={p.id} pos={p} />)}
            {closedPositions.length > 0 && (
              <>
                <div className="eyebrow pt-1">Closed / Stopped</div>
                {closedPositions.slice(0, 5).map(p => <PositionCard key={p.id} pos={p} />)}
              </>
            )}

            {!hasAnything && !broker.loading && (
              <div className="text-xs text-ink-mute">
                No open positions. Companion daemon trades appear here automatically; hit <span className="text-ink-soft">+ Add</span> to track one by hand.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
