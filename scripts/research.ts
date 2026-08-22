/**
 * Research harness — turn a day's signals into an answer about what works.
 *
 * This is the committed version of the analysis that produced the 2026-08-11
 * thesis cut. Previously that lived in throwaway scripts, so every session
 * re-derived it from scratch and the conclusions couldn't be reproduced.
 *
 *   npx tsx scripts/research.ts                        # the 20-day replay book
 *   npx tsx scripts/research.ts data/buy-signals-*.csv # a live export
 *   npx tsx scripts/research.ts --cull                 # + setup-cull simulation
 *
 * TWO RULES THIS ENCODES, both learned the hard way:
 *
 * 1. SCORE IN R, NOT PERCENT. The executor sizes by fixed dollar risk, so a +6%
 *    move on a 7%-wide stop and a +1.7% move on a 2%-wide stop are the same money.
 *    Ranking on raw % systematically flatters wide stops — it made
 *    momentum_pullback look +19% profitable when in R it loses.
 *
 * 2. JUDGE ON NET R, NOT AVG/TRADE. Filters that raise the average by trading less
 *    are not improvements. Requiring RVOL>=5 lifted avg/trade +0.179R -> +0.283R
 *    while removing 79 signals worth +9.2R. Better average, less money.
 *
 * And one warning it cannot enforce: a gate RESHUFFLES the book rather than
 * subsetting it (vetoed setups free per-symbol cap and dedup slots, which backfill
 * different signals). Simulated culls here are therefore an ESTIMATE. Confirm any
 * change with a real replay run before believing it.
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// ── Input ────────────────────────────────────────────────────────────────────

interface Signal {
  day: string
  time: string
  etMin: number
  symbol: string
  setup: string
  grade: string
  entry: number
  stop: number
  rvol: number | null
  offHigh: number | null
  outcome: string
  pnlPct: number
  /** Stop width as % of entry — the risk unit. */
  stopPct: number
  /** P/L in R: pnlPct / stopPct. The only comparable measure across setups. */
  r: number
  /** Max adverse / favorable excursion %, when the source carries them (null otherwise). */
  maePct: number | null
  mfePct: number | null
}

/** Column aliases, so a backtest CSV and a live Buy Log export both load. */
const COLUMNS: Record<string, string[]> = {
  day: ['day', 'date_ET', 'date'],
  time: ['time_ET', 'time'],
  symbol: ['symbol'],
  setup: ['setup', 'setup_type'],
  grade: ['grade'],
  entry: ['entry', 'entry_high', 'fill'],
  stop: ['stop', 'invalidation'],
  rvol: ['rvol'],
  offHigh: ['off_high_pct', 'dist_dayhigh_pct'],
  outcome: ['outcome'],
  pnl: ['scaled_pnl_pct', 'pnl_pct'],
  mae: ['mae_pct', 'maePct'],
  mfe: ['mfe_pct', 'mfePct'],
}

function pick(header: string[], names: string[]): number {
  for (const n of names) {
    const i = header.indexOf(n)
    if (i >= 0) return i
  }
  return -1
}

