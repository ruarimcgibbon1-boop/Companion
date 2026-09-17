/**
 * H3B — funnel v1 additive/open-world compatibility (red-team §5).
 *
 * H3B keeps FUNNEL_SCHEMA_VERSION = 1 and only ADDS: a `tracking_floor` eventType and extra
 * `discovery_observed` fields. Prove every existing H3A reader (assessFunnelCompleteness,
 * splitFunnelSessions, assessRun) tolerates the new event type and unknown fields without
 * throwing, dropping a file, or misclassifying completeness.
 */
import { describe, it, expect } from 'vitest'
import { assessFunnelCompleteness, splitFunnelSessions, assessRun, FUNNEL_SCHEMA_VERSION } from '../src/lib/telemetry/funnel'

const summary = (o: Record<string, unknown> = {}) =>
  ({ eventType: 'session_observability_summary', schemaVersion: 1, cleanClose: true, droppedTotal: 0, degradedEver: false, ...o })

describe('H3B funnel v1 additive compatibility', () => {
  it('schema version is unchanged (v1)', () => {
    expect(FUNNEL_SCHEMA_VERSION).toBe(1)
  })

  it('H3A readers treat the new tracking_floor event as an ordinary (ignored) event', () => {
    const events = [
      { eventType: 'sweep_started', schemaVersion: 1 },
      { eventType: 'tracking_floor', schemaVersion: 1, symbol: 'AAA', result: 'FAIL' },  // NEW event
      { eventType: 'gate_evaluation', schemaVersion: 1 },
      summary(),
    ]
    // does not throw; a clean run with a tracking_floor is still COMPLETE
    expect(assessFunnelCompleteness(events)).toBe('COMPLETE')
    expect(splitFunnelSessions(events)).toHaveLength(1)
  })

  it('unknown/additional discovery_observed fields are ignored (open-world)', () => {
    const events = [
      { eventType: 'sweep_started', schemaVersion: 1 },
      // enriched discovery event with fields a v1 reader never knew about
      { eventType: 'discovery_observed', schemaVersion: 1, symbols: [
        { symbol: 'A', sources: [{ source: 'fmp', rank: 1, changePct: 50 }], winningSource: 'fmp',
          exclusionReason: null, pre60Rank: 1, survived60: true, pre30Rank: 1, survived30: true, routeRank: 1 }] },
      summary({ someFutureField: 'x' }),   // even an unknown field on the summary
    ]
    expect(() => assessFunnelCompleteness(events)).not.toThrow()
    expect(assessFunnelCompleteness(events)).toBe('COMPLETE')
  })

  it('a tracking_floor-only trailing run (no summary) is still INCOMPLETE, not mis-certified', () => {
    const events = [summary(), { eventType: 'tracking_floor', schemaVersion: 1 }]  // new run started, no close
    expect(assessFunnelCompleteness(events)).toBe('INCOMPLETE')
    // and the degraded/gap/continued semantics are untouched
    expect(assessRun([...events, summary({ droppedTotal: 2 })])).toBe('DEGRADED_COMPLETE')
  })
})
