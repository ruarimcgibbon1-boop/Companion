'use client'

import { useState, useMemo } from 'react'
import { useTradingStore } from '@/store/trading-store'
import { dataAge, isStale } from '@/lib/market-hours'
import { calcPosition, buildTradePlans } from '@/lib/trade-plans'
import type { TickerSnapshot, PullbackScenario, SupportResistanceZone, NewsItem, TradePlan } from '@/types'
import { useSnapshot } from '@/hooks/useSnapshot'
import { ChatTab } from './ChatTab'

type Tab = 'overview' | 'plans' | 'pullback' | 'levels' | 'news' | 'technical' | 'risks' | 'calc' | 'chat'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'plans', label: 'Plans' },
  { key: 'pullback', label: 'Pullback' },
  { key: 'levels', label: 'Levels' },
  { key: 'news', label: 'News' },
  { key: 'technical', label: 'Technical' },
  { key: 'risks', label: 'Risks' },
  { key: 'calc', label: 'Calc' },
  { key: 'chat', label: '💬 Chat' },
]

const STATUS_BG: Record<string, string> = {
  'Constructive': 'bg-green-900/30 text-green-400 border border-green-700/30',
  'Developing': 'bg-yellow-900/30 text-yellow-400 border border-yellow-700/30',
  'Extended': 'bg-orange-900/30 text-orange-400 border border-orange-700/30',
  'Chasing Risk': 'bg-red-900/30 text-red-400 border border-red-700/30',
  'Weakening': 'bg-orange-900/30 text-orange-400 border border-orange-700/30',
  'Breakdown Risk': 'bg-red-900/40 text-red-300 border border-red-700/40',
  'No Clean Setup': 'bg-gray-900/30 text-gray-400 border border-gray-700/30',
}

const QUALITY_COLORS: Record<string, string> = {
  'Strong Confirmed Catalyst': 'text-green-400',
  'Moderate Catalyst': 'text-yellow-400',
  'Weak or Recycled Catalyst': 'text-orange-400',
  'Unclear Catalyst': 'text-gray-400',
  'Negative or Dilutive Catalyst': 'text-red-400',
  'No Recent Catalyst Found': 'text-gray-600',
}

const BREAKOUT_COLORS: Record<string, string> = {
  approaching: 'text-blue-400',
  testing: 'text-yellow-400',
  triggered: 'text-orange-400',
  confirmed: 'text-green-400',
  failed: 'text-red-400',
  extended: 'text-orange-500',
  none: 'text-gray-500',
}

