import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Candle } from '@/types'
import { etStrToUnixSec } from '@/lib/replay-day'
import { buildShadowCandidates, rejectionLayer, type DecisionLogRow, type ShadowCandidate } from '@/lib/research/shadow-journal'
import {
  classifyCandidate,
  operativeLayerOf,
  requiredTapeFailures,
  resolveWithFlatten,
  buildBooks,
  tapeState,
  type PhantomRow,
  type TapeStatusLite,
} from '@/lib/research/phantom-book'
import { loadTape, sha256 } from '@/lib/research/phantom-tape'

const FLATTEN = 15 * 60 + 55 // 955 — DEFAULT_EXECUTOR.flattenEtMinute
const DAY = '2026-08-20'
const bar = (hhmmss: string, o: number, h: number, l: number, c: number): Candle => ({
  time: etStrToUnixSec(`${DAY} ${hhmmss}`), open: o, high: h, low: l, close: c, volume: 0,
})
const tsOf = (hhmmss: string) => etStrToUnixSec(`${DAY} ${hhmmss}`) * 1000

function cand(p: Partial<ShadowCandidate> & { signalTs: number }): ShadowCandidate {
  const setupId = p.setupId ?? 'X:breakout:1'
  return {
    candidateId: `${DAY}:${setupId}`, etTradingDay: DAY, setupId, symbol: p.symbol ?? 'X',
    setup: p.setup ?? 'breakout', session: 'regular', signalTs: p.signalTs,
    everAccepted: p.everAccepted ?? false, terminalVerdict: p.terminalVerdict ?? 'veto', layers: [],
    lifecycle: { firstSeenTs: p.signalTs, triggeredTs: p.signalTs, vetoedTs: null, acceptedTs: null, reEvaluations: 1, expiredTs: null },
    events: [], entryRef: p.entryRef ?? 100, stop: p.stop ?? 95, targets: p.targets ?? [110],
    features: { grade: null, score: null, rvol: null, offHighPct: null, price: null }, outcome: null,
  }
}

function decisionRow(p: Partial<DecisionLogRow> & { setupId: string; verdict: DecisionLogRow['verdict'] }): DecisionLogRow {
  return {
    ts: p.ts ?? `${DAY}T09:35:00-04:00`, etTime: p.etTime ?? '09:35', symbol: p.symbol ?? 'X',
    setupId: p.setupId, setupType: p.setupType ?? 'breakout', grade: 'C', score: 60, verdict: p.verdict,
    fill: p.fill ?? null, rvol: 10, offHighPct: 0, session: 'regular', price: p.price ?? 100,
    stop: p.stop === undefined ? 95 : p.stop, targets: p.targets ?? [110], entryRef: p.entryRef === undefined ? 100 : p.entryRef,
  }
}

const row = (c: ShadowCandidate, klass: PhantomRow['klass'], candles: Candle[], actualR: number | null = null): PhantomRow => ({
  candidate: c, klass, outcome: resolveWithFlatten(c, candles, FLATTEN), actualR, hasTarget: c.targets.length > 0,
})

describe('classification (accepted vs phantom vs dup vs not-simulatable)', () => {
  it('classifies each candidate from the decision log by its identity, not its symbol', () => {
    const cands = buildShadowCandidates([
      decisionRow({ setupId: 'A:breakout:1', verdict: 'logged' }),
      decisionRow({ setupId: 'B:breakout:2', verdict: 'veto' }),
      decisionRow({ setupId: 'C:hod_break:3', verdict: 'dup' }),
      decisionRow({ setupId: 'D:breakout:4', verdict: 'session', entryRef: null, stop: null, fill: null }),
    ])
    const byId = Object.fromEntries(cands.map((c) => [c.setupId, classifyCandidate(c, new Set())]))
    expect(byId['A:breakout:1']).toBe('accepted')      // ever logged
    expect(byId['B:breakout:2']).toBe('phantom_primary')
    expect(byId['C:hod_break:3']).toBe('phantom_dup')  // cooldown layer → excluded from primary
    expect(byId['D:breakout:4']).toBe('not_simulatable') // no entry/stop
  })

  it('executor setupId marks accepted even when the terminal decision was a later dup', () => {
    const c = cand({ signalTs: tsOf('09:35'), setupId: 'X:bos:1', terminalVerdict: 'dup', everAccepted: false })
    expect(classifyCandidate(c, new Set(['X:bos:1']))).toBe('accepted')
  })
})

