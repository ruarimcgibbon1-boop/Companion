# Paper trading

Routes the same BUY signals the alert daemon texts you into an Alpaca **paper**
account: sized, ordered, and managed to a close, fully automatically.

## What this is actually measuring

Not "does the logic run" — `scripts/backtest.ts` already answers that (+0.41–0.76%
expectancy per trade). The question is **whether that expectancy survives real
fills**, and there are three ways it might not:

| Leak | Recorded as |
|---|---|
| Paying up to get filled on a thin gapper | `entrySlippagePct` per trade |
| Selling below the level on the way out | `slippagePct` per exit leg |
| Signals that never fill at all | trades in state `aborted` |

The third one matters as much as the first two and is invisible in a backtest: a
replay assumes every signal filled at its level. If a third of premarket
continuation signals can't be bought at a sane price, the real strategy is not
the backtested strategy.

Note the paper broker fills optimistically against the quote and does not model
book depth, so on thin names paper will flatter you. Read the slippage columns as
a floor on the real cost, not an estimate of it.

## Setup

1. Open a free account at [alpaca.markets](https://alpaca.markets/) and go to the
   **Paper Trading** dashboard (default equity $100k).
2. Generate an API key there and copy both the key id and the secret.
3. Add them to `.env.local`:

```
ALPACA_KEY_ID=...
ALPACA_SECRET_KEY=...
```

The client refuses to start against any non-paper Alpaca endpoint, so a typo in
`ALPACA_BASE_URL` can't quietly point this at real money.

## Running

Dev server in one terminal (the daemon reads all market data through its routes):

```bash
npm run dev
```

Daemon in another:

```bash
PAPER_TRADE=1 npx tsx scripts/alert-daemon.ts
```

Dry run — full sizing and gate logic, no orders placed:

```bash
PAPER_TRADE=1 DRY_RUN=1 npx tsx scripts/alert-daemon.ts
```

Without `PAPER_TRADE=1` the daemon behaves exactly as before: alerts only.

### Kill switch

```bash
touch ~/.companion-halt
```

Blocks all new entries within one sweep. Existing positions keep being managed —
this stops the loop from opening more, it doesn't abandon what's already on. To
flatten instead, stop the daemon with Ctrl-C: it sells everything open, prints a
session summary, and exits.

## How a trade runs

1. **Signal.** `classifyBuy` returns `logged` — the same gate stack the alerts and
   the backtest use. Paper trading is downstream of it and changes nothing about
   which signals fire.
2. **Size.** Fixed fractional risk: 0.5% of equity per trade, share count set by
   the stop distance. Capped by notional (20% of equity), buying power, and
   participation (1% of session volume). The binding cap is recorded on the trade.
3. **Entry.** A marketable limit 0.5% above the signal's entry — never a market
   order. Signals fire when price is already through the level, so a market order
   chases; the cap converts "bad fill" into "no fill", which is both cheaper and
   countable. Unfilled after 90s → canceled, trade marked `aborted`.
4. **Manage.** Exits follow `scaledPnl` in `src/lib/eod-resolver.ts` exactly —
   half at T1, stop to breakeven, remainder at T2, flatten at 15:55 ET. That
   parity is deliberate: a different ladder would make live and backtest results
   incomparable, which is the whole point of the exercise.
5. **Close.** Realized P&L is computed from fills only. Nothing is modelled.

Exit *decisions* are made off the FMP feed (the one that generated the signal),
not off broker data. The broker only fills orders.

### Risk limits

Defaults in `src/lib/execution/risk.ts`:

| Limit | Default | Terminal for the day? |
|---|---|---|
| Concurrent positions | 3 | no |
| Open risk | 1.5% of equity | no |
| Positions per symbol | 1 (no pyramiding) | no |
| Daily loss | 2% of starting equity | yes |
| Trades per day | 10 | yes |

## Known gaps

- **No broker-side stop premarket.** Alpaca rejects stop orders outside
  09:30–16:00, so a premarket position is protected only by the polled loop. If
  the daemon dies holding one, the position is naked until you restart. During
  regular hours a resting stop is placed and kept in sync with the ladder.
- **15s exit granularity.** Exits are checked once per sweep. A fast break through
  the stop is sold at whatever the next sample shows, not at the level — that
  gap is real, and it lands in the exit slippage numbers rather than being hidden.
- **Alpaca lists no OTC names.** Signals on unlisted symbols are skipped and
  recorded with reason `not tradable at broker`.

## Output

Written to `$HOME`, one set per ET day:

- `.companion-paper-trades-YYYY-MM-DD.json` — every trade, full state. Reloaded on
  restart, so a crash mid-position doesn't orphan it.
- `.companion-paper-events-YYYY-MM-DD.jsonl` — append-only audit trail of every
  submit, fill, reject, and close.

Both join back to signal research through `signalId` / `setupId`, so paper results
sit alongside the decision log the daemon already writes.
