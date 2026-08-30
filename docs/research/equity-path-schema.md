# Intraday Equity-Path — review-only schema (`equity-path/v1`)

**Status:** research/review observability only. This module has **no order authority**, is
**never imported by any production/executor/admission path**, and **never** influences a live
or paper trading decision. It reconstructs the intraday portfolio path of a **frozen** session
from broker-truth fills, 1-minute tapes, and frozen paper-trade metadata.

- Pure core: [`src/lib/research/equity-path.ts`](../../src/lib/research/equity-path.ts) (IO-free, deterministic)
- CLI: [`scripts/session-equity-path.ts`](../../scripts/session-equity-path.ts)
- Tests: [`tests/equity-path.test.ts`](../../tests/equity-path.test.ts)

```
npx tsx scripts/session-equity-path.ts 2026-08-28
```

## Inputs (frozen, fail-closed)

| Input | Source | Role |
|---|---|---|
| Broker fill ledger | `data/research-cache/broker-ledger/broker-ledger-<DAY>.json` | **Execution truth** — entry/exit fills, qty, price, timing |
| 1-minute tapes | `data/research-cache/m1_<SYM>_<DAY>.json` | Marks for open positions (last-observed close ≤ t) |
| Frozen paper trades | `reviews/prospective-offhigh/<DAY>/snapshot/paper-trades.json` | **Original-risk denominator** + labels ONLY (never realized P&L) |
| Paper events | `…/snapshot/paper-events.jsonl` | Opening equity, startup-gap provenance |
| Shadow output | `…/snapshot/shadow-output.json` | `maxConcurrentPositions` cap (availableSlots) |
| EQ observer tape | `…/snapshot/execution-quality.jsonl` | Descriptive data-quality band |
| MANIFEST | `…/snapshot/MANIFEST.json` | sha256 integrity + freeze-timing provenance |

A **missing snapshot or broker ledger is a hard error** (`ALLOW_NON_FROZEN=1` permits a
development run, which stamps `nonFrozenInput: true` and a `NON_FROZEN_INPUT` warning). There is
**no silent fallback** to mutable live files or to defective local realized P&L.

## Two ledgers kept separate

Local `PaperTrade.realizedPnl` is **known-defective on fragmented fills** (under-books P&L). The
engine therefore reconstructs all economics **exclusively from broker fills** via average-cost
replay and never reads local realized numbers. Frozen paper-trade fields are used only for the
immutable original-risk denominator and labels.

## R convention (reused, not reinvented)

`portfolio R = Σ (per-trade dollar P&L ÷ per-trade original planned dollar risk)`, where
`plannedRisk = qty × (intendedEntry − initialStop)` — the exact denominator the broker ledger's
`brokerR` already uses (verified equal to the cent on the 2026-08-28 ledger) and the sum-of-R
the shadow harness reports. A trade whose original risk is not a positive finite number makes
**every R field UNKNOWN (`null`) at any minute where that trade is active** — never guessed.

## Mark convention (non-lookahead)

The mark for an open position at instant `t` is the **close of the most recent 1-minute bar
whose open time ≤ t** — the same last-observed-close convention `phantom-book` uses. No
interpolation, no future bar. If no bar exists at/before `t` for an **open** position, that
minute's `unrealizedDollarPnl`/`totalDollarPnl` is `null` (UNKNOWN) and the interval is recorded
in `coverage.unknownIntervals`.

## Output (top level)

| Field | Meaning |
|---|---|
| `schemaVersion` | `equity-path/v1` |
| `sessionDate`, `producerHead` | ET day; git HEAD of the analysis tooling |
| `inputProvenance`, `brokerLedgerProvenance`, `tapeProvenance` | sha256s, source labels, freeze metadata |
| `nonFrozenInput` | true only under the explicit dev override |
| `coverage` | axis bounds, minutes, UNKNOWN intervals, missing tapes, risk validity, ledger completeness |
| `portfolioSummary` | peak/final/giveback (see below) |
| `givebackAttribution` | classification + group contributions |
| `tradeMetrics[]` | per-trade MFE/MAE-before-exit, capture, giveback |
| `events[]` | chronological broker-fill timeline with post-event portfolio state |
| `path[]` | per-minute samples (`null` ⇒ UNKNOWN) |
| `dataQuality`, `processMetrics` | descriptive EQ band + EOD process metrics |
| `warnings[]`, `unknowns[]` | never silently omitted |

### `portfolioSummary`

`openingBrokerEquity`, `everPositive`, `peakBasis`, `peakTotalDollarPnl`, `peakTotalR`,
`peakTimestamp`, `realized/unrealized Dollar/R AtPeak`, `openPositionsAtPeak`,
`availableSlotsAtPeak`, `finalBrokerDollarPnl`, `finalBrokerR`, `peakToCloseGivebackDollar`,
`peakToCloseGivebackR`, `givebackPctOfPeak`. If the session never becomes positive, the peak is
recorded honestly (`everPositive: false`); no green-day interpretation is forced.

