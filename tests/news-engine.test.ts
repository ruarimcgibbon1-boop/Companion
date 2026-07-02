import { describe, it, expect } from 'vitest'
import { keywordStrength, processNews, getBestCatalystSummary } from '../src/lib/news-engine'
import type { FmpNews } from '../src/lib/fmp-client'

function news(title: string, opts: { text?: string; ageHours?: number; site?: string } = {}): FmpNews {
  const published = new Date(Date.now() - (opts.ageHours ?? 1) * 3_600_000).toISOString()
  return {
    symbol: 'TEST',
    title,
    text: opts.text ?? '',
    url: 'https://example.com/a',
    site: opts.site ?? 'globenewswire',
    publisher: 'GlobeNewswire',
    publishedDate: published,
    image: '',
  }
}

// ── keywordStrength ──────────────────────────────────────────────────────────

describe('keywordStrength', () => {
  it('returns the highest star tier present', () => {
    expect(keywordStrength('Company met primary endpoint', '').stars).toBe(4)
    expect(keywordStrength('Positive Phase 3 top-line data', '').stars).toBe(3)
    expect(keywordStrength('Company receives FDA approval', '').stars).toBe(2)
    expect(keywordStrength('Company updates corporate website', '').stars).toBe(0)
  })

  it('takes the max when multiple tiers match (4 beats 3)', () => {
    // "positive" is 3-star, "positive endpoint"/"endpoint" is 4-star
    const r = keywordStrength('Positive endpoint achieved in trial', '')
    expect(r.stars).toBe(4)
    expect(r.matched).toContain('endpoint')
  })

  it('matches on word boundaries, not substrings', () => {
    // "goalkeeper" must not match "goal"
    expect(keywordStrength('The goalkeeper signed a jersey deal', '').matched).not.toContain('goal')
  })

  it('reads the body text too, not just the title', () => {
    expect(keywordStrength('Corporate update', 'The company achieved a significant milestone').stars).toBe(3)
  })
})

// ── quality mapping ──────────────────────────────────────────────────────────

describe('catalyst quality from keywords', () => {
  it('rates a fresh 4-star headline as a Strong Confirmed Catalyst', () => {
    const items = processNews([news('Drug meets primary endpoint', { ageHours: 2 })], 'TEST')
    expect(items[0].quality).toBe('Strong Confirmed Catalyst')
  })

  it('rates a fresh original 3-star headline as Strong', () => {
    const items = processNews([news('Positive top-line Phase 3 results in cancer', { ageHours: 3 })], 'TEST')
    expect(items[0].quality).toBe('Strong Confirmed Catalyst')
  })

  it('rates a fresh 2-star headline as Moderate', () => {
    const items = processNews([news('Company receives FDA approval', { ageHours: 3 })], 'TEST')
    expect(items[0].quality).toBe('Moderate Catalyst')
  })

  it('downgrades a stale 4-star headline (>48h) to Moderate', () => {
    const items = processNews([news('Drug meets primary endpoint', { ageHours: 72 })], 'TEST')
    expect(items[0].quality).toBe('Moderate Catalyst')
  })

  it('lets dilution override even strong positive language', () => {
    const items = processNews([news('Positive Phase 3 data; announces registered direct offering', { ageHours: 1 })], 'TEST')
    expect(items[0].quality).toBe('Negative or Dilutive Catalyst')
    expect(items[0].isDilutive).toBe(true)
  })

  it('finds no catalyst for generic corporate PR', () => {
    const items = processNews([news('Company to present at investor conference', { ageHours: 1 })], 'TEST')
    expect(items[0].quality).toBe('No Recent Catalyst Found')
  })

  it('surfaces the matched keywords as a bullish element', () => {
    const items = processNews([news('Company receives FDA approval', { ageHours: 1 })], 'TEST')
    expect(items[0].bullishElements.some(b => b.includes('★'))).toBe(true)
  })

  it('feeds the best-catalyst summary used by the scoring matrix', () => {
    const items = processNews([news('Drug meets primary endpoint', { ageHours: 1 })], 'TEST')
    const best = getBestCatalystSummary(items)
    expect(best.quality).toBe('Strong Confirmed Catalyst')
  })
})