function load(path: string): Signal[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const header = lines[0].split(',').map(h => h.trim())
  const idx = Object.fromEntries(
    Object.entries(COLUMNS).map(([k, names]) => [k, pick(header, names)]),
  ) as Record<keyof typeof COLUMNS, number>

  const out: Signal[] = []
  for (const line of lines.slice(1)) {
    const c = line.split(',')
    const get = (k: keyof typeof COLUMNS) => (idx[k] >= 0 ? c[idx[k]] : '')
    const entry = Number(get('entry'))
    const stop = Number(get('stop'))
    const pnlPct = Number(get('pnl'))
    const outcome = (get('outcome') || 'open').trim()
    // Unresolved rows carry no information — counting them as 0% would silently
    // drag every average toward zero and make a good book look mediocre.
    if (!Number.isFinite(pnlPct) || outcome === 'open' || outcome === '') continue
    if (!(entry > 0) || !(stop > 0) || stop >= entry) continue

    const [h, m] = (get('time') || '00:00').split(':').map(Number)
    const stopPct = ((entry - stop) / entry) * 100
    out.push({
      day: get('day') || 'n/a',
      time: get('time') || '',
      etMin: (h || 0) * 60 + (m || 0),
      symbol: get('symbol'),
      setup: get('setup'),
      grade: get('grade') || '?',
      entry, stop,
      rvol: get('rvol') ? Number(get('rvol')) : null,
      offHigh: get('offHigh') ? Number(get('offHigh')) : null,
      outcome, pnlPct, stopPct,
      r: stopPct > 0 ? pnlPct / stopPct : 0,
      maePct: get('mae') !== '' && Number.isFinite(Number(get('mae'))) ? Number(get('mae')) : null,
      mfePct: get('mfe') !== '' && Number.isFinite(Number(get('mfe'))) ? Number(get('mfe')) : null,
    })
  }
  return out
}

// ── Reporting ────────────────────────────────────────────────────────────────

const sumR = (xs: Signal[]) => xs.reduce((s, x) => s + x.r, 0)
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const b = xs.slice().sort((a, c) => a - c)
  const n = b.length
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2
}

// Median R sits alongside avg/trade because this book's edge is outlier-driven: a
// positive mean can hide a negative median (the typical trade is a loss), which is
// exactly what a mean-only view misses. See the "Robustness" section for the
// top-N-trade and per-ticker concentration that make this concrete.
function line(label: string, xs: Signal[], days: number): string {
  const w = xs.filter(x => x.outcome === 'target_hit' || x.outcome === 'win').length
  const l = xs.filter(x => x.outcome === 'invalidated' || x.outcome === 'loss').length
  const net = sumR(xs)
  const med = median(xs.map(x => x.r))
  const wr = (w + l) ? ((w / (w + l)) * 100).toFixed(0) + '%' : '—'
  return [
    label.padEnd(24),
    String(xs.length).padStart(4),
    (xs.length / days).toFixed(1).padStart(6),
    wr.padStart(6),
    ((net / xs.length >= 0 ? '+' : '') + (net / xs.length).toFixed(3) + 'R').padStart(9),
    ((med >= 0 ? '+' : '') + med.toFixed(2) + 'R').padStart(8),
    ((net >= 0 ? '+' : '') + net.toFixed(1) + 'R').padStart(9),
  ].join(' ')
}

const HEADER = 'bucket                      n   /day    win  avg/trade    medR    net R'

function section(title: string, groups: Map<string, Signal[]>, days: number) {
  console.log(`\n### ${title}`)
  console.log(HEADER)
  for (const [k, xs] of [...groups.entries()].sort((a, b) => sumR(b[1]) - sumR(a[1]))) {
    console.log(line(k, xs, days))
  }
}

