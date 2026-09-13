/**
 * Simple in-process LRU cache with TTL for server-side API responses.
 *
 * SINGLE-FLIGHT: concurrent misses for the SAME key coalesce onto ONE in-flight
 * fetch (see `getOrLoad`), so a daemon sweep, a browser poll, and Mike hitting a cold
 * key together trigger a single upstream call, not three. Different keys run
 * independently. TTL semantics are unchanged.
 *
 * INVALIDATION DURING A FLIGHT (delete/clear): the underlying fetch cannot be
 * cancelled, so an in-flight result still RESOLVES the callers already awaiting it —
 * they asked for the value and it arrived. But that late result will NOT repopulate a
 * key that was explicitly invalidated while the fetch was running: a monotonic op
 * sequence (`opSeq`) is snapshotted at flight start, and on completion the value is
 * cached only if the key has not been deleted/cleared since. The next caller after an
 * invalidation therefore always triggers a fresh fetch rather than reading a value
 * that was already declared stale.
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

class Cache {
  private store = new Map<string, CacheEntry<unknown>>()
  private inflight = new Map<string, Promise<unknown>>()
  private maxSize: number

  // Invalidation bookkeeping (generation tokens). `opSeq` bumps on every delete/clear;
  // per-key and global markers let a completing flight tell whether ITS key was
  // invalidated after the flight began.
  private opSeq = 0
  private invalidatedAtSeq = new Map<string, number>()
  private clearedAtSeq = -1

  constructor(maxSize = 500) {
    this.maxSize = maxSize
  }

  get<T>(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.data as T
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    if (this.store.size >= this.maxSize) {
      // Evict oldest
      const firstKey = this.store.keys().next().value
      if (firstKey) this.store.delete(firstKey)
    }
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs })
  }

  /**
   * Remove a cached value. If a fetch for this key is in flight, it is NOT cancelled:
   * current awaiters still receive its result, but that result will not repopulate the
   * cache (the invalidation wins), so the next caller re-fetches.
   */
  delete(key: string): void {
    this.store.delete(key)
    this.opSeq += 1
    this.invalidatedAtSeq.set(key, this.opSeq)
  }

  /**
   * Drop every cached value. In-flight fetches are not cancelled and still resolve
   * their current awaiters, but none of them will repopulate the cache after this
   * point (same rule as `delete`, applied globally).
   */
  clear(): void {
    this.store.clear()
    this.opSeq += 1
    this.clearedAtSeq = this.opSeq
  }

  size(): number {
    return this.store.size
  }

  private invalidatedSince(key: string, startSeq: number): boolean {
    if (this.clearedAtSeq > startSeq) return true
    const s = this.invalidatedAtSeq.get(key)
    return s != null && s > startSeq
  }

  /**
   * Cache-aside read with single-flight coalescing.
   *   • fresh hit            → return it, no fetch
   *   • miss, no flight      → start fn(), share the promise under `key`
   *   • miss, flight running → await the SAME promise
   *   • success              → cache (unless the key was invalidated mid-flight)
   *   • failure              → drop the flight, propagate; the key is not poisoned and
   *                            the next caller may retry
   */
  async getOrLoad<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key)
    if (hit !== null) return hit

    const existing = this.inflight.get(key)
    if (existing) return existing as Promise<T>

    const startSeq = this.opSeq
    const promise = (async () => {
      const data = await fn()
      // Only populate if this key was not explicitly invalidated during the flight.
      if (!this.invalidatedSince(key, startSeq)) this.set(key, data, ttlMs)
      return data
    })().finally(() => {
      this.inflight.delete(key)
    })

    this.inflight.set(key, promise)
    return promise as Promise<T>
  }
}

// Singleton shared across server request handlers in the same process
export const cache = new Cache()

export const TTL = {
  GAINERS: 20_000,         // 20s — keep the gainers column visibly fresh
  QUOTE: 15_000,           // 15 sec
  BATCH_QUOTE: 20_000,     // 20 sec — batch quotes for scanner
  CANDLES_1M: 30_000,      // 30 sec
  CANDLES_5M: 60_000,      // 1 min
  CANDLES_DAILY: 300_000,  // 5 min
  PROFILE: 3_600_000,      // 1 hour
  FLOAT: 21_600_000,       // 6 hours — float share counts change only on filings
  NEWS: 180_000,           // 3 min
  PREMARKET_VOL: 300_000,  // 5 min — matches the 5-min bar granularity it's built from
  LEVELS: 60_000,          // 1 min
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  // Single-flight: delegate to the cache so concurrent misses share one fetch.
  return cache.getOrLoad(key, ttlMs, fn)
}