describe('setupId-only join (no symbol fallback)', () => {
  it('joins actual R to the matching setupId and never bleeds across same-symbol setups', () => {
    const accepted = cand({ signalTs: tsOf('09:35'), setupId: 'X:breakout:1', everAccepted: true })
    const phantom = cand({ signalTs: tsOf('09:36'), setupId: 'X:opening_drive:2', terminalVerdict: 'veto' })
    const executed = new Set(['X:breakout:1'])
    const actualR = new Map<string, number>([['X:breakout:1', 2]])
    expect(classifyCandidate(accepted, executed)).toBe('accepted')
    expect(classifyCandidate(phantom, executed)).toBe('phantom_primary')
    // same symbol X, but the phantom setupId is absent from the map → null, not 2
    expect(actualR.get(accepted.setupId) ?? null).toBe(2)
    expect(actualR.get(phantom.setupId) ?? null).toBeNull()
  })
})

describe('resolver outcomes', () => {
  it('same-bar stop+target ⇒ stop (conservative)', () => {
    const c = cand({ signalTs: tsOf('09:35'), entryRef: 100, stop: 95, targets: [105] })
    const o = resolveWithFlatten(c, [bar('09:35:00', 100, 106, 94, 100)], FLATTEN)
    expect(o.result).toBe('stop')
    expect(o.hypotheticalR).toBeCloseTo(-1, 5)
  })

  it('no-fill candidate: entry never touched ⇒ no R, not entered', () => {
    const c = cand({ signalTs: tsOf('09:35'), entryRef: 100, stop: 95, targets: [110] })
    const o = resolveWithFlatten(c, [bar('09:35:00', 98, 99, 97, 98), bar('09:36:00', 98, 99, 96, 97)], FLATTEN)
    expect(o.entered).toBe(false)
    expect(o.result).toBe('no_fill')
    expect(o.hypotheticalR).toBeNull()
  })

  it('target-missing candidate resolves only to stop/flatten and is flagged', () => {
    const c = cand({ signalTs: tsOf('09:35'), entryRef: 100, stop: 95, targets: [] })
    const o = resolveWithFlatten(c, [bar('09:35:00', 100, 108, 99, 107), bar('09:36:00', 107, 109, 106, 108)], FLATTEN)
    expect(o.result).toBe('open_at_end') // never a 'target' even though price ran past where one would be
    const r = row(c, 'phantom_primary', [bar('09:35:00', 100, 108, 99, 107)])
    expect(r.hasTarget).toBe(false)
  })

  it('MFE/MAE begin at the fill bar, not the signal (pre-fill dip excluded)', () => {
    const c = cand({ signalTs: tsOf('09:35'), entryRef: 100, stop: 90, targets: [999] })
    const o = resolveWithFlatten(c, [
      bar('09:35:00', 98, 99, 80, 98),   // pre-fill: dips to 80 but high<100 so no fill
      bar('09:36:00', 100, 101, 100, 100), // fills at 100
      bar('09:37:00', 100, 104, 100, 103),
    ], FLATTEN)
    expect(o.entered).toBe(true)
    expect(o.maePct).toBe(0)     // measured from fill (low 100), NOT the pre-fill 80 (-20%)
    expect(o.mfePct).toBe(4)     // high 104 after fill
  })
})

describe('15:55 non-lookahead boundary', () => {
  it('ignores a target touched in the 15:55 bar and marks at the 15:55 OPEN', () => {
    const c = cand({ signalTs: tsOf('15:50:00'), entryRef: 100, stop: 95, targets: [110] })
    const o = resolveWithFlatten(c, [
      bar('15:50:00', 100, 101, 99, 100),  // fills at 100
      bar('15:53:00', 100, 102, 99, 100),  // no touch
      bar('15:54:00', 100, 103, 99, 100),  // last pre-flatten bar
      bar('15:55:00', 100, 115, 100, 114), // OPEN=100; high 115 would hit T1 — but this is post-flatten
    ], FLATTEN)
    expect(o.result).toBe('open_at_end')       // the 15:55 target touch is NOT credited
    expect(o.markSource).toBe('flatten_open')
    expect(o.hypotheticalR).toBe(0)            // (flattenOpen 100 − entry 100) / risk 5
  })

  it('falls back to last pre-flatten close when the 15:55 bar is absent', () => {
    const c = cand({ signalTs: tsOf('15:50:00'), entryRef: 100, stop: 95, targets: [110] })
    const o = resolveWithFlatten(c, [bar('15:50:00', 100, 101, 99, 100), bar('15:54:00', 100, 102, 99, 101)], FLATTEN)
    expect(o.result).toBe('open_at_end')
    expect(o.markSource).toBe('last_close')
  })
})

