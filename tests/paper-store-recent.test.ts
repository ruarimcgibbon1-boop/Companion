import { describe, it, expect, vi, afterEach } from 'vitest'

// This file mocks 'fs' at module scope so loadRecentTrades can be exercised
// without touching the real home directory. Kept in its own file — separate
// from paper-trades-view.test.ts, which mocks '@/lib/execution/store' itself
// for the route tests and would otherwise shadow the real implementation.

describe('loadRecentTrades', () => {
  afterEach(() => {
    vi.doUnmock('fs')
    vi.resetModules()
  })

  it('unions trades across the last N day-files and de-dupes by trade id', async () => {
    const files: Record<string, string> = {}

    vi.doMock('fs', () => ({
      existsSync: (p: string) => p in files,
      readFileSync: (p: string) => files[p],
      writeFileSync: (p: string, data: string) => { files[p] = data },
      appendFileSync: () => {},
    }))

    const { tradesFile, etDayKey, loadRecentTrades } = await import('@/lib/execution/store')
    const { newPaperTrade } = await import('@/lib/execution/types')

    const now = Date.now()
    const today = etDayKey(now)
    const yesterday = etDayKey(now - 24 * 60 * 60 * 1000)

    const sig = (id: string) => ({
      id, setupId: `${id}-setup`, symbol: 'STFS', timestamp: now,
      setupType: 'premarket_breakout', triggerPrice: 5, entryLow: 4.9, entryHigh: 5,
      invalidation: 4.8, stop: 4.8, targets: [5.5], score: 70, grade: 'strong',
      rewardRisk: 2, priceAtSignal: 5,
    })

    const tOpenToday = { ...newPaperTrade(sig('a') as never, 100, 5, now), state: 'open' as const, createdAt: now }
    const tClosedYesterday = { ...newPaperTrade(sig('b') as never, 100, 5, now - 86_400_000), state: 'closed' as const, createdAt: now - 86_400_000, realizedPnl: 50 }

    files[tradesFile(today)] = JSON.stringify([tOpenToday])
    files[tradesFile(yesterday)] = JSON.stringify([tClosedYesterday])

    const result = loadRecentTrades(2, now)
    expect(result.map(t => t.id).sort()).toEqual(['pt:a', 'pt:b'].sort())
  })

  it('returns an empty array when no day files exist', async () => {
    vi.doMock('fs', () => ({
      existsSync: () => false,
      readFileSync: () => '',
      writeFileSync: () => {},
      appendFileSync: () => {},
    }))
    const { loadRecentTrades } = await import('@/lib/execution/store')
    expect(loadRecentTrades(5)).toEqual([])
  })
})
