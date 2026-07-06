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
  DetectedSetup,
  KeyLevel,
  PriceRoadmap,
  SetupStateRecord,
  MonitorAlert,
  NotificationSettings,
  SetupLog,
  DataIntegrity,
} from '@/types'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@/types'

// Avoid importing DEFAULT_FILTERS from types (client-safe)
const INITIAL_FILTERS: ScannerFilters = {
  minPrice: 0.1,
  maxPrice: 300,
  minChangePct: 3,
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

interface MonitorSweep {
  keyLevels: Record<string, KeyLevel[]>
  roadmaps: Record<string, PriceRoadmap>
  meta: Record<string, DataIntegrity>
  symbolSetups: Record<string, DetectedSetup[]>
  setupStates: Record<string, SetupStateRecord>
  logs: SetupLog[]
  alerts: MonitorAlert[]
  ranked: DetectedSetup[]
  now: number
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

  // ── Always-on monitoring ──
  monitoredSetups: DetectedSetup[]                 // live — best setups across the universe
  symbolSetups: Record<string, DetectedSetup[]>    // live — every setup per symbol (unfiltered)
  keyLevels: Record<string, KeyLevel[]>            // live — per symbol (for chart overlays)
  roadmaps: Record<string, PriceRoadmap>           // live — per symbol
  monitorMeta: Record<string, DataIntegrity>       // live — per symbol data integrity
  setupStates: Record<string, SetupStateRecord>    // persisted — state machine records
  monitorAlerts: MonitorAlert[]                    // persisted (last 100)
  setupLogs: SetupLog[]                            // persisted — performance log
  notificationSettings: NotificationSettings        // persisted
  searchedSymbols: string[]                        // persisted — recent manual searches
  lastMonitorTime: number | null
  monitorRunning: boolean

  // Chart overlay toggles
  showSetupZones: boolean
  showTargets: boolean
  showInvalidation: boolean

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

  // Monitoring actions
  setMonitoredSetups: (s: DetectedSetup[]) => void
  /** Apply an entire monitor sweep in ONE state update (perf-critical). */
  ingestMonitorSweep: (p: MonitorSweep) => void
  setSymbolSetups: (sym: string, setups: DetectedSetup[]) => void
  setKeyLevels: (sym: string, levels: KeyLevel[]) => void
  setRoadmap: (sym: string, r: PriceRoadmap) => void
  setMonitorMeta: (sym: string, m: DataIntegrity) => void
  setSetupState: (id: string, rec: SetupStateRecord) => void
  addMonitorAlert: (a: MonitorAlert) => void
  markMonitorAlertRead: (id: string) => void
  markAllMonitorAlertsRead: () => void
  clearMonitorAlerts: () => void
  upsertSetupLog: (log: SetupLog) => void
  updateNotificationSettings: (patch: Partial<NotificationSettings>) => void
  addSearchedSymbol: (sym: string) => void
  setLastMonitorTime: (t: number) => void
  setMonitorRunning: (v: boolean) => void
  toggleSetupZones: () => void
  toggleTargets: () => void
  toggleInvalidation: () => void
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

      monitoredSetups: [],
      symbolSetups: {},
      keyLevels: {},
      roadmaps: {},
      monitorMeta: {},
      setupStates: {},
      monitorAlerts: [],
      setupLogs: [],
      notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
      searchedSymbols: [],
      lastMonitorTime: null,
      monitorRunning: false,
      showSetupZones: true,
      showTargets: true,
      showInvalidation: true,

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

      // ── Monitoring ──
      setMonitoredSetups: (setups) => set({ monitoredSetups: setups }),
      ingestMonitorSweep: (p) => set(s => {
        // Merge setup logs by id (update in place, prepend new), cap at 500.
        const idIndex = new Map(s.setupLogs.map((l, i) => [l.id, i]))
        const arr = s.setupLogs.slice()
        const fresh: typeof s.setupLogs = []
        for (const l of p.logs) {
          const i = idIndex.get(l.id)
          if (i != null) arr[i] = l
          else fresh.push(l)
        }
        const setupLogs = [...fresh, ...arr].slice(0, 500)
        return {
          keyLevels: { ...s.keyLevels, ...p.keyLevels },
          roadmaps: { ...s.roadmaps, ...p.roadmaps },
          monitorMeta: { ...s.monitorMeta, ...p.meta },
          symbolSetups: { ...s.symbolSetups, ...p.symbolSetups },
          setupStates: { ...s.setupStates, ...p.setupStates },
          setupLogs,
          monitorAlerts: p.alerts.length ? [...p.alerts, ...s.monitorAlerts].slice(0, 100) : s.monitorAlerts,
          monitoredSetups: p.ranked,
          lastMonitorTime: p.now,
        }
      }),
      setSymbolSetups: (sym, setups) => set(s => ({ symbolSetups: { ...s.symbolSetups, [sym]: setups } })),
      setKeyLevels: (sym, levels) => set(s => ({ keyLevels: { ...s.keyLevels, [sym]: levels } })),
      setRoadmap: (sym, r) => set(s => ({ roadmaps: { ...s.roadmaps, [sym]: r } })),
      setMonitorMeta: (sym, m) => set(s => ({ monitorMeta: { ...s.monitorMeta, [sym]: m } })),
      setSetupState: (id, rec) => set(s => ({ setupStates: { ...s.setupStates, [id]: rec } })),
      addMonitorAlert: (a) => set(s => ({ monitorAlerts: [a, ...s.monitorAlerts].slice(0, 100) })),
      markMonitorAlertRead: (id) => set(s => ({
        monitorAlerts: s.monitorAlerts.map(a => a.id === id ? { ...a, read: true } : a),
      })),
      markAllMonitorAlertsRead: () => set(s => ({
        monitorAlerts: s.monitorAlerts.map(a => ({ ...a, read: true })),
      })),
      clearMonitorAlerts: () => set({ monitorAlerts: [] }),
      upsertSetupLog: (log) => set(s => {
        const idx = s.setupLogs.findIndex(l => l.id === log.id)
        if (idx >= 0) {
          const next = [...s.setupLogs]
          next[idx] = log
          return { setupLogs: next }
        }
        return { setupLogs: [log, ...s.setupLogs].slice(0, 500) }
      }),
      updateNotificationSettings: (patch) => set(s => ({
        notificationSettings: { ...s.notificationSettings, ...patch },
      })),
      addSearchedSymbol: (sym) => set(s => ({
        searchedSymbols: [sym, ...s.searchedSymbols.filter(x => x !== sym)].slice(0, 20),
      })),
      setLastMonitorTime: (t) => set({ lastMonitorTime: t }),
      setMonitorRunning: (v) => set({ monitorRunning: v }),
      toggleSetupZones: () => set(s => ({ showSetupZones: !s.showSetupZones })),
      toggleTargets: () => set(s => ({ showTargets: !s.showTargets })),
      toggleInvalidation: () => set(s => ({ showInvalidation: !s.showInvalidation })),
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
        showSetupZones: s.showSetupZones,
        showTargets: s.showTargets,
        showInvalidation: s.showInvalidation,
        // Monitoring — persisted so setups + logs survive a restart
        setupStates: s.setupStates,
        monitorAlerts: s.monitorAlerts,
        setupLogs: s.setupLogs,
        notificationSettings: s.notificationSettings,
        searchedSymbols: s.searchedSymbols,
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