describe('books', () => {
  it('excludes dup_cooldown from the primary aggregate but keeps it in the raw list', () => {
    const winBar = [bar('09:35:00', 100, 111, 99, 110)] // hits T1 110 → +2R
    const rows: PhantomRow[] = [
      row(cand({ signalTs: tsOf('09:35'), setupId: 'A:breakout:1' }), 'phantom_primary', winBar),
      row(cand({ signalTs: tsOf('09:35'), setupId: 'B:breakout:2' }), 'phantom_dup', winBar),
    ]
    const books = buildBooks(rows)
    expect(books.idealPhantom.n).toBe(1)           // dup excluded
    expect(books.duplicates).toHaveLength(1)
    expect(books.duplicates[0].candidate.setupId).toBe('B:breakout:2')
  })

  it('routes accepted vs phantom vs actual into distinct books', () => {
    const winBar = [bar('09:35:00', 100, 111, 99, 110)]
    const rows: PhantomRow[] = [
      row(cand({ signalTs: tsOf('09:35'), setupId: 'A:breakout:1', everAccepted: true }), 'accepted', winBar, 1.4),
      row(cand({ signalTs: tsOf('09:35'), setupId: 'B:breakout:2' }), 'phantom_primary', winBar),
    ]
    const books = buildBooks(rows)
    expect(books.idealAccepted.n).toBe(1)
    expect(books.idealPhantom.n).toBe(1)
    expect(books.actualExecuted.n).toBe(1)
    expect(books.actualExecuted.netR).toBeCloseTo(1.4, 5)
  })
})

describe('tape provenance labelling', () => {
  it('labels same-day PROVISIONAL and settled prior-day FINAL', () => {
    const now = tsOf('12:00:00')
    expect(tapeState('2026-08-20', now)).toBe('PROVISIONAL')
    expect(tapeState('2026-08-19', now)).toBe('FINAL')
  })
})

describe('post-flatten session semantics', () => {
  it('classifies a signal fired at/after 15:55 as post_flatten and excludes it from the primary phantom aggregates', () => {
    const late = cand({ signalTs: tsOf('16:00:00'), setupId: 'LATE:breakout:1', terminalVerdict: 'session' })
    expect(classifyCandidate(late, new Set(), FLATTEN)).toBe('post_flatten')

    const winBar = [bar('09:35:00', 100, 111, 99, 110)]
    const rows: PhantomRow[] = [
      { candidate: late, klass: 'post_flatten', outcome: resolveWithFlatten(late, [], FLATTEN), actualR: null, hasTarget: true },
      row(cand({ signalTs: tsOf('09:35'), setupId: 'OK:breakout:2' }), 'phantom_primary', winBar),
    ]
    const books = buildBooks(rows)
    expect(books.counts.postFlatten).toBe(1)
    expect(books.counts.phantomPrimary).toBe(1)      // the post-flatten one is NOT counted
    expect(books.idealPhantom.n).toBe(1)              // and NOT in the R aggregate
    expect(books.counts.noFill).toBe(0)               // nor in the no-fill rate
    expect(books.postFlatten).toHaveLength(1)         // still visible in the raw bucket
  })

  it('keeps a session-gated candidate that fired strictly BEFORE 15:55 evaluable as a normal phantom', () => {
    const early = cand({ signalTs: tsOf('15:54:00'), setupId: 'EARLY:breakout:1', terminalVerdict: 'session' })
    expect(classifyCandidate(early, new Set(), FLATTEN)).toBe('phantom_primary')
  })
})

describe('acceptance is never relabelled by a later decision row', () => {
  it('an opened trade whose day ended on a dup/veto row reads accepted, with the dup kept only as audit metadata', () => {
    const c = cand({ signalTs: tsOf('06:20'), setupId: 'GDXU:bos:1', terminalVerdict: 'dup', everAccepted: false })
    const klass = classifyCandidate(c, new Set(['GDXU:bos:1']), FLATTEN)
    expect(klass).toBe('accepted')
    expect(operativeLayerOf(klass, c.terminalVerdict)).toBe('accepted')        // primary attribution
    expect(rejectionLayer(c.terminalVerdict)).toBe('duplicate_cooldown')  // audit only
  })
})

