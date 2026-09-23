/**
 * Alpaca paper credential check — run this before trusting a live session.
 *
 * Confirms the keys in .env.local authenticate, that the account is the paper
 * one, and that it can actually be traded. Prints nothing secret: the key id is
 * masked and the secret is never read back out.
 *
 *   npx tsx scripts/check-alpaca.ts
 *   npx tsx scripts/check-alpaca.ts AAPL GTE   # also check specific symbols
 */
import { loadEnvLocal } from '@/lib/execution/env'
import { AlpacaBroker } from '@/lib/execution/alpaca'

loadEnvLocal()

const ok = (s: string) => `  ✓ ${s}`
const bad = (s: string) => `  ✗ ${s}`

async function main() {
  const keyId = process.env.ALPACA_KEY_ID
  const secret = process.env.ALPACA_SECRET_KEY

  console.log('\nAlpaca paper credential check\n')

  if (!keyId || !secret) {
    console.log(bad('ALPACA_KEY_ID / ALPACA_SECRET_KEY not found'))
    console.log('\n  Add both to .env.local (see .env.local.example), then re-run.\n')
    process.exit(1)
  }
  // Masked: enough to tell two keys apart, not enough to use.
  console.log(ok(`key id ${keyId.slice(0, 4)}…${keyId.slice(-4)} (${keyId.length} chars)`))
  console.log(ok(`secret present (${secret.length} chars)`))

  if (!keyId.startsWith('PK')) {
    console.log(`  ! key id does not start with "PK" — paper keys usually do.`)
    console.log(`    If this came from the LIVE dashboard it will not authenticate here.`)
  }

  let broker: AlpacaBroker
  try {
    broker = new AlpacaBroker()
  } catch (e) {
    console.log(bad((e as Error).message))
    process.exit(1)
  }

  try {
    const account = await broker.getAccount()
    console.log(ok(`authenticated · equity $${account.equity.toLocaleString()} · buying power $${account.buyingPower.toLocaleString()}`))

    if (account.blocked) {
      console.log(bad('account is blocked from trading — resolve this in the Alpaca dashboard'))
      process.exit(1)
    }
    console.log(ok('account is tradable'))
    if (account.daytradeCount > 0) {
      console.log(`  · ${account.daytradeCount} day trades in the trailing 5 sessions (irrelevant at paper equity)`)
    }

    const positions = await broker.getPositions()
    console.log(positions.length === 0
      ? ok('no open positions')
      : `  · ${positions.length} open position(s): ${positions.map(p => `${p.symbol} ${p.qty}`).join(', ')}`)

    // Tradability spot-check. Alpaca lists no OTC names, which is the single most
    // likely reason a signal on this strategy gets skipped.
    const symbols = process.argv.slice(2).map(s => s.toUpperCase())
    if (symbols.length) {
      console.log('\n  Tradability:')
      for (const symbol of symbols) {
        const asset = await broker.getAsset(symbol)
        console.log(asset?.tradable
          ? ok(`${symbol} tradable (${asset.exchange})`)
          : bad(`${symbol} ${asset ? 'not tradable' : 'not listed at Alpaca'} — signals on it will be skipped`))
      }
    }

    console.log('\n  Ready. Next: PAPER_TRADE=1 DRY_RUN=1 npx tsx scripts/alert-daemon.ts\n')
  } catch (e) {
    const msg = (e as Error).message
    console.log(bad(msg))
    if (msg.includes('403') || msg.includes('401')) {
      console.log('\n  A 401/403 here almost always means the keys came from the LIVE dashboard,')
      console.log('  or were regenerated (which invalidates the old pair). Generate a fresh key')
      console.log('  under Paper Trading and replace BOTH lines in .env.local.\n')
    }
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
