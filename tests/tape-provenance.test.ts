import { describe, it, expect } from 'vitest'
import { classifyTape } from '@/lib/research/tape-provenance'

describe('classifyTape — honest provenance + fail-closed corruption (Finding 5)', () => {
  it('cache-verified when bytes match the sidecar hash (fetchedAt preserved)', () => {
    const r = classifyTape({ tapePresent: true, rows: 805, tapeSha256: 'abc', sidecar: { sha256: 'abc', fetchedAt: '2026-08-27T20:00:00Z' }, online: false })
    expect(r.source).toBe('cache-verified')
    expect(r.action).toBe('use')
    expect(r.fetchedAt).toBe('2026-08-27T20:00:00Z')
  })

  it('cache-existing-legacy when no sidecar: fetchedAt is null, NOT invented', () => {
    const r = classifyTape({ tapePresent: true, rows: 500, tapeSha256: 'abc', sidecar: null, online: false })
    expect(r.source).toBe('cache-existing-legacy')
    expect(r.fetchedAt).toBeNull()
    expect(r.action).toBe('use')
  })

  it('provenance_mismatch fails closed offline (refetch only when online)', () => {
    const offline = classifyTape({ tapePresent: true, rows: 805, tapeSha256: 'XYZ', sidecar: { sha256: 'abc' }, online: false })
    expect(offline.source).toBe('provenance_mismatch')
    expect(offline.action).toBe('fail_closed')
    const online = classifyTape({ tapePresent: true, rows: 805, tapeSha256: 'XYZ', sidecar: { sha256: 'abc' }, online: true })
    expect(online.action).toBe('refetch')
  })

  it('empty (zero-bar) cache is poisoned: fail closed offline, refetch online', () => {
    expect(classifyTape({ tapePresent: true, rows: 0, tapeSha256: 'x', sidecar: null, online: false }).action).toBe('fail_closed')
    expect(classifyTape({ tapePresent: true, rows: 0, tapeSha256: 'x', sidecar: null, online: true }).action).toBe('refetch')
  })

  it('missing tape: fetch when online, missing when offline', () => {
    expect(classifyTape({ tapePresent: false, rows: 0, tapeSha256: null, sidecar: null, online: true }).action).toBe('fetch')
    expect(classifyTape({ tapePresent: false, rows: 0, tapeSha256: null, sidecar: null, online: false }).action).toBe('missing')
  })
})
