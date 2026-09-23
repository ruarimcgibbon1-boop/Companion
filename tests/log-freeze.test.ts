/**
 * A resolved setup log must FREEZE.
 *
 * `updateLog` used to write the excursion metrics unconditionally, so every sweep
 * after a trade stopped out kept ratcheting maxFavorablePct upward. On 2026-08-13
 * FGI stopped at −6.5% and then ran roughly 100% — which logged a ~100% favorable
 * excursion against a trade we were not in, making a loss read like a missed
 * winner at review time. The trade is over; what price did afterwards is not part
 * of its record.
 */
import { describe, it, expect } from 'vitest'
import { updateLog } from '@/hooks/useMonitor'
import type { SetupLog, DetectedSetup, SetupStateRecord } from '@/types'

const NOW = new Date('2026-08-13T14:00:00Z').getTime()

function log(over: Partial<SetupLog> = {}): SetupLog {
  return {
    id: 'FGI:break_of_structure:8.30', symbol: 'FGI', type: 'break_of_structure',
    direction: 'long', outcome: 'open', outcomeReason: null,
    priceAtIdentification: 8.3, invalidation: 7.84,
    targets: [{ price: 8.7 }], statesReached: ['triggered'],
    maxFavorablePrice: 8.3, maxAdversePrice: 8.3,
    maxFavorablePct: 0, maxAdversePct: 0,
    identifiedAt: NOW, triggeredAt: NOW, resolvedAt: null,
    score: 62, grade: 'C',
    ...over,
  } as unknown as SetupLog
}

const setup = {
  direction: 'long', invalidation: 7.84, targets: [{ price: 8.7 }],
  score: 62, grade: 'C', testCount: 1,
} as unknown as DetectedSetup

const rec = (state: string) => ({ state }) as unknown as SetupStateRecord

describe('updateLog freeze-on-resolution', () => {
  it('still books the excursion on the sweep that RESOLVES the trade', () => {
    // The stop bar itself counts — matching eod-resolver, which walks up to and
    // including the stop bar before breaking.
    const out = updateLog(log(), setup, rec('failed'), 7.8, NOW)
    expect(out.outcome).toBe('invalidated')
    expect(out.maxAdversePrice).toBe(7.8)
  })

  it('FREEZES the excursion on every sweep AFTER resolution', () => {
    // FGI: stopped out, then ran to 16.60. The record must not follow it up.
    const stopped = log({
      outcome: 'invalidated', outcomeReason: 'Lost 7.84', resolvedAt: NOW,
      maxAdversePrice: 7.8, maxAdversePct: -6.0,
      maxFavorablePrice: 8.4, maxFavorablePct: 1.2,
    })
    const after = updateLog(stopped, setup, rec('failed'), 16.6, NOW + 60_000)
    expect(after.maxFavorablePrice).toBe(8.4)
    expect(after.maxFavorablePct).toBeCloseTo(1.2)
    expect(after.resolvedAt).toBe(NOW)
  })

  it('freezes a winner too — a target_hit does not keep growing', () => {
    const won = log({
      outcome: 'target_hit', resolvedAt: NOW,
      maxFavorablePrice: 8.7, maxFavorablePct: 4.8,
    })
    expect(updateLog(won, setup, rec('triggered'), 16.6, NOW + 60_000).maxFavorablePct)
      .toBeCloseTo(4.8)
  })

  it('does not let a later sweep re-open or re-label a resolved trade', () => {
    const stopped = log({ outcome: 'invalidated', outcomeReason: 'Lost 7.84', resolvedAt: NOW })
    const after = updateLog(stopped, setup, rec('triggered'), 8.9, NOW + 60_000)
    expect(after.outcome).toBe('invalidated')
    expect(after.outcomeReason).toBe('Lost 7.84')
  })

  it('still records a newly reached state on a resolved log', () => {
    // The state trail stays useful for review; only the RESULT is frozen.
    const stopped = log({ outcome: 'invalidated', resolvedAt: NOW, statesReached: ['triggered'] })
    expect(updateLog(stopped, setup, rec('failed'), 7.5, NOW + 60_000).statesReached)
      .toEqual(['triggered', 'failed'])
  })

  it('keeps tracking an OPEN trade normally', () => {
    const out = updateLog(log(), setup, rec('triggered'), 8.5, NOW)
    expect(out.outcome).toBe('open')
    expect(out.maxFavorablePrice).toBe(8.5)
    expect(out.maxFavorablePct).toBeCloseTo(2.41, 1)
  })
})
