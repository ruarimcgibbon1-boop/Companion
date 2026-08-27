import { describe, it, expect } from 'vitest'
import { collectDayFills, etDayBoundsMs, type FillPage, type RawFillActivity } from '@/lib/research/alpaca-fills'

const DAY = '2026-08-27'
const { startMs, endMs } = etDayBoundsMs(DAY)
const inWindowIso = new Date(startMs + 10 * 3_600_000).toISOString() // ~10h into the ET day

function act(i: number, over: Partial<RawFillActivity> = {}): RawFillActivity {
  return { id: `a${i}`, order_id: `o${i}`, symbol: 'CRWD', side: 'buy', qty: 1, price: 100, transaction_time: inWindowIso, ...over }
}

/** Pager over a fixed array of activities, page_size 100, cursor = last id. */
function pagerOf(all: RawFillActivity[], pageSize = 100) {
  return async (token: string | null): Promise<FillPage> => {
    const start = token ? all.findIndex(a => a.id === token) + 1 : 0
    const rows = all.slice(start, start + pageSize)
    const nextPageToken = rows.length === pageSize ? rows[rows.length - 1].id : null
    return { rows, nextPageToken }
  }
}

describe('collectDayFills — pagination beyond the first 100 (Finding 1)', () => {
  it('reads ALL 250 activities across 3 pages, including fills after page 1', async () => {
    const all = Array.from({ length: 250 }, (_, i) => act(i))
    // A relevant fill only reachable on page 3 (index 240).
    all[240] = act(240, { order_id: 'DEEP', symbol: 'FWDI', side: 'sell', qty: 2711, price: 6.73 })
    const r = await collectDayFills({ day: DAY, fetchPage: pagerOf(all) })
    expect(r.complete).toBe(true)
    expect(r.pages).toBe(3)
    expect(r.fills).toHaveLength(250)
    expect(r.fills.some(f => f.orderId === 'DEEP' && f.qty === 2711)).toBe(true)
  })

  it('excludes out-of-window activities (other ET days) but keeps in-window', async () => {
    const all = [
      act(1, { transaction_time: new Date(startMs - 3_600_000).toISOString() }), // prev day
      act(2, { transaction_time: inWindowIso }),                                  // in window
      act(3, { transaction_time: new Date(endMs + 3_600_000).toISOString() }),    // next day
    ]
    const r = await collectDayFills({ day: DAY, fetchPage: pagerOf(all) })
    expect(r.complete).toBe(true)
    expect(r.fills).toHaveLength(1)
    expect(r.outOfWindow).toBe(2)
  })

  it('FAILS CLOSED (complete=false) when a page fetch throws', async () => {
    const all = Array.from({ length: 150 }, (_, i) => act(i))
    let calls = 0
    const flaky = async (token: string | null): Promise<FillPage> => {
      calls++
      if (calls === 2) throw new Error('network reset')
      return pagerOf(all)(token)
    }
    const r = await collectDayFills({ day: DAY, fetchPage: flaky })
    expect(r.complete).toBe(false)
    expect(r.incompleteReason).toMatch(/fetch failed/)
    // Page-1 fills are still returned, never dropped.
    expect(r.fills.length).toBe(100)
  })

  it('FAILS CLOSED when maxPages is hit before the cursor is exhausted', async () => {
    const all = Array.from({ length: 500 }, (_, i) => act(i))
    const r = await collectDayFills({ day: DAY, fetchPage: pagerOf(all), maxPages: 2 })
    expect(r.complete).toBe(false)
    expect(r.incompleteReason).toMatch(/maxPages/)
  })
})

describe('etDayBoundsMs', () => {
  it('spans exactly one ET day (~24h in August EDT)', () => {
    const { startMs, endMs } = etDayBoundsMs('2026-08-27')
    expect((endMs - startMs) / 3_600_000).toBeCloseTo(24, 5)
  })
})
