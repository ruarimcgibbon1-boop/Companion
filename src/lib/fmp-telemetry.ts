/**
 * FMP request/byte telemetry — server-side, in-process, with per-ET-day persistence.
 *
 * The real constraint on this app is ROLLING FMP BANDWIDTH (bytes over a trailing
 * window), not request count, so this module counts bytes first and requests second.
 * It is a passive accumulator wired into the single `fmpGet()` chokepoint (see
 * fmp-client.ts): it observes calls, it never makes them and never changes their
 * result. It additionally persists a daily AGGREGATE to disk so a rolling baseline
 * survives restarts and spans multiple sessions.
 *
 * SECURITY INVARIANT (enforced by construction):
 *   The only per-call string this module ever stores, persists, or emits is the
 *   ENDPOINT FAMILY, derived EXCLUSIVELY from the `path` argument of fmpGet (e.g.
 *   "/quote", "/historical-chart/5min"). The request URL — which carries `?apikey=…`
 *   in its query string — is NEVER passed in, stored, persisted, or logged. No code
 *   path accepts a full URL or a header map. Persisted files hold only day/updatedAt,
 *   numeric aggregates, and family keys. Unit tests assert no key ever leaks.
 *
 * PROVIDER-METER CAVEAT:
 *   Local `bytes` = DECOMPRESSED response-body bytes (measured from a single body read
 *   before JSON.parse). These totals are intended for endpoint attribution, relative
 *   before/after comparison, and trend monitoring. They are NOT claimed to equal FMP's
 *   provider-side bandwidth meter (which counts compressed wire bytes and its own
 *   overhead). Treat the rolling GB as a consistent local proxy, not the vendor bill.
 *
 * "Today" is the rolling ET TRADING DAY (America/New_York calendar day), matching the
 * rest of the app's day accounting. Counters roll on the first call of a new ET day;
 * the closing day is flushed to disk before the in-memory counters reset.
 *
 * FAILURE ISOLATION: every disk operation here is best-effort and wrapped. A
 * persistence or load failure logs a warning and is swallowed — it can NEVER throw
 * into `fmpGet()`, a market-data fetch, strategy behavior, or daemon execution.
 *
 * CONCURRENCY: the daily file is written as the process's current cumulative snapshot
 * (temp file → atomic rename). This is correct for the single-daemon model the ops
 * guidance already assumes; running two writers for the same ET day would let the last
 * writer's snapshot win. Reads (rolling report) are lock-free and tolerate a partial
 * or absent file.
 */

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── Types ────────────────────────────────────────────────────────────────────

export interface FmpFamilyStat {
  requests: number        // total calls attempted for this family
  successful: number      // calls that returned a 2xx and a parseable body
  failed: number          // non-2xx OR network/parse failure
  bytes: number           // actual response-body bytes received (decompressed, pre-parse)
  latencyTotalMs: number  // summed wall-clock latency (fetch + body read)
  latencyMaxMs: number    // slowest single call
}

export interface FmpUsageSnapshot {
  /** ET day these counters cover, e.g. "2026-09-13". */
  day: string
  /** ms epoch when the current day's counters started accumulating. */
  since: number
  /** Aggregate across all families. */
  totals: FmpFamilyStat
  /** Per-endpoint-family breakdown. */
  families: Record<string, FmpFamilyStat>
}

/** On-disk shape of one ET day's aggregate. No URL/key/symbol detail — aggregates only. */
export interface FmpUsageDayFile {
  day: string
  updatedAt: number
  totals: FmpFamilyStat
  families: Record<string, FmpFamilyStat>
}

// ── State (module singleton, per Node process) ────────────────────────────────

const families = new Map<string, FmpFamilyStat>()
let currentDay = etDay()
let since = Date.now()
// Which ET day the in-memory counters have been seeded from disk for. Null arms a
// lazy load on the next telemetry use (fresh process, or after a day roll/reset).
let loadedDay: string | null = null
// Persistence scheduling. `dirty` gates pointless writes (nothing changed since the
// last persist). `persistScheduled` coalesces the off-hot-path deferred write. `lastEmit`
// throttles the periodic emit+persist to at most once per EMIT_INTERVAL_MS.
let dirty = false
let persistScheduled = false
let lastEmit = 0

function emptyStat(): FmpFamilyStat {
  return { requests: 0, successful: 0, failed: 0, bytes: 0, latencyTotalMs: 0, latencyMaxMs: 0 }
}

