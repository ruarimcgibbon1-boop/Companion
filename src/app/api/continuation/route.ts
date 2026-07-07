import { NextResponse } from 'next/server'
import { getTopGainers, getMostActive } from '@/lib/fmp-client'
import { getYFScreener, getYFTrending } from '@/lib/yahoo-client'
import { cached, TTL } from '@/lib/cache'
import { buildMonitorBatch } from '@/lib/monitor'
import { rankContinuation } from '@/lib/continuation'
import { getSessionType } from '@/lib/market-hours'

export const runtime = 'nodejs'
export const maxDuration = 60

// Non-common instruments we exclude by default (spec: preferred/warrants/rights/funds).
const EXCLUDED_TERMS = [
  'etf', 'fund', 'trust', 'warrant', 'right ', 'unit ', 'preferred', 'pref',
  'acquisition corp', 'blank check',
]
function isExcluded(name: string, symbol: string): boolean {
  const lower = (name ?? '').toLowerCase()
  if (EXCLUDED_TERMS.some(t => lower.includes(t))) return true
  if (/[WRU]$/.test(symbol) && symbol.length > 4) return true
  return false
}

/**
 * Intraday continuation scanner.
 *
 * IMPORTANT: there is deliberately NO maximum share-price filter. A liquid $400
 * stock may be a better intraday continuation than an illiquid $4 stock. `minPrice`
 * exists only to drop sub-penny noise and is configurable. `maxPrice` is honoured
 * ONLY if the caller explicitly passes it — never defaulted.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const minPrice = Number(searchParams.get('minPrice') ?? 0.5)
  const maxPriceParam = searchParams.get('maxPrice')
  const maxPrice = maxPriceParam != null ? Number(maxPriceParam) : Infinity   // no default cap
  const minChangePct = Number(searchParams.get('minChangePct') ?? 3)
  const includeEtf = searchParams.get('includeEtf') === 'true'
  const maxCandidates = Number(searchParams.get('maxCandidates') ?? 20)
  const deepN = Math.min(Number(searchParams.get('deepN') ?? 30), 40)
  const includeAll = searchParams.get('includeAll') === 'true' // include non-qualifying in output

  const session = getSessionType()
  const startedAt = Date.now()
  const endpointsUsed: string[] = []
  const endpointsFailed: string[] = []

  try {
    // ── 1. Build the active momentum universe (no max-price filter) ──────────
    const [fmpGainers, fmpActive, yfGainers, yfActives, yfTrending] = await Promise.all([
      cached('gainers', TTL.GAINERS, getTopGainers).then(r => { endpointsUsed.push('fmp:biggest-gainers'); return r }).catch(() => { endpointsFailed.push('fmp:biggest-gainers'); return [] }),
      cached('mostActive', TTL.GAINERS, getMostActive).then(r => { endpointsUsed.push('fmp:most-active'); return r }).catch(() => { endpointsFailed.push('fmp:most-active'); return [] }),
      cached('yfGainers', TTL.GAINERS, () => getYFScreener('day_gainers', 50)).then(r => { endpointsUsed.push('yf:day_gainers'); return r }).catch(() => { endpointsFailed.push('yf:day_gainers'); return [] }),
      cached('yfActives', TTL.GAINERS, () => getYFScreener('most_actives', 50)).then(r => { endpointsUsed.push('yf:most_actives'); return r }).catch(() => { endpointsFailed.push('yf:most_actives'); return [] }),
      cached('yfTrending', TTL.GAINERS, () => getYFTrending(40)).then(r => { endpointsUsed.push('yf:trending'); return r }).catch(() => { endpointsFailed.push('yf:trending'); return [] }),
    ])

    type Row = { symbol: string; name?: string; price?: number; changePct?: number }
    const rows: Row[] = [
      ...fmpGainers.map(g => ({ symbol: g.symbol, name: g.name, price: g.price, changePct: Number(g.changesPercentage) })),
      ...fmpActive.map(g => ({ symbol: g.symbol, name: g.name, price: g.price, changePct: Number(g.changesPercentage) })),
      ...yfGainers.map(g => ({ symbol: g.symbol, name: g.name, price: g.price, changePct: g.changePct })),
      ...yfActives.map(g => ({ symbol: g.symbol, name: g.name, price: g.price, changePct: g.changePct })),
      ...(yfTrending as string[]).map(s => ({ symbol: s })),
    ]

    const seen = new Set<string>()
    const universe = rows.filter(r => {
      if (!r.symbol || seen.has(r.symbol)) return false
      if (!includeEtf && isExcluded(r.name ?? '', r.symbol)) return false
      if (r.price != null && (r.price < minPrice || r.price > maxPrice)) return false
      // Momentum gate — a continuation needs an existing move (trending rows have no price/change yet, keep them).
      if (r.changePct != null && Math.abs(r.changePct) < minChangePct) return false
      seen.add(r.symbol)
      return true
    })

    const symbols = universe.map(r => r.symbol).slice(0, deepN)
    const universeSize = universe.length

    // ── 2. Deep multi-timeframe analysis via the existing monitor engine ─────
    const results = await buildMonitorBatch(symbols)
    endpointsUsed.push('fmp:quote', 'fmp:historical-chart', 'yf:chart', 'fmp:news/stock')

    // ── 3. Continuation evaluation + ranking ─────────────────────────────────
    const ranked = rankContinuation(results)
    const qualifying = ranked.filter(c => c.qualifies)
    const candidates = (includeAll ? ranked : (qualifying.length ? qualifying : ranked)).slice(0, maxCandidates)

    return NextResponse.json({
      session,
      candidates,
      meta: {
        universeSize,
        analysed: results.length,
        qualifying: qualifying.length,
        endpointsUsed: [...new Set(endpointsUsed)],
        endpointsFailed: [...new Set(endpointsFailed)],
        maxPriceApplied: maxPriceParam != null ? maxPrice : null,   // null = no cap
        scanDurationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      },
    })
  } catch (err) {
    console.error('continuation route error:', err)
    return NextResponse.json({ error: 'Failed to build continuation scan' }, { status: 500 })
  }
}
