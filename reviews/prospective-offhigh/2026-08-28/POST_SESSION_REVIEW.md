# POST-SESSION REVIEW — Session 4 — 2026-08-28

## Summary
Fourth usable prospective session. **7 filled, matched 7/7, 0 open at EOD.** A **losing**
CONTROL session (net **−5.713R / PF 0**, 0 wins) in which the off-high challenger acted with a
single **DIRECT_REMOVAL** (`CHGA:opening_range_break`, offHighPct −12.67) and **0 replacements**
→ both experiment arms **−4.667R** (removing one realized loser improves the frozen day by
**+1.046R**). The session's central findings are operational/accounting, not strategic:
**(1)** a **late (~9h) EOD freeze** with no contemporaneous true-EOD baseline, **(2)** an
**Issue 1 recurrence** (TE/UMC/PURR under-booked, +$415.76 local-vs-broker), and **(3)** a brief
**startup daemon-before-dev-server gap** (~04:29–04:33 ET). Session verdicts: **USABLE**,
**CLEAN_WITH_FINDINGS**, **accounting quality FAIL**.

## 1. Broker truth
Retrieval **complete** (`retrievalComplete=true`): 1 page, 34 activities, 34 in-window, 0
out-of-window, **mapped 7/7**, **0 unmapped**, broker residual 0 on every trade. Total broker
P&L **−$2,344.97 ≈ −7.464R**. Ledger contentSha `f0491f8e…93b2b`.

| Symbol | Setup | entry qty@VWAP | exit qty@VWAP | Broker P&L | Broker R | frags | Class |
|---|---|---|---|---|---|---|---|
| TE | break_of_structure:5.00 | 512@5.0300 | 512@4.8709 | −81.46 | −1.054 | 2 sells | **KNOWN_PARTIAL_EXIT_INGESTION** |
| UMC | break_of_structure:20.70 | 739@20.8300 | 739@20.1706 | −487.29 | −1.055 | 6 sells | **KNOWN_PARTIAL_EXIT_INGESTION** |
| AFRM | hod_break:87.03 | 176@87.3500 | 176@84.5200 | −498.08 | −1.062 | 1 | NONE (match) |
| CYCU | break_of_structure:4.18 | 2188@4.2500 | 2188@4.1300 | −262.56 | −1.078 | 1 | NONE (match) |
| CHGA | opening_range_break:0.14 | 85016@0.1432 | 85016@0.1378 | −458.80 | −1.046 | 4 sells | NONE (rounding) |
| PURR | opening_range_break:13.45 | 1312@13.8100 | 1312@13.6198 | −249.58 | −1.073 | 5 sells | **KNOWN_PARTIAL_EXIT_INGESTION** |
| PD | break_of_structure:14.13 | 1280@14.1500 | 1280@13.9100 | −307.20 | −1.096 | 1 | NONE (match) |

Because the paper account carries no commissions/fees and was flat at EOD, the summed broker
fills are the economic truth. Broker truth here is **complete and fill-level**
(`retrievalComplete=true`, consistent with the corrected Session-3 record, which is likewise
exact from the Alpaca FILL ledger): every trade's exit qty reconciles to entry qty with residual
0, and 0 fills are unmapped.

## 2. Local executor accounting
| Symbol | Local P&L | Local R | plannedRisk $ | Exit state | vs Broker | Class |
|---|---|---|---|---|---|---|
| TE | −$6.90 | −0.089 | 77.26 | `manual_review` | under-booked **loss** (booked 46/512 sh) | **KNOWN_PARTIAL_EXIT_INGESTION** |
| UMC | −$168.29 | −0.364 | 461.80 | `manual_review` | under-booked **loss** (booked 244/739 sh) | **KNOWN_PARTIAL_EXIT_INGESTION** |
| AFRM | −$498.08 | −1.062 | 469.20 | closed | match | NONE |
| CYCU | −$262.56 | −1.078 | 243.54 | closed | match | NONE |
| CHGA | −$458.75 | −1.046 | 438.76 | closed | match (rounding, −$0.05) | NONE |
| PURR | −$227.43 | −0.978 | 232.62 | `manual_review` | under-booked **loss** (booked 1197/1312 sh) | **KNOWN_PARTIAL_EXIT_INGESTION** |
| PD | −$307.20 | −1.096 | 280.25 | closed | match | NONE |

