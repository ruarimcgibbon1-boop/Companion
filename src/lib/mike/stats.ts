/**
 * MIKE'S STRATEGY — separate performance aggregation (v0.2).
 *
 * Aggregates ONLY Mike records. It never reads REGULAR trades/logs, so Mike and
 * REGULAR aggregates can never be mixed. v0.2 statistics are outcome-based (shadow
 * resolved), because Mike places no orders yet; real-fill P&L/R arrive with the
 * execution follow-up and will be attributed `strategy: 'mike'` in their own files.
 */
import type { MikeCandidate, MikeVetoReason } from './types'
import type { MikeShadowRow } from './store'

export interface MikeStats {
  total: number
  byState: Record<string, number>
  byOutcome: Record<string, number>
  vetoReasons: Record<string, number>
  triggered: number
  /** Of TRADED candidates whose shadow resolved: hit-rate to +10% / +15%. */
  tradedHit10Rate: number | null
  tradedHit15Rate: number | null
  tradedRunnerRate: number | null
  /**
   * Veto save rate: of resolved vetoed candidates, the fraction whose shadow did NOT
   * reach +10% — i.e. the veto correctly avoided a non-runner.
   */
  vetoSaveRate: number | null
  /**
   * Veto false-negative rate: of resolved vetoed candidates, the fraction that DID
   * reach +15% (a runner Mike passed on).
   */
  vetoFalseNegativeRate: number | null
  /** Outcome breakdown per veto reason: how often each reason's shadow hit +10 / +15. */
  outcomeByVetoReason: Record<string, { n: number; hit10: number; hit15: number }>
}

const rate = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null)

/**
 * @param candidates Mike candidates for the window (already Mike-only).
 * @param shadows    Resolved shadow rows keyed by symbol+level (best effort join).
 */
export function aggregateMike(candidates: MikeCandidate[], shadows: MikeShadowRow[]): MikeStats {
  const byState: Record<string, number> = {}
  const byOutcome: Record<string, number> = {}
  const vetoReasons: Record<string, number> = {}
  for (const c of candidates) {
    byState[c.state] = (byState[c.state] ?? 0) + 1
    byOutcome[c.outcome] = (byOutcome[c.outcome] ?? 0) + 1
    if (c.veto) vetoReasons[c.veto.reason] = (vetoReasons[c.veto.reason] ?? 0) + 1
  }

  const resolved = shadows.filter(s => s.shadow.resolved)
  const traded = resolved.filter(s => s.outcome === 'TRADED')
  const vetoed = resolved.filter(s => s.outcome === 'VETOED' || s.outcome === 'EXPIRED')

  const outcomeByVetoReason: MikeStats['outcomeByVetoReason'] = {}
  for (const s of vetoed) {
    const key: MikeVetoReason | 'UNKNOWN' = (s.vetoReason as MikeVetoReason) ?? 'UNKNOWN'
    const b = (outcomeByVetoReason[key] ??= { n: 0, hit10: 0, hit15: 0 })
    b.n++
    if (s.shadow.hit10) b.hit10++
    if (s.shadow.hit15) b.hit15++
  }

  return {
    total: candidates.length,
    byState, byOutcome, vetoReasons,
    triggered: byState['TRIGGERED'] ?? 0,
    tradedHit10Rate: rate(traded.filter(s => s.shadow.hit10).length, traded.length),
    tradedHit15Rate: rate(traded.filter(s => s.shadow.hit15).length, traded.length),
    tradedRunnerRate: rate(traded.filter(s => s.shadow.reachedRunner).length, traded.length),
    vetoSaveRate: rate(vetoed.filter(s => !s.shadow.hit10).length, vetoed.length),
    vetoFalseNegativeRate: rate(vetoed.filter(s => s.shadow.hit15).length, vetoed.length),
    outcomeByVetoReason,
  }
}
