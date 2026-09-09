/**
 * Read-only broker EVIDENCE acquisition — writes the immutable raw archive.
 *
 * Walks the whole ET-day FILL activity (paginated), resolves each order's
 * client_order_id (read-only getOrder), and snapshots current positions (read-only
 * getPositions). Writes RAW artifacts + a hashed acquisition manifest, then derives the
 * normalized broker ledger FROM the archive. Places/cancels/replaces NOTHING; never
 * closes a position; never mutates trade or broker state; refuses the live endpoint;
 * never archives credentials.
 *
 *   npx tsx scripts/broker-acquire.ts 2026-09-08
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { loadEnvLocal } from '@/lib/execution/env'
import { AlpacaBroker } from '@/lib/execution/alpaca'
import { collectDayFills, etDayBoundsMs, type FillPage, type RawFillActivity } from '@/lib/research/alpaca-fills'
import type { LedgerTradeRef } from '@/lib/research/broker-ledger'
import {
  BROKER_EVIDENCE_SCHEMA, hashArtifact, rebuildBrokerLedgerFromArchive,
  type RawBrokerArchive, type RawPosition, type BrokerAcquisitionManifest,
} from '@/lib/research/broker-acquire'

loadEnvLocal()

const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }
const PAGE = 100

async function main() {
  const day = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
  if (!day) { console.error('usage: tsx scripts/broker-acquire.ts <ET-day> [--trades <p>] [--out <dir>]'); process.exit(2) }

  const tradesPath = arg('--trades') ?? join(homedir(), `.companion-paper-trades-${day}.json`)
  const outDir = arg('--out') ?? join(process.cwd(), 'data', 'research-cache', 'broker-evidence', day)
  const ledgerDir = join(process.cwd(), 'data', 'research-cache', 'broker-ledger')
  if (!existsSync(tradesPath)) { console.error(`trades file not found: ${tradesPath}`); process.exit(2) }
  const rawTrades = JSON.parse(readFileSync(tradesPath, 'utf8')) as Array<Record<string, unknown>>
  const trades: LedgerTradeRef[] = rawTrades.map(t => ({ id: String(t.id), symbol: String(t.symbol), setupId: String(t.setupId), plannedRisk: t.plannedRisk == null ? null : Number(t.plannedRisk) }))

  const keyId = process.env.ALPACA_KEY_ID, secret = process.env.ALPACA_SECRET_KEY
  const base = (process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets').replace(/\/$/, '')
  if (!keyId || !secret) { console.error('ALPACA_KEY_ID / ALPACA_SECRET_KEY missing'); process.exit(2) }
  if (/(^|\/\/)api\.alpaca\.markets/.test(base)) { console.error(`refusing live endpoint ${base} — paper only`); process.exit(2) }
  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret }   // request-only; never archived
  const { startMs, endMs } = etDayBoundsMs(day)
  const activitiesEndpoint = '/v2/account/activities/FILL'
  const positionsEndpoint = '/v2/positions'

  const fetchPage = async (token: string | null): Promise<FillPage> => {
    const p = new URLSearchParams({ after: new Date(startMs).toISOString(), until: new Date(endMs).toISOString(), direction: 'asc', page_size: String(PAGE) })
    if (token) p.set('page_token', token)
    const res = await fetch(`${base}${activitiesEndpoint}?${p.toString()}`, { headers })
    if (!res.ok) throw new Error(`activities ${res.status}: ${await res.text()}`)
    const rows = (await res.json()) as RawFillActivity[]
    const nextPageToken = rows.length === PAGE ? String(rows[rows.length - 1].id) : null
    return { rows, nextPageToken }
  }

  const dayFills = await collectDayFills({ day, fetchPage })

  // Resolve client_order_id per distinct order (read-only getOrder).
  const broker = new AlpacaBroker()
  const ordersClientIds: Record<string, string | null> = {}
  for (const f of dayFills.rawActivities) {
    const oid = f.order_id == null ? null : String(f.order_id)
    if (oid && !(oid in ordersClientIds)) {
      try { ordersClientIds[oid] = (await broker.getOrder(oid))?.clientOrderId ?? null } catch { ordersClientIds[oid] = null }
    }
  }

  // Independent flatness snapshot (read-only).
  let positions: RawPosition[] = []
  let positionsAcquired = false
  try { positions = (await broker.getPositions()).map(p => ({ symbol: p.symbol, qty: p.qty })); positionsAcquired = true }
  catch (e) { console.error(`  positions query failed — flatness will be UNCONFIRMED: ${(e as Error).message}`) }

  const archive: RawBrokerArchive = { activities: dayFills.rawActivities, ordersClientIds, positions }

  mkdirSync(outDir, { recursive: true })
  const write = (name: string, v: unknown) => { const { text, bytes, sha256 } = hashArtifact(v); writeFileSync(join(outDir, name), text); return { name, bytes, sha256 } }
  const fActs = write('broker-activities.raw.json', archive.activities)
  const fOrds = write('broker-orders.raw.json', archive.ordersClientIds)
  const fPos = write('broker-positions.raw.json', archive.positions)

  const manifest: BrokerAcquisitionManifest = {
    schema: BROKER_EVIDENCE_SCHEMA, day, acquiredAtUtc: new Date().toISOString(), environment: 'PAPER',
    activitiesEndpoint, positionsEndpoint, pages: dayFills.pages, requestCount: dayFills.pages,
    activitiesRawCount: dayFills.rawCount, activitiesInWindow: dayFills.fills.length, activitiesDuplicates: dayFills.duplicates,
    activitiesComplete: dayFills.complete, incompleteReason: dayFills.incompleteReason,
    positionsAcquired, positionsCount: positions.length,
    files: [fActs, fOrds, fPos],
  }
  writeFileSync(join(outDir, 'broker-acquisition.json'), hashArtifact(manifest).text)

  // Derive the normalized ledger FROM the archive (not from memory of the fetch).
  const ledger = rebuildBrokerLedgerFromArchive(day, archive, trades, dayFills.complete)
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(join(ledgerDir, `broker-ledger-${day}.json`), JSON.stringify({ ...ledger, evidenceDir: outDir }, null, 2))

  console.log(`\nBroker evidence acquired — ${day}  (${outDir})`)
  console.log(`  activities: pages=${dayFills.pages} raw=${dayFills.rawCount} inWindow=${dayFills.fills.length} dup=${dayFills.duplicates} complete=${dayFills.complete}`)
  if (!dayFills.complete) console.log(`  !! ACTIVITIES INCOMPLETE (${dayFills.incompleteReason}) — NOT authoritative`)
  console.log(`  positions: acquired=${positionsAcquired} count=${positions.length}`)
  console.log(`  ledger contentSha256: ${ledger.contentSha256}`)
  process.exit(dayFills.complete && positionsAcquired ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