**Net local −$1,929.21 vs broker −$2,344.97 → local − broker = +$415.76** (local **understated
the loss**). All three divergences are Issue 1; broker is authoritative. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

## 3. Strategy outcome (broker economics)
| Symbol | Setup | Signal ET | Sess | offHigh | Entry (broker VWAP) | Stop (signal) | Risk $ | Broker P&L | Broker R | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| TE | break_of_structure | 04:44 | pre | −2.53 | 5.03 | 4.8509 | 77.26 | −81.46 | −1.054 | Stop (fragmented) |
| UMC | break_of_structure | 05:40 | pre | −0.33 | 20.83 | 20.1678 | 461.80 | −487.29 | −1.055 | Stop (fragmented) |
| AFRM | hod_break | 06:09 | pre | 0.00 | 87.35 | 84.6841 | 469.20 | −498.08 | −1.062 | Stop (clean) |
| CYCU | break_of_structure | 09:57 | reg | −1.16 | 4.25 | 4.1387 | 243.54 | −262.56 | −1.078 | Stop (near-instant) |
| CHGA | opening_range_break | 10:13 | reg | **−12.67** | 0.1432 | 0.1380 | 438.76 | −458.80 | −1.046 | Stop (fragmented) |
| PURR | opening_range_break | 10:39 | reg | −0.14 | 13.81 | 13.6029 | 232.62 | −249.58 | −1.073 | Stop (fragmented) |
| PD | break_of_structure | 10:57 | reg | −0.33 | 14.15 | 13.9311 | 280.25 | −307.20 | −1.096 | Stop (clean) |

**Broker-true summary:** 7 trades · **0W/7L** · ≈ **−7.464R / −$2,344.97** · win 0% · PF 0 ·
mean R ≈ −1.07 · median R ≈ −1.07. Every trade stopped at ≈ −1R (broker), i.e. stops behaved as
designed; the day was a uniform loss of full-risk stop-outs, not a tail/gap event (all broker R
between −1.046 and −1.096). No profit-taking partials occurred (no trade reached T1 before its
stop).

## 4. Off-high rule activity (frozen — report only)
- **DIRECT_REMOVAL:** `CHGA:opening_range_break:0.14`, offHigh **−12.67** (the only `< −3` in
  the book; the next-weakest was TE at −2.53), local R **−1.046** → −5.713 − (−1.046) =
  **−4.667R** (direct-only bound).
- **REPLACEMENT_ADMISSION:** **none** — the freed slot had no capacity-blocked candidate with
  resolvable geometry and offHigh ≥ −3. CASCADE_DIFFERENCE = 0; UNCHANGED = 6. Full detail in
  [`SHADOW_VALIDATION.md`](SHADOW_VALIDATION.md).

