'use client'

import { useState, useRef } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { ScannerRow, BadgeType } from '@/types'
import { dataAge, getSessionType } from '@/lib/market-hours'
import { useScanner } from '@/hooks/useScanner'

const sessionType = typeof window !== 'undefined' ? getSessionType() : 'regular'
const isPremarketSession = sessionType === 'premarket'

const BADGE_COLORS: Record<BadgeType, string> = {
  'Fresh News': 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  'Low Float': 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  'High RVOL': 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  'Extended': 'bg-red-500/20 text-red-400 border border-red-500/30',
  'Halt Risk': 'bg-red-600/20 text-red-300 border border-red-600/30',
  'Dilution Risk': 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  'No Catalyst': 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
  'VWAP Hold': 'bg-green-500/20 text-green-400 border border-green-500/30',
  'VWAP Lost': 'bg-red-500/20 text-red-400 border border-red-500/30',
}

const STATUS_COLORS: Record<string, string> = {
  'Constructive': 'text-green-400',
  'Developing': 'text-yellow-400',
  'Extended': 'text-orange-400',
  'Chasing Risk': 'text-red-400',
  'Weakening': 'text-orange-400',
  'Breakdown Risk': 'text-red-500',
  'No Clean Setup': 'text-gray-400',
}

function formatNum(n: number, decimals = 2): string {
  return n.toFixed(decimals)
}

function formatVol(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`
  return String(v)
}

function formatMktCap(v: number | null): string {
  if (!v) return '—'
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toFixed(0)}`
}

const QUICK_PRESETS = [
  { label: 'All Gainers', filters: { minChangePct: 5, maxPrice: 300, minVolume: 100000, minRelativeVolume: 0, maxFloat: null } },
  { label: 'Liquid', filters: { minChangePct: 5, maxPrice: 300, minVolume: 1000000, minRelativeVolume: 1 } },
  { label: 'Low Float', filters: { maxFloat: 10000000, minChangePct: 5, minVolume: 500000 } },
  { label: 'Under $20', filters: { maxPrice: 20, minChangePct: 5, minVolume: 500000 } },
  { label: 'Under $10', filters: { maxPrice: 10, minChangePct: 5, minVolume: 300000 } },
  { label: 'High RVOL', filters: { minRelativeVolume: 5, minChangePct: 5, minVolume: 200000 } },
]

