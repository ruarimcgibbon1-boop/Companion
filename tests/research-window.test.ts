import { describe, it, expect } from 'vitest'
import {
  researchWindowDays, isHeldOut, isResearch, classifyDays, weekdaysBetween,
  RESEARCH_MONTH, HELDOUT_MONTH,
} from '../src/lib/research-window'

describe('research / held-out split', () => {
  it('July is research, August is held out', () => {
    expect(RESEARCH_MONTH).toBe('2026-07')
    expect(HELDOUT_MONTH).toBe('2026-08')
    expect(isResearch('2026-07-14')).toBe(true)
    expect(isHeldOut('2026-07-14')).toBe(false)
    expect(isHeldOut('2026-08-03')).toBe(true)
    expect(isResearch('2026-08-03')).toBe(false)
  })

  it('the research window is 20 July trading days, none held out', () => {
    const days = researchWindowDays()
    expect(days.length).toBe(20)
    expect(days.every(isResearch)).toBe(true)
    expect(days.some(isHeldOut)).toBe(false)
  })

  it('classifyDays separates research from held-out from other', () => {
    const { research, heldout, other } = classifyDays(['2026-07-06', '2026-08-03', '2026-09-01'])
    expect(research).toEqual(['2026-07-06'])
    expect(heldout).toEqual(['2026-08-03'])
    expect(other).toEqual(['2026-09-01'])
  })

  it('weekdaysBetween is an inclusive weekday span (skips the weekend)', () => {
    // 2026-07-10 is a Friday; 2026-07-13 is the next Monday.
    expect(weekdaysBetween('2026-07-10', '2026-07-13')).toEqual(['2026-07-10', '2026-07-13'])
  })
})
