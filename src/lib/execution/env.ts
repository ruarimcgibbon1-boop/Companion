/**
 * Minimal .env.local loader for standalone scripts.
 *
 * Next.js loads .env.local for the app automatically, but a `tsx scripts/...`
 * process gets nothing — and the alert daemon has always leaned on the dev
 * server holding the keys. The executor talks to Alpaca directly, so it needs
 * ALPACA_* in its own process. Twenty lines beats a dependency for this.
 *
 * Existing process.env values always win, so `ALPACA_KEY_ID=… npx tsx …` and CI
 * secrets override the file rather than the other way round.
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

export function loadEnvLocal(file = resolve(process.cwd(), '.env.local')): void {
  if (!existsSync(file)) return
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch { return }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // Strip one layer of matching quotes, the only quoting style these files use.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}
