/**
 * Price roadmap engine.
 *
 * For a monitored stock, produces the most likely sequence of reaction points
 * above and below current price, each annotated with why it matters, the setup
 * that could occur there, the confirmation needed, what invalidates it, and
 * where price likely goes next if it holds vs fails.
 */

import type {
  KeyLevel, PriceRoadmap, RoadmapLevel, SetupType,
} from '@/types'
import { SETUP_TYPE_LABELS } from '@/types'

function expectedSetupText(l: KeyLevel): { setup: SetupType | null; text: string } {
  const setup = l.expectedSetup
  if (!setup) return { setup: null, text: 'reaction likely' }
  return { setup, text: SETUP_TYPE_LABELS[setup] }
}

function confirmationFor(l: KeyLevel): string {
  switch (l.expectedSetup) {
    case 'breakout': return 'Candle close above with volume expansion, then a hold on retest'
    case 'pullback': return 'Selling volume contracts, higher low forms, reclaim of the zone top'
    case 'vwap_bounce': return 'Buyers defend VWAP; higher low and hold above'
    case 'vwap_reclaim': return 'Close back above VWAP and hold on the retest'
    case 'ema9_bounce': return 'Reaction and hold at the 9 EMA with limited selling'
    case 'ema21_bounce': return 'Higher low into the 21 EMA with trend intact'
    case 'resistance_rejection': return 'Upper rejection wick / lower high, then loss of the level'
    case 'support_breakdown': return 'Decisive close below with expanding sell volume'
    default: return 'Wait for a clear reaction before acting'
  }
}

function buildRoadmapLevel(l: KeyLevel, currentPrice: number, side: 'up' | 'down'): RoadmapLevel {
  const { setup } = expectedSetupText(l)
  const distancePct = ((l.midpoint - currentPrice) / currentPrice) * 100
  const label = l.sourceLabels.slice(0, 2).join(' + ')
  const isResistance = l.kind === 'resistance'

  const ifHolds = side === 'up'
    ? (isResistance ? 'Rejection here → rotate back down toward the next support' : 'Acts as a shelf → continuation higher')
    : (l.kind === 'support' ? 'Bounce here → rotate back up toward the next resistance' : 'Caps price → further downside')
  const ifFails = side === 'up'
    ? 'Break and hold → next resistance becomes the target'
    : 'Loses the level → next support below comes into play'

  return {
    price: l.midpoint,
    zoneLower: l.lower,
    zoneUpper: l.upper,
    label: label || (isResistance ? 'Resistance' : 'Support'),
    why: `${l.sourceLabels.join(', ')}${l.touches ? ` · ${l.touches} touch(es)` : ''}${l.hasConfluence ? ' · confluence' : ''}`,
    possibleSetup: setup,
    confirmationNeeded: confirmationFor(l),
    invalidation: side === 'up'
      ? `Sustained trade above $${l.upper.toFixed(2)} negates rejection`
      : `Sustained trade below $${l.lower.toFixed(2)} negates the bounce`,
    ifHolds,
    ifFails,
    strength: l.strength,
    distancePct,
  }
}

export function buildRoadmap(symbol: string, currentPrice: number, levels: KeyLevel[]): PriceRoadmap {
  const above = levels
    .filter(l => l.midpoint > currentPrice * 1.001)
    .sort((a, b) => a.midpoint - b.midpoint)
    .slice(0, 5)
    .map(l => buildRoadmapLevel(l, currentPrice, 'up'))

  const below = levels
    .filter(l => l.midpoint < currentPrice * 0.999)
    .sort((a, b) => b.midpoint - a.midpoint)
    .slice(0, 5)
    .map(l => buildRoadmapLevel(l, currentPrice, 'down'))

  return {
    symbol,
    currentPrice,
    upside: above,
    downside: below,
    updatedAt: Date.now(),
  }
}
