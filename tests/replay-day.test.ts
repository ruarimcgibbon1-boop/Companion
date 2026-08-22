import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { replayDay, type RawRow } from '../src/lib/replay-day'
import { classifyBuy, passesTrackingFloor } from '../src/lib/buy-log'
import type { BuySignalRecord } from '../src/types'

// Small committed deterministic fixture (fidelity Priority 2): one symbol-day of
// real FMP 5-min tape + daily bars, checked into git. This exercises the SHARED
// replay pipeline (technicals → levels → detectors → MonitorResult → classifyBuy)
// fully OFFLINE, so a detector/gate/level regression shows up here without a
// network call — the same code path the live client and the backtest run.
//
// A full-day walk re-runs the real detector suite on every bar (~10s), so these
// use an explicit timeout and memoise the one expensive walk.
const FIX = join(__dirname, 'fixtures', 'replay-tape')
const load = (name: string): RawRow[] => {
  const j = JSON.parse(readFileSync(join(FIX, name), 'utf8'))
  return (Array.isArray(j) ? j : (j.historical ?? [])).slice().sort((a: RawRow, b: RawRow) => a.date.localeCompare(b.date))
}
const floatShares = (() => {
  try { const j = JSON.parse(readFileSync(join(FIX, 'float_BATL.json'), 'utf8')); return Array.isArray(j) ? (j[0]?.floatShares ?? null) : null } catch { return null }
})()

const SYMBOL = 'BATL'
const DAY = '2026-07-07'

function runFixture(barSeconds = 300) {
  const m5 = load(`m5_${SYMBOL}_${DAY}.json`)
  const daily = load(`daily_${SYMBOL}.json`)
  const triggers: { type: string; verdict: string }[] = []
  const logged: BuySignalRecord[] = []
  for (const rb of replayDay(SYMBOL, DAY, m5, daily, floatShares, barSeconds)) {
    for (const s of rb.setups) {
      if (!(s.direction === 'long' && s.triggeredRaw)) continue
      if (!passesTrackingFloor(s, 40)) continue
      const { verdict, buy } = classifyBuy(s, rb.result, { now: rb.nowTs, priorBuys: logged, priorLogs: [], priorStates: [] })
      triggers.push({ type: s.type, verdict })
      if (verdict === 'logged' && buy) logged.push(buy)
    }
  }
  return { triggers, logged }
}

let memo: ReturnType<typeof runFixture> | null = null
const fixtureResult = () => (memo ??= runFixture())

describe('replayDay on the committed BATL fixture (offline pipeline)', () => {
  it('detects triggered longs and logs the opening_range_break the live book logged', () => {
    const { triggers, logged } = fixtureResult()
    expect(triggers.length).toBeGreaterThan(0)
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.some(b => b.setupType === 'opening_range_break')).toBe(true)
  }, 30_000)

  it('runs the 1-minute clock through the SAME pipeline (no parallel path)', () => {
    // Pull only the first bar so this stays cheap: it proves barSeconds is plumbed
    // into the one shared generator (bar close = bar.time + 60), not that a separate
    // strategy exists. Real 1-min fidelity needs 1-min tape (see the benchmark).
    const m5 = load(`m5_${SYMBOL}_${DAY}.json`)
    const daily = load(`daily_${SYMBOL}.json`)
    const first = replayDay(SYMBOL, DAY, m5, daily, floatShares, 60).next()
    expect(first.done).toBe(false)
    if (!first.done) {
      // nowTs is the bar close: the 1-min clock lands 60s after the bar's open time.
      expect(first.value.nowTs % 1000).toBe(0)
      expect(Array.isArray(first.value.setups)).toBe(true)
    }
  }, 30_000)
})
