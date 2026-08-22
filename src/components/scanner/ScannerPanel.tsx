'use client'

import { useState, useRef, useEffect } from 'react'
import { useTradingStore } from '@/store/trading-store'
import type { ScannerRow, BadgeType } from '@/types'
import { dataAge, getSessionType } from '@/lib/market-hours'
import { useScanner } from '@/hooks/useScanner'

const BADGE_COLORS: Record<BadgeType, string> = {
  'Fresh News': 'bg-info/10 text-info ring-1 ring-inset ring-info/25',
  'Low Float': 'bg-struct/10 text-struct ring-1 ring-inset ring-struct/25',
  'High RVOL': 'bg-warn/10 text-warn ring-1 ring-inset ring-warn/25',
  'Extended': 'bg-bear/10 text-bear ring-1 ring-inset ring-bear/25',
  'Halt Risk': 'bg-bear/15 text-bear ring-1 ring-inset ring-bear/40',
  'Dilution Risk': 'bg-warn/10 text-warn ring-1 ring-inset ring-warn/25',
  'No Catalyst': 'bg-white/5 text-ink-mute ring-1 ring-inset ring-white/10',
  'VWAP Hold': 'bg-bull/10 text-bull ring-1 ring-inset ring-bull/25',
  'VWAP Lost': 'bg-bear/10 text-bear ring-1 ring-inset ring-bear/25',
}