/** ET calendar day ("YYYY-MM-DD"). Local copy of the trading-day rule so this module
 *  carries no dependency on the execution/paper-trade layer. */
export function etDay(ts: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ts))
}

// ── Persistence location ───────────────────────────────────────────────────────

/** Directory holding one aggregate JSON per ET day. Overridable via
 *  COMPANION_FMP_USAGE_DIR (tests point this at a temp dir). */
export function fmpUsageDir(): string {
  return process.env.COMPANION_FMP_USAGE_DIR || join(homedir(), '.companion-fmp-usage')
}
function usageFile(day: string): string {
  return join(fmpUsageDir(), `${day}.json`)
}

// ── Day roll + lazy load ─────────────────────────────────────────────────────

function rollDayIfNeeded(now: number): void {
  const d = etDay(now)
  if (d !== currentDay) {
    // Flush the CLOSING day synchronously before clearing (best-effort). This is the
    // ONE synchronous write on the call path, and it happens at most once per ET day,
    // at the ET-midnight boundary when the market is closed and the sweep is idle — so
    // it is not on a live market-data return path in practice. Guarded by `dirty` so a
    // day with no unpersisted change writes nothing.
    if (dirty) persistFmpUsage(currentDay, now)
    families.clear()
    currentDay = d
    since = now
    loadedDay = null                   // arm a load for the new day
    dirty = false
    persistScheduled = false
  }
}

/** Roll the day if needed, then seed the in-memory counters from that day's persisted
 *  aggregate exactly once (first telemetry use of the day / of the process). */
function ensureLoaded(now: number): void {
  rollDayIfNeeded(now)
  if (loadedDay !== currentDay) {
    loadedDay = currentDay             // set first so a load failure can't re-enter/loop
    loadPersistedDay(currentDay)
  }
}

/** Merge a persisted day's aggregate into the in-memory counters. Missing file = a
 *  normal first-of-day (silent). Corrupt/unreadable file = warn and keep fresh. Never throws. */
function loadPersistedDay(day: string): void {
  const file = usageFile(day)
  try {
    if (!existsSync(file)) return
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as FmpUsageDayFile
    if (!parsed || typeof parsed !== 'object' || !parsed.families || typeof parsed.families !== 'object') {
      throw new Error('unexpected shape')
    }
    for (const [fam, s] of Object.entries(parsed.families)) {
      const cur = families.get(fam) ?? emptyStat()
      cur.requests += s?.requests ?? 0
      cur.successful += s?.successful ?? 0
      cur.failed += s?.failed ?? 0
      cur.bytes += s?.bytes ?? 0
      cur.latencyTotalMs += s?.latencyTotalMs ?? 0
      cur.latencyMaxMs = Math.max(cur.latencyMaxMs, s?.latencyMaxMs ?? 0)
      families.set(fam, cur)
    }
  } catch (e) {
    console.warn(`[FMP] usage load failed for ${day} — starting fresh:`, (e as Error).message)
    // leave in-memory counters as they are (fresh); never propagate
  }
}

// ── Endpoint-family derivation (path ONLY — never the URL) ─────────────────────

/**
 * Reduce a request path to a stable family key for aggregation. Derived strictly from
 * the `path` argument fmpGet already receives (which never contains the apikey or any
 * query string). The interval segment of historical-chart is KEPT on purpose
 * ("/historical-chart/5min" vs "/1min") because their byte profiles differ sharply.
 */
export function fmpFamily(path: string): string {
  // Defensive: if a caller ever includes a query string, drop it so the key can never
  // carry credentials. Paths here are static templates, so this is belt-and-braces.
  const p = path.split('?')[0]
  return p.startsWith('/') ? p : `/${p}`
}

// ── Recording ──────────────────────────────────────────────────────────────────

export interface FmpCallRecord {
  path: string        // the fmpGet path arg — the ONLY source of the family key
  ok: boolean         // 2xx + parseable
  bytes: number       // response-body bytes (0 when unknown/failed before body)
  latencyMs: number
}

export function recordFmpCall(rec: FmpCallRecord, now: number = Date.now()): void {
  ensureLoaded(now)
  const family = fmpFamily(rec.path)
  const s = families.get(family) ?? emptyStat()
  s.requests += 1
  if (rec.ok) s.successful += 1
  else s.failed += 1
  s.bytes += rec.bytes > 0 ? rec.bytes : 0
  s.latencyTotalMs += rec.latencyMs
  if (rec.latencyMs > s.latencyMaxMs) s.latencyMaxMs = rec.latencyMs
  families.set(family, s)
  dirty = true   // in-memory accounting changed; a future persist has something to write
}

