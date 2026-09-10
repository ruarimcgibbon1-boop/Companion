// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MikePanel } from '../src/components/mike/MikePanel'
import type { MikeCandidate, MikeState } from '../src/lib/mike/types'

function cand(over: Partial<MikeCandidate> = {}): MikeCandidate {
  return {
    strategy: 'mike', symbol: 'ABCD', session: 'regular', now: 0, state: 'ACCEPTED' as MikeState,
    outcome: 'PENDING', price: 5.2,
    breakoutLevel: { price: 5.0, type: 'hod', establishedAt: 0, confidence: 60 },
    loadingZone: { low: 5.0, high: 5.5 },
    acceptance: { accepted: true, candleTime: 0 },
    maxExcursionAbovePct: 4,
    hardGates: { fiveMinAcceptance: true, noImmediateRejection: true, withinLoadingCeiling: true },
    supporting: { higherLowAboveLevel: true, expandingVolume: false, continuedMomentum: true, secondCandleHolds: true, vwapSupport: false, emaSupport: false },
    supportingCount: 3, supportingRequired: 2, stop: null, tradePlan: null, veto: null,
    indicators: { vwap: 4.9, ema9: 5.0, ema21: 4.8, rvol: 3 },
    ...over,
  }
}

afterEach(cleanup)

describe('MikePanel', () => {
  it('is labelled MIKE and visually distinct', () => {
    render(<MikePanel candidate={cand()} />)
    expect(screen.getByText('MIKE')).toBeTruthy()
    expect(screen.getByTestId('mike-panel')).toBeTruthy()
  })

  it('shows a waiting-acceptance state', () => {
    render(<MikePanel candidate={cand({ state: 'WAITING_5M_ACCEPTANCE', acceptance: { accepted: false, candleTime: null } })} />)
    expect(screen.getByTestId('mike-state').textContent).toContain('WAITING 5M ACCEPTANCE')
  })

  it('shows break level, loading zone and confirmations when accepted', () => {
    render(<MikePanel candidate={cand({ state: 'ACCEPTED', supportingCount: 3 })} />)
    expect(screen.getByText('Break level $5.00')).toBeTruthy()
    expect(screen.getByText('Loading zone $5.00–$5.50')).toBeTruthy()
    expect(screen.getByTestId('mike-confirmations').textContent).toContain('3/6')
  })

  it('shows a veto reason distinctly', () => {
    render(<MikePanel candidate={cand({
      state: 'VETOED', outcome: 'VETOED',
      veto: { reason: 'REJECTED_BREAKOUT', snapshot: {
        symbol: 'ABCD', time: 0, breakoutLevel: 5.0, price: 4.9, maxExcursionAbovePct: 1, acceptance: true,
        supporting: cand().supporting, supportingCount: 0,
        hardGates: { fiveMinAcceptance: true, noImmediateRejection: false, withinLoadingCeiling: true },
        failedConditions: ['closed back below'], indicators: cand().indicators, session: 'regular',
      } },
    })} />)
    expect(screen.getByTestId('mike-state').textContent).toContain('VETOED — REJECTED_BREAKOUT')
  })
})
