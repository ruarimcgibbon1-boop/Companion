'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
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
  MonitorFunnel,
  PatternHit,
  PatternLogRecord,
  NotificationSettings,
  SetupLog,
  DataIntegrity,
  BuySignalRecord,
} from '@/types'
import { DEFAULT_NOTIFICATION_SETTINGS } from '@/types'

// Avoid importing DEFAULT_FILTERS from types (client-safe)
const INITIAL_FILTERS: ScannerFilters = {
  minPrice: 0.1,
  maxPrice: 300,
  minChangePct: 3,
  maxChangePct: 1000,
  minVolume: 500000,
  minRelativeVolume: 1.5,   // filter out non-movers — require ≥1.5× relative volume
  minMarketCap: null,
  maxMarketCap: null,
  maxFloat: null,
  exchanges: ['NASDAQ', 'NYSE', 'AMEX'],
  commonStocksOnly: true,
  includeLowFloat: true,
  sessionMode: 'regular',
  maxResults: 10,           // top 10 gainers in the left column
  minNewsRecencyHours: null,
}

interface MonitorSweep {
  keyLevels: Record<string, KeyLevel[]>
  roadmaps: Record<string, PriceRoadmap>
  meta: Record<string, DataIntegrity>
  symbolSetups: Record<string, DetectedSetup[]>
  symbolPatterns: Record<string, PatternHit[] | undefined>
  setupStates: Record<string, SetupStateRecord>
  logs: SetupLog[]
  alerts: MonitorAlert[]
  buySignals: BuySignalRecord[]
  ranked: DetectedSetup[]
  funnel: MonitorFunnel
  patternLogs: PatternLogRecord[]
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
  monitorFunnel: MonitorFunnel | null              // live — latest sweep's signal funnel (ephemeral)
  symbolSetups: Record<string, DetectedSetup[]>    // live — every setup per symbol (unfiltered)
  symbolPatterns: Record<string, PatternHit[] | undefined>  // live — candlestick pattern hits per symbol
  patternLog: PatternLogRecord[]                   // persisted — accumulating log of pattern occurrences
  keyLevels: Record<string, KeyLevel[]>            // live — per symbol (for chart overlays)
  roadmaps: Record<string, PriceRoadmap>           // live — per symbol
  monitorMeta: Record<string, DataIntegrity>       // live — per symbol data integrity
  setupStates: Record<string, SetupStateRecord>    // persisted — state machine records
  monitorAlerts: MonitorAlert[]                    // persisted (last 100)
  buySignals: BuySignalRecord[]                    // persisted — every BUY indication, for review
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
  clearBuySignals: () => void
  clearPatternLog: () => void
  /** Write resolved outcomes back onto pattern-log rows, matched by id. */
  updatePatternLogs: (records: PatternLogRecord[]) => void
  updateBuySignal: (id: string, patch: Partial<BuySignalRecord>) => void
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
      monitorFunnel: null,
      symbolSetups: {},
      symbolPatterns: {},
      patternLog: [],
      keyLevels: {},
      roadmaps: {},
      monitorMeta: {},
      setupStates: {},
      monitorAlerts: [],
      buySignals: [],
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

        // Cap setupStates: it's keyed by setup id and merges every sweep, so
        // across a trading day it grows unbounded and blows the localStorage
        // quota. Keep the 500 most-recently-updated records.
        const SETUP_STATES_CAP = 500
        const mergedStates = { ...s.setupStates, ...p.setupStates }
        const stateEntries = Object.entries(mergedStates)
        const setupStates = stateEntries.length > SETUP_STATES_CAP
          ? Object.fromEntries(
              stateEntries
                .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
                .slice(0, SETUP_STATES_CAP)
            )
          : mergedStates

        return {
          keyLevels: { ...s.keyLevels, ...p.keyLevels },
          roadmaps: { ...s.roadmaps, ...p.roadmaps },
          monitorMeta: { ...s.monitorMeta, ...p.meta },
          symbolSetups: { ...s.symbolSetups, ...p.symbolSetups },
          symbolPatterns: { ...s.symbolPatterns, ...p.symbolPatterns },
          // Accumulate pattern occurrences (deduped by id), newest first, capped.
          patternLog: p.patternLogs.length
            ? [...p.patternLogs.filter(r => !s.patternLog.some(e => e.id === r.id)), ...s.patternLog].slice(0, 500)
            : s.patternLog,
          setupStates,
          setupLogs,
          monitorAlerts: p.alerts.length ? [...p.alerts, ...s.monitorAlerts].slice(0, 100) : s.monitorAlerts,
          // Dedup buy signals by id (one per trigger event); newest first, cap 300.
          buySignals: p.buySignals.length
            ? [...p.buySignals.filter(b => !s.buySignals.some(e => e.id === b.id)), ...s.buySignals].slice(0, 300)
            : s.buySignals,
          monitoredSetups: p.ranked,
          monitorFunnel: p.funnel,
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
      clearBuySignals: () => set({ buySignals: [] }),
      clearPatternLog: () => set({ patternLog: [] }),

      updatePatternLogs: (records) => set(s => {
        if (records.length === 0) return {}
        const byId = new Map(records.map(r => [r.id, r]))
        return { patternLog: s.patternLog.map(r => byId.get(r.id) ?? r) }
      }),
      updateBuySignal: (id, patch) => set(s => ({
        buySignals: s.buySignals.map(b => b.id === id ? { ...b, ...patch } : b),
      })),
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
      version: 1,
      // Resilient storage: if a write exceeds the localStorage quota, retry
      // after dropping the heavy/regenerable monitor arrays rather than letting
      // the QuotaExceededError bubble up and crash the app. Those fields are
      // rebuilt on the next monitor sweep.
      storage: createJSONStorage(() => {
        if (typeof window === 'undefined') return undefined as unknown as Storage
        const HEAVY_KEYS = ['setupStates', 'setupLogs', 'buySignals', 'monitorAlerts']
        return {
          getItem: (name: string) => window.localStorage.getItem(name),
          removeItem: (name: string) => window.localStorage.removeItem(name),
          setItem: (name: string, value: string) => {
            try {
              window.localStorage.setItem(name, value)
            } catch {
              try {
                const parsed = JSON.parse(value)
                if (parsed?.state) for (const k of HEAVY_KEYS) delete parsed.state[k]
                window.localStorage.setItem(name, JSON.stringify(parsed))
              } catch {
                /* give up quietly — persistence is best-effort */
              }
            }
          },
        }
      }),
      // v1: apply the tighter scanner defaults (rvol ≥ 1.5, top 10) to users
      // who already have older filters saved in localStorage.
      migrate: (persisted, version) => {
        const st = persisted as { filters?: ScannerFilters } | undefined
        if (st?.filters && version < 1) {
          st.filters.minRelativeVolume = 1.5
          st.filters.maxResults = 10
        }
        return st as unknown
      },
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
        buySignals: s.buySignals,
        setupLogs: s.setupLogs,
        patternLog: s.patternLog,
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
