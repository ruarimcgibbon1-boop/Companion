/**
 * Pure tape-provenance classifier (Finding 5).
 *
 * Decides what to do with an existing 1-minute tape and its optional provenance
 * sidecar, distinguishing:
 *   • fetchedAt  — when the bars were actually pulled from the provider (null for a
 *                  legacy cache file with no sidecar; we do NOT invent one);
 *   • observedAt — when THIS run recorded/verified the sidecar.
 *
 * A tape whose bytes disagree with its sidecar hash is corrupt → fail closed (only
 * an explicit online run may refetch). No network, no fs here.
 */
export type TapeAction = 'use' | 'refetch' | 'fail_closed' | 'fetch' | 'missing'

export interface TapeSidecar {
  sha256?: string | null
  fetchedAt?: string | null
  rows?: number | null
}

export interface TapeClassification {
  source:
    | 'cache-verified'         // bytes match an existing sidecar hash
    | 'cache-existing-legacy'  // present, non-empty, but no sidecar (fetchedAt unknown)
    | 'provenance_mismatch'    // bytes disagree with sidecar hash → corrupt
    | 'empty_cache'            // present but zero bars
    | 'missing'                // no tape file
  rows: number
  sha256: string | null
  fetchedAt: string | null
  action: TapeAction
  note: string | null
}

export function classifyTape(input: {
  tapePresent: boolean
  rows: number
  tapeSha256: string | null
  sidecar: TapeSidecar | null
  online: boolean
}): TapeClassification {
  const { tapePresent, rows, tapeSha256, sidecar, online } = input

  if (!tapePresent) {
    return { source: 'missing', rows: 0, sha256: null, fetchedAt: null, action: online ? 'fetch' : 'missing', note: online ? null : 'offline: cannot fetch' }
  }
  if (rows <= 0) {
    return { source: 'empty_cache', rows: 0, sha256: tapeSha256, fetchedAt: null, action: online ? 'refetch' : 'fail_closed', note: 'zero-bar cache (poisoned)' }
  }
  if (sidecar && sidecar.sha256) {
    if (sidecar.sha256 === tapeSha256) {
      return { source: 'cache-verified', rows, sha256: tapeSha256, fetchedAt: sidecar.fetchedAt ?? null, action: 'use', note: null }
    }
    return {
      source: 'provenance_mismatch', rows, sha256: tapeSha256, fetchedAt: sidecar.fetchedAt ?? null,
      action: online ? 'refetch' : 'fail_closed',
      note: 'tape bytes disagree with sidecar hash',
    }
  }
  // Non-empty tape, no sidecar → legacy cache. Do NOT invent a fetchedAt.
  return { source: 'cache-existing-legacy', rows, sha256: tapeSha256, fetchedAt: null, action: 'use', note: 'legacy cache: no provenance sidecar, fetchedAt unknown' }
}
