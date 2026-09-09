/**
 * Broker-truth ledger — OFFLINE rebuild from the frozen raw evidence archive.
 *
 * Reads the immutable raw artifacts written by scripts/broker-acquire.ts
 * (broker-activities.raw.json + broker-orders.raw.json + broker-acquisition.json),
 * VERIFIES their hashes against the acquisition manifest, then rebuilds the normalized
 * broker ledger deterministically — NO network, NO Alpaca call. This is the replay path
 * that proves the ledger is reproducible from frozen evidence, and fails closed if the
 * raw source was mutated after acquisition or the acquisition was incomplete.
 *
 *   npx tsx scripts/broker-ledger.ts 2026-09-08
 *   npx tsx scripts/broker-ledger.ts 2026-09-08 --evidence <dir> --trades <path>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { LedgerTradeRef } from '@/lib/research/broker-ledger'
import { sha256Bytes } from '@/lib/research/session-snapshot'
import { rebuildBrokerLedgerFromArchive, type RawBrokerArchive, type BrokerAcquisitionManifest } from '@/lib/research/broker-acquire'

const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }

function readVerified(dir: string, name: string, manifest: BrokerAcquisitionManifest): string {
  const text = readFileSync(join(dir, name), 'utf8')
  const mf = manifest.files.find(f => f.name === name)
  if (!mf) throw new Error(`manifest has no entry for ${name}`)
  const sha = sha256Bytes(text)
  if (sha !== mf.sha256) throw new Error(`HASH MISMATCH for ${name}: ${sha.slice(0, 12)}… ≠ manifest ${mf.sha256.slice(0, 12)}… (raw evidence mutated)`)
  return text
}

async function main() {
  const day = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
  if (!day) { console.error('usage: tsx scripts/broker-ledger.ts <ET-day> [--evidence <dir>] [--trades <path>]'); process.exit(2) }

  const evidenceDir = arg('--evidence') ?? join(process.cwd(), 'data', 'research-cache', 'broker-evidence', day)
  const tradesPath = arg('--trades') ?? join(homedir(), `.companion-paper-trades-${day}.json`)
  const outDir = join(process.cwd(), 'data', 'research-cache', 'broker-ledger')
  const manifestPath = join(evidenceDir, 'broker-acquisition.json')
  if (!existsSync(manifestPath)) { console.error(`no acquisition manifest at ${manifestPath} — run scripts/broker-acquire.ts ${day} first`); process.exit(2) }
  if (!existsSync(tradesPath)) { console.error(`trades file not found: ${tradesPath}`); process.exit(2) }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrokerAcquisitionManifest
  // Hash-verify each raw artifact against the manifest (mutation → fail closed).
  const activities = JSON.parse(readVerified(evidenceDir, 'broker-activities.raw.json', manifest))
  const ordersClientIds = JSON.parse(readVerified(evidenceDir, 'broker-orders.raw.json', manifest))
  const positions = JSON.parse(readVerified(evidenceDir, 'broker-positions.raw.json', manifest))
  const archive: RawBrokerArchive = { activities, ordersClientIds, positions }

  const rawTrades = JSON.parse(readFileSync(tradesPath, 'utf8')) as Array<Record<string, unknown>>
  const trades: LedgerTradeRef[] = rawTrades.map(t => ({ id: String(t.id), symbol: String(t.symbol), setupId: String(t.setupId), plannedRisk: t.plannedRisk == null ? null : Number(t.plannedRisk) }))

  const ledger = rebuildBrokerLedgerFromArchive(day, archive, trades, manifest.activitiesComplete)

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, `broker-ledger-${day}.json`), JSON.stringify({ ...ledger, evidenceDir, rebuiltAtUtc: new Date().toISOString() }, null, 2))

  console.log(`\nBroker ledger (OFFLINE rebuild from frozen raw) — ${day}`)
  console.log(`  raw hashes verified against manifest ✓  activitiesComplete=${manifest.activitiesComplete} positionsAcquired=${manifest.positionsAcquired}`)
  if (!manifest.activitiesComplete) console.log(`  !! acquisition was INCOMPLETE (${manifest.incompleteReason}) — ledger NOT authoritative`)
  for (const t of ledger.perTrade) console.log(`  ${t.symbol.padEnd(6)} ${t.setupId.padEnd(30)} entry ${t.entryQty}@${t.entryVwap?.toFixed(4) ?? '—'} exit ${t.exitQty}@${t.exitVwap?.toFixed(4) ?? '—'} P&L ${t.brokerPnl.toFixed(2)}`)
  console.log(`  contentSha256: ${ledger.contentSha256}`)
  process.exit(manifest.activitiesComplete ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