export function ScannerPanel() {
  const { scannerRows, scannerLoading, scannerError, lastScanTime, filters, setFilters, selectSymbol, selectedSymbol, addSearchedSymbol } = useTradingStore()
  const { scan } = useScanner()
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const sym = search.trim().toUpperCase()
    if (sym) {
      selectSymbol(sym)
      addSearchedSymbol(sym)   // keep monitoring it even after you navigate away
      setSearch('')
      searchRef.current?.blur()
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#0e1117] border-r border-gray-800">
      {/* Symbol search */}
      <form onSubmit={handleSearchSubmit} className="px-3 py-2 border-b border-gray-800">
        <div className="flex gap-1.5">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value.toUpperCase())}
            placeholder="Search ticker… e.g. LHAI"
            maxLength={10}
            className="flex-1 bg-gray-900 border border-gray-700 focus:border-blue-500 rounded px-2.5 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none font-mono tracking-wide"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={!search.trim()}
            className="px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
          >
            Go
          </button>
        </div>
      </form>

      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-200">Market Scanner</h2>
            {isPremarketSession && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400 border border-blue-800 font-medium">PRE-MKT</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {scannerLoading && (
              <span className="text-xs text-gray-500 animate-pulse">Scanning...</span>
            )}
            {lastScanTime && !scannerLoading && (
              <span className="text-xs text-gray-600">{dataAge(lastScanTime)}</span>
            )}
            <button
              onClick={() => scan(true)}
              className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400"
            >
              ↻
            </button>
          </div>
        </div>

        {/* Quick presets */}
        <div className="flex flex-wrap gap-1 mb-2">
          {QUICK_PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => setFilters(p.filters)}
              className="text-xs px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200"
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Filter row */}
        <div className="grid grid-cols-3 gap-1">
          <label className="text-xs text-gray-600">
            Min%
            <input
              type="number"
              value={filters.minChangePct}
              onChange={e => setFilters({ minChangePct: Number(e.target.value) })}
              className="block w-full mt-0.5 px-1 py-0.5 bg-gray-900 border border-gray-700 rounded text-gray-300 text-xs"
            />
          </label>
          <label className="text-xs text-gray-600">
            MaxP
            <input
              type="number"
              value={filters.maxPrice}
              onChange={e => setFilters({ maxPrice: Number(e.target.value) })}
              className="block w-full mt-0.5 px-1 py-0.5 bg-gray-900 border border-gray-700 rounded text-gray-300 text-xs"
            />
          </label>
          <label className="text-xs text-gray-600">
            MinVol
            <input
              type="number"
              value={filters.minVolume}
              onChange={e => setFilters({ minVolume: Number(e.target.value) })}
              className="block w-full mt-0.5 px-1 py-0.5 bg-gray-900 border border-gray-700 rounded text-gray-300 text-xs"
            />
          </label>
        </div>
      </div>

      {/* Error */}
      {scannerError && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-900/10 border-b border-red-900/20">
          {scannerError}
        </div>
      )}

      {/* Table header */}
      <div className="grid grid-cols-[2rem_4rem_1fr_3rem_3rem_3rem] gap-1 px-3 py-1 border-b border-gray-800 text-xs text-gray-600 font-medium">
        <span>#</span>
        <span>Sym</span>
        <span>Name</span>
        <span className="text-right">{isPremarketSession ? 'PM%' : 'Chg%'}</span>
        <span className="text-right">Vol</span>
        <span className="text-right">RVOL</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {scannerRows.length === 0 && !scannerLoading && (
          <div className="px-3 py-8 text-center text-xs text-gray-600">
            {scannerError ? 'Error loading scanner' : 'No results. Check filters or API key.'}
          </div>
        )}
        {scannerRows.map(row => (
          <ScannerRowItem
            key={row.symbol}
            row={row}
            selected={selectedSymbol === row.symbol}
            onSelect={() => selectSymbol(row.symbol)}
          />
        ))}
      </div>

      <div className="px-3 py-1.5 border-t border-gray-800 text-xs text-gray-700">
        {scannerRows.length} results
      </div>
    </div>
  )
}

function ScannerRowItem({
  row,
  selected,
  onSelect,
}: {
  row: ScannerRow
  selected: boolean
  onSelect: () => void
}) {
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer border-b border-gray-800/50 px-3 py-2 hover:bg-gray-800/40 transition-colors ${selected ? 'bg-blue-900/20 border-l-2 border-l-blue-500' : ''}`}
    >
      {/* Row 1: rank, symbol, price, change */}
      <div className="grid grid-cols-[2rem_4rem_1fr_3rem_3rem_3rem] gap-1 items-center">
        <span className="text-xs text-gray-600">{row.rank}</span>
        <span className="text-sm font-bold text-white">{row.symbol}</span>
        <span className="text-xs text-gray-500 truncate">{row.name.slice(0, 14)}</span>
        <span className={`text-xs text-right font-medium ${row.changePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {row.changePct >= 0 ? '+' : ''}{formatNum(row.changePct, 1)}%
        </span>
        <span className="text-xs text-right text-gray-400">{formatVol(row.volume)}</span>
        <span className="text-xs text-right text-yellow-400">
          {row.relativeVolume ? `${formatNum(row.relativeVolume, 1)}x` : '—'}
        </span>
      </div>

      {/* Row 2: price, mktcap, badges */}
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-xs text-gray-300 font-medium">${formatNum(row.price)}</span>
        <span className="text-xs text-gray-600">{formatMktCap(row.marketCap)}</span>
        <span className={`text-xs ml-auto ${STATUS_COLORS[row.status] ?? 'text-gray-400'}`}>
          {row.status}
        </span>
      </div>

      {/* Badges */}
      {row.badges.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {row.badges.map(b => (
            <span
              key={b.type}
              className={`text-[10px] px-1.5 py-0.5 rounded-sm font-medium ${BADGE_COLORS[b.type] ?? 'bg-gray-700 text-gray-400'}`}
            >
              {b.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
