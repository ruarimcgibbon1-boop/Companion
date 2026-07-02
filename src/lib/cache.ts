/**
 * Simple in-process LRU cache with TTL for server-side API responses.
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

class Cache {
  private store = new Map<string, CacheEntry<unknown>>()
  private maxSize: number

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

  delete(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  size(): number {
    return this.store.size
  }
}

// Singleton shared across server request handlers in the same process
export const cache = new Cache()

export const TTL = {
  GAINERS: 60_000,         // 1 min — refresh gainers list frequently
  QUOTE: 15_000,           // 15 sec
  BATCH_QUOTE: 20_000,     // 20 sec — batch quotes for scanner
  CANDLES_1M: 30_000,      // 30 sec
  CANDLES_5M: 60_000,      // 1 min
  CANDLES_DAILY: 300_000,  // 5 min
  PROFILE: 3_600_000,      // 1 hour
  NEWS: 180_000,           // 3 min
  LEVELS: 60_000,          // 1 min
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const hit = cache.get<T>(key)
  if (hit !== null) return hit
  const data = await fn()
  cache.set(key, data, ttlMs)
  return data
}
