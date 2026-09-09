/**
 * Read-only paginated Alpaca FILL-activity reader for the broker-truth ledger.
 *
 * The production `AlpacaBroker.getRecentFills` fetches ONE page of 100 account
 * activities and filters by symbol in memory — so calling it per symbol re-reads
 * the same first 100 rows and silently misses any fill beyond activity #100. That
 * is unusable for a truth ledger. This reader instead walks the WHOLE day's FILL
 * activity via cursor pagination, constrains to the ET day, and FAILS CLOSED when
 * pagination is incomplete. It never touches the executor or broker state.
 *
 * The network call is injected (`fetchPage`) so the pagination/day-bounding logic
 * is a pure, deterministic function that tests drive with >100 synthetic rows.
 */
import { etStrToUnixSec } from '@/lib/replay-day'

/** One raw Alpaca FILL activity (only the fields the ledger needs). */
export interface RawFillActivity {
  id: string
  order_id: string | null
  symbol: string
  side: string
  qty: number | string
  price: number | string
  transaction_time: string
}

export interface FillPage {
  rows: RawFillActivity[]
  /** Alpaca returns the last activity id as the next page cursor; null ends paging. */
  nextPageToken: string | null
}

/** Normalized fill (client_order_id is resolved separately, via getOrder). */
export interface DayFill {
  activityId: string
  orderId: string | null
  symbol: string
  side: 'buy' | 'sell'
  qty: number
  price: number
  transactionTime: number
}

export interface DayFillResult {
  day: string
  fills: DayFill[]
  /** Every raw activity row received across all pages, as-received (before windowing/dedup)
   *  — the immutable evidence archived for offline replay. */
  rawActivities: RawFillActivity[]
  /** FALSE means retrieval was incomplete — the ledger must NOT claim exact truth. */
  complete: boolean
  pages: number
  rawCount: number
  /** Rows that fell outside the ET-day window (excluded from `fills`). */
  outOfWindow: number
  /** Fills dropped as duplicates (same activity id seen on an overlapping page). */
  duplicates: number
  incompleteReason: string | null
}

/** [startMs, endMs) for an ET trading day, DST-correct via the ET string parser. */
export function etDayBoundsMs(day: string): { startMs: number; endMs: number } {
  const startSec = etStrToUnixSec(`${day} 00:00:00`)
  // Next calendar day at ET-midnight — handles 23h/25h DST days correctly.
  const [y, m, d] = day.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const nextDay = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
  const endSec = etStrToUnixSec(`${nextDay} 00:00:00`)
  return { startMs: startSec * 1000, endMs: endSec * 1000 }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v))

/**
 * Normalize raw activity rows into windowed, deduplicated fills for one ET day. PURE
 * and OFFLINE — the same function normalizes a live acquisition and an archived raw
 * artifact, so the broker ledger is reproducible from frozen evidence without Alpaca.
 * Dedup is by stable activity id, applied AFTER all rows are present.
 */
export function normalizeFills(raw: readonly RawFillActivity[], day: string): { fills: DayFill[]; outOfWindow: number; duplicates: number } {
  const { startMs, endMs } = etDayBoundsMs(day)
  const fills: DayFill[] = []
  const seen = new Set<string>()
  let outOfWindow = 0
  let duplicates = 0
  for (const r of raw) {
    const t = r.transaction_time ? new Date(r.transaction_time).getTime() : NaN
    if (!Number.isFinite(t) || t < startMs || t >= endMs) { outOfWindow++; continue }
    const activityId = String(r.id)
    if (seen.has(activityId)) { duplicates++; continue }
    seen.add(activityId)
    fills.push({
      activityId,
      orderId: r.order_id == null ? null : String(r.order_id),
      symbol: String(r.symbol),
      side: r.side === 'sell' ? 'sell' : 'buy',
      qty: num(r.qty),
      price: num(r.price),
      transactionTime: t,
    })
  }
  fills.sort((a, b) => a.transactionTime - b.transactionTime)
  return { fills, outOfWindow, duplicates }
}

/**
 * Walk every FILL page for `day`, constrained to the ET-day window. Pure given an
 * injected `fetchPage`. Fails closed: a throwing page, or hitting `maxPages`
 * before the cursor is exhausted, yields `complete: false` with a reason — the
 * partial fills are still returned (never dropped), but flagged not-authoritative.
 */
export async function collectDayFills(opts: {
  day: string
  fetchPage: (pageToken: string | null) => Promise<FillPage>
  maxPages?: number
}): Promise<DayFillResult> {
  const { day, fetchPage } = opts
  const maxPages = opts.maxPages ?? 500

  const rawActivities: RawFillActivity[] = []   // as-received across all pages (immutable evidence)
  const seenTokens = new Set<string>()          // cyclic-token guard
  let pages = 0
  let rawCount = 0
  let token: string | null = null
  let complete = false
  let incompleteReason: string | null = null

  while (pages < maxPages) {
    let page: FillPage
    try {
      page = await fetchPage(token)
    } catch (e) {
      incompleteReason = `page ${pages + 1} fetch failed: ${(e as Error).message}`
      break
    }
    pages++
    if (!page || !Array.isArray(page.rows)) {
      incompleteReason = `page ${pages} malformed (no rows array)`   // fail closed on malformed response
      break
    }
    rawCount += page.rows.length
    for (const r of page.rows) rawActivities.push(r)   // archive raw first; normalize later

    const next = page.nextPageToken
    if (next == null || page.rows.length === 0) { complete = true; break }
    if (typeof next !== 'string' || next === '') {
      incompleteReason = `malformed page token (${typeof next})`   // never trust a non-string cursor
      break
    }
    if (seenTokens.has(next)) {
      incompleteReason = `cyclic page token repeated (${next})`    // fail safe, never loop forever
      break
    }
    seenTokens.add(next)
    token = next
  }
  if (!complete && incompleteReason == null && pages >= maxPages) {
    incompleteReason = `hit maxPages=${maxPages} before cursor exhausted`
  }

  // Normalize from the archived raw rows — the same path an offline replay uses.
  const { fills, outOfWindow, duplicates } = normalizeFills(rawActivities, day)
  return { day, fills, rawActivities, complete, pages, rawCount, outOfWindow, duplicates, incompleteReason }
}