> **Portfolio peak is the maximum value observed on the deterministic 1-minute close-mark
> replay. It is not the true intraminute portfolio maximum.** `peakBasis` is always
> `minute_close_replay`. Open positions are marked at the last observed 1-minute bar **close**
> ≤ t; a within-minute swing between those samples is unobservable at this resolution and is
> deliberately **never synthesized**. Read `peakTotal*` / `peakTimestamp` as "best point on the
> minute-close path", not as an equity high-water mark.

### `givebackAttribution` — descriptive, review-only

`classification ∈ { NO_MEANINGFUL_GIVEBACK, OPEN_WINNER_REVERSAL, POST_PEAK_NEW_LOSSES,
MIXED_GIVEBACK, UNKNOWN }`, plus `prePeakOpenTradeGiveback`, `postPeakNewTradeGiveback`,
`otherOrUnknownContribution`, `postPeakNewTradeCount/Pnl`, `prePeakOpenTradeCount`.

**Decomposition (exact, to within rounding):**
`prePeakOpenTradeGiveback + postPeakNewTradeGiveback + otherOrUnknownContribution =
peakToCloseGivebackDollar` (= `peakTotalDollarPnl − finalBrokerDollarPnl`).

- **`prePeakOpenTradeGiveback`** = Σ over trades **open at the portfolio peak instant**
  (entered ≤ peak **and** still holding shares at the peak minute) of
  `(value at the PORTFOLIO peak instant) − (final broker contribution)`, where value at peak =
  that trade's realized-so-far **plus** unrealized marked at the **peak minute's close**. This is
  the trade's value **at the portfolio peak**, *not* its individual trade-level MFE and *not* its
  value at its own trade peak.
- **`postPeakNewTradeGiveback`** = Σ over trades **entered after the peak** of
  `0 − (final broker contribution)` (their value at the peak instant is 0).
- **`otherOrUnknownContribution`** = `totalGiveback` minus the two above — the rounding residual
  (trades fully closed before the peak contribute 0), unless an input was UNKNOWN.

Worked example — **Session 4 (2026-08-28):** peak `+386.23` − final `−2344.97` = giveback
`2731.20` = pre-peak-open `1453.06` (3 trades) + post-peak-new `1278.14` (4 trades) + other
`0.00`; residual `0.00`.

**Bands (documented, NOT strategy rules):** giveback below `|0.25R|` → `NO_MEANINGFUL_GIVEBACK`;
otherwise a group owning ≥ **70%** of the giveback is dominant (`OPEN_WINNER_REVERSAL` /
`POST_PEAK_NEW_LOSSES`), else `MIXED_GIVEBACK`. UNKNOWN whenever a required input is UNKNOWN.
These labels are **descriptive review categories only and must never be converted into trading
rules.**

### `tradeMetrics[]`

`brokerRealizedPnl/R`, `originalDollarRisk`, `maxUnrealizedDollar/R BeforeExit` + `timeOfMFE`,
`minUnrealizedDollar/R BeforeExit` + `timeOfMAE`; for losers `didTradeBecomeGreen`,
`maxGreenRBeforeStop`, `minutesFromMFEToExit`, `gaveBackMoreThan{0_5,1,2}R`; for winners
`captureEfficiency = brokerR / maxUnrealizedRBeforeExit` (only where MFE_R > 0),
`mfeToExitGivebackR = maxUnrealizedRBeforeExit − brokerR`. MFE/MAE use intrabar high/low against
running average cost, with the peak share count held through each bar (a documented intrabar
convention, since sub-bar fill ordering is unobservable).

### `events[]`

One row per broker fill, sorted, with `eventType ∈ { ENTRY_FILL, PARTIAL_ENTRY, T1_EXIT,
PARTIAL_EXIT, STOP_EXIT, FINAL_EXIT, EOD_FLATTEN, OTHER_FILL }` (exit reason joined from local
exit legs by `orderId`), plus `realized/unrealized/total PnlAfterEvent`, `portfolioRAfterEvent`,
`openPositions`, `availableSlots`.

### Descriptive process metrics

`dataQuality.eq.band ∈ { GOOD, DEGRADED, POOR, UNKNOWN }` — from quote/trade freshness, dropped,
and error/aborted rows (bands documented in `EQ_BANDS_DOC`). `processMetrics.eodFreezeStatus ∈
{ ON_TIME, LATE, FAILED, UNKNOWN }`, `marketCloseToFreezeMinutes`, `startupGapSeconds`. These are
**descriptive only**; existing session-classification rules remain authoritative, and nothing
here alters session usability.

## Output artifact

`data/research-cache/equity-path/equity-path-<DAY>.json` (gitignored research cache).
