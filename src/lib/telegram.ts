/**
 * Telegram alert delivery (server-side only — the bot token must never reach
 * the browser). Sends BUY signals as texts via the Telegram Bot API.
 *
 * Setup: create a bot with @BotFather → TELEGRAM_BOT_TOKEN; message the bot
 * once, then read your chat id from getUpdates → TELEGRAM_CHAT_ID. Both live
 * in .env.local; when either is missing, sends are silently skipped so the
 * app runs fine without Telegram configured.
 */

import type { BuySignalRecord } from '@/types'

const API_TIMEOUT_MS = 10_000

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
}

// Micro-caps need more decimals than large caps (matches px() in signals.ts).
function px(n: number): string {
  return `$${n.toFixed(Math.abs(n) < 1 ? 3 : 2)}`
}

export function formatBuySignal(b: BuySignalRecord): string {
  const targets = b.targets.slice(0, 2).map(px).join(' → ') || 'open'
  const rr = b.rewardRisk != null ? `${b.rewardRisk.toFixed(1)}:1` : 'n/a'
  const rvol = b.ctxRelVol != null ? ` · RVOL ${b.ctxRelVol.toFixed(1)}` : ''
  const lines = [
    `🚨 <b>BUY ${b.symbol}</b> — ${b.setupType.replace(/_/g, ' ')} triggered`,
    `Enter ~${px(b.entryHigh)} · Stop ${px(b.stop)} · Sell into ${targets}`,
    `R/R ${rr} · Score ${b.score} (${b.grade})${rvol} · Price ${px(b.priceAtSignal)}`,
    `Plan: trim at T1 → move stop to breakeven → trail the rest`,
  ]
  return lines.join('\n')
}

/** Send a message to the configured chat. Returns false when unconfigured or on API failure — never throws. */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) return false

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error('telegram send failed:', res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.error('telegram send error:', err)
    return false
  }
}
