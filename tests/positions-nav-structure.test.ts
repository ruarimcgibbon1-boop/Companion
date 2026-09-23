/**
 * Structural checks for the nav reshuffle (Positions moved from a persistent
 * bottom dock into a top-right tab). TopBar pulls in useMonitor/useEodResolution,
 * which hit live snapshot/candle endpoints on mount — too heavy to render in a
 * unit test — so these assertions read the source directly, the same way a
 * reviewer would confirm "is Positions in the nav, in the right order, and is
 * the bottom dock gone" without booting the whole dashboard.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const topBarSrc = readFileSync(join(__dirname, '../src/components/dashboard/TopBar.tsx'), 'utf8')
const pageSrc = readFileSync(join(__dirname, '../src/app/page.tsx'), 'utf8')

describe('TopBar nav', () => {
  it('renders Opportunities, Continuation, Positions, Journal, Alerts in that order', () => {
    const idx = {
      opportunities: topBarSrc.indexOf('Opportunities'),
      continuation: topBarSrc.indexOf('Continuation'),
      positions: topBarSrc.indexOf('>\n          Positions'),
      journal: topBarSrc.indexOf('>\n          Journal'),
      alerts: topBarSrc.indexOf('<AlertsDrawer'),
    }
    expect(Object.values(idx).every(i => i !== -1)).toBe(true)
    expect(idx.opportunities).toBeLessThan(idx.continuation)
    expect(idx.continuation).toBeLessThan(idx.positions)
    expect(idx.positions).toBeLessThan(idx.journal)
    expect(idx.journal).toBeLessThan(idx.alerts)
  })

  it('shows a count badge on the Positions tab when positions are open', () => {
    expect(topBarSrc).toMatch(/openPositionsCount > 0/)
  })

  it('renders PositionTracker as a dismissible drawer, not an always-on element', () => {
    expect(topBarSrc).toMatch(/positionsOpen && <PositionTracker broker=\{broker\} onClose=/)
  })
})

describe('bottom Positions dock removal', () => {
  it('page.tsx no longer imports or renders PositionTracker at the bottom of the dashboard', () => {
    expect(pageSrc).not.toMatch(/import\s*\{\s*PositionTracker/)
    expect(pageSrc).not.toMatch(/<PositionTracker/)
  })

  it('page.tsx still renders the other three panels untouched', () => {
    expect(pageSrc).toMatch(/<ScannerPanel/)
    expect(pageSrc).toMatch(/<ChartPanel/)
    expect(pageSrc).toMatch(/<CompanionPanel/)
  })
})
