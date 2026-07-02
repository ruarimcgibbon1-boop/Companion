import type { FmpNews } from './fmp-client'
import type { NewsItem, CatalystCategory, CatalystQuality } from '@/types'
import { dataAge } from './market-hours'

const DILUTION_TERMS = [
  'public offering',
  'registered direct',
  'private placement',
  'at-the-market',
  ' atm ',
  'shelf registration',
  'convertible note',
  'resale registration',
  'prospectus supplement',
  'warrant',
  'rights offering',
  'follow-on offering',
  'secondary offering',
  'shares of common stock',
  'priced an offering',
]

// Catalyst keyword strength tiers (trader-calibrated). Higher stars = stronger
// attention/move potential. The MAX star found in a headline drives quality.
// Ordered longest-phrase-first within a tier so specific phrases win.
const CATALYST_KEYWORD_TIERS: Array<{ stars: 2 | 3 | 4; terms: string[] }> = [
  {
    stars: 4,
    terms: [
      'positive endpoint', 'positive ceo statement', 'endpoints', 'endpoint', 'primary',
    ],
  },
  {
    stars: 3,
    terms: [
      'phase iii', 'phase 3', 'positive', 'top-line', 'top line', 'significant',
      'demonstrates', 'demonstrate', 'demonstrated', 'demonstrating', 'demonstration',
      'treatment', 'drug trials', 'drug trial', 'agreements', 'agreement', 'cancer',
      'partnerships', 'partnership', 'collaborations', 'collaboration', 'collab',
      'improvements', 'improvement', 'successful', 'success', 'billionaire', 'carl icahn',
      'increase', 'awarded', 'awards', 'award', 'top of the line', 'significance',
      'significantly', 'important', 'survival', 'reached', 'goal', 'billion',
    ],
  },
  {
    stars: 2,
    terms: [
      'phase ii', 'phase 2', 'receives', 'received', 'receive', 'fda', 'approval',
      'approves', 'approved', 'approve', 'beneficial', 'benefits', 'benefit',
      'fast track', 'breakouts', 'breakout', 'acquirements', 'expansion', 'expand',
      'contracts', 'contract', 'completes', 'completed', 'complete', 'promising',
      'achievements', 'achievement', 'achieves', 'achieved', 'achieve', 'launches',
      'repurchase', 'purchase', 'bankruptcy', 'special',
    ],
  },
]

// Precompiled matchers: word-boundary, case-insensitive, one regex per tier.
const TIER_MATCHERS = CATALYST_KEYWORD_TIERS.map(t => ({
  stars: t.stars,
  terms: t.terms,
  regexes: t.terms.map(term => ({
    term,
    re: new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  })),
}))

/** Highest catalyst star tier present, plus the specific keywords matched. */
export function keywordStrength(title: string, text: string): { stars: 0 | 2 | 3 | 4; matched: string[] } {
  const combined = `${title} ${text}`
  let stars: 0 | 2 | 3 | 4 = 0
  const matched: string[] = []
  for (const tier of TIER_MATCHERS) {
    for (const { term, re } of tier.regexes) {
      if (re.test(combined)) {
        matched.push(term)
        if (tier.stars > stars) stars = tier.stars
      }
    }
  }
  return { stars, matched }
}

const CATALYST_PATTERNS: Array<{ pattern: RegExp; category: CatalystCategory }> = [
  { pattern: /earnings|revenue|profit|loss|EPS|quarterly result/i, category: 'Earnings' },
  { pattern: /guidance|outlook|forecast|raises|lowers|updates/i, category: 'Guidance' },
  { pattern: /FDA|clinical trial|phase [123]|NDA|BLA|IND|drug|therapy|approval/i, category: 'FDA/Clinical' },
  { pattern: /contract|awarded|agreement|win|deal/i, category: 'Contract' },
  { pattern: /partnership|collaboration|joint venture/i, category: 'Partnership' },
  { pattern: /acqui|merger|takeover|buyout/i, category: 'Acquisition' },
  { pattern: /financing|credit facility|loan|debt|bond/i, category: 'Financing' },
  { pattern: /offering|priced|shares|prospectus|shelf/i, category: 'Offering' },
  { pattern: /repurchase|buyback/i, category: 'Share Repurchase' },
  { pattern: /analyst|upgrade|downgrade|price target|rating/i, category: 'Analyst Action' },
  { pattern: /lawsuit|settlement|SEC|investigation|regulatory|fine/i, category: 'Legal/Regulatory' },
  { pattern: /CEO|CFO|COO|appoints|resign|executive/i, category: 'Management Change' },
  { pattern: /launch|release|unveil|product|service/i, category: 'Product Launch' },
]

function detectCatalystCategory(title: string, text: string): CatalystCategory {
  const combined = `${title} ${text}`.toLowerCase()
  for (const { pattern, category } of CATALYST_PATTERNS) {
    if (pattern.test(combined)) return category
  }
  return 'No Catalyst'
}

function detectDilution(title: string, text: string): boolean {
  const combined = `${title} ${text}`.toLowerCase()
  return DILUTION_TERMS.some(term => combined.includes(term))
}

