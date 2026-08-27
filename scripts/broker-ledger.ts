/**
 * Broker-truth ledger (C2.1, corrected per Finding 1) — READ-ONLY.
 *
 * Walks the WHOLE ET-day Alpaca FILL activity via cursor pagination (never one
 * page of 100), constrains to the ET day, resolves client_order_id per order, and
 * maps fills to trades. FAILS CLOSED: if retrieval is incomplete the artifact is
 * flagged `retrievalComplete=false` and the process exits nonzero — it never
 * claims exact broker truth on a partial read. Unmapped (external) fills are kept
 * explicit. Places no orders, mutates no trade or broker state.
 *
 *   npx tsx scripts/broker-ledger.ts 2026-08-27
 *   npx tsx scripts/broker-ledger.ts 2026-08-27 --trades <snapshot/paper-trades.json>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { loadEnvLocal } from '@/lib/execution/env'
import { AlpacaBroker } from '@/lib/execution/alpaca'
import { collectDayFills, etDayBoundsMs, type FillPage, type RawFillActivity } from '@/lib/research/alpaca-fills'
import { buildBrokerLedger, type LedgerFill, type LedgerTradeRef } from '@/lib/research/broker-ledger'

loadEnvLocal()

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const PAGE = 100

async function main() {
  const day = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
  if (!day) { console.error('usage: tsx scripts/broker-ledger.ts <ET-day> [--trades <path>] [--out <dir>]'); process.exit(2) }

  const tradesPath = arg('--trades') ?? join(homedir(), `.companion-paper-trades-${day}.json`)
  const outDir = arg('--out') ?? join(process.cwd(), 'data', 'research-cache', 'broker-ledger')
  if (!existsSync(tradesPath)) { console.error(`trades file not found: ${tradesPath}`); process.exit(2) }

  const rawTrades = JSON.parse(readFileSync(tradesPath, 'utf8')) as Array<Record<string, unknown>>
  const trades: LedgerTradeRef[] = rawTrades.map(t => ({
    id: String(t.id), symbol: String(t.symbol), setupId: String(t.setupId),
    plannedRisk: t.plannedRisk == null ? null : Number(t.plannedRisk),
  }))

  // Read-only auth surface: keys from env, paper base, live endpoint refused.
  const keyId = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY
  const base = (process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets').replace(/\/$/, '')
  if (!keyId || !secret) { console.error('ALPACA_KEY_ID / ALPACA_SECRET_KEY missing'); process.exit(2) }
  if (/(^|\/\/)api\.alpaca\.markets/.test(base)) { console.error(`refusing live endpoint ${base} — paper only`); process.exit(2) }
  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret }
  const { startMs, endMs } = etDayBoundsMs(day)

  const fetchPage = async (token: string | null): Promise<FillPage> => {
    const p = new URLSearchParams({
      after: new Date(startMs).toISOString(), until: new Date(endMs).toISOString(),
      direction: 'asc', page_size: String(PAGE),
    })
    if (token) p.set('page_token', token)
    const res = await fetch(`${base}/v2/account/activities/FILL?${p.toString()}`, { headers })
    if (!res.ok) throw new Error(`activities ${res.status}: ${await res.text()}`)
    const rows = (await res.json()) as RawFillActivity[]
    // Alpaca cursor = last activity id; a short page means the cursor is exhausted.
    const nextPageToken = rows.length === PAGE ? String(rows[rows.length - 1].id) : null
    return { rows, nextPageToken }
  }

  const dayFills = await collectDayFills({ day, fetchPage })

  // Resolve client_order_id per distinct order (read-only getOrder).
  const broker = new AlpacaBroker()
  const orderClientId = new Map<string, string | null>()
  const fills: LedgerFill[] = []
  for (const f of dayFills.fills) {
    let clientOrderId: string | null = null
    if (f.orderId) {
      if (!orderClientId.has(f.orderId)) {
        try { orderClientId.set(f.orderId, (await broker.getOrder(f.orderId))?.clientOrderId ?? null) }
        catch { orderClientId.set(f.orderId, null) }
      }
      clientOrderId = orderClientId.get(f.orderId) ?? null
    }
    fills.push({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, filledAt: f.transactionTime, orderId: f.orderId, clientOrderId })
  }

  const ledger = buildBrokerLedger(day, fills, trades, 'alpaca-paper-activities/FILL(paginated)', dayFills.complete)

  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `broker-ledger-${day}.json`)
  writeFileSync(outFile, JSON.stringify({
    ...ledger,
    generatedAtUtc: new Date().toISOString(),
    tradesSource: tradesPath,
    retrieval: { complete: dayFills.complete, pages: dayFills.pages, rawCount: dayFills.rawCount, outOfWindow: dayFills.outOfWindow, incompleteReason: dayFills.incompleteReason },
  }, null, 2))

  console.log(`\nBroker-truth ledger — ${day}`)
  console.log(`  retrieval: pages=${dayFills.pages} rawActivities=${dayFills.rawCount} inWindow=${fills.length} outOfWindow=${dayFills.outOfWindow} complete=${dayFills.complete}`)
  if (!dayFills.complete) console.log(`  !! RETRIEVAL INCOMPLETE (${dayFills.incompleteReason}) — NOT authoritative broker truth`)
  for (const t of ledger.perTrade) {
    const flags = t.flags.length ? `  [${t.flags.join(',')}]` : ''
    console.log(`  ${t.symbol.padEnd(6)} ${t.setupId.padEnd(32)} entry ${t.entryQty}@${t.entryVwap?.toFixed(4) ?? '—'}  exit ${t.exitQty}@${t.exitVwap?.toFixed(4) ?? '—'}  P&L ${t.brokerPnl >= 0 ? '+' : ''}${t.brokerPnl.toFixed(2)}  R ${t.brokerR == null ? '—' : (t.brokerR >= 0 ? '+' : '') + t.brokerR.toFixed(3)}${flags}`)
  }
  if (ledger.unmapped.length) {
    console.log(`  UNMAPPED (external) fills: ${ledger.unmapped.length}`)
    for (const f of ledger.unmapped) console.log(`    ${f.symbol} ${f.side} ${f.qty}@${f.price} order=${f.orderId ?? '—'} coid=${f.clientOrderId ?? '—'}`)
  }
  console.log(`  TOTAL broker P&L: ${ledger.totals.brokerPnl >= 0 ? '+' : ''}${ledger.totals.brokerPnl.toFixed(2)}${dayFills.complete ? '' : '  (PARTIAL — do not trust)'}`)
  console.log(`  contentSha256: ${ledger.contentSha256}`)
  console.log(`  written: ${outFile}\n`)
  process.exit(dayFills.complete ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
