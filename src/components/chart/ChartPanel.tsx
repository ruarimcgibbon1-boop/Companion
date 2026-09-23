'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { useBrokerPositions } from '@/hooks/useBrokerPositions'
import { isTodayPremarket, isTodayAfterHours, isRegularHours, dataAge } from '@/lib/market-hours'
import { emaAll } from '@/lib/technical'
import { selectChartPosition, structuralOverlayKey, type ChartPositionOverlay } from './position-overlay'

type ChartInterval = '1min' | '5min' | '15min' | 'daily'

interface Candle {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// Determine if a candle timestamp (unix ms) is an extended-hours candle
function isExtendedCandle(tsMs: number): boolean {
  return isTodayPremarket(tsMs) || isTodayAfterHours(tsMs)
}

// ── Live position badge ──────────────────────────────────────────────────────
// Compact, always-current read of the on-chart position. Rendered as an ordinary
// React element (not a chart primitive), so its P&L refreshes every broker poll
// WITHOUT touching the lightweight-charts instance (Phase 11).

const RECON_BADGE: Record<string, { label: string; cls: string }> = {
  verified:      { label: 'VERIFIED',      cls: 'text-bull' },
  pending:       { label: 'PENDING',       cls: 'text-ink-mute' },
  discrepancy:   { label: 'DISCREPANCY',   cls: 'text-warn' },
  manual_review: { label: 'MANUAL REVIEW', cls: 'text-warn' },
}

function overlayHeader(o: ChartPositionOverlay): { icon: string; label: string; cls: string } {
  if (o.kind === 'manual') return { icon: '◆', label: 'TRACKER POSITION', cls: 'text-ink-soft' }
  switch (o.source) {
    case 'companion':    return { icon: '⚡', label: 'LIVE POSITION',   cls: 'text-accent-hi' }
    case 'external':     return { icon: '○', label: 'EXTERNAL',        cls: 'text-ink-mute' }
    default:             return { icon: '⚠', label: 'UNATTRIBUTED',    cls: 'text-warn' }
  }
}

function LivePositionBadge({
  overlay, stale, error, lastSuccessAt,
}: {
  overlay: ChartPositionOverlay
  stale: boolean
  error: string | null
  lastSuccessAt: number | null
}) {
  const o = overlay
  const head = overlayHeader(o)
  const pnl = o.unrealizedPnl
  const pnlPct = o.unrealizedPnlPct
  const pnlCls = pnl == null ? 'text-ink-mute' : pnl >= 0 ? 'text-bull' : 'text-bear'
  const recon = o.kind === 'broker' && o.reconciliationStatus ? RECON_BADGE[o.reconciliationStatus] : null
  const isBroker = o.kind === 'broker'
  const syncAge = lastSuccessAt != null ? dataAge(lastSuccessAt) : null

  return (
    <div className="absolute top-2 left-2 z-10 pointer-events-none select-none rounded-lg bg-app/85 backdrop-blur-sm ring-1 ring-inset ring-line-strong px-2.5 py-1.5 shadow-lg shadow-black/40 min-w-[132px]">
      <div className="flex items-center gap-1.5">
        <span className={`text-[11px] font-bold tracking-wide ${head.cls}`}>{head.icon} {head.label}</span>
        {recon && <span className={`text-[9px] font-semibold ${recon.cls}`}>{recon.label}</span>}
      </div>
      <div className={`text-sm tnum font-semibold ${pnlCls} leading-tight mt-0.5`}>
        {pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`}
        {pnlPct != null && (
          <span className={`text-[11px] ml-1.5 ${pnlCls}`}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</span>
        )}
      </div>
      <div className="text-[10px] text-ink-mute tnum mt-0.5">
        {o.qty.toLocaleString()} sh
        {o.entryIsActualFill && <span className="text-ink-faint"> @ ${o.entry.toFixed(2)} avg</span>}
      </div>
      {isBroker && error && (
        <div className="text-[10px] text-bear font-semibold mt-1">
          ALPACA UNAVAILABLE{syncAge ? ` • last ${syncAge}` : ''}
        </div>
      )}
      {isBroker && !error && stale && (
        <div className="text-[10px] text-warn font-semibold mt-1">
          ALPACA STALE{syncAge ? ` • ${syncAge}` : ''}
        </div>
      )}
    </div>
  )
}

export function ChartPanel() {
  const {
    selectedSymbol,
    snapshot,
    chartInterval,
    setChartInterval,
    showVwap,
    showEma9,
    showEma20,
    showLevels,
    toggleVwap,
    toggleEma9,
    toggleEma20,
    toggleLevels,
    positions,
    setLivePrice,
    showSetupZones,
    showTargets,
    showInvalidation,
    toggleSetupZones,
    toggleTargets,
    toggleInvalidation,
    monitoredSetups,
  } = useTradingStore()

  // Monitored setups for the currently-charted symbol (overlay source).
  // Memoised so the chart-building effect only re-runs when the *selected*
  // symbol's overlays actually change — not on every 25s monitor sweep.
  const symbolSetups = useMemo(
    () => selectedSymbol ? monitoredSetups.filter(s => s.symbol === selectedSymbol).slice(0, 4) : [],
    [monitoredSetups, selectedSymbol]
  )
  const overlayKey = useMemo(
    () => symbolSetups.map(s => `${s.id}:${s.state}:${s.zoneLower.toFixed(3)}:${s.zoneUpper.toFixed(3)}:${s.invalidation.toFixed(3)}:${s.targets.map(t => t.price.toFixed(3)).join(',')}`).join('|'),
    [symbolSetups]
  )

  // ── Broker (Alpaca) position feed ───────────────────────────────────────────
  // Broker-authoritative exposure for the selected symbol, polled on the shared
  // cadence. Overlay priority (Phase 2): broker position → manual/local → none.
  const broker = useBrokerPositions()
  const [showPosition, setShowPosition] = useState(true)

  const overlay: ChartPositionOverlay | null = useMemo(
    () => selectChartPosition({
      symbol: selectedSymbol,
      brokerPositions: broker.positions,
      manualPositions: positions,
    }),
    [selectedSymbol, broker.positions, positions],
  )

  // STRUCTURAL signature only — excludes price/P&L, so the chart is NOT rebuilt on
  // every 2.5s broker poll (Phase 11). Geometry changes (entry/qty/stop/targets)
  // change this key and trigger exactly one rebuild.
  const overlayStructuralKey = useMemo(() => structuralOverlayKey(overlay), [overlay])
  const hasOverlay = showPosition && overlay != null

  const chartContainerRef = useRef<HTMLDivElement>(null)
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chartRef = useRef<unknown>(null)
  const cleanupRef = useRef<() => void>(() => {})
  const prevSymbolRef = useRef<string | null>(null)
  const prevIntervalRef = useRef<string | null>(null)

  // ── Fetch candles ─────────────────────────────────────────────────────────

  const fetchCandles = useCallback(async (sym: string, interval: ChartInterval) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/candles?symbol=${sym}&interval=${interval}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const c = data.candles ?? []
      if (c.length === 0) setError('No candle data returned. Check FMP subscription includes intraday data.')
      setCandles(c)
      // Push latest close price to store so CompanionPanel can rebuild trade plans with current price
      if (c.length > 0) setLivePrice(c[c.length - 1].close)
    } catch (err) {
      setError((err as Error).message)
      setCandles([])
    } finally {
      setLoading(false)
    }
    // Zustand setters are stable references — safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear chart state when the ticker is deselected
    if (!selectedSymbol) { setCandles([]); setLivePrice(null); return }
    fetchCandles(selectedSymbol, chartInterval)
    const id = setInterval(() => fetchCandles(selectedSymbol, chartInterval), 30_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSymbol, chartInterval, fetchCandles])

  // ── Build / rebuild chart ─────────────────────────────────────────────────

  useEffect(() => {
    if (!chartContainerRef.current) return
    if (candles.length === 0) return

    // Save visible range before teardown so we can restore it after a data refresh
    // (only when the symbol/interval hasn't changed — i.e. this is a background update)
    const isSameView = (
      prevSymbolRef.current === selectedSymbol &&
      prevIntervalRef.current === chartInterval
    )
    let savedRange: { from: number; to: number } | null = null
    if (isSameView && chartRef.current) {
      try {
        savedRange = (chartRef.current as {
          timeScale: () => { getVisibleRange: () => { from: number; to: number } | null }
        }).timeScale().getVisibleRange()
      } catch { /* ignore */ }
    }
    prevSymbolRef.current = selectedSymbol
    prevIntervalRef.current = chartInterval

    cleanupRef.current()
    cleanupRef.current = () => {}

    let cancelled = false

    import('lightweight-charts').then((lc) => {
      if (cancelled || !chartContainerRef.current) return

      const { createChart, CrosshairMode, LineStyle, LineType, CandlestickSeries, HistogramSeries, LineSeries } = lc

      if (chartRef.current) {
        try { (chartRef.current as { remove: () => void }).remove() } catch { /* already removed */ }
        chartRef.current = null
      }

      const chart = createChart(chartContainerRef.current, {
        layout: {
          background: { color: '#0e131a' },
          textColor: '#8b96a5',
        },
        grid: {
          vertLines: { color: 'rgba(33,42,54,0.55)' },
          horzLines: { color: 'rgba(33,42,54,0.55)' },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#212a36' },
        timeScale: {
          borderColor: '#212a36',
          timeVisible: true,
          secondsVisible: false,
        },
        localization: {
          timeFormatter: (ts: number) =>
            new Intl.DateTimeFormat('en-US', {
              timeZone: 'America/New_York',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).format(new Date(ts * 1000)),
        },
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight,
      })

      chartRef.current = chart

      type LCTime = import('lightweight-charts').Time

      const chartData = candles.map(c => {
        const tsMs = new Date(c.date).getTime()
        const extended = isExtendedCandle(tsMs)
        const isGreen = c.close >= c.open
        // Extended hours: muted teal/slate colors
        const upColor = extended ? '#2d6a6a' : '#2ebd85'
        const downColor = extended ? '#6a3535' : '#f6465d'
        const borderUpColor = extended ? '#3a8585' : '#2ebd85'
        const borderDownColor = extended ? '#854444' : '#f6465d'
        return {
          time: Math.floor(tsMs / 1000) as LCTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          color: isGreen ? upColor : downColor,
          borderColor: isGreen ? borderUpColor : borderDownColor,
          wickColor: isGreen ? borderUpColor : borderDownColor,
        }
      })

      // ── Candlestick series ───────────────────────────────────────────────
      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#2ebd85',
        downColor: '#f6465d',
        borderUpColor: '#2ebd85',
        borderDownColor: '#f6465d',
        wickUpColor: '#2ebd85',
        wickDownColor: '#f6465d',
      })
      candleSeries.setData(chartData)

      // ── Current price line ───────────────────────────────────────────────
      const lastCandle = candles[candles.length - 1]
      if (lastCandle) {
        candleSeries.createPriceLine({
          price: lastCandle.close,
          color: '#e5e7eb',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '',
        })
      }

      // ── Position overlay (broker-authoritative, else manual) ─────────────
      // ONE overlay per symbol — broker truth wins over the manual tracker, so no
      // duplicate entry/stop/target lines are drawn (Phase 2). EXTERNAL and
      // UNATTRIBUTED positions expose exposure only: no invented stop/targets.
      if (showPosition && overlay) {
        const o = overlay
        const isLong = o.direction === 'long'

        // Entry / actual average fill. A real broker fill reads cyan + "AVG FILL"
        // so it is visibly distinct from an intended/manual entry (blue).
        const isExternal = o.source === 'external' || o.source === 'unattributed'
        const entryColor = o.entryIsActualFill ? (isExternal ? '#7dd3fc' : '#22d3ee') : '#60a5fa'
        const entryTitle = o.entryIsActualFill
          ? `AVG FILL $${o.entry.toFixed(2)} · ${o.qty.toLocaleString()} SH`
          : `Entry (${isLong ? 'L' : 'S'}) ${o.qty.toLocaleString()}sh`
        candleSeries.createPriceLine({
          price: o.entry,
          color: entryColor,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: entryTitle,
        })

        // Stop — drawn only for Companion/manual overlays (o.stop null otherwise).
        // Solid = a resting broker protective stop is recorded; dashed = intended
        // strategy stop only (e.g. premarket, where Alpaca accepts no stop order).
        if (o.stop != null) {
          const stopTitle = o.stopIsBreakeven ? `STOP · BE $${o.stop.toFixed(2)}` : `STOP $${o.stop.toFixed(2)}`
          candleSeries.createPriceLine({
            price: o.stop,
            color: '#f87171',
            lineWidth: 2,
            lineStyle: o.hasProtectiveStop ? LineStyle.Solid : LineStyle.Dashed,
            axisLabelVisible: true,
            title: stopTitle,
          })
          // Initial stop ghost — only once the stop has moved from its origin.
          if (o.initialStop != null && o.initialStop !== o.stop) {
            candleSeries.createPriceLine({
              price: o.initialStop,
              color: '#f8717140',
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: false,
              title: '',
            })
          }
        }

        // Targets — completed ones go quieter (dotted + ✓) rather than vanishing.
        const targetColors = ['#4ade80', '#34d399', '#10b981']
        o.targets.forEach((t, i) => {
          const c = targetColors[i] ?? '#34d399'
          candleSeries.createPriceLine({
            price: t.price,
            color: t.hit ? c + '80' : c,
            lineWidth: t.hit ? 1 : 2,
            lineStyle: t.hit ? LineStyle.Dotted : LineStyle.Dashed,
            axisLabelVisible: true,
            title: t.hit ? `${t.label} ✓` : t.label,
          })
        })
      }

      // ── Volume bars ──────────────────────────────────────────────────────
      const volumeSeries = chart.addSeries(HistogramSeries, {
        color: '#374151',
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
      })
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
      volumeSeries.setData(
        candles.map(c => {
          const tsMs = new Date(c.date).getTime()
          const extended = isExtendedCandle(tsMs)
          return {
            time: Math.floor(tsMs / 1000) as LCTime,
            value: c.volume,
            color: extended
              ? (c.close >= c.open ? '#2d6a6a50' : '#6a353550')
              : (c.close >= c.open ? '#2ebd8530' : '#f6465d30'),
          }
        })
      )

      // ── VWAP ────────────────────────────────────────────────────────────
      if (showVwap) {
        // Accumulate over regular-session candles; carry last value through extended hours
        let cumTPV = 0
        let cumVol = 0
        let lastVwap: number | null = null
        const vwapData: { time: LCTime; value: number }[] = []
        for (const d of chartData) {
          const tsMs = (d.time as number) * 1000
          const vol = (d as unknown as { volume: number }).volume ?? 0
          if (isRegularHours(tsMs)) {
            const tp = (d.high + d.low + d.close) / 3
            cumTPV += tp * vol
            cumVol += vol
            if (cumVol > 0) {
              lastVwap = cumTPV / cumVol
              vwapData.push({ time: d.time, value: lastVwap })
            }
          } else if (lastVwap !== null) {
            // Extend the VWAP line through pre/afterhours at the last known value
            vwapData.push({ time: d.time, value: lastVwap })
          }
        }
        if (vwapData.length > 0) {
          const vwapSeries = chart.addSeries(LineSeries, {
            color: '#a855f7',
            lineWidth: 2,
            lineStyle: LineStyle.Solid,
            lineType: LineType.Curved,
            title: 'VWAP',
            priceScaleId: 'right',
            lastValueVisible: true,
          })
          vwapSeries.setData(vwapData)
        }
      }

      // ── EMA 9 ─────────────────────────────────────────────────────────────
      if (showEma9) {
        const closes = chartData.map(d => d.close)
        const vals = emaAll(closes, 9)
        const offset = chartData.length - vals.length
        const data = vals.map((value, i) => ({ time: chartData[offset + i].time, value }))
        if (data.length > 0) {
          const s = chart.addSeries(LineSeries, {
            color: '#f59e0b',
            lineWidth: 1,
            title: 'EMA9',
            priceScaleId: 'right',
            lastValueVisible: true,
          })
          s.setData(data)
        }
      }

      // ── EMA 20 ───────────────────────────────────────────────────────────
      if (showEma20) {
        const closes = chartData.map(d => d.close)
        const vals = emaAll(closes, 20)
        const offset = chartData.length - vals.length
        const data = vals.map((value, i) => ({ time: chartData[offset + i].time, value }))
        if (data.length > 0) {
          const s = chart.addSeries(LineSeries, {
            color: '#3b82f6',
            lineWidth: 1,
            title: 'EMA20',
            priceScaleId: 'right',
            lastValueVisible: true,
          })
          s.setData(data)
        }
      }

      // ── MA 50 (daily) ─────────────────────────────────────────────────────
      if (snapshot?.technical?.ma50Daily) {
        const s = chart.addSeries(LineSeries, {
          color: '#f97316',
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          title: 'MA50',
          priceScaleId: 'right',
          lastValueVisible: true,
        })
        const v = snapshot.technical.ma50Daily
        s.setData(chartData.map(d => ({ time: d.time, value: v })))
      }

      // ── MA 200 (daily) ────────────────────────────────────────────────────
      if (snapshot?.technical?.ma200Daily) {
        const s = chart.addSeries(LineSeries, {
          color: '#ec4899',
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          title: 'MA200',
          priceScaleId: 'right',
          lastValueVisible: true,
        })
        const v = snapshot.technical.ma200Daily
        s.setData(chartData.map(d => ({ time: d.time, value: v })))
      }

      // ── Session level lines ───────────────────────────────────────────────
      if (showLevels && snapshot?.sessionLevels) {
        const sl = snapshot.sessionLevels
        const levelDefs: Array<{ price: number | null; color: string; label: string; style?: number }> = [
          { price: sl.vwap, color: '#a855f7', label: 'VWAP', style: LineStyle.Dashed },
          { price: sl.premarketHigh, color: '#f97316', label: 'PM High', style: LineStyle.Dotted },
          { price: sl.premarketLow, color: '#f97316', label: 'PM Low', style: LineStyle.Dotted },
          { price: sl.previousDayHigh, color: '#6b7280', label: 'PDH', style: LineStyle.Dotted },
          { price: sl.previousDayLow, color: '#6b7280', label: 'PDL', style: LineStyle.Dotted },
          { price: sl.previousClose, color: '#4b5563', label: 'Prev Close', style: LineStyle.Dotted },
          { price: sl.or5High, color: '#0ea5e9', label: 'OR5H' },
          { price: sl.or5Low, color: '#0ea5e9', label: 'OR5L' },
          { price: sl.or15High, color: '#0284c7', label: 'OR15H' },
          { price: sl.or15Low, color: '#0284c7', label: 'OR15L' },
        ]
        for (const def of levelDefs) {
          if (!def.price) continue
          const s = chart.addSeries(LineSeries, {
            color: def.color + '99',
            lineWidth: 1,
            lineStyle: def.style ?? LineStyle.Solid,
            title: def.label,
            priceScaleId: 'right',
            lastValueVisible: true,
            crosshairMarkerVisible: false,
          })
          s.setData(chartData.map(d => ({ time: d.time, value: def.price as number })))
        }
      }

      // ── Monitored setup overlays ──────────────────────────────────────────
      // When a live position is on the chart the theoretical setup is muted so the
      // ACTUAL position dominates (Phase 9) — context kept, prominence lowered.
      const setupMuted = showPosition && overlay != null
      for (const su of symbolSetups) {
        const dir = su.direction === 'long'
        if (showSetupZones) {
          // Zone bounds as a shaded pair of lines + a labelled midline
          candleSeries.createPriceLine({
            price: su.zoneUpper, color: dir ? '#2ebd8560' : '#f6465d60',
            lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '',
          })
          candleSeries.createPriceLine({
            price: su.zoneLower, color: dir ? '#2ebd8560' : '#f6465d60',
            lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '',
          })
          candleSeries.createPriceLine({
            price: su.zoneMidpoint,
            color: setupMuted ? (dir ? '#2ebd8570' : '#f6465d70') : (dir ? '#2ebd85' : '#f6465d'),
            lineWidth: setupMuted ? 1 : 2, lineStyle: setupMuted ? LineStyle.Dotted : LineStyle.Solid,
            axisLabelVisible: true,
            title: `${su.grade === 'below' ? '' : su.grade + ' '}${su.type.replace(/_/g, ' ')} ${su.score}`,
          })
        }
        if (showInvalidation) {
          candleSeries.createPriceLine({
            price: su.invalidation, color: '#f87171',
            lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '✕ inval',
          })
        }
        if (showTargets) {
          for (const t of su.targets.slice(0, 3)) {
            candleSeries.createPriceLine({
              price: t.price, color: '#34d399',
              lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
              title: `${t.label}${t.rewardRisk ? ` ${t.rewardRisk}R` : ''}`,
            })
          }
        }
      }

      if (savedRange) {
        try {
          chart.timeScale().setVisibleRange(savedRange as import('lightweight-charts').IRange<import('lightweight-charts').Time>)
        } catch {
          chart.timeScale().fitContent()
        }
      } else {
        chart.timeScale().fitContent()
      }

      // ── Resize observer ───────────────────────────────────────────────────
      const ro = new ResizeObserver(() => {
        if (chartContainerRef.current && chartRef.current) {
          try {
            (chartRef.current as { applyOptions: (o: object) => void }).applyOptions({
              width: chartContainerRef.current.clientWidth,
              height: chartContainerRef.current.clientHeight,
            })
          } catch { /* chart removed */ }
        }
      })
      if (chartContainerRef.current) ro.observe(chartContainerRef.current)

      cleanupRef.current = () => {
        ro.disconnect()
        try { chart.remove() } catch { /* already gone */ }
        chartRef.current = null
      }
    })

    return () => {
      cancelled = true
    }
    // overlayKey is a stable signature of symbolSetups — avoids rebuilding the
    // chart on every monitor sweep when the selected symbol's overlays are unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // overlayStructuralKey is a signature of ONLY structural position geometry —
    // it excludes price/P&L, so the 2.5s broker poll never rebuilds the chart; the
    // live badge below consumes P&L directly and updates on its own (Phase 11).
  }, [candles, showVwap, showEma9, showEma20, showLevels, showSetupZones, showTargets, showInvalidation, overlayKey, snapshot?.sessionLevels, snapshot?.technical, overlayStructuralKey, showPosition])

  useEffect(() => () => cleanupRef.current(), [])

  return (
    <div className="flex flex-col h-full bg-panel">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2.5 px-3 py-2 border-b border-line flex-shrink-0 min-h-[44px]">
        {selectedSymbol ? (
          <>
            <span className="text-sm font-bold text-ink tracking-wide">{selectedSymbol}</span>
            {snapshot?.quote && (
              <>
                <span className="text-sm tnum text-ink">
                  ${snapshot.quote.price.toFixed(2)}
                </span>
                <span className={`text-xs font-semibold tnum ${snapshot.quote.changesPercentage >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {snapshot.quote.changesPercentage >= 0 ? '+' : ''}{snapshot.quote.changesPercentage.toFixed(2)}%
                </span>
                {snapshot.setupScore && (
                  <span className="text-[11px] text-ink-mute ml-0.5 tnum">
                    Score {snapshot.setupScore.total}/100
                  </span>
                )}
                {overlay && (
                  <span className="text-xs ml-0.5 px-1.5 py-0.5 rounded-md font-medium ring-1 ring-inset ring-accent/40 text-accent-hi bg-accent/10 tnum">
                    {overlay.direction === 'long' ? '▲' : '▼'} {overlay.qty.toLocaleString()}sh
                    {overlay.unrealizedPnl != null && (
                      <span className={overlay.unrealizedPnl >= 0 ? ' text-bull' : ' text-bear'}>
                        {' '}{overlay.unrealizedPnl >= 0 ? '+' : ''}${overlay.unrealizedPnl.toFixed(2)}
                      </span>
                    )}
                  </span>
                )}
                {snapshot.breakoutStatus && snapshot.breakoutStatus.state !== 'none' && (
                  <span className={`text-[10px] ml-0.5 px-1.5 py-0.5 rounded font-semibold tracking-wide ${
                    snapshot.breakoutStatus.state === 'confirmed' ? 'text-bull bg-bull/10 ring-1 ring-inset ring-bull/25' :
                    snapshot.breakoutStatus.state === 'triggered' ? 'text-warn bg-warn/10 ring-1 ring-inset ring-warn/25' :
                    snapshot.breakoutStatus.state === 'failed' ? 'text-bear bg-bear/10 ring-1 ring-inset ring-bear/25' :
                    snapshot.breakoutStatus.state === 'extended' ? 'text-warn bg-warn/10 ring-1 ring-inset ring-warn/25' :
                    'text-info bg-info/10 ring-1 ring-inset ring-info/25'
                  }`}>
                    {snapshot.breakoutStatus.state.toUpperCase()}
                  </span>
                )}
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-ink-mute">No ticker selected</span>
        )}

        <div className="ml-auto flex items-center gap-1 flex-wrap">
          {/* Interval buttons — segmented control */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-app/60 ring-1 ring-inset ring-line">
            {(['1min', '5min', '15min', 'daily'] as ChartInterval[]).map(iv => (
              <button
                key={iv}
                onClick={() => setChartInterval(iv)}
                className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                  chartInterval === iv
                    ? 'bg-accent text-white font-semibold'
                    : 'text-ink-mute hover:text-ink'
                }`}
              >
                {iv}
              </button>
            ))}
          </div>
          <div className="w-px h-4 bg-line-strong mx-1" />
          {/* Indicator toggles */}
          {[
            { key: 'vwap', label: 'VWAP', active: showVwap, toggle: toggleVwap, color: 'text-struct' },
            { key: 'ema9', label: 'E9', active: showEma9, toggle: toggleEma9, color: 'text-warn' },
            { key: 'ema20', label: 'E20', active: showEma20, toggle: toggleEma20, color: 'text-info' },
            { key: 'lvl', label: 'Levels', active: showLevels, toggle: toggleLevels, color: 'text-ink-soft' },
            { key: 'zones', label: 'Setups', active: showSetupZones, toggle: toggleSetupZones, color: 'text-bull' },
            { key: 'tgt', label: 'Targets', active: showTargets, toggle: toggleTargets, color: 'text-bull' },
            { key: 'inv', label: 'Inval', active: showInvalidation, toggle: toggleInvalidation, color: 'text-bear' },
            { key: 'pos', label: 'Position', active: showPosition, toggle: () => setShowPosition(v => !v), color: 'text-accent-hi' },
          ].map(btn => (
            <button
              key={btn.key}
              onClick={btn.toggle}
              className={`text-[11px] px-2 py-1 rounded-md ring-1 ring-inset transition-colors ${
                btn.active
                  ? `ring-current bg-white/5 ${btn.color}`
                  : 'ring-line text-ink-mute hover:text-ink-soft hover:ring-line-strong'
              }`}
            >
              {btn.label}
            </button>
          ))}
          {snapshot?.technical?.ma50Daily && (
            <span className="text-[11px] text-warn/60 ml-1">MA50</span>
          )}
          {snapshot?.technical?.ma200Daily && (
            <span className="text-[11px] text-struct/60">MA200</span>
          )}
          {selectedSymbol && (
            <button
              onClick={() => fetchCandles(selectedSymbol, chartInterval)}
              className="w-6 h-6 flex items-center justify-center rounded-md bg-raised text-ink-mute hover:text-ink hover:bg-hover ml-1 transition-colors"
              title="Refresh candles"
            >
              ↻
            </button>
          )}
        </div>
      </div>

      {/* ── Extended session legend ── */}
      {selectedSymbol && (
        <div className="flex items-center gap-3 px-3 py-1 border-b border-line/50 bg-app/30 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm bg-[#2ebd85]" />
            <span className="text-[10px] text-ink-mute">Regular</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm bg-[#2d6a6a]" />
            <span className="text-[10px] text-ink-mute">Extended</span>
          </div>
          <span className="text-[10px] text-ink-faint">· Times in ET</span>
        </div>
      )}

      {/* ── Chart area — always rendered ── */}
      <div className="flex-1 relative min-h-0">

        {/* Placeholder when no ticker selected */}
        {!selectedSymbol && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 pointer-events-none">
            <svg className="w-10 h-10 text-line-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 12l3-3 3 3 4-4M4 20h16M4 4h16" />
            </svg>
            <p className="text-xs text-ink-mute">Select a ticker from the scanner to load its chart</p>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-panel/70 z-10 pointer-events-none">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="absolute inset-x-0 top-2 flex justify-center z-10 pointer-events-none">
            <div className="px-3 py-1.5 bg-bear/15 ring-1 ring-inset ring-bear/30 rounded-md text-xs text-bear max-w-sm text-center">
              {error}
            </div>
          </div>
        )}

        {/* Live position badge — broker-authoritative, updates independently of the chart */}
        {hasOverlay && overlay && candles.length > 0 && (
          <LivePositionBadge
            overlay={overlay}
            stale={broker.stale}
            error={broker.error}
            lastSuccessAt={broker.lastSuccessAt}
          />
        )}

        {/* The chart div — always in the DOM so ResizeObserver has a stable target */}
        <div
          ref={chartContainerRef}
          className="w-full h-full"
          style={{ visibility: candles.length > 0 ? 'visible' : 'hidden' }}
        />
      </div>
    </div>
  )
}
