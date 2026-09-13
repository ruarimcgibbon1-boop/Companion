/**
 * FMP request/byte telemetry — server-side, in-process, read-only reporting.
 *
 * The real constraint on this app is ROLLING FMP BANDWIDTH (bytes/day), not request
 * count, so this module counts bytes first and requests second. It is a passive
 * accumulator wired into the single `fmpGet()` chokepoint (see fmp-client.ts): it
 * observes calls, it never makes them and never changes their result.
 *
 * SECURITY INVARIANT (enforced by construction):
 *   The only per-call string this module ever stores or emits is the ENDPOINT FAMILY,
 *   which is derived EXCLUSIVELY from the `path` argument of fmpGet (e.g. "/quote",
 *   "/historical-chart/5min"). The request URL — which carries `?apikey=…` in its
 *   query string — is NEVER passed in, stored, or logged here. There is no code path
 *   that accepts a full URL or a header map. A unit test asserts no emitted line
 *   contains a key.
 *
 * "Today" is the rolling ET TRADING DAY (America/New_York calendar day), matching the
 * rest of the app's day accounting (execution/store.etDayKey). Counters auto-reset on
 * the first call of a new ET day, so a long-running daemon reports per-session-day
 * without any external reset.
 */

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

// ── State (module singleton, per Node process) ────────────────────────────────

const families = new Map<string, FmpFamilyStat>()
let currentDay = etDay()
let since = Date.now()

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

function rollDayIfNeeded(now: number): void {
  const d = etDay(now)
  if (d !== currentDay) {
    families.clear()
    currentDay = d
    since = now
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
  rollDayIfNeeded(now)
  const family = fmpFamily(rec.path)
  const s = families.get(family) ?? emptyStat()
  s.requests += 1
  if (rec.ok) s.successful += 1
  else s.failed += 1
  s.bytes += rec.bytes > 0 ? rec.bytes : 0
  s.latencyTotalMs += rec.latencyMs
  if (rec.latencyMs > s.latencyMaxMs) s.latencyMaxMs = rec.latencyMs
  families.set(family, s)
}

// ── Read-only snapshot ───────────────────────────────────────────────────────

export function getFmpUsage(now: number = Date.now()): FmpUsageSnapshot {
  rollDayIfNeeded(now)
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
  return { day: currentDay, since, totals, families: out }
}

/** Explicit reset (tests / manual). Production resets automatically on ET-day change. */
export function resetFmpUsage(now: number = Date.now()): void {
  families.clear()
  currentDay = etDay(now)
  since = now
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

// ── Periodic aggregated emission + soft budget (informational only) ────────────

// Emit at most once per interval, from the call path — so there is one aggregated
// heartbeat rather than a line per market-data call.
const EMIT_INTERVAL_MS = 60_000
let lastEmit = 0
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
 * Called after each recorded call. Logs an aggregated usage line at most once per
 * EMIT_INTERVAL_MS, plus a one-shot soft-budget warning at 80/90/100% of the day's
 * byte budget. Pure logging — no control-flow effect on the caller.
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
  for (const line of formatFmpUsageLines(snap)) log(line)
}
