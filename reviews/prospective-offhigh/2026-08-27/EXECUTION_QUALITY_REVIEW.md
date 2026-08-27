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

## Latency — corrected with primary broker-fill timestamps (2026-08-28)

> The earlier version lacked broker-side fill timestamps and inferred a "broker-fill →
> recognition lag" **up to ≈ 2h26m** for FWDI. The Alpaca FILL ledger now supplies exact
> transaction timestamps, which **overturn that reading** (details below). The broker-fill
> and local-recognition instants are now separable for the stop-liquidated trades.

| Symbol | broker stop fill (ET, from FILL stream) | local recognition (ET) | broker-fill → recognition lag | Note |
|---|---|---|---|---|
| NVDL | 07:36:5x | 07:36:56 | ~seconds | clean broker stop @35.34; no defect |
| WKSP | 05:04:04–08 | 05:04:08 | ~seconds | illiquid stop-market; **market-gap** ≈ −2.2R (fills 5–8% below stop) |
| YYGH | t1 11:52:08 (798 in 3 frags); stop 14:02:54–55 (798) | t1 11:52:08 / mismatch 11:52:53 | ~seconds | qty reconciled in seconds; the defect is the **omitted 389-share t1 P&L**, not stale qty |
| CRWD | — | on fill | ~seconds | winner |
| CRM | — | on fill | ~seconds | winner |
| FWDI | **single ~1-second liquidation 13:56:41–42** (2,711 in 4 frags, one stop order) | ~13:57:24 (reconcile) | **≈ 43 s** | position legitimately open until 13:56:41; NOT a 2h26m stale window |

**FWDI correction (material).** The FILL stream shows the FWDI stop did **not** bleed the
position down across the afternoon. It rested from placement (11:31 ET) while the **2,711-share
position remained legitimately open** — broker qty and local qty were **both 2,711** — until
the stop triggered and liquidated the entire position in a **~1-second fill burst at 13:56:41
ET** (fragments 1,274+305+950+182). Local reconciliation recognized the change at ~13:57:24 ET.
The supported **broker-fill → local-recognition lag is therefore ≈ 43 seconds**, not ≈ 2h26m;
the 2h26m interval was the **holding period between stop placement and stop execution**, during
which local state was *correct*, not stale. This remains distinct from the 2026-08-26 HOWL
**network outage** (Issue 2): continuous EQ coverage confirms connectivity was healthy.

## Partial-exit ingestion check (Issue 1) — accounting defect stands
- **FWDI — largest $ under-book of the trial.** Entry 2,711 @6.83 (11:31 ET). The stop
  liquidated all 2,711 shares at ≈6.7353 vwap in one ~1-second burst (13:56:41 ET); the local
  executor ingested **only the 182-share fragment** (priced via `external_close_priced` after
  the 13:57 reconcile) and **omitted 2,529 exit shares** from realized P&L. Exact broker
  **−$256.73 / −0.924R** vs local **−$17.24 / −0.062R** (from the FILL ledger, not equity
  subtraction). The recognition-lag diagnosis is corrected (≈43 s); **the accounting
  incompleteness is real and material and is NOT retracted.**
- **YYGH.** The t1 target order filled **798 shares** (fragments 409+136+253 @1.99); local
  ingested only the first **409** and **omitted 389 t1 shares** from realized P&L. Exact broker
  **+$71.82 / +0.678R** vs local **+$32.92 / +0.311R**. Qty was reconciled to 798 within
  seconds (11:52:53) — no stale-qty window; the defect is the omitted-P&L on the un-ingested
  fragments.

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