function scoreCatalystQuality(
  category: CatalystCategory,
  isDilutive: boolean,
  ageHours: number,
  isOriginal: boolean,
  keywordStars: 0 | 2 | 3 | 4
): CatalystQuality {
  // A dilutive offering dominates short-term price action regardless of any
  // positive language in the same release.
  if (isDilutive) return 'Negative or Dilutive Catalyst'

  const recent = ageHours < 24
  const fresh = ageHours < 48

  // Keyword-strength tiers take precedence — they are the trader's calibration.
  if (keywordStars === 4) return fresh ? 'Strong Confirmed Catalyst' : 'Moderate Catalyst'
  if (keywordStars === 3) return (recent && isOriginal) ? 'Strong Confirmed Catalyst' : fresh ? 'Moderate Catalyst' : 'Weak or Recycled Catalyst'
  if (keywordStars === 2) return fresh ? 'Moderate Catalyst' : 'Weak or Recycled Catalyst'

  // No calibrated keyword hit — fall back to category-based scoring.
  if (category === 'No Catalyst') return 'No Recent Catalyst Found'
  if (ageHours > 48) return 'Weak or Recycled Catalyst'

  const strongCategories: CatalystCategory[] = ['Earnings', 'FDA/Clinical', 'Acquisition', 'Contract']
  const moderateCategories: CatalystCategory[] = ['Guidance', 'Partnership', 'Analyst Action', 'Product Launch', 'Management Change']

  if (strongCategories.includes(category) && recent && isOriginal) return 'Strong Confirmed Catalyst'
  if (strongCategories.includes(category) || moderateCategories.includes(category)) return 'Moderate Catalyst'
  return 'Weak or Recycled Catalyst'
}

function extractBullishBearish(title: string, text: string): { bullish: string[]; bearish: string[] } {
  const combined = `${title} ${text}`
  const bullish: string[] = []
  const bearish: string[] = []

  if (/beat|exceed|surpass|record|above expectations/i.test(combined)) bullish.push('Beat expectations')
  if (/growth|increase|gain|expand|positive/i.test(combined)) bullish.push('Positive growth indicators')
  if (/new contract|new partnership|new deal/i.test(combined)) bullish.push('New business development')
  if (/approval|approved|clearance/i.test(combined)) bullish.push('Regulatory approval')
  if (/miss|disappoint|below|decline|loss|fell/i.test(combined)) bearish.push('Missed expectations')
  if (/offering|dilut|shares|prospectus/i.test(combined)) bearish.push('Potential dilution')
  if (/lawsuit|fine|investigation|violation/i.test(combined)) bearish.push('Legal/regulatory risk')
  if (/guidance cut|lowered|reduces/i.test(combined)) bearish.push('Reduced guidance')

  return { bullish, bearish }
}

export function processNews(raw: FmpNews[], symbol: string): NewsItem[] {
  const seen = new Set<string>()
  const items: NewsItem[] = []

  for (const n of raw) {
    // Dedup by title similarity
    const key = n.title.toLowerCase().replace(/\W+/g, '').slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)

    const publishedAt = new Date(n.publishedDate).getTime()
    const ageMs = Date.now() - publishedAt
    const ageHours = ageMs / 3_600_000
    const isDilutive = detectDilution(n.title, n.text)
    const category = detectCatalystCategory(n.title, n.text)
    // Original wire releases (globenewswire, accesswire, prnewswire, businesswire)
    // are higher-signal than aggregators/blogs (seekingalpha, benzinga, yahoo).
    const site = n.site.toLowerCase()
    const isAggregator =
      site.includes('seekingalpha') || site.includes('benzinga') ||
      site.includes('yahoo') || site.includes('motley') || site.includes('zacks')
    const isOriginal = !isAggregator
    const { stars: keywordStars, matched } = keywordStrength(n.title, n.text)
    const quality = scoreCatalystQuality(category, isDilutive, ageHours, isOriginal, keywordStars)
    const { bullish, bearish } = extractBullishBearish(n.title, n.text)
    // Surface the calibrated keywords that fired, so the "why" is visible.
    if (keywordStars > 0 && !isDilutive && matched.length) {
      bullish.unshift(`${'★'.repeat(keywordStars)} ${matched.slice(0, 4).join(', ')}`)
    }

    items.push({
      id: `${symbol}-${publishedAt}-${key.slice(0, 10)}`,
      title: n.title,
      text: n.text.slice(0, 500),
      url: n.url,
      source: n.site,
      publishedDate: n.publishedDate,
      age: dataAge(publishedAt),
      isDilutive,
      isOriginalRelease: isOriginal,
      catalystCategory: category,
      bullishElements: bullish,
      bearishElements: bearish,
      quality,
      symbol,
    })
  }

  return items.sort((a, b) => new Date(b.publishedDate).getTime() - new Date(a.publishedDate).getTime())
}

export function getBestCatalystSummary(news: NewsItem[]): {
  quality: CatalystQuality
  category: CatalystCategory
  summary: string
} {
  if (!news.length) {
    return {
      quality: 'No Recent Catalyst Found',
      category: 'No Catalyst',
      summary: 'No recent news catalyst found.',
    }
  }
  const best = news[0]
  return {
    quality: best.quality,
    category: best.catalystCategory,
    summary: best.title,
  }
}
