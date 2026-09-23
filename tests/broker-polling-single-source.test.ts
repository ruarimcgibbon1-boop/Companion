/**
 * Proves the fix for the duplicate-poller defect found in pre-commit review:
 * useBrokerPositions() was being instantiated independently by both TopBar
 * (for the nav badge) and PositionTracker (for the drawer), so opening the
 * Positions drawer doubled the /api/paper/positions request rate.
 *
 * TopBar pulls in useMonitor/useEodResolution, which hit live snapshot/candle
 * endpoints on mount — too heavy to mount in a unit test (see
 * positions-nav-structure.test.ts) — so this is a structural/source-level
 * proof: there is exactly one call site that instantiates the poll loop
 * (useBrokerPositions()), and everything else consumes its result as a value,
 * never as an independent hook call. positions-drawer.test.tsx complements
 * this with a runtime proof that PositionTracker, given that value as a prop,
 * issues no /api/paper/positions fetch of its own.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const topBarSrc = readFileSync(join(__dirname, '../src/components/dashboard/TopBar.tsx'), 'utf8')
const positionTrackerSrc = readFileSync(join(__dirname, '../src/components/positions/PositionTracker.tsx'), 'utf8')

describe('single broker-position poller', () => {
  it('TopBar instantiates useBrokerPositions() exactly once', () => {
    const calls = topBarSrc.match(/useBrokerPositions\(\)/g) ?? []
    expect(calls).toHaveLength(1)
    expect(topBarSrc).toMatch(/const broker = useBrokerPositions\(\)/)
  })

  it('PositionTracker no longer imports or calls useBrokerPositions — it receives the feed as a prop', () => {
    // No value import of the hook, and no assignment-form call site anywhere
    // in the file (a prose comment may still mention the hook's name).
    expect(positionTrackerSrc).not.toMatch(/import\s*\{[^}]*\buseBrokerPositions\b[^}]*\}\s*from/)
    expect(positionTrackerSrc).not.toMatch(/=\s*useBrokerPositions\(\)/)
    // … only a type-only import of the state shape it renders.
    expect(positionTrackerSrc).toMatch(/import type \{ BrokerPositionsState \} from '@\/hooks\/useBrokerPositions'/)
    expect(positionTrackerSrc).toMatch(/export function PositionTracker\(\{ broker, onClose \}: \{ broker: BrokerPositionsState; onClose: \(\) => void \}\)/)
  })

  it('TopBar passes the SAME broker value to both the nav badge count and the drawer — one source of truth', () => {
    // The badge count is derived from `broker.positions.length` …
    expect(topBarSrc).toMatch(/openPositionsCount = broker\.positions\.length \+ manualOpenCount/)
    // … and the identical `broker` variable is threaded into the drawer.
    expect(topBarSrc).toMatch(/<PositionTracker broker=\{broker\} onClose=/)
  })

  it('the drawer is conditionally rendered but the poller (in TopBar) is not — exactly 1 active poller whether the drawer is open or closed', () => {
    // useBrokerPositions() is called unconditionally at TopBar's top level, not
    // inside the `positionsOpen &&` branch that gates the drawer.
    const pollerLine = topBarSrc.split('\n').find(l => l.includes('const broker = useBrokerPositions()'))
    const drawerLine = topBarSrc.split('\n').find(l => l.includes('positionsOpen && <PositionTracker'))
    expect(pollerLine).toBeDefined()
    expect(drawerLine).toBeDefined()
    expect(pollerLine).not.toMatch(/positionsOpen/)
  })
})