// ── Read-only snapshot ───────────────────────────────────────────────────────

/** Derive totals + a plain-object family map from the current in-memory counters. */
function currentSnapshot(): { totals: FmpFamilyStat; families: Record<string, FmpFamilyStat> } {
  const totals = emptyStat()
  const out: Record<string, FmpFamilyStat> = {}
  for (const [family, s] of families) {
    out[family] = { ...s }
    totals.requests += s.requests
    totals.successful += s.successful
    totals.failed += s.failed
    totals.bytes += s.bytes
    totals.latencyTotalMs += s.latencyTotalMs
    if (s.latencyMaxMs > totals.latencyMaxMs) totals.latencyMaxMs = s.latencyMaxMs
  }
  return { totals, families: out }
}

export function getFmpUsage(now: number = Date.now()): FmpUsageSnapshot {
  ensureLoaded(now)
  const { totals, families: out } = currentSnapshot()
  return { day: currentDay, since, totals, families: out }
}

/** Explicit reset (tests / manual). Clears in-memory counters and arms a fresh
 *  load-on-next-use. Does NOT touch disk. */
export function resetFmpUsage(now: number = Date.now()): void {
  families.clear()
  currentDay = etDay(now)
  since = now
  loadedDay = null
  dirty = false
  persistScheduled = false
  lastEmit = 0
}

// ── Persistence (atomic; best-effort; never throws into the caller) ────────────

/** Build the on-disk aggregate for `day` from the current counters, or null when there
 *  is nothing to persist (so a bare reset/empty state can never clobber a day's file). */
function buildDayFile(day: string, now: number): FmpUsageDayFile | null {
  const { totals, families: fam } = currentSnapshot()
  if (totals.requests === 0) return null
  return { day, updatedAt: now, totals, families: fam }
}

/** Atomic write (temp file → rename). Best-effort: warns and returns false on failure,
 *  never throws. This is the ONLY function that touches the disk for writes. */
