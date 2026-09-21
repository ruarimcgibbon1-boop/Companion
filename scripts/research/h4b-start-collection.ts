/**
 * H4B — official collection START command (research bookkeeping ONLY).
 *
 *   npm run h4b:start-collection   (or: npx tsx scripts/research/h4b-start-collection.ts)
 *
 * Verifies the tracked experiment + decision-policy fingerprints and the current producer HEAD, then
 * creates the IMMUTABLE official start marker and prints the exact official startedAtUtc. It does NOT
 * start the daemon, make provider calls, or touch execution. The human runs this deliberately, then
 * starts the normal Companion processes. A second run REFUSES (the official start time is never reset).
 */
import { spawnSync } from 'child_process'
import {
  EXPERIMENT_SPEC_VERSION, EXPERIMENT_EPOCH, experimentConfigHash, DEFAULT_LEADER_CONTINUATION_CONFIG,
} from '@/lib/leader/leader-continuation'
import { DECISION_POLICY_VERSION, decisionPolicyHash } from '@/lib/leader/leader-continuation-policy'
import { createCollectionMarker, readCollectionMarker, collectionMarkerPath } from '@/lib/leader/h4b-collection-marker'

function git(args: string[]): string | null {
  try {
    const r = spawnSync('git', args, { encoding: 'utf8' })
    const out = (r.stdout ?? '').trim()
    return r.status === 0 && out ? out : null
  } catch { return null }
}

function main(): void {
  const experimentConfigHashV = experimentConfigHash(DEFAULT_LEADER_CONTINUATION_CONFIG)
  const decisionPolicyHashV = decisionPolicyHash()
  const producerHead = git(['rev-parse', 'HEAD'])
  const branchRaw = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchRaw === 'HEAD' ? 'DETACHED' : branchRaw

  const existing = readCollectionMarker(EXPERIMENT_EPOCH)
  if (existing) {
    console.error('H4B OFFICIAL COLLECTION ALREADY STARTED — refusing to reset the official start time.')
    console.error(`  epoch: ${existing.experimentEpoch}  startedAtUtc: ${existing.startedAtUtc}`)
    console.error(`  marker: ${collectionMarkerPath(EXPERIMENT_EPOCH)}`)
    process.exitCode = 1
    return
  }

  const res = createCollectionMarker({
    startedAtUtc: new Date().toISOString(),
    experimentSpecVersion: EXPERIMENT_SPEC_VERSION,
    experimentConfigHash: experimentConfigHashV,
    experimentEpoch: EXPERIMENT_EPOCH,
    decisionPolicyVersion: DECISION_POLICY_VERSION,
    decisionPolicyHash: decisionPolicyHashV,
    producerHead, branch,
  })

  if (!res.ok) {
    if (res.reason === 'ALREADY_EXISTS') {
      console.error('H4B OFFICIAL COLLECTION ALREADY STARTED — refusing to reset the official start time.')
      console.error(`  marker: ${res.path}`)
    } else {
      console.error(`H4B start FAILED to write the marker: ${res.error}`)
    }
    process.exitCode = 1
    return
  }

  console.log('H4B OFFICIAL COLLECTION STARTED')
  console.log(`  ${EXPERIMENT_EPOCH}`)
  console.log(`  ${experimentConfigHashV}`)
  console.log(`  ${decisionPolicyHashV}`)
  console.log(`  startedAtUtc: ${res.marker.startedAtUtc}`)
  console.log(`  producerHead: ${producerHead ?? 'UNKNOWN'}  branch: ${branch ?? 'UNKNOWN'}`)
  console.log(`  marker: ${res.path}`)
  console.log('  NOTE: this only records the start boundary — now start the normal Companion processes.')
}

const invokedDirectly = (() => { try { return process.argv[1] ? import.meta.url === new URL(`file://${process.argv[1]}`).href : false } catch { return false } })()
if (invokedDirectly) main()

export { main as runH4bStartCollection }