const STATUS_COLORS: Record<string, string> = {
  'Constructive': 'text-bull',
  'Developing': 'text-warn',
  'Extended': 'text-warn',
  'Chasing Risk': 'text-bear',
  'Weakening': 'text-warn',
  'Breakdown Risk': 'text-bear',
  'No Clean Setup': 'text-ink-mute',
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

  // Session is time-derived, so it must NOT be computed during render — the
  // server and first client render would disagree and break hydration. Start
  // from the server-safe default and resolve the real session after mount,
  // re-checking periodically to catch premarket→regular→afterhours transitions.
  const [sessionType, setSessionType] = useState<ReturnType<typeof getSessionType>>('regular')
  useEffect(() => {
    const update = () => setSessionType(getSessionType())
    update()
    const id = setInterval(update, 60_000)
    return () => clearInterval(id)
  }, [])
  const isPremarketSession = sessionType === 'premarket'

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
    <div className="flex flex-col h-full bg-panel border-r border-line">
      {/* Symbol search */}
      <form onSubmit={handleSearchSubmit} className="px-3 py-2.5 border-b border-line">
        <div className="flex gap-1.5">
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value.toUpperCase())}
            placeholder="Search ticker…"
            maxLength={10}
            className="ring-focus flex-1 bg-raised border border-line-strong focus:border-accent rounded-md px-2.5 py-1.5 text-sm text-ink placeholder-ink-faint focus:outline-none font-mono tracking-wide"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={!search.trim()}
            className="ring-focus px-3.5 py-1.5 rounded-md bg-accent hover:bg-accent-hi disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
          >
            Go
          </button>
        </div>
      </form>

      {/* Header */}
      <div className="px-3 py-2.5 border-b border-line">
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <h2 className="eyebrow !text-[11px] text-ink-soft">Market Scanner</h2>
            {isPremarketSession && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-info/10 text-info ring-1 ring-inset ring-info/25 font-semibold tracking-wide">PRE-MKT</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {scannerLoading && (
              <span className="text-[11px] text-ink-mute animate-pulse">Scanning…</span>
            )}
            {lastScanTime && !scannerLoading && (
              <span className="text-[11px] text-ink-faint tnum">{dataAge(lastScanTime)}</span>
            )}
            <button
              onClick={() => scan(true)}
              className="ring-focus w-6 h-6 flex items-center justify-center rounded-md bg-raised hover:bg-hover text-ink-mute hover:text-ink transition-colors"
              title="Refresh scan"
            >
              ↻
            </button>
          </div>
        </div>

        {/* Quick presets */}
        <div className="flex flex-wrap gap-1 mb-2.5">
          {QUICK_PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => setFilters(p.filters)}
              className="text-[11px] px-2 py-0.5 rounded-md bg-raised/70 hover:bg-hover text-ink-soft hover:text-ink ring-1 ring-inset ring-line transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Filter row */}
        <div className="grid grid-cols-3 gap-1.5">
          {([
            { key: 'minChangePct', label: 'Min %', value: filters.minChangePct },
            { key: 'maxPrice', label: 'Max $', value: filters.maxPrice },
            { key: 'minVolume', label: 'Min Vol', value: filters.minVolume },
          ] as const).map(f => (
            <label key={f.key} className="eyebrow !tracking-wide flex flex-col gap-1">
              {f.label}
              <input
                type="number"
                value={f.value}
                onChange={e => setFilters({ [f.key]: Number(e.target.value) })}
                className="ring-focus w-full px-1.5 py-1 bg-raised border border-line rounded-md text-ink-soft text-xs tnum focus:border-accent focus:outline-none"
              />
            </label>
          ))}
        </div>
      </div>

      {/* Error */}
      {scannerError && (
        <div className="px-3 py-2 text-xs text-bear bg-bear/5 border-b border-bear/20">
          {scannerError}
        </div>
      )}

      {/* Table header */}
      <div className="grid grid-cols-[1.5rem_4rem_1fr_3rem_3rem_3rem] gap-1 px-3 py-1.5 border-b border-line eyebrow !text-[9px] bg-app/40">
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
          <div className="px-4 py-10 text-center text-xs text-ink-mute">
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

      <div className="px-3 py-1.5 border-t border-line text-[10px] text-ink-faint tnum">
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
      className={`relative cursor-pointer px-3 py-2 transition-colors ${
        selected
          ? 'bg-accent/10 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent before:shadow-[0_0_10px_var(--color-accent)]'
          : 'border-b border-line/50 hover:bg-hover'
      }`}
    >
      {/* Row 1: rank, symbol, price, change */}
      <div className="grid grid-cols-[1.5rem_4rem_1fr_3rem_3rem_3rem] gap-1 items-center">
        <span className="text-[11px] text-ink-faint tnum">{row.rank}</span>
        <span className={`text-sm font-bold tracking-wide ${selected ? 'text-accent-hi' : 'text-ink'}`}>{row.symbol}</span>
        <span className="text-[11px] text-ink-mute truncate">{row.name.slice(0, 14)}</span>
        <span className={`text-xs text-right font-semibold tnum ${row.changePct >= 0 ? 'text-bull' : 'text-bear'}`}>
          {row.changePct >= 0 ? '+' : ''}{formatNum(row.changePct, 1)}%
        </span>
        <span className="text-xs text-right text-ink-soft tnum">{formatVol(row.volume)}</span>
        <span className="text-xs text-right text-warn tnum">
          {row.relativeVolume ? `${formatNum(row.relativeVolume, 1)}×` : '—'}
        </span>
      </div>

      {/* Row 2: price, mktcap, status */}
      <div className="flex items-center gap-2 mt-1">
        <span className="text-xs text-ink font-semibold tnum">${formatNum(row.price)}</span>
        <span className="text-[11px] text-ink-mute tnum">{formatMktCap(row.marketCap)}</span>
        <span className={`text-[11px] ml-auto font-medium ${STATUS_COLORS[row.status] ?? 'text-ink-mute'}`}>
          {row.status}
        </span>
      </div>

      {/* Badges */}
      {row.badges.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {row.badges.map(b => (
            <span
              key={b.type}
              className={`text-[10px] px-1.5 py-0.5 rounded font-semibold tracking-wide ${BADGE_COLORS[b.type] ?? 'bg-white/5 text-ink-mute'}`}
            >
              {b.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