function writeDayFileAtomic(day: string, file: FmpUsageDayFile): boolean {
  try {
    const dir = fmpUsageDir()
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${day}.json.tmp.${process.pid}`)
    writeFileSync(tmp, JSON.stringify(file))
    renameSync(tmp, usageFile(day))
    return true
  } catch (e) {
    console.warn(`[FMP] usage persist failed for ${day}:`, (e as Error).message)
    return false
  }
}

/**
 * SYNCHRONOUS persist of the current day's aggregate. Used for the ET-day rollover
 * flush, explicit flush (graceful shutdown, `flushFmpUsage`), and tests. No-op
 * (returns false) when there is nothing to persist. Never throws.
 */
export function persistFmpUsage(day: string = currentDay, now: number = Date.now()): boolean {
  const file = buildDayFile(day, now)
  if (!file) return false
  const ok = writeDayFileAtomic(day, file)
  if (ok) dirty = false
  return ok
}

/**
 * Flush the current day synchronously — intended for graceful shutdown (SIGINT/SIGTERM).
 * Best-effort; returns false when there is nothing to persist. Not wired into the daemon
 * here (that lands with the daemon integration step); exported so a shutdown handler can
 * call it. Never throws.
 */
export function flushFmpUsage(now: number = Date.now()): boolean {
  return persistFmpUsage(currentDay, now)
}

/**
 * Schedule an OFF-HOT-PATH persist. Captures the current aggregate SYNCHRONOUSLY (cheap
 * object build) and performs the disk write on the next event-loop turn via setImmediate,
 * so the write latency NEVER sits on the fmpGet() return path. Coalesced by
 * `persistScheduled`, and a no-op when there is nothing to persist. Never throws.
 */
function schedulePersist(day: string, now: number): void {
  if (persistScheduled) return
  const file = buildDayFile(day, now)
  if (!file) return
  persistScheduled = true
  dirty = false   // captured into `file`; any new record re-arms `dirty`
  setImmediate(() => {
    persistScheduled = false
    writeDayFileAtomic(day, file)   // best-effort; failure warned inside, never thrown
  })
}

// ── Formatting / reporting ─────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  const gb = bytes / 1_000_000_000
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / 1_000_000
  if (mb >= 1) return `${mb.toFixed(2)} MB`
  const kb = bytes / 1_000
  if (kb >= 1) return `${kb.toFixed(1)} KB`
  return `${bytes} B`
}

/** Fraction (0..1) of total bytes attributable to each family, largest first. */
export function bytesShare(snapshot: FmpUsageSnapshot): Array<{ family: string; bytes: number; share: number }> {
  const total = snapshot.totals.bytes
  return Object.entries(snapshot.families)
    .map(([family, s]) => ({ family, bytes: s.bytes, share: total > 0 ? s.bytes / total : 0 }))
    .sort((a, b) => b.bytes - a.bytes)
}

/**
 * Human-readable log lines. First line is the day total; following lines are the
 * top families by byte share. Emitted PERIODICALLY (see maybeEmitFmpUsage), never
 * per call.
 *
 *   [FMP] today 0.84 GB · 18,420 req
 *   [FMP] historical-chart/5min 61% bytes
 *   [FMP] quote 22% bytes
 */
export function formatFmpUsageLines(snapshot: FmpUsageSnapshot, topN = 3): string[] {
  const t = snapshot.totals
  const lines = [`[FMP] today ${formatBytes(t.bytes)} · ${t.requests.toLocaleString('en-US')} req`]
  for (const { family, share } of bytesShare(snapshot).slice(0, topN)) {
    if (share <= 0) continue
    // Family printed without its leading slash to match the requested format.
    lines.push(`[FMP] ${family.replace(/^\//, '')} ${Math.round(share * 100)}% bytes`)
  }
  return lines
}

// ── Rolling multi-day report (read-only; disk scan; no network) ────────────────

export interface RollingFamily { family: string; bytes: number; requests: number; share: number }
export interface RollingUsage {
  days: number
  window: string[]            // ET dates considered, most recent first
  datesPresent: string[]      // subset of `window` that had a persisted file, most recent first
  totalRequests: number
  totalBytes: number
  gb: number
  families: RollingFamily[]   // largest bytes first
  today: FmpUsageDayFile | null   // today's persisted aggregate (may lag the live daemon by ≤1 emit interval)
  limitGb: number | null      // FMP_ROLLING_LIMIT_GB, DISPLAY ONLY
  usedPct: number | null      // totalBytes vs limit, DISPLAY ONLY
}

/**
 * Optional rolling display limit, in GB, from FMP_ROLLING_LIMIT_GB. DISPLAY ONLY:
 * used solely to render a "used / limit (pct)" line. It NEVER throttles, disables, or
 * gates any feed, request, or strategy/execution behavior. Absent/invalid ⇒ no limit.
 */
export function rollingLimitBytes(): number | null {
  const raw = process.env.FMP_ROLLING_LIMIT_GB
  if (!raw) return null
  const gb = Number(raw)
  return Number.isFinite(gb) && gb > 0 ? gb * 1_000_000_000 : null
}

/**
 * Scan the persisted daily aggregates and sum the trailing `days` ET dates (inclusive
 * of today). Pure disk read — makes NO network calls and never throws. A day outside
 * the window is excluded; a corrupt/absent file is skipped.
 */
export function getRollingUsage(days = 30, now: number = Date.now()): RollingUsage {
  const window: string[] = []
  for (let i = 0; i < days; i++) window.push(etDay(now - i * 86_400_000))
  const windowSet = new Set(window)
  const todayKey = window[0]

  const agg = new Map<string, FmpFamilyStat>()
  let totalRequests = 0, totalBytes = 0
  const datesPresent: string[] = []
  let today: FmpUsageDayFile | null = null

  try {
    const dir = fmpUsageDir()
    const files = existsSync(dir) ? readdirSync(dir) : []
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)
      if (!m || !windowSet.has(m[1])) continue
      let parsed: FmpUsageDayFile
      try { parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as FmpUsageDayFile } catch { continue }
      if (!parsed || !parsed.families) continue
      datesPresent.push(m[1])
      if (m[1] === todayKey) today = parsed
      for (const [fam, s] of Object.entries(parsed.families)) {
        const cur = agg.get(fam) ?? emptyStat()
        cur.requests += s?.requests ?? 0
        cur.successful += s?.successful ?? 0
        cur.failed += s?.failed ?? 0
        cur.bytes += s?.bytes ?? 0
        cur.latencyTotalMs += s?.latencyTotalMs ?? 0
        cur.latencyMaxMs = Math.max(cur.latencyMaxMs, s?.latencyMaxMs ?? 0)
        agg.set(fam, cur)
        totalRequests += s?.requests ?? 0
        totalBytes += s?.bytes ?? 0
      }
    }
  } catch (e) {
    console.warn('[FMP] rolling usage scan failed:', (e as Error).message)
  }

  const fam: RollingFamily[] = [...agg.entries()]
    .map(([family, s]) => ({ family, bytes: s.bytes, requests: s.requests, share: totalBytes > 0 ? s.bytes / totalBytes : 0 }))
    .sort((a, b) => b.bytes - a.bytes)
  const limit = rollingLimitBytes()
  return {
    days,
    window,
    datesPresent: datesPresent.sort().reverse(),
    totalRequests,
    totalBytes,
    gb: totalBytes / 1_000_000_000,
    families: fam,
    today,
    limitGb: limit != null ? limit / 1_000_000_000 : null,
    usedPct: limit != null && limit > 0 ? (totalBytes / limit) * 100 : null,
  }
}