describe('comparable vs target-missing split', () => {
  it('separates target-present (comparable) from target-missing geometry in the headline books', () => {
    const winBar = [bar('09:35:00', 100, 111, 99, 110)] // hits T1 → +2R for the target-present one
    const stopBar = [bar('09:35:00', 100, 101, 94, 96)] // low ≤ stop 95 → -1R
    const rows: PhantomRow[] = [
      row(cand({ signalTs: tsOf('09:35'), setupId: 'P:breakout:1', targets: [110] }), 'phantom_primary', winBar),
      row(cand({ signalTs: tsOf('09:35'), setupId: 'Q:breakout:2', targets: [] }), 'phantom_primary', stopBar),
    ]
    const books = buildBooks(rows)
    expect(books.idealPhantom.n).toBe(2)             // all entered
    expect(books.idealPhantomComparable.n).toBe(1)   // target-present only
    expect(books.idealTargetMissing.n).toBe(1)       // target-missing only
    expect(books.counts.comparablePhantom).toBe(1)
    expect(books.idealPhantomComparable.netR).toBeCloseTo(2, 5)
  })
})

describe('immutable input snapshot semantics', () => {
  it('building from a frozen snapshot is unaffected by later appends to the source log', () => {
    const rows = [
      decisionRow({ setupId: 'A:breakout:1', verdict: 'veto' }),
      decisionRow({ setupId: 'B:breakout:2', verdict: 'logged' }),
    ]
    const frozen = rows.slice()
    const before = buildShadowCandidates(frozen)
    rows.push(decisionRow({ setupId: 'C:breakout:3', verdict: 'veto' })) // production log "grows"
    const after = buildShadowCandidates(frozen)                          // still the frozen snapshot
    expect(after).toEqual(before)
    expect(after).toHaveLength(2)
  })

  it('sha256 is stable for identical content and changes when content changes', () => {
    const text = '{"a":1}\n{"b":2}'
    expect(sha256(text)).toBe(sha256(text))
    expect(sha256(text)).not.toBe(sha256(text + '\n{"c":3}'))
    expect(sha256(text)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('offline cached-tape mode', () => {
  it('reads cached bars without touching the network, and reports missing on a cache miss', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-cache-'))
    try {
      const bars: Candle[] = [bar('09:35:00', 100, 101, 99, 100)]
      writeFileSync(join(dir, `m1_X_${DAY}.json`), JSON.stringify(bars))
      const fetchRows = vi.fn().mockResolvedValue([])

      const hit = await loadTape({ symbol: 'X', day: DAY, offline: true, cacheDir: dir, fetchRows })
      expect(hit.source).toBe('cache')
      expect(hit.bars).toHaveLength(1)
      expect(hit.targetDayBars).toBe(1)
      expect(fetchRows).not.toHaveBeenCalled()

      const miss = await loadTape({ symbol: 'Y', day: DAY, offline: true, cacheDir: dir, fetchRows })
      expect(miss.source).toBe('missing')
      expect(miss.bars).toHaveLength(0)
      expect(fetchRows).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fail-closed tape hardening', () => {
  const fmpRow = (hhmmss: string, px: number) => ({ date: `${DAY} ${hhmmss}`, open: px, high: px, low: px, close: px, volume: 1 })

  it('does NOT cache a network fetch that returns [] (no poisoned file written)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-fc-'))
    try {
      const fetchRows = vi.fn().mockResolvedValue([])
      const res = await loadTape({ symbol: 'X', day: DAY, offline: false, cacheDir: dir, fetchRows, retries: 1, retryDelayMs: 0 })
      expect(res.source).toBe('fetch_failed')
      expect(res.bars).toHaveLength(0)
      expect(existsSync(join(dir, `m1_X_${DAY}.json`))).toBe(false) // never cached
      expect(fetchRows).toHaveBeenCalledTimes(2) // initial + 1 retry
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty cache in OFFLINE mode (EMPTY_TAPE_CACHE)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-fc-'))
    try {
      writeFileSync(join(dir, `m1_X_${DAY}.json`), '[]')
      const fetchRows = vi.fn().mockResolvedValue([])
      const res = await loadTape({ symbol: 'X', day: DAY, offline: true, cacheDir: dir, fetchRows })
      expect(res.source).toBe('empty_cache')
      expect(res.targetDayBars).toBe(0)
      expect(fetchRows).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refetches an empty cache when online, and overwrites it with real bars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-fc-'))
    try {
      const file = join(dir, `m1_X_${DAY}.json`)
      writeFileSync(file, '[]')
      const fetchRows = vi.fn().mockResolvedValue([fmpRow('09:35:00', 100)])
      const res = await loadTape({ symbol: 'X', day: DAY, offline: false, cacheDir: dir, fetchRows, retries: 0, retryDelayMs: 0 })
      expect(res.source).toBe('network')
      expect(res.bars).toHaveLength(1)
      expect(fetchRows).toHaveBeenCalledTimes(1)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1) // poisoned file replaced
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts a non-empty tape with no PHANTOM_DAY bars as zero for the requested day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-fc-'))
    try {
      // bars for a DIFFERENT day only
      const other: Candle[] = [{ time: etStrToUnixSec('2026-08-18 09:35:00'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]
      writeFileSync(join(dir, `m1_X_${DAY}.json`), JSON.stringify(other))
      const res = await loadTape({ symbol: 'X', day: DAY, offline: true, cacheDir: dir, fetchRows: vi.fn() })
      expect(res.bars.length).toBeGreaterThan(0)
      expect(res.targetDayBars).toBe(0) // no bars for 2026-08-20
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('DATA_INCOMPLETE when a required ACCEPTED symbol has zero target-day bars', () => {
    const rows: PhantomRow[] = [
      row(cand({ signalTs: tsOf('09:35'), setupId: 'G:bos:1', symbol: 'GDXU', everAccepted: true }), 'accepted', []),
    ]
    const tape = new Map<string, TapeStatusLite>([['GDXU', { source: 'fetch_failed', targetDayBars: 0 }]])
    const fails = requiredTapeFailures(rows, tape)
    expect(fails).toHaveLength(1)
    expect(fails[0]).toMatchObject({ symbol: 'GDXU', klass: 'accepted', status: 'fetch_failed', targetDayBars: 0 })
  })

  it('DATA_INCOMPLETE when a required PRIMARY-PHANTOM symbol has zero target-day bars', () => {
    const rows: PhantomRow[] = [
      row(cand({ signalTs: tsOf('09:35'), setupId: 'A:breakout:1', symbol: 'AZI' }), 'phantom_primary', []),
    ]
    const tape = new Map<string, TapeStatusLite>([['AZI', { source: 'empty_cache', targetDayBars: 0 }]])
    const fails = requiredTapeFailures(rows, tape)
    expect(fails).toHaveLength(1)
    expect(fails[0]).toMatchObject({ symbol: 'AZI', klass: 'phantom_primary', targetDayBars: 0 })
    expect(fails[0].reason).toMatch(/EMPTY_TAPE_CACHE/)
  })

  it('a missing post-flatten-only symbol does NOT invalidate the primary book', () => {
    const winBar = [bar('09:35:00', 100, 111, 99, 110)]
    const rows: PhantomRow[] = [
      row(cand({ signalTs: tsOf('09:35'), setupId: 'OK:breakout:1', symbol: 'OK' }), 'phantom_primary', winBar),
      { candidate: cand({ signalTs: tsOf('16:10:00'), setupId: 'LATE:breakout:2', symbol: 'LATE' }), klass: 'post_flatten', outcome: resolveWithFlatten(cand({ signalTs: tsOf('16:10:00'), setupId: 'LATE:breakout:2', symbol: 'LATE' }), [], FLATTEN), actualR: null, hasTarget: true },
    ]
    const tape = new Map<string, TapeStatusLite>([
      ['OK', { source: 'cache', targetDayBars: 400 }],
      ['LATE', { source: 'fetch_failed', targetDayBars: 0 }], // post_flatten symbol missing — must not block
    ])
    expect(requiredTapeFailures(rows, tape)).toHaveLength(0)
  })

  it('valid tape passes the gate cleanly (no failures)', () => {
    const winBar = [bar('09:35:00', 100, 111, 99, 110)]
    const rows: PhantomRow[] = [
      row(cand({ signalTs: tsOf('09:35'), setupId: 'A:breakout:1', symbol: 'AAA', everAccepted: true }), 'accepted', winBar, 1.4),
      row(cand({ signalTs: tsOf('09:35'), setupId: 'B:breakout:2', symbol: 'BBB' }), 'phantom_primary', winBar),
    ]
    const tape = new Map<string, TapeStatusLite>([
      ['AAA', { source: 'cache', targetDayBars: 390 }],
      ['BBB', { source: 'network', targetDayBars: 405 }],
    ])
    expect(requiredTapeFailures(rows, tape)).toHaveLength(0)
  })
})
