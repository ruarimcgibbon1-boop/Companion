'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  ScannerRow,
  TickerSnapshot,
  ScannerFilters,
  WatchlistItem,
  Alert,
  Position,
  PositionTarget,
  TrailingStopMode,
  DEFAULT_FILTERS,
} from '@/types'

// Avoid importing DEFAULT_FILTERS from types (client-safe)
const INITIAL_FILTERS: ScannerFilters = {
  minPrice: 1,
  maxPrice: 300,
  minChangePct: 5,
  maxChangePct: 1000,
  minVolume: 500000,
  minRelativeVolume: 0,
  minMarketCap: null,
  maxMarketCap: null,
  maxFloat: null,
  exchanges: ['NASDAQ', 'NYSE', 'AMEX'],
  commonStocksOnly: true,
  includeLowFloat: true,
  sessionMode: 'regular',
  maxResults: 30,
  minNewsRecencyHours: null,
}

type ChartInterval = '1min' | '5min' | '15min' | 'daily'
type ActiveTab = 'overview' | 'plans' | 'pullback' | 'levels' | 'news' | 'technical' | 'risks' | 'calc' | 'chat'

interface TradingStore {
  // Scanner
  scannerRows: ScannerRow[]
  scannerLoading: boolean
  scannerError: string | null
  lastScanTime: number | null
  filters: ScannerFilters

  // Selected ticker
  selectedSymbol: string | null
  snapshot: TickerSnapshot | null
  snapshotLoading: boolean
  snapshotError: string | null

  // Chart
  chartInterval: ChartInterval
  showVwap: boolean
  showEma9: boolean
  showEma20: boolean
  showLevels: boolean
  livePrice: number | null        // latest candle close — written by ChartPanel on every fetch

  // UI
  activeTab: ActiveTab

  // Watchlist
  watchlist: WatchlistItem[]
  alerts: Alert[]

  // Positions
  positions: Position[]

  // Actions
  setScannerRows: (rows: ScannerRow[]) => void
  setScannerLoading: (v: boolean) => void
  setScannerError: (e: string | null) => void
  setLastScanTime: (t: number) => void
  setFilters: (f: Partial<ScannerFilters>) => void

  selectSymbol: (sym: string) => void
  setSnapshot: (s: TickerSnapshot | null) => void
  setSnapshotLoading: (v: boolean) => void
  setSnapshotError: (e: string | null) => void

  setChartInterval: (i: ChartInterval) => void
  setLivePrice: (p: number | null) => void
  toggleVwap: () => void
  toggleEma9: () => void
  toggleEma20: () => void
  toggleLevels: () => void
  setActiveTab: (t: ActiveTab) => void

  addToWatchlist: (sym: string) => void
  removeFromWatchlist: (sym: string) => void
  addAlert: (a: Alert) => void
  markAlertRead: (index: number) => void
  clearAlerts: () => void

  // Position actions
  addPosition: (p: Position) => void
  updatePosition: (id: string, patch: Partial<Position>) => void
  closePosition: (id: string, closePrice: number) => void
  removePosition: (id: string) => void
}

export const useTradingStore = create<TradingStore>()(
  persist(
    (set) => ({
      scannerRows: [],
      scannerLoading: false,
      scannerError: null,
      lastScanTime: null,
      filters: INITIAL_FILTERS,

      selectedSymbol: null,
      snapshot: null,
      snapshotLoading: false,
      snapshotError: null,

      chartInterval: '5min',
      showVwap: true,
      showEma9: true,
      showEma20: true,
      showLevels: true,
      livePrice: null,
      activeTab: 'overview',

      watchlist: [],
      alerts: [],
      positions: [],

      setScannerRows: (rows) => set({ scannerRows: rows }),
      setScannerLoading: (v) => set({ scannerLoading: v }),
      setScannerError: (e) => set({ scannerError: e }),
      setLastScanTime: (t) => set({ lastScanTime: t }),
      setFilters: (f) => set(s => ({ filters: { ...s.filters, ...f } })),

      selectSymbol: (sym) => set({ selectedSymbol: sym, snapshot: null, activeTab: 'overview' }),
      setSnapshot: (s) => set({ snapshot: s }),
      setSnapshotLoading: (v) => set({ snapshotLoading: v }),
      setSnapshotError: (e) => set({ snapshotError: e }),

      setChartInterval: (i) => set({ chartInterval: i }),
      setLivePrice: (p) => set({ livePrice: p }),
      toggleVwap: () => set(s => ({ showVwap: !s.showVwap })),
      toggleEma9: () => set(s => ({ showEma9: !s.showEma9 })),
      toggleEma20: () => set(s => ({ showEma20: !s.showEma20 })),
      toggleLevels: () => set(s => ({ showLevels: !s.showLevels })),
      setActiveTab: (t) => set({ activeTab: t }),

      addToWatchlist: (sym) => set(s => ({
        watchlist: s.watchlist.some(w => w.symbol === sym)
          ? s.watchlist
          : [...s.watchlist, { symbol: sym, addedAt: Date.now(), alertConditions: [] }],
      })),
      removeFromWatchlist: (sym) => set(s => ({
        watchlist: s.watchlist.filter(w => w.symbol !== sym),
      })),
      addAlert: (a) => set(s => ({ alerts: [a, ...s.alerts].slice(0, 100) })),
      markAlertRead: (i) => set(s => {
        const alerts = [...s.alerts]
        if (alerts[i]) alerts[i] = { ...alerts[i], read: true }
        return { alerts }
      }),
      clearAlerts: () => set({ alerts: [] }),

      addPosition: (p) => set(s => ({ positions: [p, ...s.positions] })),
      updatePosition: (id, patch) => set(s => ({
        positions: s.positions.map(p => p.id === id ? { ...p, ...patch } : p),
      })),
      closePosition: (id, closePrice) => set(s => ({
        positions: s.positions.map(p =>
          p.id === id
            ? { ...p, status: 'closed', closedAt: Date.now(), closePrice, currentPrice: closePrice }
            : p
        ),
      })),
      removePosition: (id) => set(s => ({
        positions: s.positions.filter(p => p.id !== id),
      })),
    }),
    {
      name: 'trading-companion',
      partialize: (s) => ({
        watchlist: s.watchlist,
        filters: s.filters,
        chartInterval: s.chartInterval,
        showVwap: s.showVwap,
        showEma9: s.showEma9,
        showEma20: s.showEma20,
        showLevels: s.showLevels,
        // Persist positions but strip live fields
        positions: s.positions.map(p => ({
          ...p,
          currentPrice: null,
          unrealizedPnl: null,
          unrealizedPnlPct: null,
          lastPriceUpdate: null,
        })),
      }),
    }
  )
)
