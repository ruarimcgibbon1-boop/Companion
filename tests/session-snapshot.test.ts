import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { classifyDrift, isBytePrefix, countRows, fileStats, summarizeJsonlTail } from '@/lib/research/session-snapshot'
import { sha256 } from '@/lib/research/phantom-tape'

const FROZEN_DECISIONS_SHA = '826b136ceae4fcf9aecbca970d57309afdf5916b28b84a423f4a9231d8393877'

describe('classifyDrift — snapshot drift classes', () => {
  it('CLEAN when live equals snapshot', () => {
    const snap = Buffer.from('a\nb\nc\n')
    expect(classifyDrift('x', snap, Buffer.from('a\nb\nc\n')).driftClass).toBe('CLEAN')
  })
  it('POST_FREEZE_APPEND_DRIFT when snapshot is an exact byte-prefix of live (Session-3 case)', () => {
    const snap = Buffer.from('row1\nrow2\n')
    const live = Buffer.from('row1\nrow2\nrow3\nrow4\n')
    const r = classifyDrift('decisions', snap, live)
    expect(r.driftClass).toBe('POST_FREEZE_APPEND_DRIFT')
    expect(r.appended?.rows).toBe(2)
    expect(r.appended?.bytes).toBe('row3\nrow4\n'.length)
  })
  it('NON_PREFIX_DRIFT when the frozen region was rewritten', () => {
    const snap = Buffer.from('row1\nROW2\n')
    const live = Buffer.from('row1\nEDITED\nrow3\n')
    expect(classifyDrift('decisions', snap, live).driftClass).toBe('NON_PREFIX_DRIFT')
  })
  it('MISSING_LIVE when the live file is gone', () => {
    expect(classifyDrift('x', Buffer.from('a'), null).driftClass).toBe('MISSING_LIVE')
  })
})

describe('isBytePrefix / countRows helpers', () => {
  it('isBytePrefix is byte-exact', () => {
    expect(isBytePrefix(Buffer.from('ab'), Buffer.from('abc'))).toBe(true)
    expect(isBytePrefix(Buffer.from('ac'), Buffer.from('abc'))).toBe(false)
    expect(isBytePrefix(Buffer.from('abcd'), Buffer.from('abc'))).toBe(false)
  })
  it('countRows counts non-empty lines', () => {
    expect(countRows('a\nb\n\nc\n')).toBe(3)
  })
})

describe('summarizeJsonlTail — metadata only, no performance', () => {
  it('reports rows/ts/symbols/verdict+session counts and nothing else', () => {
    const tail = [
      JSON.stringify({ ts: '2026-08-27T21:47:26.398Z', symbol: 'GSUN', verdict: 'session', session: 'afterhours' }),
      JSON.stringify({ ts: '2026-08-27T22:21:22.945Z', symbol: 'CRWD', verdict: 'session', session: 'afterhours' }),
    ].join('\n') + '\n'
    const s = summarizeJsonlTail(tail)
    expect(s.rows).toBe(2)
    expect(s.firstTs).toBe('2026-08-27T21:47:26.398Z')
    expect(s.lastTs).toBe('2026-08-27T22:21:22.945Z')
    expect(s.symbols).toEqual(['CRWD', 'GSUN'])
    expect(s.verdictCounts).toEqual({ session: 2 })
    expect(Object.keys(s)).not.toContain('pnl')
  })
})

// Live-file fixture: only runs where the real 2026-08-27 decisions file is present.
const liveDecisions = join(homedir(), '.companion-decisions-2026-08-27.jsonl')
describe.runIf(existsSync(liveDecisions))('fileStats reproduces the frozen decisions prefix hash', () => {
  it('first 316 rows hash to the frozen SHA (append-only drift confirmed against live)', () => {
    const lines = readFileSync(liveDecisions, 'utf8').split('\n')
    // Reconstruct the frozen 316-row prefix (trailing newline preserved).
    const prefix = lines.slice(0, 316).join('\n') + '\n'
    expect(sha256(prefix)).toBe(FROZEN_DECISIONS_SHA)
    // And the live file is a byte-superset (append drift), not a rewrite.
    const live = readFileSync(liveDecisions)
    const r = classifyDrift('decisions', Buffer.from(prefix), live)
    expect(['CLEAN', 'POST_FREEZE_APPEND_DRIFT']).toContain(r.driftClass)
    const fs = fileStats('decisions', 'snapshot/decisions.jsonl', Buffer.from(prefix))
    expect(fs.rows).toBe(316)
  })
})
