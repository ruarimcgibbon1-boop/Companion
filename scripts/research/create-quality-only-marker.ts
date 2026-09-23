/**
 * One-shot script to create the official QUALITY_ONLY_CONTINUATION
 * collection-start marker at the confirmed permanent path. Run once, by hand,
 * after commit+push are verified. Never invoked automatically by the daemon
 * or any test — this is the deliberate, explicit act of starting epoch 1.
 */
import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { createStartMarker, readStartMarker } from '../../src/lib/experiments/quality-only/persistence'
import { buildProvenance, EXPERIMENT_SPEC_VERSION, EXPERIMENT_EPOCH } from '../../src/lib/experiments/quality-only/spec'

const MARKER_DIR = join(homedir(), '.companion-quality-only')
const MARKER_PATH = join(MARKER_DIR, 'quality-only-epoch-1.collection-start.json')

mkdirSync(MARKER_DIR, { recursive: true })

const provenance = buildProvenance()

console.log('specVersion:', EXPERIMENT_SPEC_VERSION)
console.log('epoch:', EXPERIMENT_EPOCH)
console.log('provenance:', JSON.stringify(provenance, null, 2))
console.log('markerPath:', MARKER_PATH)

const existingBefore = readStartMarker(MARKER_PATH)
console.log('marker exists before create attempt:', existingBefore.exists)

const result = createStartMarker(MARKER_PATH, provenance)
console.log('createStartMarker result:', JSON.stringify(result, null, 2))

if (!result.created && !result.alreadyExisted) {
  console.error('UNEXPECTED: neither created nor alreadyExisted — investigate')
  process.exit(1)
}
