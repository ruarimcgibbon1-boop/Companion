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
  const px = (n: number | null | undefined) => (n != null ? '$' + n.toFixed(2) : 'n/a')

  // Compact context — only the numbers a trader actually references. Kept lean
  // because this block is re-sent on every message; verbosity here is the main
  // driver of chat token cost. Ask for detail and the model still has the values.
  const best = s.pullbacks[0]
  const contextBlock = `

TICKER ${s.symbol} · ${px(s.quote.price)} (${s.quote.changesPercentage >= 0 ? '+' : ''}${s.quote.changesPercentage.toFixed(1)}%) · RVOL ${t.relativeVolume != null ? t.relativeVolume.toFixed(1) + 'x' : 'n/a'} · ${s.sessionType} · data ${s.dataQuality}
Catalyst: ${s.catalystQuality} (${s.catalystCategory})${s.catalystSummary ? ` — ${s.catalystSummary}` : ''}
Setup score ${s.setupScore.total}/100 (${s.setupScore.status}) · Breakout ${bo.state.toUpperCase()}${bo.level ? ` @ ${px(bo.level)} ${bo.levelLabel ?? ''}` : ''}
Levels: VWAP ${px(sl.vwap)} · HOD ${px(sl.regularHigh)} · LOD ${px(sl.regularLow)} · PMH ${px(sl.premarketHigh)} · PML ${px(sl.premarketLow)} · PDH ${px(sl.previousDayHigh)} · PrevClose ${px(sl.previousClose)}
EMAs: 9 ${px(t.ema9)} · 20 ${px(t.ema20)} · 50MA ${px(t.ma50Daily)} · RSI ${t.rsi14 != null ? t.rsi14.toFixed(0) : 'n/a'} · VWAPdist ${t.distanceFromVwapPct != null ? t.distanceFromVwapPct.toFixed(1) + '%' : 'n/a'} · trend ${t.trend5m}/${t.trend15m}
${best ? `Best setup: ${best.name} entry ${px(best.entryZoneLow)}–${px(best.entryZoneHigh)}, stop ${px(best.invalidation)}, T1 ${px(best.target1)}, R/R ${best.rewardRisk ? best.rewardRisk.toFixed(1) : 'n/a'}` : 'No clean setup.'}
${s.warnings.length ? `Warnings: ${s.warnings.slice(0, 3).join(' | ')}` : ''}
Zones: ${s.zones.slice(0, 3).map(z => `${z.type[0].toUpperCase()} ${px(z.lower)}–${px(z.upper)} (${z.strengthScore}/10)`).join(' · ')}
${s.news.length ? `News: ${s.news.slice(0, 2).map(n => `[${n.quality}] ${n.title}`).join(' · ')}` : ''}`

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

  // Build Anthropic messages — strip any system-role messages from history,
  // then keep only the most recent turns. Trading chats are short-horizon;
  // an unbounded transcript is re-billed on every message, so cap the window.
  const MAX_HISTORY = 10
  const anthropicMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    .slice(-MAX_HISTORY)

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 900,
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
