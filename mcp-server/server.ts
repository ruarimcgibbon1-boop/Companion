#!/usr/bin/env node
/**
 * Intraday Trading Companion — MCP Server
 * Exposes trading analysis tools to Claude via Model Context Protocol.
 *
 * Launch: npx tsx mcp-server/server.ts
 * Or after build: node mcp-server/dist/server.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// We call the Next.js API routes via HTTP so the MCP server works independently
const NEXT_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${NEXT_URL}${path}`)
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`)
  return res.json()
}

const server = new Server(
  { name: 'intraday-trading-companion', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

// ── Tool definitions ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_top_gainers',
      description: 'Get the current top percentage gainers from the US market scanner.',
      inputSchema: {
        type: 'object',
        properties: {
          minChangePct: { type: 'number', description: 'Minimum % gain (default 5)' },
          minVolume: { type: 'number', description: 'Minimum volume (default 500000)' },
          maxResults: { type: 'number', description: 'Max results (default 30)' },
          minRvol: { type: 'number', description: 'Minimum relative volume' },
          maxPrice: { type: 'number', description: 'Max price filter' },
        },
      },
    },
    {
      name: 'get_scanner_results',
      description: 'Get the full scanner results with badges, catalyst labels and setup scores.',
      inputSchema: {
        type: 'object',
        properties: {
          minChangePct: { type: 'number' },
          minVolume: { type: 'number' },
          maxResults: { type: 'number' },
          minRvol: { type: 'number' },
          maxPrice: { type: 'number' },
          minMktCap: { type: 'number' },
          maxFloat: { type: 'number' },
        },
      },
    },
    {
      name: 'get_ticker_snapshot',
      description: 'Get a complete analysis snapshot for a single ticker including quote, technicals, levels, and pullback scenarios.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Ticker symbol e.g. AAPL' },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'get_intraday_candles',
      description: 'Get raw intraday candles for a ticker.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          interval: { type: 'string', enum: ['1min', '5min', '15min', 'daily'] },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'get_technical_levels',
      description: 'Get support/resistance zones and session levels for a ticker.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'get_support_resistance',
      description: 'Get scored support and resistance zones.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'get_pullback_scenarios',
      description: 'Get potential pullback setup scenarios with entry, confirmation, invalidation and targets.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'get_recent_news',
      description: 'Get recent news and press releases for a ticker with catalyst analysis.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'get_catalyst_analysis',
      description: 'Get catalyst quality assessment and summary for a ticker.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'get_setup_report',
      description: 'Get the full structured setup report for a ticker including score breakdown, verdict and warnings.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'compare_tickers',
      description: 'Compare setup quality and technicals across multiple tickers.',
      inputSchema: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of ticker symbols to compare',
          },
        },
        required: ['symbols'],
      },
    },
    {
      name: 'get_daily_context',
      description: 'Get daily timeframe context: 50/200 MA, gap, 5-day and 20-day ranges, daily RSI and ATR.',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
  ],
}))

// ── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const a = (args ?? {}) as Record<string, unknown>

  try {
    switch (name) {
      case 'get_top_gainers':
      case 'get_scanner_results': {
        const params = new URLSearchParams()
        if (a.minChangePct) params.set('minChangePct', String(a.minChangePct))
        if (a.minVolume) params.set('minVolume', String(a.minVolume))
        if (a.maxResults) params.set('maxResults', String(a.maxResults))
        if (a.minRvol) params.set('minRvol', String(a.minRvol))
        if (a.maxPrice) params.set('maxPrice', String(a.maxPrice))
        if (a.minMktCap) params.set('minMktCap', String(a.minMktCap))
        if (a.maxFloat) params.set('maxFloat', String(a.maxFloat))
        const data = await apiGet(`/api/gainers?${params}`) as { rows: unknown[]; sessionType: string; timestamp: number }
        const rows = (data.rows ?? []) as Array<Record<string, unknown>>
        const summary = rows.slice(0, 15).map(r =>
          `${r.rank}. ${r.symbol} ${r.name} | $${Number(r.price).toFixed(2)} +${Number(r.changePct).toFixed(1)}% | Vol ${formatVol(Number(r.volume))} | RVOL ${r.relativeVolume ? Number(r.relativeVolume).toFixed(1) : 'n/a'} | ${r.catalystLabel} | ${r.status} | Badges: ${(r.badges as Array<{label:string}>).map(b => b.label).join(', ') || 'none'}`
        ).join('\n')
        return {
          content: [{
            type: 'text',
            text: `**Top Gainers — ${data.sessionType} session**\nTimestamp: ${new Date(data.timestamp).toISOString()}\n\n${summary || 'No results matching filters.'}\n\nTotal: ${rows.length} stocks`,
          }],
        }
      }

      case 'get_ticker_snapshot': {
        const symbol = String(a.symbol ?? '').toUpperCase()
        if (!symbol) throw new Error('symbol required')
        const snap = await apiGet(`/api/snapshot?symbol=${symbol}`) as Record<string, unknown>
        return { content: [{ type: 'text', text: formatSnapshot(snap) }] }
      }

      case 'get_intraday_candles': {
        const symbol = String(a.symbol ?? '').toUpperCase()
        const interval = String(a.interval ?? '5min')
        const data = await apiGet(`/api/candles?symbol=${symbol}&interval=${interval}`) as { candles: unknown[]; timestamp: number }
        const candles = data.candles ?? []
        const recent = (candles as Array<Record<string,unknown>>).slice(-20)
        const text = recent.map(c => `${c.date} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`).join('\n')
        return {
          content: [{
            type: 'text',
            text: `**${symbol} — ${interval} candles (last 20)**\n${text}\nTotal candles: ${candles.length}`,
          }],
        }
      }

      case 'get_technical_levels':
      case 'get_support_resistance': {
        const symbol = String(a.symbol ?? '').toUpperCase()
        const snap = await apiGet(`/api/snapshot?symbol=${symbol}`) as Record<string, unknown>
        const levels = snap.sessionLevels as Record<string, unknown>
        const zones = snap.zones as Array<Record<string, unknown>>
        const text = [
          `**${symbol} — Key Levels**`,
          `Timestamp: ${new Date(Number(snap.timestamp)).toISOString()}`,
          '',
          '**Session Levels:**',
          `VWAP: ${fmt(levels?.vwap)}`,
          `Premarket High: ${fmt(levels?.premarketHigh)} | Low: ${fmt(levels?.premarketLow)}`,
          `Day High: ${fmt(levels?.regularHigh)} | Day Low: ${fmt(levels?.regularLow)}`,
          `Previous Close: ${fmt(levels?.previousClose)}`,
          `PDH: ${fmt(levels?.previousDayHigh)} | PDL: ${fmt(levels?.previousDayLow)}`,
          `5-min OR: ${fmt(levels?.or5High)} / ${fmt(levels?.or5Low)}`,
          `15-min OR: ${fmt(levels?.or15High)} / ${fmt(levels?.or15Low)}`,
          '',
          '**Support/Resistance Zones:**',
          ...(zones ?? []).map(z =>
            `[${(z.type as string).toUpperCase()}] $${Number(z.lower).toFixed(2)}–$${Number(z.upper).toFixed(2)} | Score: ${z.strengthScore}/10 | ${z.status} | ${(z.reasons as string[]).join(', ')}`
          ),
        ].join('\n')
        return { content: [{ type: 'text', text }] }
      }

      case 'get_pullback_scenarios': {
        const symbol = String(a.symbol ?? '').toUpperCase()
        const snap = await apiGet(`/api/snapshot?symbol=${symbol}`) as Record<string, unknown>
        const pullbacks = snap.pullbacks as Array<Record<string, unknown>>
        const price = (snap.quote as Record<string,unknown>)?.price
        const text = [
          `**${symbol} — Pullback Scenarios @ $${fmt(price)}**`,
          `Timestamp: ${new Date(Number(snap.timestamp)).toISOString()}`,
          `Status: ${(snap.setupScore as Record<string,unknown>)?.status}`,
          '',
          ...(pullbacks ?? []).map((p, i) => [
            `**Scenario ${i + 1}: ${p.name}**`,
            `Entry zone: $${Number(p.entryZoneLow).toFixed(2)}–$${Number(p.entryZoneHigh).toFixed(2)}`,
            `Confirmation: ${p.confirmation}`,
            `Trigger: ${p.trigger}`,
            `Invalidation: $${Number(p.invalidation).toFixed(2)}`,
            `Target 1: ${p.target1 ? `$${Number(p.target1).toFixed(2)}` : 'n/a'} | Target 2: ${p.target2 ? `$${Number(p.target2).toFixed(2)}` : 'n/a'}`,
            `R/R: ${p.rewardRisk ? Number(p.rewardRisk).toFixed(1) : 'n/a'} | Confidence: ${p.confidenceScore}%`,
            `Volume confirms: ${p.volumeConfirms} | Chasing: ${p.isChasing}`,
            '',
          ].join('\n')),
          ...((snap.warnings as string[]) ?? []).map(w => `⚠️  ${w}`),
        ].join('\n')
        return { content: [{ type: 'text', text }] }
      }

      case 'get_recent_news':
      case 'get_catalyst_analysis': {
        const symbol = String(a.symbol ?? '').toUpperCase()
        const data = await apiGet(`/api/news?symbol=${symbol}`) as { news: Array<Record<string,unknown>>; timestamp: number }
        const news = (data.news ?? []).slice(0, 10)
        const text = [
          `**${symbol} — News & Catalyst Analysis**`,
          `Timestamp: ${new Date(data.timestamp).toISOString()}`,
          '',
          ...news.map(n =>
            `**${n.title}**\nSource: ${n.source} | ${n.age} | ${n.quality}\nCategory: ${n.catalystCategory}${n.isDilutive ? ' ⚠️ DILUTION RISK' : ''}\nBullish: ${(n.bullishElements as string[]).join(', ') || 'none'} | Bearish: ${(n.bearishElements as string[]).join(', ') || 'none'}\n`
          ),
        ].join('\n')
        return { content: [{ type: 'text', text }] }
      }

      case 'get_setup_report': {
        const symbol = String(a.symbol ?? '').toUpperCase()
        const snap = await apiGet(`/api/snapshot?symbol=${symbol}`) as Record<string, unknown>
        return { content: [{ type: 'text', text: formatSnapshot(snap) }] }
      }

      case 'get_daily_context': {
        const symbol = String(a.symbol ?? '').toUpperCase()
        const snap = await apiGet(`/api/snapshot?symbol=${symbol}`) as Record<string, unknown>
        const t = snap.technical as Record<string, unknown>
        const text = [
          `**${symbol} — Daily Context**`,
          `Gap: ${t?.gapPct ? `${Number(t.gapPct).toFixed(1)}%` : 'n/a'}`,
          `50-day MA: ${fmt(t?.ma50Daily)} | 200-day MA: ${fmt(t?.ma200Daily)}`,
          `Daily RSI: ${t?.dailyRsi ? Number(t.dailyRsi).toFixed(1) : 'n/a'}`,
          `Daily ATR: ${fmt(t?.dailyAtr)}`,
          `5-day range: ${fmt(t?.fiveDayLow)} – ${fmt(t?.fiveDayHigh)}`,
          `20-day range: ${fmt(t?.twentyDayLow)} – ${fmt(t?.twentyDayHigh)}`,
          `20-day avg vol: ${t?.avgVolume20d ? formatVol(Number(t.avgVolume20d)) : 'n/a'}`,
          `Breaking out of multi-day range: ${t?.isBreakingOutOfRange}`,
        ].join('\n')
        return { content: [{ type: 'text', text }] }
      }

      case 'compare_tickers': {
        const symbols = (a.symbols as string[] ?? []).map(s => s.toUpperCase()).slice(0, 5)
        const snaps = await Promise.all(symbols.map(s => apiGet(`/api/snapshot?symbol=${s}`)))
        const rows = snaps.map((snap, i) => {
          const s = snap as Record<string, unknown>
          const q = s.quote as Record<string, unknown>
          const sc = s.setupScore as Record<string, unknown>
          return `${symbols[i]}: $${fmt(q?.price)} +${Number(q?.changesPercentage ?? 0).toFixed(1)}% | Score: ${sc?.total}/100 | ${sc?.status} | ${s.catalystQuality} | ${s.dataQuality}`
        })
        return {
          content: [{
            type: 'text',
            text: `**Ticker Comparison**\n${rows.join('\n')}`,
          }],
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    }
  }
})

function fmt(v: unknown): string {
  if (v == null) return 'n/a'
  return `$${Number(v).toFixed(2)}`
}

function formatVol(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`
  return String(v)
}

function formatSnapshot(snap: Record<string, unknown>): string {
  const q = snap.quote as Record<string, unknown>
  const t = snap.technical as Record<string, unknown>
  const sc = snap.setupScore as Record<string, unknown>
  const bd = sc?.breakdown as Record<string, unknown>
  const levels = snap.sessionLevels as Record<string, unknown>
  const pullbacks = snap.pullbacks as Array<Record<string, unknown>>
  const warnings = snap.warnings as string[]

  return [
    `**${q?.symbol} — ${q?.name}**`,
    `Timestamp: ${new Date(Number(snap.timestamp)).toISOString()}`,
    `Session: ${snap.sessionType} | Data quality: ${snap.dataQuality}`,
    '',
    '**Market State**',
    `Price: ${fmt(q?.price)} | Change: +${Number(q?.changesPercentage ?? 0).toFixed(2)}%`,
    `Day: ${fmt(q?.dayLow)} – ${fmt(q?.dayHigh)} | Vol: ${formatVol(Number(q?.volume ?? 0))}`,
    `RVOL: ${t?.relativeVolume ? Number(t.relativeVolume).toFixed(1) : 'n/a'}x`,
    '',
    '**Trend**',
    `5-min: ${t?.trend5m} | 15-min: ${t?.trend15m}`,
    `VWAP dist: ${t?.distanceFromVwapPct ? `${Number(t.distanceFromVwapPct).toFixed(1)}%` : 'n/a'}`,
    `RSI: ${t?.rsi14 ? Number(t.rsi14).toFixed(1) : 'n/a'}`,
    `Higher H/L: ${t?.higherHighsLows} | Lower H/L: ${t?.lowerHighsLows}`,
    '',
    '**Key Levels**',
    `VWAP: ${fmt(levels?.vwap)} | 9 EMA: ${fmt(t?.ema9)} | 20 EMA: ${fmt(t?.ema20)}`,
    `OR5: ${fmt(levels?.or5High)} / ${fmt(levels?.or5Low)}`,
    `PM High: ${fmt(levels?.premarketHigh)} | PDH: ${fmt(levels?.previousDayHigh)}`,
    '',
    '**Catalyst**',
    `${snap.catalystSummary}`,
    `Quality: ${snap.catalystQuality} | Category: ${snap.catalystCategory}`,
    '',
    '**Setup Score: ${sc?.total}/100 — ${sc?.classification}**',
    `Trend/Structure: ${bd?.trendStructure}/20 | Volume/Liq: ${bd?.volumeLiquidity}/15`,
    `Catalyst: ${bd?.catalystQuality}/15 | Pullback: ${bd?.pullbackQuality}/20`,
    `S/R Clarity: ${bd?.srClarity}/10 | R/R: ${bd?.rewardRisk}/10 | Extension: ${bd?.extensionRisk}/10`,
    '',
    `**Verdict: ${sc?.status}**`,
    '',
    pullbacks?.length ? `**Best Pullback: ${pullbacks[0]?.name}**` : '**No clean pullback setup identified.**',
    pullbacks?.[0] ? `Entry: $${Number(pullbacks[0].entryZoneLow).toFixed(2)}–$${Number(pullbacks[0].entryZoneHigh).toFixed(2)} | Stop: $${Number(pullbacks[0].invalidation).toFixed(2)}` : '',
    pullbacks?.[0]?.confirmation ? `Confirmation: ${pullbacks[0].confirmation}` : '',
    '',
    warnings?.length ? `**Warnings:**\n${warnings.map(w => `⚠️  ${w}`).join('\n')}` : '',
  ].join('\n')
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Intraday Trading Companion MCP server running on stdio')
}

main().catch(err => {
  console.error('MCP server error:', err)
  process.exit(1)
})
