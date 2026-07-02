import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { TickerSnapshot } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 60

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

function buildSystemPrompt(snapshot: TickerSnapshot | null): string {
  const base = `You are an intraday trading companion — a concise, direct trading advisor embedded inside a live US equity trading dashboard. You help the user think through setups, validate their reasoning, identify risks, and plan trades. You are not a financial advisor; the user is a trader making their own decisions and you are their thinking partner.

Style: Be direct and brief. Use bullet points. No disclaimers about "not financial advice" — the user already knows. Lead with the most important point. Speak like an experienced prop trader would to a colleague.

When discussing a specific ticker you have been given live analysis including price, technicals, session levels, news/catalyst, S/R zones, setup score, breakout state, and trade plans. Reference these numbers precisely rather than speaking in generalities.

Time context: Today is ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Current ET time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })}.`

  if (!snapshot) {
    return base + '\n\nNo ticker is currently selected — you can discuss general concepts or ask the user what they are looking at.'
  }

  const s = snapshot
  const t = s.technical
  const sl = s.sessionLevels
  const bo = s.breakoutStatus

  const contextBlock = `

── CURRENT TICKER: ${s.symbol} ──────────────────────────────
Price: $${s.quote.price.toFixed(2)} (${s.quote.changesPercentage >= 0 ? '+' : ''}${s.quote.changesPercentage.toFixed(2)}% today)
Volume: ${s.quote.volume.toLocaleString()} | AvgVol: ${s.quote.avgVolume.toLocaleString()} | RVOL: ${t.relativeVolume != null ? t.relativeVolume.toFixed(1) + 'x' : 'n/a'}
Session: ${s.sessionType} | Data quality: ${s.dataQuality}

CATALYST: ${s.catalystQuality} — ${s.catalystCategory}
Summary: ${s.catalystSummary}

SETUP SCORE: ${s.setupScore.total}/100 (${s.setupScore.status})
  Trend/Structure: ${s.setupScore.breakdown.trendStructure}/20
  Volume/Liquidity: ${s.setupScore.breakdown.volumeLiquidity}/15
  Catalyst: ${s.setupScore.breakdown.catalystQuality}/15
  Pullback Quality: ${s.setupScore.breakdown.pullbackQuality}/20
  S/R Clarity: ${s.setupScore.breakdown.srClarity}/10
  R/R: ${s.setupScore.breakdown.rewardRisk}/10
  Extension Risk: ${s.setupScore.breakdown.extensionRisk}/10

BREAKOUT STATE: ${bo.state.toUpperCase()}${bo.level ? ` @ $${bo.level.toFixed(2)} (${bo.levelLabel})` : ''}
${bo.description}

KEY LEVELS:
  VWAP: ${sl.vwap ? '$' + sl.vwap.toFixed(2) : 'n/a'}
  Day High: ${sl.regularHigh ? '$' + sl.regularHigh.toFixed(2) : 'n/a'} | Day Low: ${sl.regularLow ? '$' + sl.regularLow.toFixed(2) : 'n/a'}
  PM High: ${sl.premarketHigh ? '$' + sl.premarketHigh.toFixed(2) : 'n/a'} | PM Low: ${sl.premarketLow ? '$' + sl.premarketLow.toFixed(2) : 'n/a'}
  OR5: ${sl.or5High ? '$' + sl.or5High.toFixed(2) : 'n/a'} / ${sl.or5Low ? '$' + sl.or5Low.toFixed(2) : 'n/a'}
  Prev Close: ${sl.previousClose ? '$' + sl.previousClose.toFixed(2) : 'n/a'} | PDH: ${sl.previousDayHigh ? '$' + sl.previousDayHigh.toFixed(2) : 'n/a'}

TECHNICALS:
  9 EMA: ${t.ema9 ? '$' + t.ema9.toFixed(2) : 'n/a'} | 20 EMA: ${t.ema20 ? '$' + t.ema20.toFixed(2) : 'n/a'}
  50 MA: ${t.ma50Daily ? '$' + t.ma50Daily.toFixed(2) : 'n/a'} | 200 MA: ${t.ma200Daily ? '$' + t.ma200Daily.toFixed(2) : 'n/a'}
  RSI: ${t.rsi14 != null ? t.rsi14.toFixed(1) : 'n/a'} | ATR: ${t.atr != null ? t.atr.toFixed(3) : 'n/a'}
  VWAP dist: ${t.distanceFromVwapPct != null ? t.distanceFromVwapPct.toFixed(1) + '%' : 'n/a'}
  Trend 5m: ${t.trend5m} | Trend 15m: ${t.trend15m}
  HH/HL: ${t.higherHighsLows == null ? 'n/a' : t.higherHighsLows ? 'yes' : 'no'} | LH/LL: ${t.lowerHighsLows == null ? 'n/a' : t.lowerHighsLows ? 'yes' : 'no'}
  Volume trend: ${t.volumeTrend} | VWAP crosses: ${t.vwapCrossCount}

${s.pullbacks.length > 0 ? `BEST PULLBACK SETUP: ${s.pullbacks[0].name}
  Entry: $${s.pullbacks[0].entryZoneLow.toFixed(2)}–$${s.pullbacks[0].entryZoneHigh.toFixed(2)}
  Stop/Invalidation: $${s.pullbacks[0].invalidation.toFixed(2)}
  Target 1: ${s.pullbacks[0].target1 ? '$' + s.pullbacks[0].target1.toFixed(2) : 'n/a'}
  R/R: ${s.pullbacks[0].rewardRisk ? s.pullbacks[0].rewardRisk.toFixed(1) + ':1' : 'n/a'}
  Confidence: ${s.pullbacks[0].confidenceScore}%` : 'No pullback scenarios identified.'}

${s.warnings.length > 0 ? `WARNINGS: ${s.warnings.join(' | ')}` : 'No active warnings.'}

TOP S/R ZONES (nearest first):
${s.zones.slice(0, 5).map(z => `  ${z.type.toUpperCase()} $${z.lower.toFixed(2)}–$${z.upper.toFixed(2)} | strength ${z.strengthScore}/10 | ${z.reasons.slice(0, 2).join(', ')}`).join('\n')}

RECENT NEWS:
${s.news.slice(0, 3).map(n => `  [${n.quality}] ${n.title} (${n.age})`).join('\n')}
──────────────────────────────────────────────────`

  return base + contextBlock
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set. Add it to your .env.local file.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }

  let body: { messages: Array<{ role: string; content: string }>; snapshot: TickerSnapshot | null }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
  }

  const { messages, snapshot } = body

  // Validate messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages required' }), { status: 400 })
  }

  const systemPrompt = buildSystemPrompt(snapshot)

  // Build Anthropic messages — strip any system-role messages from history
  const anthropicMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: anthropicMessages,
  })

  // Return a streaming text response
  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            controller.enqueue(encoder.encode(chunk.delta.text))
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Stream error'
        controller.enqueue(encoder.encode(`\n\n[Error: ${msg}]`))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    },
  })
}
