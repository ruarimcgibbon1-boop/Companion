/**
 * H3B — tracking-floor observability (Step 11) + H3A funnel intact.
 * The daemon emits a `tracking_floor` funnel event for a raw trigger that fails
 * passesTrackingFloor (previously dropped silently). We assert the boundary decision
 * (passesTrackingFloor) and the event's schema/joinability.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { passesTrackingFloor, DISPLAY_FLOOR_SCORE } from '../src/lib/buy-log'
import { emitFunnel, __resetFunnelCountersForTest, type SweepContext } from '../src/lib/telemetry/funnel'
import type { DetectedSetup } from '../src/types'

const setup = (o: { score?: number; levelQuality?: number; confidence?: number }): DetectedSetup =>
  ({ id: 'AAA:breakout:9.00', symbol: 'AAA', type: 'breakout', score: o.score ?? 40,
     confidence: o.confidence ?? 0, breakdown: { levelQuality: o.levelQuality ?? 1 } } as unknown as DetectedSetup)

describe('H3B tracking-floor boundary + event', () => {
  // Rule: score>=55 OR (levelQuality/20*100 >= minLevelStrength*0.2) OR confidence>=minLevelStrength.
  const MIN_LEVEL_STRENGTH = 40
  it('a below-score, weak-level, low-confidence setup fails the tracking floor', () => {
    expect(passesTrackingFloor(setup({ score: 40, levelQuality: 1, confidence: 0 }), MIN_LEVEL_STRENGTH)).toBe(false) // 5% < 8%
    // any one of the three clears it
    expect(passesTrackingFloor(setup({ score: DISPLAY_FLOOR_SCORE }), MIN_LEVEL_STRENGTH)).toBe(true)
    expect(passesTrackingFloor(setup({ score: 40, levelQuality: 4, confidence: 0 }), MIN_LEVEL_STRENGTH)).toBe(true)  // 20% >= 8%
    expect(passesTrackingFloor(setup({ score: 40, levelQuality: 1, confidence: 40 }), MIN_LEVEL_STRENGTH)).toBe(true) // confidence
  })

  describe('event schema', () => {
    let dir: string
    const ctx: SweepContext = { sweepId: 'sw-tf', producerHead: 'h' }
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tf-')); process.env.COMPANION_FUNNEL_DIR = dir; __resetFunnelCountersForTest() })
    afterEach(() => { delete process.env.COMPANION_FUNNEL_DIR; rmSync(dir, { recursive: true, force: true }) })
    it('tracking_floor event carries symbol/setupId/observed/rule/result and joins by sweepId+setupId', () => {
      emitFunnel(ctx, 'tracking_floor', {
        symbol: 'AAA', strategyId: 'BASE', setupId: 'AAA:breakout:9.00', setupType: 'breakout',
        triggeredRaw: true, observed: { score: 40, levelStrength: 20 },
        rule: { displayFloorScore: DISPLAY_FLOOR_SCORE, minLevelStrength: 40 }, result: 'FAIL', reason: 'below_tracking_floor',
      })
      const f = readdirSync(dir)[0]
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf8').trim())
      expect(rec.eventType).toBe('tracking_floor')
      expect(rec.sweepId).toBe('sw-tf')
      expect(rec.setupId).toBe('AAA:breakout:9.00')
      expect(rec.result).toBe('FAIL')
      expect(rec.reason).toBe('below_tracking_floor')
      expect(rec.observed.score).toBe(40)
    })
  })
})
