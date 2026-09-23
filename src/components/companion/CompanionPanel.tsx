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
  'Constructive': 'bg-bull/10 text-bull ring-1 ring-inset ring-bull/30',
  'Developing': 'bg-warn/10 text-warn ring-1 ring-inset ring-warn/30',
  'Extended': 'bg-warn/10 text-warn ring-1 ring-inset ring-warn/30',
  'Chasing Risk': 'bg-bear/10 text-bear ring-1 ring-inset ring-bear/30',
  'Weakening': 'bg-warn/10 text-warn ring-1 ring-inset ring-warn/30',
  'Breakdown Risk': 'bg-bear/15 text-bear ring-1 ring-inset ring-bear/40',
  'No Clean Setup': 'bg-white/5 text-ink-mute ring-1 ring-inset ring-white/10',
}

const QUALITY_COLORS: Record<string, string> = {
  'Strong Confirmed Catalyst': 'text-bull',
  'Moderate Catalyst': 'text-warn',
  'Weak or Recycled Catalyst': 'text-warn',
  'Unclear Catalyst': 'text-ink-mute',
  'Negative or Dilutive Catalyst': 'text-bear',
  'No Recent Catalyst Found': 'text-ink-faint',
}

const BREAKOUT_COLORS: Record<string, string> = {
  approaching: 'text-info',
  testing: 'text-warn',
  triggered: 'text-warn',
  confirmed: 'text-bull',
  failed: 'text-bear',
  extended: 'text-warn',
  none: 'text-ink-mute',
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
      <div className="flex flex-col h-full bg-panel border-l border-line items-center justify-center p-4">
        <p className="text-ink-mute text-sm text-center">Select a ticker to begin analysis</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-panel border-l border-line">
      {/* Ticker header */}
      <div className="px-4 pt-3 pb-3 border-b border-line flex-shrink-0 bg-gradient-to-b from-white/[0.02] to-transparent">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-xl font-bold text-ink tracking-wide">{selectedSymbol}</span>
            {snapshot?.quote?.name && (
              <span className="text-xs text-ink-mute truncate">{snapshot.quote.name}</span>
            )}
          </div>
          <button
            onClick={() => isWatching ? removeFromWatchlist(selectedSymbol) : addToWatchlist(selectedSymbol)}
            className={`ring-focus flex-shrink-0 text-xs px-2 py-1 rounded-md border font-medium transition-colors ${isWatching ? 'border-accent/50 bg-accent/10 text-accent-hi' : 'border-line-strong text-ink-mute hover:text-ink hover:border-ink-mute'}`}
          >
            {isWatching ? '★ Watching' : '☆ Watch'}
          </button>
        </div>

        {snapshot?.quote && (
          <div className="flex items-center gap-3">
            <span className="text-[26px] leading-none font-semibold text-ink tnum">${snapshot.quote.price.toFixed(2)}</span>
            <span className={`text-sm font-semibold tnum ${snapshot.quote.changesPercentage >= 0 ? 'text-bull' : 'text-bear'}`}>
              {fmtPct(snapshot.quote.changesPercentage)}
            </span>
            {snapshot.setupScore && (
              <span className={`ml-auto text-[11px] px-2 py-1 rounded-md font-semibold ${STATUS_BG[snapshot.setupScore.status] ?? 'bg-white/5 text-ink-mute'}`}>
                {snapshot.setupScore.status}
              </span>
            )}
          </div>
        )}

        {/* Breakout status */}
        {snapshot?.breakoutStatus && snapshot.breakoutStatus.state !== 'none' && (
          <div className={`mt-1.5 text-xs ${BREAKOUT_COLORS[snapshot.breakoutStatus.state] ?? 'text-ink-mute'}`}>
            {snapshot.breakoutStatus.description}
          </div>
        )}

        {snapshot && (
          <div className="flex items-center gap-2 mt-2 tnum">
            <span className={`inline-flex items-center gap-1 text-[10px] ${snapshot.dataQuality === 'High' ? 'text-bull' : snapshot.dataQuality === 'Stale' ? 'text-bear' : 'text-warn'}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-current" />{snapshot.dataQuality}
            </span>
            <span className="text-[10px] text-line-strong">•</span>
            <span className={`text-[10px] ${isStale(snapshot.timestamp, 60000) ? 'text-bear' : 'text-ink-mute'}`}>
              {dataAge(snapshot.timestamp)}
            </span>
            <span className="text-[10px] text-line-strong">•</span>
            <span className="text-[10px] text-ink-mute">{snapshot.sessionType}</span>
          </div>
        )}
      </div>

      {/* Tabs — scrollable */}
      <div className="flex border-b border-line flex-shrink-0 overflow-x-auto bg-app/30">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex-shrink-0 text-xs px-3 py-2.5 border-b-2 font-medium transition-colors ${activeTab === t.key ? 'border-accent text-ink' : 'border-transparent text-ink-mute hover:text-ink-soft'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {snapshotLoading && !snapshot && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-ink-mute text-sm animate-pulse">Loading analysis…</span>
        </div>
      )}
      {snapshotError && (
        <div className="px-4 py-2 text-xs text-bear bg-bear/5">{snapshotError}</div>
      )}

      {/* Chat tab renders regardless of snapshot so it can prompt user to select a ticker */}
      {activeTab === 'chat' && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <ChatTab snapshot={snapshot} symbol={selectedSymbol} />
        </div>
      )}

      {!snapshot && !snapshotLoading && activeTab !== 'chat' && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-ink-mute text-xs">Select a ticker to load analysis</span>
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
      <h3 className="eyebrow mb-2">{title}</h3>
      {children}
    </div>
  )
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-line/40 last:border-0">
      <span className="text-xs text-ink-mute">{label}</span>
      <span className={`text-xs tnum ${valueClass ?? 'text-ink-soft'}`}>{value}</span>
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
        <div className="card card-hi p-3 mb-3">
          <div className="flex items-center gap-3">
            <div className="text-[34px] leading-none font-bold text-ink tnum">{sc.total}<span className="text-sm text-ink-faint font-medium">/100</span></div>
            <div className="min-w-0">
              <div className={`text-xs font-semibold px-2 py-0.5 rounded-md inline-block ${STATUS_BG[sc.status] ?? 'bg-white/5 text-ink-soft'}`}>
                {sc.status}
              </div>
              <div className="text-xs text-ink-mute mt-1">{sc.classification}</div>
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
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
          <div className={`card text-xs px-2.5 py-2 ${BREAKOUT_COLORS[snap.breakoutStatus.state]}`}>
            <span className="font-semibold uppercase tracking-wide">{snap.breakoutStatus.state}</span>
            {snap.breakoutStatus.level && (
              <span className="ml-2 text-ink-soft tnum">@ ${snap.breakoutStatus.level.toFixed(2)}</span>
            )}
            <div className="mt-0.5 text-ink-soft font-normal">{snap.breakoutStatus.description}</div>
          </div>
          {snap.breakoutStatus.volumeConfirms && (
            <div className="text-xs text-bull mt-1.5">✓ Volume confirms</div>
          )}
        </Section>
      )}

      <Section title="Catalyst">
        <div className={`text-xs font-semibold mb-1 ${QUALITY_COLORS[snap.catalystQuality] ?? 'text-ink-mute'}`}>
          {snap.catalystQuality} — {snap.catalystCategory}
        </div>
        <p className="text-xs text-ink-soft leading-relaxed">{snap.catalystSummary}</p>
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
          <div className="card p-3">
            <div className="text-xs font-semibold text-accent-hi mb-1.5">{snap.pullbacks[0].name}</div>
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
  const color = pct >= 75 ? 'bg-bull' : pct >= 50 ? 'bg-warn' : 'bg-bear'
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[11px] text-ink-mute w-28 flex-shrink-0">{label}</span>
      <div className="flex-1 bg-app rounded-full h-1.5 ring-1 ring-inset ring-line/60 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-ink-soft w-9 text-right tnum">{value}/{max}</span>
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
        <div className="flex items-center gap-1.5 mb-2.5 text-[10px] text-bull">
          <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse inline-block" />
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
              className={`ring-focus flex-1 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                selected === l
                  ? 'bg-accent text-white shadow-[0_0_0_1px_var(--color-accent)]'
                  : isValid
                  ? 'bg-raised text-ink-soft ring-1 ring-inset ring-line hover:ring-ink-mute'
                  : 'bg-surface/50 text-ink-faint ring-1 ring-inset ring-line/60'
              }`}
            >
              Plan {l}
              <div className={`text-[9px] font-normal ${selected === l ? 'text-white/70' : 'text-ink-faint'}`}>
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
  const planTypeColor = plan.type === 'No-Trade' ? 'text-ink-mute' : plan.valid ? 'text-accent-hi' : 'text-ink-mute'
  return (
    <div className={`card p-3 ${plan.type === 'No-Trade' || !plan.valid ? 'opacity-90' : 'card-hi'}`}>
      <div className="flex items-center justify-between mb-2.5">
        <span className={`text-sm font-bold ${planTypeColor}`}>Plan {plan.label}: {plan.name}</span>
        {!plan.valid && plan.invalidReason && (
          <span className="text-[10px] font-semibold text-bear bg-bear/10 ring-1 ring-inset ring-bear/25 px-1.5 py-0.5 rounded">Invalid</span>
        )}
      </div>

      {!plan.valid && plan.invalidReason && (
        <div className="text-xs text-warn mb-2.5 bg-warn/8 ring-1 ring-inset ring-warn/20 px-2 py-1.5 rounded-md">
          ⚠ {plan.invalidReason}
        </div>
      )}

      {plan.type !== 'No-Trade' && (
        <>
          {/* Entry */}
          <div className="bg-app/60 ring-1 ring-inset ring-line rounded-md p-2 mb-2">
            <div className="eyebrow mb-1">Entry</div>
            {plan.entryLow && plan.entryHigh && (
              <div className="text-sm tnum text-ink">${plan.entryLow.toFixed(2)} – ${plan.entryHigh.toFixed(2)}</div>
            )}
            <div className="text-xs text-ink-soft mt-0.5">{plan.entryTrigger}</div>
          </div>

          {/* Risk */}
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div className="bg-app/60 ring-1 ring-inset ring-line rounded-md p-2">
              <div className="eyebrow mb-0.5">Stop</div>
              <div className="text-sm tnum text-bear">{fmt(plan.stopLoss)}</div>
            </div>
            <div className="bg-app/60 ring-1 ring-inset ring-line rounded-md p-2">
              <div className="eyebrow mb-0.5">Invalidation</div>
              <div className="text-sm tnum text-bear">{fmt(plan.invalidation)}</div>
            </div>
          </div>

          {/* Targets */}
          {plan.targets.length > 0 && (
            <div className="mb-2">
              <div className="eyebrow mb-1.5">Targets</div>
              <div className="space-y-1">
                {plan.targets.map((t, i) => (
                  <div key={i} className="flex items-center justify-between bg-app/60 ring-1 ring-inset ring-line rounded-md px-2 py-1">
                    <span className="text-xs text-ink-mute">{t.label}</span>
                    <span className="text-xs tnum text-bull">{fmt(t.price)}</span>
                    {t.rewardRisk && (
                      <span className="text-xs text-ink-mute tnum">{t.rewardRisk.toFixed(1)}:1</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Confirmation */}
          {plan.confirmation.length > 0 && (
            <div className="mb-2">
              <div className="eyebrow mb-1.5">Confirmation needed</div>
              {plan.confirmation.map((c, i) => (
                <div key={i} className="text-xs text-ink-soft flex items-start gap-1.5 py-0.5">
                  <span className="text-bull flex-shrink-0">✓</span><span>{c}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Ideal / avoid */}
      {plan.idealConditions.length > 0 && (
        <div className="mb-2">
          <div className="eyebrow mb-1.5">Ideal conditions</div>
          {plan.idealConditions.map((c, i) => (
            <div key={i} className="text-xs text-ink-soft flex items-start gap-1.5 py-0.5">
              <span className="text-accent flex-shrink-0">+</span><span>{c}</span>
            </div>
          ))}
        </div>
      )}
      {plan.avoidWhen.length > 0 && (
        <div className="mb-2">
          <div className="eyebrow mb-1.5">Avoid when</div>
          {plan.avoidWhen.map((c, i) => (
            <div key={i} className="text-xs text-ink-soft flex items-start gap-1.5 py-0.5">
              <span className="text-bear flex-shrink-0">−</span><span>{c}</span>
            </div>
          ))}
        </div>
      )}

      {/* Pullback label */}
      {plan.pullbackDepth && (
        <div className="text-xs text-accent-hi mt-1">
          Pullback depth: <span className="font-semibold">{plan.pullbackDepth}</span>
        </div>
      )}

      {plan.notes && (
        <div className="text-xs text-ink-mute mt-2 italic border-t border-line pt-2">{plan.notes}</div>
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
    <div className="card p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-accent-hi">{index + 1}. {p.name}</span>
        <span className={`text-xs font-semibold tnum ${confidenceColor}`}>{p.confidenceScore}%</span>
      </div>
      <div className="mb-2">
        <Row label="Entry zone" value={`$${p.entryZoneLow.toFixed(2)} – $${p.entryZoneHigh.toFixed(2)}`} />
        <Row label="Invalidation" value={fmt(p.invalidation)} valueClass="text-bear" />
        <Row label="Target 1" value={fmt(p.target1)} valueClass="text-bull" />
        <Row label="Target 2" value={fmt(p.target2)} valueClass="text-bull" />
        <Row label="R/R" value={p.rewardRisk ? `${p.rewardRisk.toFixed(1)}:1` : 'n/a'} />
        <Row label="Vol confirms" value={p.volumeConfirms ? 'Yes' : 'No'} />
        <Row label="Chasing" value={p.isChasing ? 'Yes ⚠️' : 'No'} />
      </div>
      <div className="text-xs text-ink-soft mb-1"><span className="text-ink-mute">Confirmation:</span> {p.confirmation}</div>
      <div className="text-xs text-ink-soft mb-1"><span className="text-ink-mute">Trigger:</span> {p.trigger}</div>
      {p.whatMakesStronger.length > 0 && (
        <div className="text-xs text-ink-mute">+ {p.whatMakesStronger.join(' · ')}</div>
      )}
      {p.whatMakesWeaker.length > 0 && (
        <div className="text-xs text-ink-mute">− {p.whatMakesWeaker.join(' · ')}</div>
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
  const typeColor = zone.type === 'support' ? 'text-bull' : zone.type === 'resistance' ? 'text-bear' : 'text-warn'
  // 5-tier strength label
  const strengthLabel =
    zone.strengthScore >= 9 ? 'Very Strong' :
    zone.strengthScore >= 7 ? 'Strong' :
    zone.strengthScore >= 5 ? 'Moderate' :
    zone.strengthScore >= 3 ? 'Weak' :
    'Very Weak'
  const strengthColor =
    zone.strengthScore >= 9 ? 'text-bull' :
    zone.strengthScore >= 7 ? 'text-warn' :
    zone.strengthScore >= 5 ? 'text-ink-soft' :
    'text-ink-mute'

  return (
    <div className="card p-2 mb-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className={`text-xs font-semibold tracking-wide ${typeColor}`}>{zone.type.toUpperCase()}</span>
        <div className="flex items-center gap-2 tnum">
          <span className={`text-xs ${strengthColor}`}>{strengthLabel} ({zone.strengthScore}/10)</span>
          <span className={`text-xs ${zone.status === 'testing' ? 'text-warn' : zone.status === 'failed' ? 'text-bear' : 'text-ink-mute'}`}>
            {zone.status}
          </span>
        </div>
      </div>
      <div className="text-xs text-ink tnum">
        ${zone.lower.toFixed(2)} – ${zone.upper.toFixed(2)}
        <span className="ml-2 text-ink-mute">({zone.priorReactions} reactions)</span>
      </div>
      <div className="text-xs text-ink-mute mt-0.5">{zone.reasons.join(' · ')}</div>
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
    <div className={`card p-3 ${n.isDilutive ? '!bg-bear/8 !ring-1 !ring-inset !ring-bear/25 !border-transparent' : ''}`}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className={`text-xs font-semibold leading-tight ${QUALITY_COLORS[n.quality] ?? 'text-ink-mute'}`}>
          {n.quality}
        </span>
        <span className="text-[10px] text-ink-mute flex-shrink-0 tnum">{n.age}</span>
      </div>
      <a href={n.url} target="_blank" rel="noopener noreferrer" className="text-xs text-ink-soft hover:text-ink leading-snug block mb-1.5 transition-colors">
        {n.title}
      </a>
      <div className="flex items-center gap-2 text-[11px] text-ink-mute">
        <span>{n.source}</span>
        {n.isDilutive && <span className="text-bear font-semibold">⚠️ DILUTION</span>}
        <span>{n.catalystCategory}</span>
      </div>
      {n.bullishElements.length > 0 && (
        <div className="text-xs text-bull/90 mt-1">+ {n.bullishElements.join(' · ')}</div>
      )}
      {n.bearishElements.length > 0 && (
        <div className="text-xs text-bear/90">− {n.bearishElements.join(' · ')}</div>
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
            <label className="eyebrow block mb-1">Account Size ($)</label>
            <input
              type="number"
              value={accountSize}
              onChange={e => setAccountSize(e.target.value)}
              className="ring-focus w-full bg-raised border border-line rounded-md px-2 py-1.5 text-xs text-ink tnum focus:border-accent focus:outline-none"
              placeholder="25000"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Max Risk (%)</label>
            <input
              type="number"
              value={maxRiskPct}
              onChange={e => setMaxRiskPct(e.target.value)}
              className="ring-focus w-full bg-raised border border-line rounded-md px-2 py-1.5 text-xs text-ink tnum focus:border-accent focus:outline-none"
              placeholder="1"
              step="0.1"
              min="0.1"
              max="5"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Entry Price ($)</label>
            <input
              type="number"
              value={entry}
              onChange={e => setEntry(e.target.value)}
              className="ring-focus w-full bg-raised border border-line rounded-md px-2 py-1.5 text-xs text-ink tnum focus:border-accent focus:outline-none"
              step="0.01"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Stop Loss ($)</label>
            <input
              type="number"
              value={stop}
              onChange={e => setStop(e.target.value)}
              className="ring-focus w-full bg-raised border border-line rounded-md px-2 py-1.5 text-xs text-ink tnum focus:border-accent focus:outline-none"
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
