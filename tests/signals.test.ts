import { describe, it, expect } from 'vitest'
import { deriveSignal } from '../src/lib/signals'
import type { DetectedSetup, SetupState, SetupDirection, SetupType } from '../src/types'

function setup(over: Partial<DetectedSetup> = {}): DetectedSetup {
  const base: Omit<DetectedSetup, 'signal'> = {
    id: 'X:pullback:5.00', symbol: 'XYZ', type: 'pullback' as SetupType,
    direction: 'long' as SetupDirection, state: 'triggered' as SetupState,
    score: 82, grade: 'A-',
    breakdown: { levelQuality: 16, priceAction: 12, volumeMomentum: 11, trendAlignment: 8, catalyst: 6, rewardRisk: 12, liquidity: 8, confirmation: 3 },
    zoneLower: 4.95, zoneUpper: 5.05, zoneMidpoint: 5.0,
    rationale: 'r', confirmation: ['hold above 5.05'], invalidation: 4.9, stopReference: 4.9,
    targets: [{ price: 5.3, label: 'T1', rewardRisk: 3 }, { price: 5.6, label: 'T2', rewardRisk: 5 }],
    rewardRisk: 3, distanceToZonePct: 0, distanceFromVwapPct: 2, distanceFromEma9Pct: 1, distanceFromEma21Pct: 2,
    approachThresholdPct: 1, testCount: 1, confidence: 80, risks: [], keyRisks: [], notes: '',
    nextIfHolds: 5.3, nextIfFails: 4.7,
  }
  return { ...base, signal: {} as DetectedSetup['signal'], ...over }
}

describe('deriveSignal', () => {
  it('a triggered long is a decisive BUY with entry, stop and sell targets', () => {
    const sig = deriveSignal(setup({ state: 'triggered', direction: 'long' }))
    expect(sig.action).toBe('buy')
    expect(sig.verb).toBe('BUY')
    expect(sig.urgency).toBe('now')
    expect(sig.headline).toMatch(/BUY XYZ/)
    expect(sig.headline).toMatch(/stop/i)
    expect(sig.headline).toMatch(/\$5\.30/)   // T1 as a sell target
    expect(sig.triggerPrice).toBe(5.05)        // reclaim the zone top
  })

  it('a triggered short is a decisive SELL / SHORT', () => {
    const sig = deriveSignal(setup({ state: 'triggered', direction: 'short', type: 'resistance_rejection', invalidation: 5.15 }))
    expect(sig.action).toBe('sell_short')
    expect(sig.verb).toBe('SELL / SHORT')
    expect(sig.triggerPrice).toBe(4.95)        // lose the zone bottom
    expect(sig.headline).toMatch(/SELL\/SHORT XYZ/)
  })

  it('a confirming long is PREP BUY (soon, not yet)', () => {
    const sig = deriveSignal(setup({ state: 'confirming' }))
    expect(sig.action).toBe('prep_buy')
    expect(sig.verb).toBe('PREP BUY')
    expect(sig.urgency).toBe('soon')
  })

  it('at the level is WAIT — do not chase', () => {
    const sig = deriveSignal(setup({ state: 'at_level' }))
    expect(sig.verb).toBe('WAIT')
    expect(sig.headline).toMatch(/WAIT/)
    expect(sig.headline).toMatch(/chase/i)
  })

  it('approaching is WATCH with distance and trigger condition', () => {
    const sig = deriveSignal(setup({ state: 'approaching', distanceToZonePct: -1.8 }))
    expect(sig.verb).toBe('WATCH')
    expect(sig.headline).toMatch(/1\.8% away/)
    expect(sig.triggerCondition).toMatch(/\$5\.05/)
  })

  it('a failed setup is AVOID and points to the next level', () => {
    const sig = deriveSignal(setup({ state: 'failed', nextIfFails: 4.72 }))
    expect(sig.action).toBe('avoid')
    expect(sig.verb).toBe('AVOID')
    expect(sig.headline).toMatch(/\$4\.72/)
  })

  it('formats sub-$1 prices with more precision', () => {
    const sig = deriveSignal(setup({
      state: 'triggered', zoneLower: 0.94, zoneUpper: 0.97, zoneMidpoint: 0.955,
      invalidation: 0.90, targets: [{ price: 1.03, label: 'T1', rewardRisk: 2 }],
    }))
    expect(sig.headline).toMatch(/\$0\.970/)   // 3 decimals under $1
  })
})
