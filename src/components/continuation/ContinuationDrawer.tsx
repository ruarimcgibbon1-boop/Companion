'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { ContinuationCandidate, FrontSideClass, ExtensionClass, ContinuationStatus } from '@/lib/continuation'

interface ContinuationResponse {
  session: string
  candidates: ContinuationCandidate[]
  meta: {
    universeSize: number
    analysed: number
    qualifying: number
    endpointsFailed: string[]
    maxPriceApplied: number | null
    scanDurationMs: number
    timestamp: number
  }
}

const POLL_MS = 30_000

const FRONT_COLOR: Record<FrontSideClass, string> = {
  'Early front side': 'text-emerald-300 bg-emerald-900/40 border-emerald-700',
  'Established front side': 'text-green-300 bg-green-900/30 border-green-800',
  'Late front side': 'text-yellow-300 bg-yellow-900/30 border-yellow-800',
  'Transitioning to backside': 'text-orange-400 bg-orange-900/30 border-orange-800',
  'Backside': 'text-red-400 bg-red-900/30 border-red-800',
  'Unclear': 'text-gray-500 bg-gray-800/40 border-gray-700',
}

const EXT_COLOR: Record<ExtensionClass, string> = {
  'Not extended': 'text-emerald-300',
  'Slightly extended': 'text-green-300',
  'Moderately extended': 'text-yellow-300',
  'Highly extended': 'text-orange-400',
  'Parabolic': 'text-red-400',
}

const STATUS_COLOR: Record<ContinuationStatus, string> = {
  'Triggering now': 'text-emerald-300 bg-emerald-900/50',
  'Breakout confirmed': 'text-emerald-300 bg-emerald-900/50',
  'Approaching entry': 'text-blue-300 bg-blue-900/40',
  'Pulling back constructively': 'text-cyan-300 bg-cyan-900/40',
  'Consolidating beneath resistance': 'text-cyan-300 bg-cyan-900/30',
  'Waiting for volume': 'text-gray-400 bg-gray-800',
  'Waiting for VWAP reclaim': 'text-blue-300 bg-blue-900/30',
  'Waiting for high-of-day break': 'text-blue-300 bg-blue-900/30',
  'Breakout retesting': 'text-cyan-300 bg-cyan-900/40',
  'Extended—do not chase': 'text-orange-400 bg-orange-900/40',
  'Losing momentum': 'text-orange-400 bg-orange-900/30',
  'Backside transition': 'text-red-400 bg-red-900/40',
  'Setup failed': 'text-red-400 bg-red-900/40',
  'Avoid': 'text-gray-500 bg-gray-900',
}

function scoreColor(s: number): string {
  if (s >= 82) return 'text-emerald-300'
  if (s >= 74) return 'text-green-300'
  if (s >= 66) return 'text-yellow-300'
  if (s >= 55) return 'text-orange-400'
  return 'text-gray-500'
}

const px = (n: number | null) => (n == null ? '—' : `$${n.toFixed(n < 1 ? 3 : 2)}`)

