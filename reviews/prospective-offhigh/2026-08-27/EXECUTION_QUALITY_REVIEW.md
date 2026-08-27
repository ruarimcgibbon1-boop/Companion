# EXECUTION-QUALITY REVIEW — Session 3 — 2026-08-27

- EQ tape: `~/.companion-execution-quality-2026-08-27.jsonl`
- sha256: `c2b35887d66897b1cc5b91fe5c2782cbd9772fa967a7728d3e061d296e510aa8`
- rows: **29,361** · bytes: 23,328,766
- Observer health: **HEALTHY** — `EXEC_OBSERVER=1` active; continuous tape (Issue 3 stays resolved).

## Tape summary
- Coverage: **04:29:26 → 15:29:22 ET** (continuous to the last active position's exit).
- Cadence: median **2002 ms** / p95 **2003 ms** (min 1982, max 2200) — no cadence gaps.
- `quoteStatus` all `ok` → **0 quote errors**. `tradeStatus` all `ok` → **0 trade errors**.
- `observationDropped` all `false` → **0 dropped iterations**; 0 aborted observations.
- `executionPath`: broker_stop 17,990 / polled 11,371. `observedFeed`: alpaca-iex (all).

## Freshness — reconciled to the full 29,361 (not exhaustive two-way)
| Freshness | Quote | Trade |
|---|---|---|
| fresh | 20,467 (69.71%) | 17,783 (60.57%) |
| stale | 8,887 (30.27%) | 11,562 (39.38%) |
| **null / undefined** | **7 (0.02%)** | **16 (0.05%)** |
| **total** | **29,361** | **29,361** |

The residual **7 quote-null / 16 trade-null** rows are observations where the poll
**succeeded** (`status=ok`, not dropped) but the feed payload carried **no bid/ask**
(`observedBid/Ask/QuoteTs=null`) or **no trade print** (`observedTradePrice/TradeTs=null`);
freshness is therefore undefined — a **third state distinct from stale** (5 rows are both-null;
all on CRWD/FWDI/YYGH). Fresh/stale percentages are **not exhaustive** without this null bucket.
Stale rows are dominated by illiquid premarket quote age (WKSP/OKTA/DAIC/CYPH; quoteAge p95
~14.7h). **No breach was recorded on a null or stale row.**

## Breach evidence
- `observedBreach=true`: **2,318** — **100% `observedBidAtOrBelowStop=true`, 100% on fresh
  quotes**. Only **1** row had `observedTradeAtOrBelowStop=true` all day.
- Broker-native stops trigger on **trade prints**, not bid; bid-at-or-below-stop touches
  (e.g. CRWD 1,954, against the breakeven trail 213.66) did not stop positions that kept
  trading above the stop. **No stale/null observation is used as stop evidence.**

## Latency — two distinct sub-latencies (not conflated)
The artifacts provide `submitted → local-recognized-fill` intervals (event pairs) but **no
independent broker-side fill timestamp**. For cleanly-filled trades the broker-fill instant and
the local-recognition instant **cannot be separated** — they collapse into the submit→local-fill
interval. The one trade with a measurable broker-fill→recognition gap is **FWDI**.

| Symbol | submit → broker fill | broker fill → local recognition | combined (submit→local-fill) | Note |
|---|---|---|---|---|
| NVDL | not separable | not separable | **3.39 s** (exit) | clean broker stop @35.34 (gap −0.018%). *Corrected:* this is submit→local-fill, **not** a "recognition delay"; no evidence of lag. |
| WKSP | not separable | not separable | 31.1 s + 4.4 s (2 legs) | illiquid stop-market; **market-gap** ≈ −2.2R (fills 5–8% below stop 0.5818) |
| YYGH (runner) | not separable | not separable | ~0 on fill | 293 fresh bid≤stop from 09:30; broker stop trade-triggered 10:03:38 @1.88 |
| CRWD | not separable | not separable | 3.6 s (t1) / 3.3 s (t2) | winner; breakeven-stop bid touches held on trade prints |
| CRM | not separable | not separable | 3.5 s (t1) / 3.4 s (t2) | winner |
| FWDI | placed 11:31:31; broker fills across 11:31–13:57 (not individually timestamped) | **up to ≈ 2h26m** (protective_stop placed 11:31:31 → reconcile discovery 13:57:24) | 182-share residual only | **broker-fill→recognition lag is the measurable defect (Issue 1)** |

## Partial-exit ingestion check (Issue 1)
- **FWDI — most severe instance of the trial.** Entry 2,711 @6.83 (11:31 ET); the broker stop
  sold the position down over the session, but local ingested **none** of those exits for
  ~2h26m (`reconcile brokerQty=182 localQty=2711` at 13:57), then forced flat and priced the
  residual 182 externally (`external_close_priced extFills=4` @6.7353). Local booked P&L on
  **182 of 2,711 shares**: local −$17.24/−0.062R vs broker ≈ −$256.7/−0.924R.
- **YYGH — mild instance.** 798-share t1 filled at broker; local ingested only one 409-share
  leg (`reconcile brokerQty=798 localQty=1187`). Local +$32.92/+0.311R vs broker ≈ +$71.8/+0.678R.

**FWDI lag = Issue 1 (ingestion), NOT Issue 2 (network).** The EQ tape shows **4,376 continuous
FWDI observations at steady 2 s cadence across the whole 11:31→13:57 window** — connectivity was
healthy; the executor failed to ingest broker exit fills. This is explicitly distinct from the
2026-08-26 HOWL network outage (Issue 2).

## Post-signal excursion — REVIEW-ONLY diagnostic (outside the frozen criterion)
Full same-day excursion per signal, regardless of executor action. **Does not affect PASS/FAIL
of the off-high hypothesis and is not used to tune the threshold.** Window: signal → 16:00 ET;
anchor: decision-time `entryRef`; `riskPerShare = entryRef − stop`.

**Coverage denominators (both reported):** **signal-instance 3 / 10** (6 filled + 3 aborted + 1
blocked CRWD:bos = 10 instances; tapes for CRWD:opening_drive, CRWD:break_of_structure, FWDI);
**unique-symbol 2 / 9** (tapes only for CRWD, FWDI).

| Symbol | setupId | Instance | Sig ET | entryRef | Fill | Stop | Real R | SigMFE_R | Min/MAE_R | MFE_% | Min/MAE_% | MFE_t | Min_t | EOD_R | EOD_% | FillMFE_R | FillMin_R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CRWD | opening_drive:211.67 | filled | 09:34 | 213.98 | 213.66 | 210.77 | +3.552 | +4.645 | **+0.321** ¹ | +6.97 | +0.48 | 15:53 | 09:39 | +4.356 | +6.53 | +5.270 | +0.467 ¹ |
| FWDI | opening_range_break:6.71 | filled | 11:31 | 6.83 | 6.83 | 6.7276 | −0.924ᵉ | +1.562 | −2.524 ² | +2.34 | −3.79 | 11:54 | 15:35 | −1.659 | −2.49 | +1.562 | −2.524 ² |
| CRWD | break_of_structure:206.70 | blocked repl. | 06:39 | 207.23 | — | 201.01 | — | +3.484 | −0.497 ² | +10.45 | −1.49 | 15:53 | 07:11 | +3.334 | +10.00 | — | — |
| NVDL / WKSP / YYGH / CRM | — | filled | — | — | — | — | — | **DATA_INCOMPLETE — no 1m tape** ||||||||||
| OKTA / DAIC / CYPH | — | aborted | — | — | — | — | — | **DATA_INCOMPLETE — no 1m tape** ||||||||||

¹ **CRWD never traded below entryRef** (min 215.01 > 213.98) → **minimum excursion +0.321R, not
adverse.** ² Genuinely traded below entryRef (adverse excursion).

**Capture efficiency (both anchors):** CRWD:opening_drive — realized +3.552R →
**signal-anchored 76.5%** (3.552/4.645), **fill-anchored 67.4%** (3.552/5.270). CRM winner but
**DATA_INCOMPLETE (no tape)** → not computable.

**Descriptive observations only (no stop/target/re-entry recommendation):** CRWD captured a high
share of a move that never dipped below entry. FWDI produced a brief +1.562R spike (11:54) then
reversed into an adverse excursion that **continued materially past the stop** to −2.524R,
closing −1.659R; never recovered. The unfilled CRWD:bos ran to +3.484R MFE with a shallow
−0.497R minimum (never near its stop); the +2.888R target-hit reconstruction is conservative.

## Note
This EQ review documents observation; **no code change is made** (executor is CONTROL and
frozen). Ingestion repair is deferred (Issue 1). Standing mitigation — nightly
broker-vs-local reconciliation — captured both divergences.
