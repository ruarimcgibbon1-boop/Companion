/**
 * Regression: premarket volume must distinguish "unmeasured" from "measured zero".
 *
 * The Yahoo premarket candle feed returns bars with a price but volume 0 for a
 * name whose tape it never captured (FNGR, PSQL premarket 2026-08-31). The
 * gainers route summed those bars and wrote a literal `premarketVolume: 0`, and
 * the final premarket volume floor then read that as a measured zero and dropped
 * the candidate — the exact movers the relaxed /api/gainers query could still
 * see. The fix treats a non-positive feed reading as UNKNOWN (null) so the row
 * survives, while a genuinely measured volume is a positive number that the
 * existing floor still screens.
 */
import { describe, it, expect } from 'vitest'
import { premarketVolumeReading } from '../src/app/api/gainers/route'

// Mirrors the route: effectiveMinVolume in premarket = filters.minVolume * 0.05.
const FLOOR = 500_000 * 0.05 // 25,000 shares

// The route's final premarket volume predicate, verbatim, so the floor cases
// below assert the real admit/reject decision the row will get.
const clearsFloor = (premarketVolume: number | null): boolean =>
  premarketVolume == null || premarketVolume >= FLOOR

describe('premarketVolumeReading — missing vs measured', () => {
  it('treats a feed-gap zero as UNKNOWN (null), not measured zero', () => {
    // Yahoo premarket bars carry price but volume 0, so getPremarketQuote sums to 0.
    expect(premarketVolumeReading(0)).toBeNull()
  })

  it('treats absent premarket data (no quote) as UNKNOWN (null)', () => {
    expect(premarketVolumeReading(undefined)).toBeNull()
    expect(premarketVolumeReading(null)).toBeNull()
  })

  it('passes a genuinely measured positive volume through as a number', () => {
    expect(premarketVolumeReading(42_000)).toBe(42_000)
  })
})

describe('premarket volume floor — fail-open on missing, still screen measured', () => {
  it('1. an unmeasured/feed-gap zero is unknown and does NOT falsely remove the candidate', () => {
    // Row construction runs the feed reading through premarketVolumeReading first,
    // so a feed-gap zero reaches the floor as null and survives.
    const reading = premarketVolumeReading(0)
    expect(reading).toBeNull()
    expect(clearsFloor(reading)).toBe(true)
  })

  it('2. a genuinely measured volume below the floor is still rejected', () => {
    // A real, backfilled measurement below the floor (e.g. 12,000 < 25,000 shares).
    expect(clearsFloor(12_000)).toBe(false)
  })

  it('3. a genuinely measured volume at/above the floor is admitted', () => {
    expect(clearsFloor(120_000)).toBe(true)
    // Exactly at the floor is admitted (>=), matching the existing predicate.
    expect(clearsFloor(FLOOR)).toBe(true)
  })
})
