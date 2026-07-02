'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { isTodayPremarket, isTodayAfterHours, isRegularHours } from '@/lib/market-hours'
import { emaAll } from '@/lib/technical'
import type { Position } from '@/types'

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

  // Monitored setups for the currently-charted symbol (overlay source)
  const symbolSetups = selectedSymbol
    ? monitoredSetups.filter(s => s.symbol === selectedSymbol).slice(0, 4)
    : []

  // Active (non-closed) position for the currently selected symbol
  const activePosition: Position | null =
    selectedSymbol
      ? (positions.find(
          p => p.symbol === selectedSymbol && p.status !== 'closed' && p.status !== 'stopped'
        ) ?? null)
      : null

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
  }, [])

  useEffect(() => {
    if (!selectedSymbol) { setCandles([]); setLivePrice(null); return }
    fetchCandles(selectedSymbol, chartInterval)
    const id = setInterval(() => fetchCandles(selectedSymbol, chartInterval), 30_000)
    return () => clearInterval(id)
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
          background: { color: '#0e1117' },
          textColor: '#9ca3af',
        },
        grid: {
          vertLines: { color: '#1f2937' },
          horzLines: { color: '#1f2937' },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#374151' },
        timeScale: {
          borderColor: '#374151',
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
        const upColor = extended ? '#2d6a6a' : '#22c55e'
        const downColor = extended ? '#6a3535' : '#ef4444'
        const borderUpColor = extended ? '#3a8585' : '#22c55e'
        const borderDownColor = extended ? '#854444' : '#ef4444'
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
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderUpColor: '#22c55e',
        borderDownColor: '#ef4444',
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
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

      // ── Position trade lines ─────────────────────────────────────────────
      if (activePosition) {
        const pos = activePosition
        const isLong = pos.direction === 'long'

        // Entry line
        candleSeries.createPriceLine({
          price: pos.entry,
          color: '#60a5fa',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `Entry (${isLong ? 'L' : 'S'}) ${pos.shares}sh`,
        })

        // Stop loss line
        candleSeries.createPriceLine({
          price: pos.stop,
          color: '#f87171',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: pos.stop === pos.entry ? 'Stop (BE)' : pos.stop === pos.initialStop ? 'Stop' : 'Stop ⟳',
        })

        // Initial stop (ghost) — only if stop has moved from original
        if (pos.stop !== pos.initialStop) {
          candleSeries.createPriceLine({
            price: pos.initialStop,
            color: '#f8717140',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: '',
          })
        }

        // Profit targets
        const targetColors = ['#4ade80', '#34d399', '#10b981']
        for (let i = 0; i < pos.targets.length; i++) {
          const t = pos.targets[i]
          candleSeries.createPriceLine({
            price: t.price,
            color: t.hit ? targetColors[i] + '80' : targetColors[i],
            lineWidth: t.hit ? 1 : 2,
            lineStyle: t.hit ? LineStyle.Dotted : LineStyle.Dashed,
            axisLabelVisible: true,
            title: t.hit ? `${t.label} ✓` : t.label,
          })
        }

        // Risk/reward shading via very faint area series isn't supported,
        // but we show a midpoint label so the zone is clear
        if (pos.targets.length > 0) {
          const rr = Math.abs(pos.targets[0].price - pos.entry) / Math.abs(pos.entry - pos.stop)
          const entryLine = pos.entry
          candleSeries.createPriceLine({
            price: entryLine,
            color: '#00000000', // transparent — used only for the axis label
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: false,
            title: `R/R ${rr.toFixed(1)}:1`,
          })
        }
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
              : (c.close >= c.open ? '#22c55e30' : '#ef444430'),
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
      for (const su of symbolSetups) {
        const dir = su.direction === 'long'
        if (showSetupZones) {
          // Zone bounds as a shaded pair of lines + a labelled midline
          candleSeries.createPriceLine({
            price: su.zoneUpper, color: dir ? '#22c55e60' : '#ef444460',
            lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '',
          })
          candleSeries.createPriceLine({
            price: su.zoneLower, color: dir ? '#22c55e60' : '#ef444460',
            lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '',
          })
          candleSeries.createPriceLine({
            price: su.zoneMidpoint, color: dir ? '#22c55e' : '#ef4444',
            lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, showVwap, showEma9, showEma20, showLevels, showSetupZones, showTargets, showInvalidation, symbolSetups, snapshot?.sessionLevels, snapshot?.technical, activePosition?.entry, activePosition?.stop, activePosition?.status, activePosition?.targets])

  useEffect(() => () => cleanupRef.current(), [])

  return (
    <div className="flex flex-col h-full bg-[#0e1117]">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 flex-shrink-0 min-h-[40px]">
        {selectedSymbol ? (
          <>
            <span className="text-sm font-bold text-white">{selectedSymbol}</span>
            {snapshot?.quote && (
              <>
                <span className="text-sm font-mono text-gray-200">
                  ${snapshot.quote.price.toFixed(2)}
                </span>
                <span className={`text-xs font-medium ${snapshot.quote.changesPercentage >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {snapshot.quote.changesPercentage >= 0 ? '+' : ''}{snapshot.quote.changesPercentage.toFixed(2)}%
                </span>
                {snapshot.setupScore && (
                  <span className="text-xs text-gray-600 ml-1">
                    Score {snapshot.setupScore.total}/100
                  </span>
                )}
                {activePosition && (
                  <span className="text-xs ml-1 px-1.5 py-0.5 rounded font-medium border border-blue-700 text-blue-300 bg-blue-900/30">
                    {activePosition.direction === 'long' ? '▲' : '▼'} {activePosition.shares.toLocaleString()}sh
                    {activePosition.unrealizedPnl != null && (
                      <span className={activePosition.unrealizedPnl >= 0 ? ' text-green-400' : ' text-red-400'}>
                        {' '}{activePosition.unrealizedPnl >= 0 ? '+' : ''}${activePosition.unrealizedPnl.toFixed(2)}
                      </span>
                    )}
                  </span>
                )}
                {snapshot.breakoutStatus && snapshot.breakoutStatus.state !== 'none' && (
                  <span className={`text-xs ml-1 px-1.5 py-0.5 rounded font-medium ${
                    snapshot.breakoutStatus.state === 'confirmed' ? 'text-green-400 bg-green-900/20' :
                    snapshot.breakoutStatus.state === 'triggered' ? 'text-yellow-400 bg-yellow-900/20' :
                    snapshot.breakoutStatus.state === 'failed' ? 'text-red-400 bg-red-900/20' :
                    snapshot.breakoutStatus.state === 'extended' ? 'text-orange-400 bg-orange-900/20' :
                    'text-blue-400 bg-blue-900/20'
                  }`}>
                    {snapshot.breakoutStatus.state.toUpperCase()}
                  </span>
                )}
              </>
            )}
          </>
        ) : (
          <span className="text-xs text-gray-600">No ticker selected</span>
        )}

        <div className="ml-auto flex items-center gap-1 flex-wrap">
          {/* Interval buttons */}
          {(['1min', '5min', '15min', 'daily'] as ChartInterval[]).map(iv => (
            <button
              key={iv}
              onClick={() => setChartInterval(iv)}
              className={`text-xs px-2 py-0.5 rounded ${
                chartInterval === iv
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {iv}
            </button>
          ))}
          <div className="w-px h-4 bg-gray-700 mx-1" />
          {/* Indicator toggles */}
          {[
            { key: 'vwap', label: 'VWAP', active: showVwap, toggle: toggleVwap, color: 'text-purple-400' },
            { key: 'ema9', label: 'E9', active: showEma9, toggle: toggleEma9, color: 'text-yellow-400' },
            { key: 'ema20', label: 'E20', active: showEma20, toggle: toggleEma20, color: 'text-blue-400' },
            { key: 'lvl', label: 'Levels', active: showLevels, toggle: toggleLevels, color: 'text-gray-400' },
            { key: 'zones', label: 'Setups', active: showSetupZones, toggle: toggleSetupZones, color: 'text-emerald-400' },
            { key: 'tgt', label: 'Targets', active: showTargets, toggle: toggleTargets, color: 'text-green-400' },
            { key: 'inv', label: 'Inval', active: showInvalidation, toggle: toggleInvalidation, color: 'text-red-400' },
          ].map(btn => (
            <button
              key={btn.key}
              onClick={btn.toggle}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                btn.active
                  ? `border-current ${btn.color}`
                  : 'border-gray-700 text-gray-600 hover:text-gray-400'
              }`}
            >
              {btn.label}
            </button>
          ))}
          {snapshot?.technical?.ma50Daily && (
            <span className="text-xs text-orange-400/60 ml-1">MA50</span>
          )}
          {snapshot?.technical?.ma200Daily && (
            <span className="text-xs text-pink-400/60">MA200</span>
          )}
          {selectedSymbol && (
            <button
              onClick={() => fetchCandles(selectedSymbol, chartInterval)}
              className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-500 hover:text-gray-300 ml-1"
              title="Refresh candles"
            >
              ↻
            </button>
          )}
        </div>
      </div>

      {/* ── Extended session legend ── */}
      {selectedSymbol && (
        <div className="flex items-center gap-3 px-3 py-1 border-b border-gray-800/50 bg-gray-900/20 flex-shrink-0">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-[#22c55e]" />
            <span className="text-[10px] text-gray-500">Regular</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm bg-[#2d6a6a]" />
            <span className="text-[10px] text-gray-500">Extended</span>
          </div>
          <span className="text-[10px] text-gray-700">· Times in ET</span>
        </div>
      )}

      {/* ── Chart area — always rendered ── */}
      <div className="flex-1 relative min-h-0">

        {/* Placeholder when no ticker selected */}
        {!selectedSymbol && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
            <svg className="w-10 h-10 text-gray-800" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 12l3-3 3 3 4-4M4 20h16M4 4h16" />
            </svg>
            <p className="text-xs text-gray-700">Select a ticker from the scanner to load its chart</p>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0e1117]/70 z-10 pointer-events-none">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '150ms' }} />
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="absolute inset-x-0 top-2 flex justify-center z-10 pointer-events-none">
            <div className="px-3 py-1.5 bg-red-900/30 border border-red-800/40 rounded text-xs text-red-400 max-w-sm text-center">
              {error}
            </div>
          </div>
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
