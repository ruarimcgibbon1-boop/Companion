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
  isOriginal: boolean
): CatalystQuality {
  if (isDilutive) return 'Negative or Dilutive Catalyst'
  if (category === 'No Catalyst') return 'No Recent Catalyst Found'
  if (ageHours > 48) return 'Weak or Recycled Catalyst'

  const strongCategories: CatalystCategory[] = ['Earnings', 'FDA/Clinical', 'Acquisition', 'Contract']
  const moderateCategories: CatalystCategory[] = ['Guidance', 'Partnership', 'Analyst Action', 'Product Launch', 'Management Change']

  if (strongCategories.includes(category) && ageHours < 24 && isOriginal) return 'Strong Confirmed Catalyst'
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
    const isOriginal = !n.site.toLowerCase().includes('seekingalpha') &&
      !n.site.toLowerCase().includes('benzinga') &&
      !n.site.toLowerCase().includes('accesswire') === false  // accesswire IS original
    const quality = scoreCatalystQuality(category, isDilutive, ageHours, isOriginal)
    const { bullish, bearish } = extractBullishBearish(n.title, n.text)

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
