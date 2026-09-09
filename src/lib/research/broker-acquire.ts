/**
 * Raw broker evidence archival + offline replay — READ-ONLY, pure where possible.
 *
 * The derivation boundary the V2 evidence chain requires:
 *   Alpaca read-only acquisition
 *     → write RAW artifacts (activities, orders→coid map, positions) + acquisition manifest (hashes)
 *     → normalize the broker ledger FROM those raw artifacts
 *     → reconcile local vs normalized ledger + archived position snapshot
 * so the ledger and reconciliation are reproducible offline from the frozen raw source,
 * never from a re-query of Alpaca.
 *
 * NEVER archives credentials — API keys/secrets/Authorization headers live only in the
 * request layer and are not part of any response payload written here.
 */
import { normalizeFills, type RawFillActivity } from '@/lib/research/alpaca-fills'
import { buildBrokerLedger, type BrokerLedger, type LedgerFill, type LedgerTradeRef } from '@/lib/research/broker-ledger'
import { sha256Bytes } from '@/lib/research/session-snapshot'

export const BROKER_EVIDENCE_SCHEMA = 'broker-evidence/v1'

/** Raw Alpaca position row — only the fields flatness needs (as-received, unrounded). */
export interface RawPosition {
  symbol: string
  qty: number | string
  [k: string]: unknown   // preserve any other fields the broker returned
}

/** The immutable raw acquisition bundle written at EOD. */
export interface RawBrokerArchive {
  activities: RawFillActivity[]
  /** order id → client_order_id (from read-only getOrder), needed to attribute fills offline. */
  ordersClientIds: Record<string, string | null>
  positions: RawPosition[]
}

/** Non-secret acquisition metadata + per-file hashes. */
export interface BrokerAcquisitionManifest {
  schema: string
  day: string
  acquiredAtUtc: string
  environment: 'PAPER'
  activitiesEndpoint: string
  positionsEndpoint: string
  pages: number
  requestCount: number
  activitiesRawCount: number
  activitiesInWindow: number
  activitiesDuplicates: number
  activitiesComplete: boolean
  incompleteReason: string | null
  positionsAcquired: boolean
  positionsCount: number
  files: Array<{ name: string; bytes: number; sha256: string }>
}

/** Deterministic serialization used both to write and to hash an artifact. */
export function serializeArtifact(v: unknown): string {
  return JSON.stringify(v, null, 2)
}

export function hashArtifact(v: unknown): { bytes: number; sha256: string; text: string } {
  const text = serializeArtifact(v)
  return { bytes: Buffer.byteLength(text), sha256: sha256Bytes(text), text }
}

export interface PositionSnapshot { map: Map<string, number>; count: number }

/** Parse an archived raw positions array into a symbol→qty flatness map. */
export function positionsFromRaw(raw: readonly RawPosition[]): PositionSnapshot {
  const map = new Map<string, number>()
  for (const p of raw) map.set(String(p.symbol), Number(p.qty))
  return { map, count: raw.length }
}

/** Attribute fills to client_order_ids from the archived orders map, producing LedgerFills. */
export function ledgerFillsFromArchive(archive: RawBrokerArchive, day: string): LedgerFill[] {
  const { fills } = normalizeFills(archive.activities, day)
  return fills.map(f => ({
    symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, filledAt: f.transactionTime,
    orderId: f.orderId,
    clientOrderId: f.orderId != null ? (archive.ordersClientIds[f.orderId] ?? null) : null,
  }))
}

/**
 * Rebuild the normalized broker ledger entirely from the archived raw source — OFFLINE,
 * no network. Same inputs → same `contentSha256`.
 */
export function rebuildBrokerLedgerFromArchive(
  day: string,
  archive: RawBrokerArchive,
  trades: readonly LedgerTradeRef[],
  activitiesComplete: boolean,
): BrokerLedger {
  const fills = ledgerFillsFromArchive(archive, day)
  return buildBrokerLedger(day, fills, trades, 'archive:broker-activities.raw.json', activitiesComplete)
}