/**
 *   [FMP] rolling 30d 41.2 / 50.0 GB (82.4%)      (with FMP_ROLLING_LIMIT_GB)
 *   [FMP] rolling 30d 41.2 GB                      (without)
 * DISPLAY ONLY.
 */
export function formatRollingLine(r: RollingUsage): string {
  if (r.limitGb != null && r.usedPct != null) {
    return `[FMP] rolling ${r.days}d ${r.gb.toFixed(1)} / ${r.limitGb.toFixed(1)} GB (${r.usedPct.toFixed(1)}%)`
  }
  return `[FMP] rolling ${r.days}d ${r.gb.toFixed(1)} GB`
}

// ── Periodic aggregated emission + persistence + soft budget (informational) ────

// Emit + schedule a persist at most once per interval, from the call path — so there is
// one aggregated heartbeat (and at most one disk write) rather than one per market-data
// call. `lastEmit` lives in the state block above.
const EMIT_INTERVAL_MS = 60_000
const budgetWarned = new Set<number>()   // dedupe 80/90/100% warnings per day+level

/**
 * Optional soft daily byte budget, in GB, from FMP_SOFT_DAILY_GB. INFORMATIONAL ONLY:
 * crossing it logs a warning and nothing else. It NEVER disables a feed, throttles a
 * request, or alters any strategy/execution behavior. Absent/invalid ⇒ no budget.
 */
export function softBudgetBytes(): number | null {
  const raw = process.env.FMP_SOFT_DAILY_GB
  if (!raw) return null
  const gb = Number(raw)
  return Number.isFinite(gb) && gb > 0 ? gb * 1_000_000_000 : null
}

/**
 * Called after each recorded call. At most once per EMIT_INTERVAL_MS it (a) SCHEDULES an
 * off-hot-path persist of the day's aggregate (only when `dirty`) and (b) logs an
 * aggregated usage line; plus a one-shot soft-budget warning at 80/90/100% of the day's
 * byte budget. The disk write is deferred (setImmediate) so its latency NEVER sits on the
 * fmpGet() return path. Pure side-effects — no control-flow effect on the caller, never
 * throws.
 */
export function maybeEmitFmpUsage(
  log: (...a: unknown[]) => void = console.log,
  now: number = Date.now(),
): void {
  const snap = getFmpUsage(now)

  const budget = softBudgetBytes()
  if (budget != null) {
    const pct = snap.totals.bytes / budget
    for (const level of [1, 0.9, 0.8]) {
      if (pct >= level && !budgetWarned.has(level)) {
        budgetWarned.add(level)
        log(`[FMP] ⚠ ${Math.round(level * 100)}% of soft daily budget (${formatBytes(snap.totals.bytes)} / ${formatBytes(budget)})`)
        break
      }
    }
    // New day clears the day's warnings (getFmpUsage rolled `since` already).
    if (snap.since === now || snap.totals.bytes === 0) budgetWarned.clear()
  }

  if (now - lastEmit < EMIT_INTERVAL_MS) return
  lastEmit = now
  if (snap.totals.requests === 0) return
  if (dirty) schedulePersist(currentDay, now)   // deferred off the return path; skipped when unchanged
  for (const line of formatFmpUsageLines(snap)) log(line)
}
