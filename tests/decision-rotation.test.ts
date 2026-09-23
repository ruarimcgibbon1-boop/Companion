import { describe, it, expect } from 'vitest'
import { decisionsFile, etDayKey } from '@/lib/execution/store'

/**
 * The daemon derives the decision-log path from `decisionsFile(etDayKey(now))` at
 * APPEND time (not once at startup), so a continuously-running process rolls to the
 * next ET-day file across midnight WITHOUT a restart. This proves the path function
 * rotates on the timestamp alone.
 */
describe('ET-day decision-log rotation (no restart)', () => {
  // 2026-08-19 23:30 ET  and  2026-08-20 00:30 ET straddle ET midnight.
  const beforeEtMidnight = Date.parse('2026-08-20T03:30:00Z')  // 23:30 ET on the 19th
  const afterEtMidnight = Date.parse('2026-08-20T04:30:00Z')   // 00:30 ET on the 20th

  it('rolls to a new file across ET midnight for the SAME running process', () => {
    const before = decisionsFile(etDayKey(beforeEtMidnight))
    const after = decisionsFile(etDayKey(afterEtMidnight))
    expect(before).toMatch(/\.companion-decisions-2026-08-19\.jsonl$/)
    expect(after).toMatch(/\.companion-decisions-2026-08-20\.jsonl$/)
    expect(before).not.toBe(after)
  })

  it('an afterhours decision past UTC midnight stays on the correct ET day', () => {
    // 2026-08-20T01:30:00Z == 2026-08-19 21:30 ET — must NOT spill into the 20th.
    const afterhours = Date.parse('2026-08-20T01:30:00Z')
    expect(etDayKey(afterhours)).toBe('2026-08-19')
    expect(decisionsFile(etDayKey(afterhours))).toMatch(/2026-08-19\.jsonl$/)
  })

  it('a premarket decision (before UTC rollover) is on the same ET day as its RTH', () => {
    const premarket = Date.parse('2026-08-19T11:00:00Z')  // 07:00 ET
    const rth = Date.parse('2026-08-19T14:00:00Z')        // 10:00 ET
    expect(etDayKey(premarket)).toBe(etDayKey(rth))
  })
})
