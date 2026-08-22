/**
 * Chart position-overlay selection — pure, testable, no rendering.
 *
 * The chart draws at most ONE position overlay for the selected symbol, chosen by
 * a strict priority (Phase 2):
 *
 *   broker position for symbol  →  manual/local position  →  nothing
 *
 * Alpaca is authoritative for exposure, so a broker position always wins over a
 * manual tracker entry for the same symbol — never both (no duplicate entry/stop/
 * target lines). This module resolves that choice and normalises either source
 * into one descriptor the chart renders uniformly.
 *
 * The descriptor separates STRUCTURAL fields (entry/stop/targets/qty — the things
 * that define where lines sit) from LIVE fields (price/P&L — which change every
 * 2.5s broker poll). `structuralOverlayKey` hashes ONLY the structural fields, so
 * the chart effect can rebuild lines only when geometry actually changes and let
 * P&L update independently. See ChartPanel for how the key gates the rebuild.
 */
import type { BrokerPositionView, PositionSource, ReconciliationStatus } from '@/lib/execution/positions-view'
import type { Position } from '@/types'

export type OverlaySource = PositionSource | 'manual'

export interface OverlayTarget {
  label: string
  price: number
  /** Ledger/broker says this target actually completed — rendered dotted + ✓. */
  hit: boolean
}

export interface ChartPositionOverlay {
  kind: 'broker' | 'manual'
  source: OverlaySource
  symbol: string
  direction: 'long' | 'short'

  // ── Structural (define where lines sit; drive chart rebuild) ────────────────
  /** Broker avgEntryPrice for a broker overlay, or the manual entry. */
  entry: number
  /** True when `entry` is a real broker average fill (not an intended entry). */
  entryIsActualFill: boolean
  /** Remaining shares — broker qty is authoritative; manual uses tracker shares. */
  qty: number
  /** Companion/manual stop, or null for EXTERNAL/UNATTRIBUTED (no invented stop). */
  stop: number | null
  initialStop: number | null
  stopIsBreakeven: boolean
  /** Only true when a resting broker protective stop is actually recorded. */
  hasProtectiveStop: boolean
  /** Empty for EXTERNAL/UNATTRIBUTED — never invent Companion targets. */
  targets: OverlayTarget[]
  reconciliationStatus: ReconciliationStatus | null

  // ── Live (change constantly; must NOT drive chart rebuild) ──────────────────
  currentPrice: number | null
  unrealizedPnl: number | null
  unrealizedPnlPct: number | null
}

const BE_EPS = (entry: number) => Math.max(0.005, Math.abs(entry) * 0.001)

/** Whether a stop sits at breakeven (moved up to entry). */
function isBreakeven(stop: number | null, entry: number): boolean {
  return stop != null && Math.abs(stop - entry) <= BE_EPS(entry)
}

function fromBroker(p: BrokerPositionView): ChartPositionOverlay {
  const companion = p.source === 'companion'
  // EXTERNAL / UNATTRIBUTED carry exposure only — no Companion stop/targets/BE.
  const stop = companion ? p.currentStop : null
  const targets: OverlayTarget[] = []
  if (companion) {
    if (p.t1 != null) targets.push({ label: 'T1', price: p.t1, hit: p.targetState === 't1_hit' || p.targetState === 't2_hit' })
    if (p.t2 != null) targets.push({ label: 'T2', price: p.t2, hit: p.targetState === 't2_hit' })
  }
  return {
    kind: 'broker',
    source: p.source,
    symbol: p.symbol,
    direction: p.direction,
    entry: p.avgEntryPrice,
    entryIsActualFill: true,
    qty: p.qty,
    stop,
    initialStop: companion ? p.initialStop : null,
    stopIsBreakeven: companion && isBreakeven(stop, p.avgEntryPrice),
    hasProtectiveStop: companion && p.hasProtectiveStop,
    targets,
    reconciliationStatus: companion ? p.reconciliationStatus : null,
    currentPrice: p.currentPrice,
    unrealizedPnl: p.unrealizedPnl,
    unrealizedPnlPct: p.unrealizedPnlPct,
  }
}

function fromManual(p: Position): ChartPositionOverlay {
  return {
    kind: 'manual',
    source: 'manual',
    symbol: p.symbol,
    direction: p.direction,
    entry: p.entry,
    entryIsActualFill: false,
    qty: p.shares,
    stop: p.stop,
    initialStop: p.initialStop,
    stopIsBreakeven: isBreakeven(p.stop, p.entry),
    hasProtectiveStop: false,
    targets: p.targets.map(t => ({ label: t.label, price: t.price, hit: t.hit })),
    reconciliationStatus: null,
    currentPrice: p.currentPrice,
    unrealizedPnl: p.unrealizedPnl,
    unrealizedPnlPct: p.unrealizedPnlPct,
  }
}

/**
 * Pick the single overlay to draw for `symbol`, applying broker-over-manual
 * priority. Returns null when neither source has a position for the symbol (the
 * chart then shows setup overlays only).
 */
export function selectChartPosition(args: {
  symbol: string | null
  brokerPositions: BrokerPositionView[]
  manualPositions: Position[]
}): ChartPositionOverlay | null {
  const { symbol, brokerPositions, manualPositions } = args
  if (!symbol) return null
  const sym = symbol.toUpperCase()

  const broker = brokerPositions.find(p => p.symbol.toUpperCase() === sym)
  if (broker) return fromBroker(broker)   // broker truth wins — never also draw manual

  const manual = manualPositions.find(
    p => p.symbol.toUpperCase() === sym && p.status !== 'closed' && p.status !== 'stopped',
  )
  return manual ? fromManual(manual) : null
}

/**
 * A stable signature of ONLY the structural fields. Two overlays that differ just
 * in current price or P&L produce the SAME key, so the chart is not torn down and
 * rebuilt on every broker poll; a change in entry/qty/stop/target geometry DOES
 * change the key and triggers a rebuild. Null → '' (no overlay).
 */
export function structuralOverlayKey(o: ChartPositionOverlay | null): string {
  if (!o) return ''
  const n = (v: number | null) => (v == null ? '·' : v.toFixed(4))
  const targets = o.targets.map(t => `${t.label}${n(t.price)}${t.hit ? '✓' : ''}`).join(',')
  return [
    o.kind, o.source, o.direction,
    n(o.entry), o.qty, n(o.stop), n(o.initialStop),
    o.stopIsBreakeven ? 'be' : '', o.hasProtectiveStop ? 'prot' : '',
    targets, o.reconciliationStatus ?? '',
  ].join('|')
}
