/**
 * FMP usage baseline reporter — READ ONLY, NO NETWORK.
 *
 * Prints today's persisted FMP aggregate and the rolling 30-day local total from the
 * per-ET-day files in ~/.companion-fmp-usage (override with COMPANION_FMP_USAGE_DIR).
 * It makes no market-data calls and imports no market-data client — it only reads the
 * aggregate JSON the telemetry layer persists.
 *
 * Local `bytes` are DECOMPRESSED response-body bytes (see fmp-telemetry.ts): use them
 * for attribution and before/after comparison, not as FMP's provider-side meter.
 *
 *   npm run fmp:usage
 *   FMP_ROLLING_LIMIT_GB=50 npm run fmp:usage      # adds a "used / limit (pct)" line
 *   ROLLING_DAYS=7 npm run fmp:usage               # window other than 30
 */
import {
  getRollingUsage, formatRollingLine, formatBytes, fmpUsageDir,
  type FmpUsageDayFile, type FmpFamilyStat,
} from '@/lib/fmp-telemetry'

function topByBytes(families: Record<string, FmpFamilyStat>, n: number) {
  return Object.entries(families)
    .map(([family, s]) => ({ family, bytes: s.bytes, requests: s.requests }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n)
}

function main(): void {
  const days = Number(process.env.ROLLING_DAYS) > 0 ? Number(process.env.ROLLING_DAYS) : 30
  const r = getRollingUsage(days)
  const today: FmpUsageDayFile | null = r.today

  console.log(`FMP USAGE  ·  dir ${fmpUsageDir()}`)
  console.log('(local bytes = decompressed response body; a consistent proxy, not FMP\'s provider meter)')
  console.log('')

  // ── TODAY ──
  console.log(`TODAY  (${r.window[0]})`)
  if (today) {
    console.log(`  requests        ${today.totals.requests.toLocaleString('en-US')}`)
    console.log(`  local measured  ${formatBytes(today.totals.bytes)}`)
    const top = topByBytes(today.families, 3)
    if (top.length) {
      console.log('  TOP ENDPOINTS BY BYTES')
      top.forEach((t, i) => console.log(`    ${i + 1}. ${t.family.replace(/^\//, '')}  ${formatBytes(t.bytes)}  (${t.requests.toLocaleString('en-US')} req)`))
    }
  } else {
    console.log('  (no persisted usage for today yet)')
  }
  console.log('')

  // ── ROLLING WINDOW ──
  console.log(`ROLLING ${days} DAYS`)
  console.log(`  ${formatRollingLine(r)}`)
  console.log(`  requests        ${r.totalRequests.toLocaleString('en-US')}`)
  console.log(`  days with data  ${r.datesPresent.length} / ${days}`)
  const topRolling = r.families.slice(0, 5)
  if (topRolling.length) {
    console.log('  TOP ENDPOINTS BY BYTES')
    topRolling.forEach((t, i) => console.log(`    ${i + 1}. ${t.family.replace(/^\//, '')}  ${formatBytes(t.bytes)}  (${Math.round(t.share * 100)}%)`))
  } else {
    console.log('  (no persisted usage in window)')
  }
}

main()