// ── Robustness: is the edge real, or a handful of trades on a handful of names? ──
// A +net-R book can still be one where the median trade loses and the whole edge
// is 5 trades on 2 tickers. This section makes that explicit so a filter is never
// tuned to noise.
function robustness(signals: Signal[]) {
  const rs = signals.map(s => s.r)
  const net = sumR(signals)
  console.log('\n### Robustness (outlier + concentration)')
  console.log(`mean/trade ${net / signals.length >= 0 ? '+' : ''}${(net / signals.length).toFixed(3)}R  ·  median/trade ${median(rs) >= 0 ? '+' : ''}${median(rs).toFixed(2)}R  ·  net ${net >= 0 ? '+' : ''}${net.toFixed(1)}R`)

  // Top-N trade dependence: how much of the net comes from the best few trades.
  const sorted = signals.slice().sort((a, b) => b.r - a.r)
  for (const n of [1, 3, 5, 10]) {
    if (n > sorted.length) break
    const topR = sorted.slice(0, n).reduce((s, x) => s + x.r, 0)
    console.log(`  net minus top-${String(n).padStart(2)} trades: ${(net - topR) >= 0 ? '+' : ''}${(net - topR).toFixed(1)}R   (top-${n} = ${((topR / net) * 100).toFixed(0)}% of net)`)
  }

  // Max drawdown of the time-ordered cumulative-R curve (equity roughness).
  const ordered = signals.slice().sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time))
  let cum = 0, peak = 0, dd = 0
  for (const s of ordered) { cum += s.r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak) }
  console.log(`  max drawdown (time-ordered): ${dd.toFixed(1)}R  ·  net/|maxDD| = ${dd < 0 ? (net / -dd).toFixed(2) : '∞'}`)

  // Per-ticker concentration.
  const bySym = groupBy(signals, s => s.symbol || '?')
  const ticks = [...bySym.entries()].map(([k, xs]) => ({ k, n: xs.length, r: sumR(xs) })).sort((a, b) => b.r - a.r)
  const top2 = ticks.slice(0, 2).reduce((s, x) => s + x.r, 0)
  console.log(`  distinct tickers: ${ticks.length}  ·  top-2 tickers = ${net ? ((top2 / net) * 100).toFixed(0) : '—'}% of net`)
  console.log(`  best:  ${ticks.slice(0, 4).map(t => `${t.k}(${t.n},${t.r >= 0 ? '+' : ''}${t.r.toFixed(1)}R)`).join('  ')}`)
  console.log(`  worst: ${ticks.slice(-3).map(t => `${t.k}(${t.n},${t.r >= 0 ? '+' : ''}${t.r.toFixed(1)}R)`).join('  ')}`)
}

// ── Excursion: MAE/MFE, only when the source CSV carries the columns. ───────────
function excursion(signals: Signal[]) {
  const withEx = signals.filter(s => s.maePct != null || s.mfePct != null)
  if (withEx.length === 0) {
    console.log('\n### Excursion (MAE/MFE)')
    console.log('  not available — the source CSV has no mae_pct/mfe_pct columns.')
    console.log('  (backtest.ts now exports them; re-run the replay to populate this.)')
    return
  }
  const wins = withEx.filter(s => s.outcome === 'target_hit' || s.outcome === 'win')
  const loss = withEx.filter(s => s.outcome === 'invalidated' || s.outcome === 'loss')
  const avg = (xs: Signal[], f: (s: Signal) => number | null) => {
    const v = xs.map(f).filter((x): x is number => x != null)
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN
  }
  const fmt = (n: number) => Number.isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
  console.log('\n### Excursion (MAE/MFE)')
  console.log(`  ALL    avg MAE ${fmt(avg(withEx, s => s.maePct))}  avg MFE ${fmt(avg(withEx, s => s.mfePct))}  (n=${withEx.length})`)
  console.log(`  wins   avg MAE ${fmt(avg(wins, s => s.maePct))}  avg MFE ${fmt(avg(wins, s => s.mfePct))}  (n=${wins.length})`)
  console.log(`  losses avg MAE ${fmt(avg(loss, s => s.maePct))}  avg MFE ${fmt(avg(loss, s => s.mfePct))}  (n=${loss.length})`)
  console.log('  (heat taken before the winner ran = how much stop room the entry actually needed.)')
}

