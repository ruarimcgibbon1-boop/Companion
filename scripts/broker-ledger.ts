/**
 * Broker-truth ledger (C2.1) — READ-ONLY.
 *
 * Reconstructs exact per-trade broker economics for an ET day from Alpaca's own
 * FILL activity, mapped to trades via client_order_id. Writes a hashed artifact so
 * nightly reconciliation cites primary fills instead of equity subtraction.
 *
 * Reads only: Alpaca FILL activities + getOrder (for client_order_id). Places no
 * orders, cancels nothing, mutates no local trade or broker state.
 *
 *   npx tsx scripts/broker-ledger.ts 2026-08-27
 *   npx tsx scripts/broker-ledger.ts 2026-08-27 --trades /path/to/snapshot/paper-trades.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { loadEnvLocal } from '@/lib/execution/env'
import { AlpacaBroker } from '@/lib/execution/alpaca'
import { buildBrokerLedger, type LedgerFill, type LedgerTradeRef } from '@/lib/research/broker-ledger'

loadEnvLocal()

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

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
  const symbols = [...new Set(trades.map(t => t.symbol))]
  // Earliest activity anchor: earliest trade creation minus 1h, so no fill is missed.
  const earliest = Math.min(...rawTrades.map(t => Number(t.createdAt ?? t.entrySubmittedAt ?? Date.now())))
  const sinceMs = (Number.isFinite(earliest) ? earliest : Date.now()) - 3_600_000

  const broker = new AlpacaBroker()
  if (!broker.getRecentFills) { console.error('broker has no getRecentFills — cannot build ledger'); process.exit(1) }

  // Fetch fills per symbol, then resolve client_order_id per distinct order (cached).
  const orderClientId = new Map<string, string | null>()
  const fills: LedgerFill[] = []
  let fetchFailures = 0
  for (const sym of symbols) {
    let raw: Awaited<ReturnType<NonNullable<typeof broker.getRecentFills>>>
    try {
      raw = await broker.getRecentFills(sym, sinceMs)
    } catch (e) {
      fetchFailures++
      console.error(`  ! getRecentFills(${sym}) failed: ${(e as Error).message}`)
      continue
    }
    for (const f of raw) {
      let clientOrderId: string | null = null
      if (f.orderId) {
        if (!orderClientId.has(f.orderId)) {
          try { orderClientId.set(f.orderId, (await broker.getOrder(f.orderId))?.clientOrderId ?? null) }
          catch { orderClientId.set(f.orderId, null) }
        }
        clientOrderId = orderClientId.get(f.orderId) ?? null
      }
      fills.push({ ...f, clientOrderId })
    }
  }

  const ledger = buildBrokerLedger(day, fills, trades)

  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `broker-ledger-${day}.json`)
  const artifact = { ...ledger, generatedAtUtc: new Date().toISOString(), tradesSource: tradesPath, fetchFailures }
  writeFileSync(outFile, JSON.stringify(artifact, null, 2))

  // Console summary (metadata + economics; no equity subtraction anywhere).
  console.log(`\nBroker-truth ledger — ${day}`)
  console.log(`  fills: ${fills.length} (${ledger.totals.mappedFills} mapped, ${ledger.totals.unmappedFills} unmapped)  fetchFailures: ${fetchFailures}`)
  for (const t of ledger.perTrade) {
    const flags = t.flags.length ? `  [${t.flags.join(',')}]` : ''
    console.log(`  ${t.symbol.padEnd(6)} ${t.setupId.padEnd(32)} entry ${t.entryQty}@${t.entryVwap?.toFixed(4) ?? '—'}  exit ${t.exitQty}@${t.exitVwap?.toFixed(4) ?? '—'}  P&L ${t.brokerPnl >= 0 ? '+' : ''}${t.brokerPnl.toFixed(2)}  R ${t.brokerR == null ? '—' : (t.brokerR >= 0 ? '+' : '') + t.brokerR.toFixed(3)}${flags}`)
  }
  if (ledger.unmapped.length) {
    console.log(`  UNMAPPED (external) fills: ${ledger.unmapped.length}`)
    for (const f of ledger.unmapped) console.log(`    ${f.symbol} ${f.side} ${f.qty}@${f.price} order=${f.orderId ?? '—'} coid=${f.clientOrderId ?? '—'}`)
  }
  console.log(`  TOTAL broker P&L: ${ledger.totals.brokerPnl >= 0 ? '+' : ''}${ledger.totals.brokerPnl.toFixed(2)}`)
  console.log(`  contentSha256: ${ledger.contentSha256}`)
  console.log(`  written: ${outFile}\n`)
  if (fetchFailures > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exit(1) })