export function ContinuationDrawer({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ContinuationResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (force = false) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ maxCandidates: '20', includeAll: String(showAll) })
      if (force) params.set('refresh', '1')
      const res = await fetch(`/api/continuation?${params}`, { signal: abortRef.current.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [showAll])

  useEffect(() => {
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, POLL_MS)
    return () => { clearInterval(id); abortRef.current?.abort() }
  }, [load])

  const m = data?.meta
  const ageSec = m ? Math.round((Date.now() - m.timestamp) / 1000) : 0

  return (
    <div className="fixed inset-0 z-50 bg-[#0a0d12]/95 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white">🎯 Intraday Continuation</span>
          {data && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-300 font-medium capitalize">
              {data.session}
            </span>
          )}
          {loading && <span className="text-[11px] text-gray-500 animate-pulse">scanning…</span>}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} className="accent-blue-500" />
            Show non-qualifying
          </label>
          <button onClick={() => load(true)} className="text-xs px-2.5 py-1 rounded border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500">
            ↻ Refresh
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg px-2">✕</button>
        </div>
      </div>

      {/* Meta bar */}
      {m && (
        <div className="flex items-center gap-4 px-4 h-8 border-b border-gray-900 text-[11px] text-gray-500 flex-shrink-0">
          <span>universe <span className="text-gray-300">{m.universeSize}</span></span>
          <span>analysed <span className="text-gray-300">{m.analysed}</span></span>
          <span>qualifying <span className="text-emerald-300">{m.qualifying}</span></span>
          <span>scan <span className="text-gray-300">{m.scanDurationMs}ms</span></span>
          <span>updated <span className="text-gray-300">{ageSec}s ago</span></span>
          <span className="text-emerald-400/70">no max-price cap{m.maxPriceApplied != null ? ` (≤$${m.maxPriceApplied})` : ''}</span>
          {m.endpointsFailed.length > 0 && <span className="text-orange-400">failed: {m.endpointsFailed.join(', ')}</span>}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {error && <div className="p-4 text-sm text-red-400">Error: {error}</div>}
        {!error && data && data.candidates.length === 0 && (
          <div className="p-8 text-center text-sm text-gray-500">
            No qualifying continuation setups right now. This is normal — the model won&apos;t force a trade.
            <br />Tick <span className="text-gray-300">Show non-qualifying</span> to see what&apos;s closest.
          </div>
        )}
        <div className="divide-y divide-gray-900">
          {data?.candidates.map((c, i) => (
            <CandidateRow
              key={c.symbol}
              c={c}
              rank={i + 1}
              open={expanded === c.symbol}
              onToggle={() => setExpanded(expanded === c.symbol ? null : c.symbol)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function CandidateRow({ c, rank, open, onToggle }: { c: ContinuationCandidate; rank: number; open: boolean; onToggle: () => void }) {
  return (
    <div className={c.qualifies ? '' : 'opacity-60'}>
      {/* Collapsed summary */}
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-900/40">
        <span className="w-6 text-xs text-gray-600 font-mono">{rank}</span>
        <span className="w-16 font-bold text-white text-sm">{c.symbol}</span>
        <span className="w-20 text-xs text-gray-400 font-mono">{px(c.price)}</span>
        <span className={`w-14 text-xs font-mono ${c.changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {c.changePct >= 0 ? '+' : ''}{c.changePct.toFixed(1)}%
        </span>
        <span className={`w-10 text-sm font-bold ${scoreColor(c.continuationScore)}`}>{c.continuationScore}</span>
        <span className="flex-1 text-xs text-gray-300 truncate">{c.continuationType}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${FRONT_COLOR[c.frontSide]}`}>{c.frontSide}</span>
        <span className={`text-[10px] font-medium ${EXT_COLOR[c.extension]}`}>{c.extension}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLOR[c.status]}`}>{c.status}</span>
        {c.qualifies
          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-700 text-white font-medium">READY</span>
          : <span className="text-[10px] text-gray-600">{open ? '' : c.rejectionReason}</span>}
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="px-4 pb-4 pl-14 grid grid-cols-2 gap-x-8 gap-y-3 text-xs">
          <div>
            <div className="text-gray-500 mb-1 font-medium">Verdict</div>
            <div className="text-gray-200">{c.verdict}</div>
            <div className="text-gray-500 mt-2 mb-1 font-medium">Main risk</div>
            <div className="text-orange-300">{c.mainRisk}</div>
            <div className="text-gray-500 mt-2 mb-1 font-medium">Catalyst</div>
            <div className="text-gray-300">{c.catalyst}</div>
          </div>

          <div>
            <div className="text-gray-500 mb-1 font-medium">Trade plan</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-gray-300">
              <span className="text-gray-500">Entry</span><span>{c.entryZone ? `${px(c.entryZone[0])}–${px(c.entryZone[1])}` : '—'}</span>
              <span className="text-gray-500">Trigger</span><span>{px(c.triggerPrice)}</span>
              <span className="text-gray-500">Stop</span><span className="text-red-300">{px(c.stop)}</span>
              <span className="text-gray-500">Targets</span><span className="text-green-300">{c.targets.length ? c.targets.map(px).join(' → ') : '—'}</span>
              <span className="text-gray-500">R/R</span><span className={c.rewardRisk != null && c.rewardRisk >= 2 ? 'text-emerald-300' : 'text-orange-300'}>{c.rewardRisk != null ? `${c.rewardRisk.toFixed(1)}:1` : '—'}</span>
              <span className="text-gray-500">RVOL</span><span>{c.relativeVolume != null ? `${c.relativeVolume.toFixed(1)}×` : '—'}</span>
            </div>
          </div>

          <div className="col-span-2">
            <div className="text-gray-500 mb-1 font-medium">Score breakdown — base {c.baseScore} → {c.continuationScore} <span className={scoreColor(c.continuationScore)}>({c.scoreLabel})</span></div>
            <div className="flex flex-wrap gap-1.5">
              {c.adjustments.length === 0 && <span className="text-gray-600">no adjustments</span>}
              {c.adjustments.map((a, i) => (
                <span key={i} className={`text-[10px] px-1.5 py-0.5 rounded ${a.delta > 0 ? 'bg-green-900/30 text-green-300' : 'bg-red-900/30 text-red-300'}`}>
                  {a.label} {a.delta > 0 ? '+' : ''}{a.delta}
                </span>
              ))}
            </div>
            {!c.qualifies && c.rejectionReason && (
              <div className="mt-2 text-[11px] text-gray-500">Not actionable: <span className="text-orange-300">{c.rejectionReason}</span></div>
            )}
            {c.delayed && <div className="mt-1 text-[11px] text-orange-400">⚠ Data delayed — verify a live quote before acting.</div>}
          </div>
        </div>
      )}
    </div>
  )
}