const groupBy = (xs: Signal[], fn: (s: Signal) => string) => {
  const m = new Map<string, Signal[]>()
  for (const x of xs) { const k = fn(x); const g = m.get(k) ?? []; g.push(x); m.set(k, g) }
  return m
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const wantCull = args.includes('--cull')
  const paths = args.filter(a => !a.startsWith('--'))
  const defaultPath = resolve(
    process.env.SCRATCH ?? '/private/tmp/claude-501/-Users-elonmusk-Companion/e73f584c-b4b9-412c-a4d7-ccaf1e47b222/scratchpad',
    'backtest-july-signals.csv',
  )
  const sources = paths.length ? paths : [defaultPath]

  const signals: Signal[] = []
  for (const p of sources) {
    if (!existsSync(p)) { console.error(`missing: ${p}`); continue }
    const loaded = load(p)
    console.log(`loaded ${String(loaded.length).padStart(4)} resolved signals from ${p}`)
    signals.push(...loaded)
  }
  if (signals.length === 0) {
    console.error('\nNo RESOLVED signals found. A CSV whose outcome column is all "open"')
    console.error('carries no information — run the EOD resolver first.')
    process.exit(1)
  }

  const days = new Set(signals.map(s => s.day)).size || 1
  console.log(`\n${signals.length} resolved signals across ${days} day(s) · net ${sumR(signals) >= 0 ? '+' : ''}${sumR(signals).toFixed(1)}R`)
  console.log('\n(all figures in R = P/L ÷ stop width; judge on NET R, not avg/trade)')

  console.log('\n### Whole book')
  console.log(HEADER)
  console.log(line('ALL', signals, days))

  robustness(signals)
  excursion(signals)

  section('By setup', groupBy(signals, s => s.setup), days)
  section('By session', groupBy(signals, s =>
    s.etMin < 570 ? 'premarket' : s.etMin < 600 ? 'open 09:30-10:00'
      : s.etMin < 840 ? 'midday 10:00-14:00' : 'late 14:00+'), days)
  section('By grade', groupBy(signals, s => s.grade), days)
  section('By stop width', groupBy(signals, s =>
    s.stopPct < 2 ? 'stop <2%' : s.stopPct < 4 ? 'stop 2-4%'
      : s.stopPct < 7 ? 'stop 4-7%' : 'stop 7%+'), days)
  section('By distance from high', groupBy(signals, s =>
    s.offHigh == null ? 'unknown' : s.offHigh >= -1 ? 'at high (0 to -1%)'
      : s.offHigh >= -3 ? '-1 to -3%' : s.offHigh >= -5 ? '-3 to -5%' : 'below -5%'), days)
  section('By RVOL', groupBy(signals, s =>
    s.rvol == null ? 'unknown' : s.rvol < 5 ? 'rvol <5' : s.rvol < 20 ? 'rvol 5-20'
      : s.rvol < 100 ? 'rvol 20-100' : 'rvol 100+'), days)

  if (!wantCull) {
    console.log('\n(pass --cull to simulate removing the negative setups)')
    return
  }

  // ── Cull simulation ────────────────────────────────────────────────────────
  console.log('\n### Cull simulation — ESTIMATE ONLY')
  console.log('A veto reshuffles the book (freed cap/dedup slots backfill other signals),')
  console.log('so confirm any cut with a real replay run before shipping it.\n')
  console.log(HEADER.replace('bucket', 'book  '))
  console.log(line('baseline', signals, days))

  // Greedily drop the worst net-R setup while net R keeps improving.
  const dropped: string[] = []
  let current = signals
  for (;;) {
    const bySetup = groupBy(current, s => s.setup)
    let worst: string | null = null
    let worstR = 0
    for (const [k, xs] of bySetup) {
      const net = sumR(xs)
      if (net < worstR) { worstR = net; worst = k }
    }
    if (!worst) break
    const without = current.filter(s => s.setup !== worst)
    if (sumR(without) <= sumR(current)) break
    dropped.push(worst)
    current = without
    console.log(line(`− ${worst}`, current, days))
  }
  console.log(`\nsuggested cut: ${dropped.length ? dropped.join(', ') : '(nothing — every setup is net positive)'}`)
  console.log(`net R ${sumR(signals).toFixed(1)}R → ${sumR(current).toFixed(1)}R  ·  ${(current.length / days).toFixed(1)} signals/day`)
}

main()
