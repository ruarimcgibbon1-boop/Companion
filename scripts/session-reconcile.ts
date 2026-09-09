/**
 * Local-vs-broker session reconciliation — OFFLINE, READ-ONLY.
 *
 * Consumes the LOCAL paper trades, the broker-truth ledger (offline rebuild), and the
 * ARCHIVED raw position snapshot — all from frozen evidence, no Alpaca call — and emits a
 * deterministic, hash-stamped reconciliation report. A trade is only VERIFIED when broker
 * retrieval was complete AND an independent position snapshot was acquired; partial
 * evidence yields a clearly non-authoritative report. Mutates nothing; archives no secrets.
 *
 *   npx tsx scripts/session-reconcile.ts 2026-09-08
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type { BrokerLedger } from '@/lib/research/broker-ledger'
import { reconcile, localViewFromTrade } from '@/lib/research/broker-reconcile'
import { positionsFromRaw, type RawPosition, type BrokerAcquisitionManifest } from '@/lib/research/broker-acquire'
import { sha256Bytes } from '@/lib/research/session-snapshot'

const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const day = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined
  if (!day) { console.error('usage: tsx scripts/session-reconcile.ts <ET-day> [--trades <p>] [--ledger <p>] [--evidence <dir>] [--out <dir>]'); process.exit(2) }

  const tradesPath = arg('--trades') ?? join(homedir(), `.companion-paper-trades-${day}.json`)
  const ledgerPath = arg('--ledger') ?? join(process.cwd(), 'data', 'research-cache', 'broker-ledger', `broker-ledger-${day}.json`)
  const evidenceDir = arg('--evidence') ?? join(process.cwd(), 'data', 'research-cache', 'broker-evidence', day)
  const outDir = arg('--out') ?? join(process.cwd(), 'data', 'research-cache', 'reconcile')
  if (!existsSync(tradesPath)) { console.error(`trades file not found: ${tradesPath}`); process.exit(2) }
  if (!existsSync(ledgerPath)) { console.error(`broker ledger not found: ${ledgerPath} — run scripts/broker-ledger.ts ${day}`); process.exit(2) }

  const localViews = (JSON.parse(readFileSync(tradesPath, 'utf8')) as Array<Record<string, unknown>>).map(localViewFromTrade)
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as BrokerLedger

  // Independent flatness from the ARCHIVED raw position snapshot (hash-verified), not a live query.
  let positions: Map<string, number> | null = null
  const manifestPath = join(evidenceDir, 'broker-acquisition.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrokerAcquisitionManifest
    const posName = 'broker-positions.raw.json'
    const posText = existsSync(join(evidenceDir, posName)) ? readFileSync(join(evidenceDir, posName), 'utf8') : null
    const mf = manifest.files.find(f => f.name === posName)
    if (manifest.positionsAcquired && posText != null && mf && sha256Bytes(posText) === mf.sha256) {
      positions = positionsFromRaw(JSON.parse(posText) as RawPosition[]).map
    } else if (manifest.positionsAcquired && posText != null && mf && sha256Bytes(posText) !== mf.sha256) {
      console.error('  !! position snapshot HASH MISMATCH — treating flatness as unavailable')
    } else {
      console.log('  (position snapshot not acquired — flatness UNCONFIRMED, nothing authoritative-VERIFIED)')
    }
  } else {
    console.log('  (no acquisition manifest — flatness UNCONFIRMED)')
  }

  const report = reconcile(day, localViews, ledger, positions)

  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `reconcile-${day}.json`)
  writeFileSync(outFile, JSON.stringify({ ...report, generatedAtUtc: new Date().toISOString(), tradesSource: tradesPath, ledgerSource: ledgerPath, evidenceDir }, null, 2))

  console.log(`\nLocal-vs-broker reconciliation — ${day}`)
  if (!report.retrievalComplete) console.log('  !! broker retrieval INCOMPLETE — nothing can be VERIFIED')
  if (!report.positionSnapshotAvailable) console.log('  !! no position snapshot — broker flatness UNCONFIRMED, no authoritative VERIFIED')
  for (const r of report.perTrade) {
    console.log(`  ${r.symbol.padEnd(6)} ${r.setupId.padEnd(30)} ${r.classification.padEnd(28)} exitΔ ${r.delta.exitQty} pnlΔ ${r.delta.pnl == null ? '—' : r.delta.pnl.toFixed(2)} brokerPos ${r.brokerPositionQty ?? '—'}`)
  }
  const s = report.summary
  console.log(`  summary: verified=${s.verified} discrepancies=${s.discrepancies} unresolved=${s.unresolved} unmatched=${s.unmatched} / total=${s.total}`)
  console.log(`  contentSha256: ${report.contentSha256}`)
  process.exit(s.verified === s.total && report.retrievalComplete && report.positionSnapshotAvailable ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
