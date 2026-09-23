import { describe, it, expect } from 'vitest'
import {
  isHammer, isBullishEngulfing, isMorningStar, isThreeWhiteSoldiers, detectCandlePatterns,
} from '../src/lib/candlestick-patterns'
import type { Candle } from '../src/types'

const c = (o: number, h: number, l: number, cl: number, v = 100_000): Candle =>
  ({ time: 0, open: o, high: h, low: l, close: cl, volume: v })

describe('raw candlestick shapes', () => {
  it('hammer: small body, long lower wick, tiny upper wick', () => {
    expect(isHammer(c(10.0, 10.02, 9.0, 9.95))).toBe(true)  // body .05, lower wick ~.95, tiny upper wick
    expect(isHammer(c(10.0, 10.5, 9.9, 10.4))).toBe(false)  // big body, no lower wick
  })

  it('bullish engulfing: green body swallows the prior red body', () => {
    expect(isBullishEngulfing(c(10.0, 10.05, 9.5, 9.6), c(9.55, 10.3, 9.5, 10.2))).toBe(true)
    expect(isBullishEngulfing(c(9.6, 10.05, 9.5, 10.0), c(9.55, 10.3, 9.5, 10.2))).toBe(false) // prev green
  })

  it('morning star: red → small body → strong green into the red body', () => {
    expect(isMorningStar(c(10.0, 10.05, 9.4, 9.5), c(9.45, 9.55, 9.35, 9.48), c(9.5, 10.1, 9.45, 9.95))).toBe(true)
    expect(isMorningStar(c(10.0, 10.05, 9.4, 9.5), c(9.45, 9.55, 9.35, 9.48), c(9.5, 9.6, 9.45, 9.55))).toBe(false) // weak green
  })

  it('three white soldiers: three rising greens opening within the prior body', () => {
    expect(isThreeWhiteSoldiers(c(9.0, 9.32, 8.98, 9.3), c(9.2, 9.62, 9.18, 9.6), c(9.5, 9.92, 9.48, 9.9))).toBe(true)
    expect(isThreeWhiteSoldiers(c(9.0, 9.3, 8.98, 9.3), c(9.2, 9.6, 9.18, 9.6), c(9.5, 9.55, 9.48, 9.5))).toBe(false) // 3rd not higher
  })
})

describe('detectCandlePatterns — with context filters', () => {
  const base = [c(9.0, 9.1, 8.9, 9.0), c(9.0, 9.1, 8.9, 9.0), c(9.0, 9.1, 8.9, 9.0)] // filler

  it('flags a hammer and scores location + volume + trend', () => {
    const candles = [...base, c(10.0, 10.02, 9.0, 9.98, 300_000)] // hammer, high volume
    const hits = detectCandlePatterns(candles, { atSupport: true, uptrend: true })
    const h = hits.find(x => x.pattern === 'hammer')!
    expect(h).toBeTruthy()
    expect(h.volumeConfirmed).toBe(true)
    expect(h.atSupport).toBe(true)
    expect(h.strength).toBe(100) // 40 + 25 + 20 + 15
  })

  it('the same hammer mid-range on flat volume scores near a coin flip', () => {
    const candles = [...base, c(10.0, 10.02, 9.0, 9.98, 100_000)]
    const h = detectCandlePatterns(candles, { atSupport: false, uptrend: false })
      .find(x => x.pattern === 'hammer')!
    expect(h.strength).toBe(40)
  })

  it('returns nothing on fewer than 3 candles', () => {
    expect(detectCandlePatterns([c(9, 9.1, 8.9, 9)], { atSupport: true, uptrend: true })).toEqual([])
  })
})