function fmt(v: number | null | undefined): string {
  if (v == null) return 'n/a'
  return `$${v.toFixed(2)}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'n/a'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

export function CompanionPanel() {
  useSnapshot()
  const { snapshot, snapshotLoading, snapshotError, selectedSymbol, activeTab, setActiveTab, addToWatchlist, removeFromWatchlist, watchlist, livePrice } = useTradingStore()

  // Rebuild trade plans using the live chart price whenever it differs from the snapshot price.
  // This keeps entry zones, stops and targets current even between snapshot refreshes.
  const liveTradePlans = useMemo(() => {
    if (!snapshot) return null
    const price = livePrice ?? snapshot.quote.price
    if (Math.abs(price - snapshot.quote.price) < 0.001) return null  // no meaningful difference
    return buildTradePlans({
      price,
      technical: snapshot.technical,
      levels: snapshot.sessionLevels,
      zones: snapshot.zones,
      catalystQuality: snapshot.catalystQuality,
      breakout: snapshot.breakoutStatus,
    })
  }, [snapshot, livePrice])

  const isWatching = watchlist.some(w => w.symbol === selectedSymbol)

  if (!selectedSymbol) {
    return (
      <div className="flex flex-col h-full bg-[#0e1117] border-l border-gray-800 items-center justify-center p-4">
        <p className="text-gray-600 text-sm text-center">Select a ticker to begin analysis</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#0e1117] border-l border-gray-800">
      {/* Ticker header */}
      <div className="px-4 py-3 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center justify-between mb-1">
          <div>
            <span className="text-lg font-bold text-white">{selectedSymbol}</span>
            {snapshot?.quote?.name && (
              <span className="ml-2 text-xs text-gray-500">{snapshot.quote.name}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => isWatching ? removeFromWatchlist(selectedSymbol) : addToWatchlist(selectedSymbol)}
              className={`text-xs px-2 py-0.5 rounded border ${isWatching ? 'border-blue-500 text-blue-400' : 'border-gray-600 text-gray-500 hover:text-gray-300'}`}
            >
              {isWatching ? '★ Watching' : '☆ Watch'}
            </button>
          </div>
        </div>

        {snapshot?.quote && (
          <div className="flex items-center gap-3">
            <span className="text-2xl font-mono text-white">${snapshot.quote.price.toFixed(2)}</span>
            <span className={`text-sm font-medium ${snapshot.quote.changesPercentage >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {fmtPct(snapshot.quote.changesPercentage)}
            </span>
            {snapshot.setupScore && (
              <span className={`ml-auto text-xs px-2 py-1 rounded ${STATUS_BG[snapshot.setupScore.status] ?? 'bg-gray-800 text-gray-400'}`}>
                {snapshot.setupScore.status}
              </span>
            )}
          </div>
        )}

        {/* Breakout status */}
        {snapshot?.breakoutStatus && snapshot.breakoutStatus.state !== 'none' && (
          <div className={`mt-1 text-xs ${BREAKOUT_COLORS[snapshot.breakoutStatus.state] ?? 'text-gray-500'}`}>
            {snapshot.breakoutStatus.description}
          </div>
        )}

        {snapshot && (
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-xs ${snapshot.dataQuality === 'High' ? 'text-green-600' : snapshot.dataQuality === 'Stale' ? 'text-red-600' : 'text-yellow-600'}`}>
              {snapshot.dataQuality}
            </span>
            <span className="text-xs text-gray-700">•</span>
            <span className={`text-xs ${isStale(snapshot.timestamp, 60000) ? 'text-red-600' : 'text-gray-600'}`}>
              {dataAge(snapshot.timestamp)}
            </span>
            <span className="text-xs text-gray-700">•</span>
            <span className="text-xs text-gray-600">{snapshot.sessionType}</span>
          </div>
        )}
      </div>

      {/* Tabs — scrollable */}
      <div className="flex border-b border-gray-800 flex-shrink-0 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex-shrink-0 text-xs px-3 py-2 border-b-2 transition-colors ${activeTab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-600 hover:text-gray-400'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {snapshotLoading && !snapshot && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-gray-500 text-sm animate-pulse">Loading analysis...</span>
        </div>
      )}
      {snapshotError && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-900/10">{snapshotError}</div>
      )}

      {/* Chat tab renders regardless of snapshot so it can prompt user to select a ticker */}
      {activeTab === 'chat' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ChatTab snapshot={snapshot} symbol={selectedSymbol} />
        </div>
      )}

      {!snapshot && !snapshotLoading && activeTab !== 'chat' && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-gray-600 text-xs">Select a ticker to load analysis</span>
        </div>
      )}

      {snapshot && activeTab !== 'chat' && (
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'overview' && <OverviewTab snap={snapshot} />}
          {activeTab === 'plans' && <PlansTab snap={snapshot} liveTradePlans={liveTradePlans} livePrice={livePrice} />}
          {activeTab === 'pullback' && <PullbackTab snap={snapshot} />}
          {activeTab === 'levels' && <LevelsTab snap={snapshot} />}
          {activeTab === 'news' && <NewsTab snap={snapshot} />}
          {activeTab === 'technical' && <TechnicalTab snap={snapshot} />}
          {activeTab === 'risks' && <RisksTab snap={snapshot} />}
          {activeTab === 'calc' && <CalcTab snap={snapshot} />}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{title}</h3>
      {children}
    </div>
  )
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span className="text-xs text-gray-600">{label}</span>
      <span className={`text-xs font-mono ${valueClass ?? 'text-gray-300'}`}>{value}</span>
    </div>
  )
}

// ── Overview ───────────────────────────────────────────────────────────────

function OverviewTab({ snap }: { snap: TickerSnapshot }) {
  const sc = snap.setupScore
  const bd = sc.breakdown

  return (
    <div className="px-4 py-3 space-y-4">
      <Section title="Setup Score">
        <div className="flex items-center gap-3 mb-3">
          <div className="text-3xl font-bold text-white">{sc.total}<span className="text-sm text-gray-500">/100</span></div>
          <div>
            <div className={`text-sm font-medium px-2 py-0.5 rounded inline-block ${STATUS_BG[sc.status] ?? 'bg-gray-800 text-gray-300'}`}>
              {sc.status}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{sc.classification}</div>
          </div>
        </div>
        <div className="space-y-1">
          <ScoreBar label="Trend/Structure" value={bd.trendStructure} max={20} />
          <ScoreBar label="Volume/Liquidity" value={bd.volumeLiquidity} max={15} />
          <ScoreBar label="Catalyst" value={bd.catalystQuality} max={15} />
          <ScoreBar label="Pullback Quality" value={bd.pullbackQuality} max={20} />
          <ScoreBar label="S/R Clarity" value={bd.srClarity} max={10} />
          <ScoreBar label="Reward/Risk" value={bd.rewardRisk} max={10} />
          <ScoreBar label="Extension Risk" value={bd.extensionRisk} max={10} />
        </div>
      </Section>

      {/* Breakout status */}
      {snap.breakoutStatus.state !== 'none' && (
        <Section title="Breakout Status">
          <div className={`text-xs px-2 py-1.5 rounded bg-gray-900 border border-gray-800 ${BREAKOUT_COLORS[snap.breakoutStatus.state]}`}>
            <span className="font-semibold uppercase">{snap.breakoutStatus.state}</span>
            {snap.breakoutStatus.level && (
              <span className="ml-2 text-gray-400">@ ${snap.breakoutStatus.level.toFixed(2)}</span>
            )}
            <div className="mt-0.5 text-gray-400 font-normal">{snap.breakoutStatus.description}</div>
          </div>
          {snap.breakoutStatus.volumeConfirms && (
            <div className="text-xs text-green-500 mt-1">✓ Volume confirms</div>
          )}
        </Section>
      )}

      <Section title="Catalyst">
        <div className={`text-xs font-medium mb-1 ${QUALITY_COLORS[snap.catalystQuality] ?? 'text-gray-400'}`}>
          {snap.catalystQuality} — {snap.catalystCategory}
        </div>
        <p className="text-xs text-gray-400">{snap.catalystSummary}</p>
      </Section>

      <Section title="Market Context">
        <Row label="5-min trend" value={snap.technical.trend5m} valueClass={snap.technical.trend5m === 'up' ? 'text-green-400' : snap.technical.trend5m === 'down' ? 'text-red-400' : 'text-gray-400'} />
        <Row label="15-min trend" value={snap.technical.trend15m} valueClass={snap.technical.trend15m === 'up' ? 'text-green-400' : snap.technical.trend15m === 'down' ? 'text-red-400' : 'text-gray-400'} />
        <Row label="Higher H/L" value={snap.technical.higherHighsLows == null ? 'n/a' : snap.technical.higherHighsLows ? 'Yes' : 'No'} />
        <Row label="VWAP dist" value={snap.technical.distanceFromVwapPct != null ? `${snap.technical.distanceFromVwapPct.toFixed(1)}%` : 'n/a'} />
        <Row label="RVOL" value={snap.technical.relativeVolume != null ? `${snap.technical.relativeVolume.toFixed(1)}x` : 'n/a'} valueClass="text-yellow-400" />
        <Row label="RSI 14" value={snap.technical.rsi14 != null ? snap.technical.rsi14.toFixed(1) : 'n/a'} valueClass={snap.technical.rsi14 != null && snap.technical.rsi14 > 70 ? 'text-red-400' : 'text-gray-300'} />
      </Section>

      {/* Premarket structure */}
      {(snap.sessionLevels.premarketHigh || snap.sessionLevels.premarketLow) && (
        <Section title="Premarket Structure">
          <Row label="PM High" value={fmt(snap.sessionLevels.premarketHigh)} valueClass="text-orange-400" />
          <Row label="PM Low" value={fmt(snap.sessionLevels.premarketLow)} valueClass="text-orange-400" />
          {snap.sessionLevels.premarketVolume && (
            <Row label="PM Volume" value={snap.sessionLevels.premarketVolume.toLocaleString()} />
          )}
        </Section>
      )}

      {snap.pullbacks.length > 0 && (
        <Section title="Best Setup">
          <div className="bg-gray-900 rounded p-3">
            <div className="text-xs font-semibold text-blue-400 mb-1">{snap.pullbacks[0].name}</div>
            <Row label="Entry zone" value={`$${snap.pullbacks[0].entryZoneLow.toFixed(2)} – $${snap.pullbacks[0].entryZoneHigh.toFixed(2)}`} />
            <Row label="Invalidation" value={fmt(snap.pullbacks[0].invalidation)} valueClass="text-red-400" />
            <Row label="Confidence" value={`${snap.pullbacks[0].confidenceScore}%`} />
          </div>
        </Section>
      )}
    </div>
  )
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = (value / max) * 100
  const color = pct >= 75 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-600 w-28 flex-shrink-0">{label}</span>
      <div className="flex-1 bg-gray-800 rounded-full h-1.5">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-8 text-right">{value}/{max}</span>
    </div>
  )
}

// ── Trade Plans ────────────────────────────────────────────────────────────

function PlansTab({ snap, liveTradePlans, livePrice }: { snap: TickerSnapshot; liveTradePlans: TradePlan[] | null; livePrice: number | null }) {
  const [selected, setSelected] = useState<'A' | 'B' | 'C' | 'D'>('A')
  const plans = liveTradePlans ?? snap.tradePlans
  const plan = plans.find(p => p.label === selected)
  const isLive = liveTradePlans !== null

  return (
    <div className="px-4 py-3">
      {/* Live price indicator */}
      {isLive && livePrice != null && (
        <div className="flex items-center gap-1.5 mb-2 text-[10px] text-green-500">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />
          Plans updated to live price ${livePrice.toFixed(2)}
        </div>
      )}
      {/* Plan selector */}
      <div className="flex gap-1 mb-3">
        {(['A', 'B', 'C', 'D'] as const).map(l => {
          const p = plans.find(x => x.label === l)
          const isValid = p?.valid ?? false
          return (
            <button
              key={l}
              onClick={() => setSelected(l)}
              className={`flex-1 py-1.5 rounded text-xs font-semibold transition-colors border ${
                selected === l
                  ? 'bg-blue-700 border-blue-500 text-white'
                  : isValid
                  ? 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  : 'bg-gray-900 border-gray-800 text-gray-600'
              }`}
            >
              Plan {l}
              <div className={`text-[9px] font-normal ${selected === l ? 'text-blue-200' : 'text-gray-600'}`}>
                {p?.type}
              </div>
            </button>
          )
        })}
      </div>

      {plan && <PlanCard plan={plan} price={snap.quote.price} />}
    </div>
  )
}

function PlanCard({ plan }: { plan: TradePlan; price: number }) {
  const planTypeColor = plan.type === 'No-Trade' ? 'text-gray-500' : plan.valid ? 'text-blue-400' : 'text-gray-600'
  return (
    <div className={`rounded-lg border p-3 ${plan.type === 'No-Trade' ? 'bg-gray-900/40 border-gray-800' : plan.valid ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/40 border-gray-800'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-sm font-bold ${planTypeColor}`}>Plan {plan.label}: {plan.name}</span>
        {!plan.valid && plan.invalidReason && (
          <span className="text-xs text-red-500 bg-red-900/20 px-1.5 py-0.5 rounded">Invalid</span>
        )}
      </div>

      {!plan.valid && plan.invalidReason && (
        <div className="text-xs text-orange-400 mb-2 bg-orange-900/10 px-2 py-1.5 rounded">
          ⚠ {plan.invalidReason}
        </div>
      )}

      {plan.type !== 'No-Trade' && (
        <>
          {/* Entry */}
          <div className="bg-gray-800/50 rounded p-2 mb-2">
            <div className="text-xs font-semibold text-gray-400 mb-1">Entry</div>
            {plan.entryLow && plan.entryHigh && (
              <div className="text-sm font-mono text-white">${plan.entryLow.toFixed(2)} – ${plan.entryHigh.toFixed(2)}</div>
            )}
            <div className="text-xs text-gray-400 mt-0.5">{plan.entryTrigger}</div>
          </div>

          {/* Risk */}
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div className="bg-gray-800/50 rounded p-2">
              <div className="text-xs text-gray-500 mb-0.5">Stop</div>
              <div className="text-sm font-mono text-red-400">{fmt(plan.stopLoss)}</div>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <div className="text-xs text-gray-500 mb-0.5">Invalidation</div>
              <div className="text-sm font-mono text-red-500">{fmt(plan.invalidation)}</div>
            </div>
          </div>

          {/* Targets */}
          {plan.targets.length > 0 && (
            <div className="mb-2">
              <div className="text-xs font-semibold text-gray-400 mb-1">Targets</div>
              <div className="space-y-1">
                {plan.targets.map((t, i) => (
                  <div key={i} className="flex items-center justify-between bg-gray-800/50 rounded px-2 py-1">
                    <span className="text-xs text-gray-400">{t.label}</span>
                    <span className="text-xs font-mono text-green-400">{fmt(t.price)}</span>
                    {t.rewardRisk && (
                      <span className="text-xs text-gray-500">{t.rewardRisk.toFixed(1)}:1</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Confirmation */}
          {plan.confirmation.length > 0 && (
            <div className="mb-2">
              <div className="text-xs font-semibold text-gray-400 mb-1">Confirmation needed</div>
              {plan.confirmation.map((c, i) => (
                <div key={i} className="text-xs text-gray-500 flex items-start gap-1">
                  <span className="text-green-600 flex-shrink-0">✓</span><span>{c}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Ideal / avoid */}
      {plan.idealConditions.length > 0 && (
        <div className="mb-2">
          <div className="text-xs font-semibold text-gray-400 mb-1">Ideal conditions</div>
          {plan.idealConditions.map((c, i) => (
            <div key={i} className="text-xs text-gray-500 flex items-start gap-1">
              <span className="text-blue-600 flex-shrink-0">+</span><span>{c}</span>
            </div>
          ))}
        </div>
      )}
      {plan.avoidWhen.length > 0 && (
        <div className="mb-2">
          <div className="text-xs font-semibold text-gray-400 mb-1">Avoid when</div>
          {plan.avoidWhen.map((c, i) => (
            <div key={i} className="text-xs text-gray-500 flex items-start gap-1">
              <span className="text-red-600 flex-shrink-0">−</span><span>{c}</span>
            </div>
          ))}
        </div>
      )}

      {/* Pullback label */}
      {plan.pullbackDepth && (
        <div className="text-xs text-blue-400 mt-1">
          Pullback depth: <span className="font-semibold">{plan.pullbackDepth}</span>
        </div>
      )}

      {plan.notes && (
        <div className="text-xs text-gray-500 mt-2 italic border-t border-gray-800 pt-2">{plan.notes}</div>
      )}
    </div>
  )
}

// ── Pullback ───────────────────────────────────────────────────────────────

function PullbackTab({ snap }: { snap: TickerSnapshot }) {
  return (
    <div className="px-4 py-3 space-y-4">
      {snap.pullbacks.length === 0 ? (
        <div className="text-xs text-gray-500 py-4 text-center">No pullback scenarios identified.</div>
      ) : (
        snap.pullbacks.map((p, i) => <PullbackCard key={i} p={p} index={i} />)
      )}
      {snap.warnings.length > 0 && (
        <Section title="Warnings">
          <div className="space-y-1">
            {snap.warnings.map((w, i) => (
              <div key={i} className="text-xs text-orange-400 flex items-start gap-1">
                <span>⚠️</span><span>{w}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Short availability quick view */}
      {snap.shortAvailability.warning && (
        <Section title="Short Availability">
          {(() => {
            const sa = snap.shortAvailability
            const isEasy = sa.availability === 'Easy'
            const isHTB = sa.availability === 'HTB' || sa.availability === 'Tight'
            return (
              <div className={`text-xs p-2 rounded border leading-relaxed ${
                isHTB ? 'text-green-400 bg-green-900/20 border-green-800' :
                isEasy ? 'text-red-400 bg-red-900/20 border-red-800' :
                'text-yellow-400 bg-yellow-900/20 border-yellow-800'
              }`}>
                {sa.squeezeRisk && <span className="font-semibold">Squeeze Risk · </span>}
                {sa.warning}
              </div>
            )
          })()}
        </Section>
      )}
    </div>
  )
}

function PullbackCard({ p, index }: { p: PullbackScenario; index: number }) {
  const confidenceColor = p.confidenceScore >= 70 ? 'text-green-400' : p.confidenceScore >= 50 ? 'text-yellow-400' : 'text-orange-400'
  return (
    <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-blue-400">{index + 1}. {p.name}</span>
        <span className={`text-xs font-medium ${confidenceColor}`}>{p.confidenceScore}%</span>
      </div>
      <div className="space-y-0.5 mb-2">
        <Row label="Entry zone" value={`$${p.entryZoneLow.toFixed(2)} – $${p.entryZoneHigh.toFixed(2)}`} />
        <Row label="Invalidation" value={fmt(p.invalidation)} valueClass="text-red-400" />
        <Row label="Target 1" value={fmt(p.target1)} valueClass="text-green-400" />
        <Row label="Target 2" value={fmt(p.target2)} valueClass="text-green-400" />
        <Row label="R/R" value={p.rewardRisk ? `${p.rewardRisk.toFixed(1)}:1` : 'n/a'} />
        <Row label="Vol confirms" value={p.volumeConfirms ? 'Yes' : 'No'} />
        <Row label="Chasing" value={p.isChasing ? 'Yes ⚠️' : 'No'} />
      </div>
      <div className="text-xs text-gray-500 mb-1"><span className="text-gray-600">Confirmation:</span> {p.confirmation}</div>
      <div className="text-xs text-gray-500 mb-1"><span className="text-gray-600">Trigger:</span> {p.trigger}</div>
      {p.whatMakesStronger.length > 0 && (
        <div className="text-xs text-gray-600">+ {p.whatMakesStronger.join(' · ')}</div>
      )}
      {p.whatMakesWeaker.length > 0 && (
        <div className="text-xs text-gray-600">− {p.whatMakesWeaker.join(' · ')}</div>
      )}
    </div>
  )
}

// ── Levels ─────────────────────────────────────────────────────────────────

function LevelsTab({ snap }: { snap: TickerSnapshot }) {
  const sl = snap.sessionLevels
  return (
    <div className="px-4 py-3 space-y-4">
      <Section title="Session Levels">
        <Row label="VWAP" value={fmt(sl.vwap)} valueClass="text-purple-400" />
        <Row label="Day High" value={fmt(sl.regularHigh)} />
        <Row label="Day Low" value={fmt(sl.regularLow)} />
        <Row label="Opening print" value={fmt(sl.openingPrint)} />
        <Row label="5-min OR High" value={fmt(sl.or5High)} valueClass="text-blue-400" />
        <Row label="5-min OR Low" value={fmt(sl.or5Low)} valueClass="text-blue-400" />
        <Row label="15-min OR High" value={fmt(sl.or15High)} />
        <Row label="15-min OR Low" value={fmt(sl.or15Low)} />
        <Row label="PM High" value={fmt(sl.premarketHigh)} valueClass="text-orange-400" />
        <Row label="PM Low" value={fmt(sl.premarketLow)} valueClass="text-orange-400" />
        <Row label="Prev Close" value={fmt(sl.previousClose)} valueClass="text-gray-400" />
        <Row label="Prev Day High" value={fmt(sl.previousDayHigh)} valueClass="text-gray-400" />
        <Row label="Prev Day Low" value={fmt(sl.previousDayLow)} valueClass="text-gray-400" />
      </Section>

      <Section title={`S/R Zones (${snap.zones.length})`}>
        {snap.zones.length === 0 && <div className="text-xs text-gray-600">No zones calculated</div>}
        {snap.zones.map((z, i) => <ZoneCard key={i} zone={z} />)}
      </Section>
    </div>
  )
}

function ZoneCard({ zone }: { zone: SupportResistanceZone }) {
  const typeColor = zone.type === 'support' ? 'text-green-400' : zone.type === 'resistance' ? 'text-red-400' : 'text-yellow-400'
  // 5-tier strength label
  const strengthLabel =
    zone.strengthScore >= 9 ? 'Very Strong' :
    zone.strengthScore >= 7 ? 'Strong' :
    zone.strengthScore >= 5 ? 'Moderate' :
    zone.strengthScore >= 3 ? 'Weak' :
    'Very Weak'
  const strengthColor =
    zone.strengthScore >= 9 ? 'text-green-400' :
    zone.strengthScore >= 7 ? 'text-yellow-400' :
    zone.strengthScore >= 5 ? 'text-gray-400' :
    'text-gray-600'

  return (
    <div className="bg-gray-900 rounded p-2 mb-1 border border-gray-800">
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-semibold ${typeColor}`}>{zone.type.toUpperCase()}</span>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${strengthColor}`}>{strengthLabel} ({zone.strengthScore}/10)</span>
          <span className={`text-xs ${zone.status === 'testing' ? 'text-yellow-400' : zone.status === 'failed' ? 'text-red-400' : 'text-gray-500'}`}>
            {zone.status}
          </span>
        </div>
      </div>
      <div className="text-xs text-gray-300 font-mono">
        ${zone.lower.toFixed(2)} – ${zone.upper.toFixed(2)}
        <span className="ml-2 text-gray-600">({zone.priorReactions} reactions)</span>
      </div>
      <div className="text-xs text-gray-600 mt-0.5">{zone.reasons.join(' · ')}</div>
    </div>
  )
}

// ── News ───────────────────────────────────────────────────────────────────

function NewsTab({ snap }: { snap: TickerSnapshot }) {
  return (
    <div className="px-4 py-3 space-y-3">
      {snap.news.length === 0 && (
        <div className="text-xs text-gray-600 py-4 text-center">No recent news</div>
      )}
      {snap.news.slice(0, 15).map((n, i) => <NewsCard key={i} news={n} />)}
    </div>
  )
}

function NewsCard({ news: n }: { news: NewsItem }) {
  return (
    <div className={`rounded-lg p-3 border ${n.isDilutive ? 'bg-red-900/20 border-red-800/30' : 'bg-gray-900 border-gray-800'}`}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className={`text-xs font-medium leading-tight ${QUALITY_COLORS[n.quality] ?? 'text-gray-400'}`}>
          {n.quality}
        </span>
        <span className="text-xs text-gray-600 flex-shrink-0">{n.age}</span>
      </div>
      <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-200 hover:text-white leading-tight block mb-1">
        {n.title}
      </a>
      <div className="flex items-center gap-2 text-xs text-gray-600">
        <span>{n.source}</span>
        {n.isDilutive && <span className="text-red-400 font-medium">⚠️ DILUTION</span>}
        <span>{n.catalystCategory}</span>
      </div>
      {n.bullishElements.length > 0 && (
        <div className="text-xs text-green-600 mt-1">+ {n.bullishElements.join(' · ')}</div>
      )}
      {n.bearishElements.length > 0 && (
        <div className="text-xs text-red-600">− {n.bearishElements.join(' · ')}</div>
      )}
    </div>
  )
}

// ── Technical ──────────────────────────────────────────────────────────────

function TechnicalTab({ snap }: { snap: TickerSnapshot }) {
  const t = snap.technical
  return (
    <div className="px-4 py-3 space-y-4">
      <Section title="Intraday Indicators">
        <Row label="VWAP" value={fmt(t.vwap)} valueClass="text-purple-400" />
        <Row label="9 EMA" value={fmt(t.ema9)} valueClass="text-yellow-400" />
        <Row label="20 EMA" value={fmt(t.ema20)} valueClass="text-blue-400" />
        <Row label="50 MA (intra)" value={fmt(t.ma50Intraday)} />
        <Row label="RSI 14" value={t.rsi14 != null ? t.rsi14.toFixed(1) : 'n/a'} valueClass={t.rsi14 != null && t.rsi14 > 70 ? 'text-red-400' : t.rsi14 != null && t.rsi14 < 30 ? 'text-green-400' : 'text-gray-300'} />
        <Row label="ATR" value={t.atr != null ? t.atr.toFixed(3) : 'n/a'} />
        <Row label="RVOL" value={t.relativeVolume != null ? `${t.relativeVolume.toFixed(1)}x` : 'n/a'} valueClass="text-yellow-400" />
        <Row label="Volume trend" value={t.volumeTrend} />
        <Row label="VWAP distance" value={t.distanceFromVwapPct != null ? `${t.distanceFromVwapPct.toFixed(1)}%` : 'n/a'} />
        <Row label="HOD distance" value={t.distanceFromDayHighPct != null ? `${t.distanceFromDayHighPct.toFixed(1)}%` : 'n/a'} />
      </Section>

      <Section title="Daily Context">
        <Row label="50-day MA" value={fmt(t.ma50Daily)} />
        <Row label="200-day MA" value={fmt(t.ma200Daily)} />
        <Row label="Daily RSI" value={t.dailyRsi != null ? t.dailyRsi.toFixed(1) : 'n/a'} />
        <Row label="Daily ATR" value={t.dailyAtr != null ? t.dailyAtr.toFixed(3) : 'n/a'} />
        <Row label="Gap %" value={t.gapPct != null ? `${t.gapPct >= 0 ? '+' : ''}${t.gapPct.toFixed(1)}%` : 'n/a'} valueClass={t.gapPct != null && t.gapPct > 0 ? 'text-green-400' : 'text-red-400'} />
        <Row label="5-day H/L" value={t.fiveDayHigh != null ? `${fmt(t.fiveDayLow)} / ${fmt(t.fiveDayHigh)}` : 'n/a'} />
        <Row label="20-day H/L" value={t.twentyDayHigh != null ? `${fmt(t.twentyDayLow)} / ${fmt(t.twentyDayHigh)}` : 'n/a'} />
        <Row label="Range breakout" value={t.isBreakingOutOfRange ? 'Yes ✓' : 'No'} valueClass={t.isBreakingOutOfRange ? 'text-green-400' : 'text-gray-400'} />
      </Section>
    </div>
  )
}

// ── Risks ──────────────────────────────────────────────────────────────────

function RisksTab({ snap }: { snap: TickerSnapshot }) {
  return (
    <div className="px-4 py-3 space-y-4">
      <Section title="Active Warnings">
        {snap.warnings.length === 0 ? (
          <div className="text-xs text-gray-600">No active warnings</div>
        ) : (
          snap.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 py-1 border-b border-gray-800/50">
              <span className="text-orange-400">⚠️</span>
              <span className="text-xs text-gray-300">{w}</span>
            </div>
          ))
        )}
      </Section>

      <Section title="Short Availability">
        {(() => {
          const sa = snap.shortAvailability
          const colors: Record<string, string> = {
            Easy: 'text-red-400 bg-red-900/20 border-red-800',
            Moderate: 'text-yellow-400 bg-yellow-900/20 border-yellow-800',
            Tight: 'text-blue-400 bg-blue-900/20 border-blue-800',
            HTB: 'text-green-400 bg-green-900/20 border-green-800',
            Unknown: 'text-gray-500 bg-gray-900/20 border-gray-800',
          }
          const labels: Record<string, string> = {
            Easy: 'Easy To Borrow',
            Moderate: 'Moderate Borrow',
            Tight: 'Tight Borrow',
            HTB: 'Hard To Borrow',
            Unknown: 'Borrow Unknown',
          }
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-0.5 rounded border font-semibold ${colors[sa.availability]}`}>
                  {labels[sa.availability]}
                </span>
                {sa.squeezeRisk && (
                  <span className="text-xs px-2 py-0.5 rounded border border-green-700 text-green-400 bg-green-900/20 font-semibold">
                    Squeeze Risk
                  </span>
                )}
              </div>
              {sa.floatShares != null && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-gray-900 rounded p-2 border border-gray-800">
                    <div className="text-[10px] text-gray-600">Float Shares</div>
                    <div className="text-xs font-mono text-gray-300">
                      {sa.floatShares >= 1e6 ? `${(sa.floatShares / 1e6).toFixed(2)}M` : sa.floatShares.toLocaleString()}
                    </div>
                  </div>
                  {sa.freeFloatPct != null && (
                    <div className="bg-gray-900 rounded p-2 border border-gray-800">
                      <div className="text-[10px] text-gray-600">Free Float</div>
                      <div className="text-xs font-mono text-gray-300">{sa.freeFloatPct.toFixed(1)}%</div>
                    </div>
                  )}
                </div>
              )}
              {sa.warning && (
                <div className={`text-xs p-2 rounded border leading-relaxed ${colors[sa.availability]}`}>
                  {sa.warning}
                </div>
              )}
              {sa.availability === 'Unknown' && (
                <div className="text-xs text-gray-600">Float data not available for this symbol.</div>
              )}
            </div>
          )
        })()}
      </Section>

      <Section title="Dilution Risk">
        {snap.news.filter(n => n.isDilutive).length === 0 ? (
          <div className="text-xs text-gray-600">No dilution language detected in recent news</div>
        ) : (
          snap.news.filter(n => n.isDilutive).map((n, i) => (
            <div key={i} className="text-xs text-red-400 py-1 border-b border-red-900/20">
              ⚠️ {n.title}
            </div>
          ))
        )}
      </Section>

      <Section title="What Changes the Thesis">
        <div className="space-y-2">
          {snap.pullbacks.length > 0 && (
            <div>
              <div className="text-xs text-gray-600 mb-1">Invalidation level:</div>
              <div className="text-sm font-mono text-red-400">${snap.pullbacks[0].invalidation.toFixed(2)}</div>
            </div>
          )}
          {snap.breakoutStatus.state === 'confirmed' && (
            <div className="text-xs text-green-400">Breakout is confirmed. If price closes back below {snap.breakoutStatus.level ? `$${snap.breakoutStatus.level.toFixed(2)}` : 'breakout level'}, the thesis is invalidated.</div>
          )}
          {snap.technical.lowerHighsLows && (
            <div className="text-xs text-orange-400">Structure is showing lower highs and lower lows — bullish thesis weakened.</div>
          )}
          {snap.technical.vwapCrossCount > 3 && (
            <div className="text-xs text-gray-400">VWAP has been crossed {snap.technical.vwapCrossCount} times — indecisive price action.</div>
          )}
          {snap.news.some(n => n.isDilutive) && (
            <div className="text-xs text-red-400">Dilution risk present — size accordingly.</div>
          )}
        </div>
      </Section>

      <Section title="Data Quality">
        <Row label="Quality" value={snap.dataQuality} valueClass={snap.dataQuality === 'High' ? 'text-green-400' : snap.dataQuality === 'Stale' ? 'text-red-400' : 'text-yellow-400'} />
        <Row label="Session" value={snap.sessionType} />
        <Row label="Last update" value={dataAge(snap.timestamp)} />
      </Section>
    </div>
  )
}

// ── Position Risk Calculator ───────────────────────────────────────────────

function CalcTab({ snap }: { snap: TickerSnapshot }) {
  const [accountSize, setAccountSize] = useState('25000')
  const [maxRiskPct, setMaxRiskPct] = useState('1')
  const [entry, setEntry] = useState(snap.quote.price.toFixed(2))
  const [stop, setStop] = useState(
    snap.pullbacks.length > 0 ? snap.pullbacks[0].invalidation.toFixed(2) : ''
  )

  const entryNum = parseFloat(entry)
  const stopNum = parseFloat(stop)
  const acctNum = parseFloat(accountSize)
  const riskNum = parseFloat(maxRiskPct)

  const valid = !isNaN(entryNum) && !isNaN(stopNum) && !isNaN(acctNum) && !isNaN(riskNum)
    && entryNum > 0 && stopNum > 0 && entryNum !== stopNum && acctNum > 0 && riskNum > 0

  const result = valid ? calcPosition(acctNum, riskNum, entryNum, stopNum) : null

  return (
    <div className="px-4 py-3 space-y-4">
      <Section title="Position Size Calculator">
        <div className="space-y-2">
          <div>
            <label className="text-xs text-gray-500 block mb-0.5">Account Size ($)</label>
            <input
              type="number"
              value={accountSize}
              onChange={e => setAccountSize(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono"
              placeholder="25000"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-0.5">Max Risk (%)</label>
            <input
              type="number"
              value={maxRiskPct}
              onChange={e => setMaxRiskPct(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono"
              placeholder="1"
              step="0.1"
              min="0.1"
              max="5"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-0.5">Entry Price ($)</label>
            <input
              type="number"
              value={entry}
              onChange={e => setEntry(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono"
              step="0.01"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-0.5">Stop Loss ($)</label>
            <input
              type="number"
              value={stop}
              onChange={e => setStop(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono"
              step="0.01"
            />
          </div>
        </div>
      </Section>

      {result && (
        <>
          <Section title="Result">
            <div className="bg-gray-900 rounded-lg p-3 border border-gray-700 space-y-1">
              <Row label="Max monetary risk" value={`$${result.maxMonetaryRisk.toFixed(2)}`} valueClass="text-red-400" />
              <Row label="Risk per share" value={`$${result.riskPerShare.toFixed(3)}`} />
              <Row label="Max shares" value={result.maxShares.toLocaleString()} valueClass="text-white text-sm" />
              <Row label="Position value" value={`$${result.positionValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} valueClass="text-yellow-400" />
              <Row label="% of account" value={`${((result.positionValue / acctNum) * 100).toFixed(1)}%`} />
            </div>
          </Section>

          <Section title="R/R Targets">
            <div className="space-y-1">
              {result.riskRewardTargets.map((t) => (
                <div key={t.ratio} className="flex items-center justify-between bg-gray-900 rounded px-2 py-1.5 border border-gray-800">
                  <span className="text-xs text-gray-500">{t.ratio}:1</span>
                  <span className="text-xs font-mono text-green-400">${t.targetPrice.toFixed(2)}</span>
                  <span className="text-xs text-gray-400">+${t.profit.toFixed(0)}</span>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
