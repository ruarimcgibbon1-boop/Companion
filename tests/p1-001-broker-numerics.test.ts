/**
 * P1-001 — INVALID BROKER NUMERICS (remediated).
 *
 * Safe design: ZERO is valid data; UNKNOWN/INVALID is not zero. The adapter now fails CLOSED
 * on malformed/missing REQUIRED numerics (throws BrokerDataError rather than return a
 * fabricated 0), maps ABSENT optional numerics to null, and throws on MALFORMED optional
 * numerics. Genuine numeric zero ('0', 0, '0.0') is preserved.
 *
 * Exercises the REAL AlpacaBroker adapter with a stubbed fetch — no network.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AlpacaBroker, BrokerDataError } from '@/lib/execution/alpaca'

const broker = () => new AlpacaBroker({ keyId: 'k', secretKey: 's' })

function stubFetchJson(body: unknown, ok = true, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  })) as unknown as typeof fetch)
}

/**
 * Malformed/missing variants that must NEVER become a fabricated numeric 0 for a REQUIRED
 * field. Non-finite values are given as STRINGS ('NaN', 'Infinity') because Alpaca returns
 * every numeric as a string, and because JSON transport turns a raw JS NaN/Infinity into null.
 */
const REQUIRED_INVALID: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ["'' (empty)", ''],
  ["'   ' (whitespace)", '   '],
  ["'abc'", 'abc'],
  ["'NaN'", 'NaN'],
  ["'Infinity'", 'Infinity'],
  ["'-Infinity'", '-Infinity'],
]

afterEach(() => { vi.unstubAllGlobals() })

describe('P1-001 broker numerics — required fields fail closed', () => {
  describe('position qty (getPosition) rejects malformed instead of fabricating flat 0', () => {
    for (const [label, value] of REQUIRED_INVALID) {
      it(`qty=${label} → throws`, async () => {
        stubFetchJson({ symbol: 'TEST', qty: value, avg_entry_price: '10', qty_available: '0', unrealized_pl: '0' })
        await expect(broker().getPosition('TEST')).rejects.toBeInstanceOf(BrokerDataError)
      })
    }
  })

  describe('order qty / filledQty (getOrder) reject malformed', () => {
    for (const [label, value] of REQUIRED_INVALID) {
      it(`filled_qty=${label} → throws`, async () => {
        stubFetchJson({ id: 'o1', symbol: 'TEST', side: 'buy', status: 'filled', qty: '100', filled_qty: value, filled_avg_price: '10' })
        await expect(broker().getOrder('o1')).rejects.toBeInstanceOf(BrokerDataError)
      })
      it(`qty=${label} → throws`, async () => {
        stubFetchJson({ id: 'o1', symbol: 'TEST', side: 'buy', status: 'new', qty: value, filled_qty: '0', filled_avg_price: null })
        await expect(broker().getOrder('o1')).rejects.toBeInstanceOf(BrokerDataError)
      })
    }
  })

  describe('account equity (getAccount) rejects malformed instead of fabricating zero-equity', () => {
    for (const [label, value] of REQUIRED_INVALID) {
      it(`equity=${label} → throws`, async () => {
        stubFetchJson({ equity: value, cash: '1', buying_power: '1', daytrade_count: '0' })
        await expect(broker().getAccount()).rejects.toBeInstanceOf(BrokerDataError)
      })
    }
  })

  describe('fill qty / price (getRecentFills) reject malformed — no trusted BrokerFill', () => {
    for (const [label, value] of REQUIRED_INVALID) {
      it(`fill qty=${label} → throws`, async () => {
        stubFetchJson([{ symbol: 'TEST', side: 'sell', qty: value, price: '10', transaction_time: new Date().toISOString(), order_id: 'o1' }])
        await expect(broker().getRecentFills('TEST', 0)).rejects.toBeInstanceOf(BrokerDataError)
      })
      it(`fill price=${label} → throws`, async () => {
        stubFetchJson([{ symbol: 'TEST', side: 'sell', qty: '10', price: value, transaction_time: new Date().toISOString(), order_id: 'o1' }])
        await expect(broker().getRecentFills('TEST', 0)).rejects.toBeInstanceOf(BrokerDataError)
      })
    }
  })
})

describe('P1-001 broker numerics — optional fields', () => {
  it("filled_avg_price absent (undefined/null/''/whitespace) → null (not 0)", async () => {
    for (const v of [undefined, null, '', '   ']) {
      stubFetchJson({ id: 'o1', symbol: 'TEST', side: 'buy', status: 'filled', qty: '100', filled_qty: '100', filled_avg_price: v })
      const order = await broker().getOrder('o1')
      expect(order?.filledAvgPrice).toBeNull()
      vi.unstubAllGlobals()
    }
  })

  it("filled_avg_price malformed ('abc'/'NaN'/'Infinity') → throws (corrupt price, not silent null)", async () => {
    for (const v of ['abc', 'NaN', 'Infinity']) {
      stubFetchJson({ id: 'o1', symbol: 'TEST', side: 'buy', status: 'filled', qty: '100', filled_qty: '100', filled_avg_price: v })
      await expect(broker().getOrder('o1')).rejects.toBeInstanceOf(BrokerDataError)
      vi.unstubAllGlobals()
    }
  })
})

describe('P1-001 broker numerics — genuine zero is preserved', () => {
  it("position qty '0' / 0 → a real flat position (qty 0), not a throw", async () => {
    for (const v of ['0', 0, '0.0']) {
      stubFetchJson({ symbol: 'TEST', qty: v, avg_entry_price: '0', qty_available: '0', unrealized_pl: '0' })
      const pos = await broker().getPosition('TEST')
      expect(pos?.qty).toBe(0)
      vi.unstubAllGlobals()
    }
  })

  it("account equity '0' / 0 → 0 (valid), order filled_qty '0' → 0", async () => {
    stubFetchJson({ equity: '0', cash: '0', buying_power: '0', daytrade_count: '0' })
    expect((await broker().getAccount()).equity).toBe(0)
    vi.unstubAllGlobals()
    stubFetchJson({ id: 'o1', symbol: 'TEST', side: 'buy', status: 'new', qty: '100', filled_qty: '0', filled_avg_price: null })
    const order = await broker().getOrder('o1')
    expect(order?.filledQty).toBe(0)
  })
})
