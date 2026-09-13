/**
 * Cache single-flight / coalescing semantics.
 *
 * Concurrent misses for the same key must share ONE fetch; failures must not poison
 * the key; different keys stay independent; and an invalidation (delete/clear) during
 * a flight must not let the late result repopulate the key.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { cache, cached } from '../src/lib/cache'

const TTL = 10_000

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  cache.clear()
})

describe('cached() single-flight', () => {
  it('1) collapses 10 simultaneous same-key misses into ONE fn() call', async () => {
    let calls = 0
    const d = deferred<string>()
    const fn = () => { calls++; return d.promise }

    const awaiters = Array.from({ length: 10 }, () => cached('k', TTL, fn))
    expect(calls).toBe(1)
    d.resolve('value')
    const results = await Promise.all(awaiters)

    expect(calls).toBe(1)
    // 2) all callers receive the same result
    expect(results).toEqual(Array(10).fill('value'))
  })

  it('3) a failed flight is not poisoned and 4) a later retry succeeds', async () => {
    let calls = 0
    const fn1 = () => { calls++; return Promise.reject(new Error('boom')) }
    await expect(cached('k', TTL, fn1)).rejects.toThrow('boom')
    expect(calls).toBe(1)
    // in-flight cleared on failure → next call actually runs fn again
    const fn2 = () => { calls++; return Promise.resolve('ok') }
    await expect(cached('k', TTL, fn2)).resolves.toBe('ok')
    expect(calls).toBe(2)
  })

  it('5) different keys do NOT coalesce', async () => {
    let a = 0, b = 0
    const da = deferred<string>(); const db = deferred<string>()
    const pa = cached('a', TTL, () => { a++; return da.promise })
    const pb = cached('b', TTL, () => { b++; return db.promise })
    expect(a).toBe(1)
    expect(b).toBe(1)
    da.resolve('A'); db.resolve('B')
    expect(await pa).toBe('A')
    expect(await pb).toBe('B')
  })

  it('caches the result so a subsequent hit does not re-fetch', async () => {
    let calls = 0
    await cached('k', TTL, () => { calls++; return Promise.resolve('v') })
    await cached('k', TTL, () => { calls++; return Promise.resolve('v') })
    expect(calls).toBe(1)
  })

  it('6) an expired cached value triggers exactly one new shared fetch', async () => {
    let calls = 0
    await cached('k', 1, () => { calls++; return Promise.resolve('v1') })
    expect(calls).toBe(1)
    await new Promise(r => setTimeout(r, 5))   // let the 1ms TTL expire

    const d = deferred<string>()
    const fn = () => { calls++; return d.promise }
    const awaiters = Array.from({ length: 5 }, () => cached('k', TTL, fn))
    expect(calls).toBe(2)   // one new fetch, shared by all 5
    d.resolve('v2')
    expect(await Promise.all(awaiters)).toEqual(Array(5).fill('v2'))
  })

  it('7) cache.delete during a flight resolves awaiters but does NOT repopulate the key', async () => {
    let calls = 0
    const d = deferred<string>()
    const p = cached('k', TTL, () => { calls++; return d.promise })
    // Invalidate mid-flight, then let the fetch complete.
    cache.delete('k')
    d.resolve('late')
    expect(await p).toBe('late')            // current awaiter still gets the value

    // The invalidated key was NOT repopulated → next caller re-fetches.
    let recalled = 0
    await cached('k', TTL, () => { recalled++; return Promise.resolve('fresh') })
    expect(recalled).toBe(1)
    expect(calls).toBe(1)
    expect(cache.get<string>('k')).toBe('fresh')
  })

  it('8) cache.clear during a flight is safe and also prevents repopulation', async () => {
    const d = deferred<string>()
    const p = cached('k', TTL, () => d.promise)
    cache.clear()                            // clear with work in flight
    d.resolve('late')
    expect(await p).toBe('late')
    expect(cache.get<string>('k')).toBeNull()   // not repopulated
    expect(cache.size()).toBe(0)
  })

  it('a delete on an unrelated key does NOT block the in-flight key from caching', async () => {
    const d = deferred<string>()
    const p = cached('k', TTL, () => d.promise)
    cache.delete('other')                    // unrelated invalidation
    d.resolve('v')
    await p
    expect(cache.get<string>('k')).toBe('v') // k still cached normally
  })
})
