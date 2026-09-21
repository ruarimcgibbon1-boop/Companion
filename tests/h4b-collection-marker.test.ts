/**
 * H4B — official collection-start marker: immutability, boundary classification, no side effects.
 * (STEP 4/5/7; tests E–M.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createCollectionMarker, readCollectionMarker, collectionMarkerPath, classifyOfficial,
  type CollectionStartMarker,
} from '../src/lib/leader/h4b-collection-marker'

const EPOCH = 'h4b-epoch-1'
const baseInput = {
  startedAtUtc: '2026-09-22T13:30:00.000Z',
  experimentSpecVersion: 'h4b-leadercont-2', experimentConfigHash: '89e8b4e0', experimentEpoch: EPOCH,
  decisionPolicyVersion: 'h4b-decision-2', decisionPolicyHash: 'e3c1fe88',
  producerHead: 'abc123', branch: 'research/h4b-leader-continuation-shadow',
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'h4bmark-')); process.env.COMPANION_H4B_DIR = dir })
afterEach(() => { delete process.env.COMPANION_H4B_DIR; rmSync(dir, { recursive: true, force: true }) })

describe('H4B collection marker', () => {
  it('E. first start creates the marker', () => {
    const res = createCollectionMarker(baseInput)
    expect(res.ok).toBe(true)
    expect(existsSync(collectionMarkerPath(EPOCH))).toBe(true)
  })

  it('F. second start REFUSES to overwrite (immutable start time)', () => {
    const first = createCollectionMarker(baseInput)
    expect(first.ok).toBe(true)
    const startedAt = readCollectionMarker(EPOCH)!.startedAtUtc
    // Attempt a second start with a DIFFERENT time — must be refused, original preserved.
    const second = createCollectionMarker({ ...baseInput, startedAtUtc: '2999-01-01T00:00:00.000Z' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('ALREADY_EXISTS')
    expect(readCollectionMarker(EPOCH)!.startedAtUtc).toBe(startedAt)   // unchanged
  })

  it('G. marker contains exact hashes / version / epoch / status', () => {
    createCollectionMarker(baseInput)
    const m = readCollectionMarker(EPOCH)!
    expect(m.status).toBe('RUNNING')
    expect(m).toMatchObject({
      experimentSpecVersion: 'h4b-leadercont-2', experimentConfigHash: '89e8b4e0', experimentEpoch: EPOCH,
      decisionPolicyVersion: 'h4b-decision-2', decisionPolicyHash: 'e3c1fe88',
      producerHead: 'abc123', branch: 'research/h4b-leader-continuation-shadow',
    })
  })

  it('L. absence of a marker cannot masquerade as official collection', () => {
    expect(readCollectionMarker(EPOCH)).toBeNull()
    expect(classifyOfficial(null, { candidateObservedAt: '2026-09-22T14:00:00Z' })).toBe('NO_MARKER')
  })

  const marker = (): CollectionStartMarker => { createCollectionMarker(baseInput); return readCollectionMarker(EPOCH)! }

  it('H. a pre-start candidate is PRE_OFFICIAL', () => {
    expect(classifyOfficial(marker(), { candidateObservedAt: '2026-09-22T13:29:59Z', experimentConfigHash: '89e8b4e0', experimentEpoch: EPOCH })).toBe('PRE_OFFICIAL')
  })
  it('I. a post-start candidate with matching hash/epoch is OFFICIAL', () => {
    expect(classifyOfficial(marker(), { candidateObservedAt: '2026-09-22T13:30:01Z', experimentConfigHash: '89e8b4e0', experimentEpoch: EPOCH })).toBe('OFFICIAL')
  })
  it('J. a wrong experiment hash is rejected (not silently mixed)', () => {
    expect(classifyOfficial(marker(), { candidateObservedAt: '2026-09-22T14:00:00Z', experimentConfigHash: 'deadbeef', experimentEpoch: EPOCH })).toBe('HASH_MISMATCH')
  })
  it('K. a wrong epoch is rejected', () => {
    expect(classifyOfficial(marker(), { candidateObservedAt: '2026-09-22T14:00:00Z', experimentConfigHash: '89e8b4e0', experimentEpoch: 'h4b-epoch-2' })).toBe('EPOCH_MISMATCH')
  })

  it('M. marker creation has no execution/provider side effect (only the marker file is written)', () => {
    createCollectionMarker(baseInput)
    // The only file in the marker dir is the epoch marker; the module imports no executor/broker/provider.
    expect(readdirSync(dir)).toEqual([`${EPOCH}.collection-start.json`])
    const src = readFileSync(join(process.cwd(), 'src/lib/leader/h4b-collection-marker.ts'), 'utf8')
    expect(/executor|paper-|broker|arbitrat|risk-manager|fetch\(|getQuote|getIntradayCandles|onSignal/i.test(src)).toBe(false)
  })
})