## 5. Reconciliation note
Local **−$1,929.21** vs broker **−$2,344.97** → **local − broker = +$415.76** (local understated
the loss). Drivers: **TE** (local −$6.90/−0.089R vs broker −$81.46/−1.054R — 46 of 512 shares
booked), **UMC** (local −$168.29/−0.364R vs broker −$487.29/−1.055R — 244 of 739 booked), and
**PURR** (local −$227.43/−0.978R vs broker −$249.58/−1.073R — 1197 of 1312 booked). The other
four reconcile at fill level (AFRM/CYCU/PD exact; CHGA rounding). Broker is authoritative;
broker flat at EOD. See [ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

## 6. Post-signal & post-exit excursion — REVIEW-ONLY diagnostic (NOT part of the frozen criterion)
Full same-day excursion per **filled** signal, regardless of what the executor did, and the
post-terminal-exit path to 16:00 ET. **Does not affect PASS/FAIL of the off-high hypothesis and
is not used to tune the threshold, stops, or targets.** Anchor = decision-time `entryRef`;
`riskPerShare = entryRef − originalStop` (all 7 > 0). Tape coverage **7/7 filled tickers** (all
17 enumerated symbols have 1-min tape). Full table + method in `EXECUTION_QUALITY_REVIEW.md`.

**Most important finding — CHGA (the only trade removed by `offHighPct < −3`):** stopped, then
**reclaimed entry ~3 min after the stop**, **reached original T1 ~23 min after**, **reached the
original final target ~24 min after**, with **post-exit MFE ≈ +17.2R** and an intraday high
≈ **0.2358** (+64% over the 0.1434 entry). Descriptive label **STOP_THEN_RAN_TO_FINAL_TARGET**.
The other six stopped trades did **not** show comparable upward continuation: five continued
materially lower (post-exit MAE −1.93R to −10.81R) and CYCU only marginally reclaimed entry
(+0.18R) before falling to −5.48R.

**Do NOT infer** stop-too-tight, threshold-wrong, targets-wrong, re-entry-needed, or any
strategy change. Sample = **one session / seven trades**; this is descriptive only.

## 7. Data quality & accounting
- **Trial usability USABLE**; **operational cleanliness CLEAN_WITH_FINDINGS**; **accounting
  quality FAIL.**
- CONTROL reconciles **7/7** and is faithful (recon shadowOnly 0, liveOnly 0). The frozen
  −5.713R stands.
- **Accounting FAIL:** local under-booked **$415.76** on TE/UMC/PURR (Issue 1). Broker layer is
  complete and authoritative (−$2,344.97, 0 unmapped). The defect changed **R magnitude only**,
  not the admission/removal/replacement/cascade sets (all determined independently of exit P&L),
  and CHGA (the removal) reconciles exactly — so the **+1.046R experiment−control delta is
  broker-faithful**.
- Two operational findings: the **late (~9h) EOD freeze** (Issue 6 — no contemporaneous
  baseline; snapshot CLEAN but not a true-EOD proof) and the **startup daemon-before-dev-server
  gap** (Issue 5, ~04:29–04:33 ET). See `OPERATIONAL_DIAGNOSIS.md`.

## 8. Startup qualification (verbatim principle — do not strengthen UNKNOWN into NO)
The scanner was unavailable ~04:29–04:33 ET because the alert daemon started before the local
Next dev server. Determinations:

| Determination | Verdict |
|---|---|
| Missed prospective signal | **UNKNOWN** |
| Missed CONTROL admission | **UNKNOWN — no evidence of one** |
| Changed observed direct-removal set | **NO** |
| Changed observed replacement set | **NO** |
| Changed observed cascade | **NO** |
| Executor authority loss | **NO** |
| Broker exposure issue | **NO** |

> "The 04:29–04:33 ET scanner outage creates an unobservable prospective interval. Whether an
> eligible signal or CONTROL admission occurred during that interval is UNKNOWN. No observed
> Session 4 admission, removal, replacement, execution-authority event, or broker exposure was
> affected. Under the preregistered materiality rule, absence of evidence that this brief
> startup gap altered the prospective comparison is insufficient by itself to invalidate
> Session 4."

First decision row posted **04:33:47 ET** (immediately post-recovery); the first admission (TE)
was **~04:46 ET**, ~13 min later. The removal (CHGA, 10:13 ET) and the empty replacement set are
far outside the gap.

## 9. Interim discipline
No strategy verdict, no rule tuning, no stop/target change. Four sessions in; the challenger has
now acted in Sessions 2, 3, and 4. The hypothesis verdict is computed **once, after session 10**.
