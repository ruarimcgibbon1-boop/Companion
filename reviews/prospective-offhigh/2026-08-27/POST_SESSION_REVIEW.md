# POST-SESSION REVIEW — Session 3 — 2026-08-27

## Summary
Third usable prospective session. **6 filled, matched 6/6, 0 open at EOD.** A **winning**
CONTROL session (net +2.395R / PF 1.554) in which the off-high challenger acted for the second
time: one DIRECT_REMOVAL (`YYGH`) and one REPLACEMENT_ADMISSION (`CRWD:break_of_structure`).
Both experiment arms were positive this session. The session's central finding is operational,
not strategic: the **most severe partial-exit ingestion instance of the trial (FWDI)**.
Session verdict **CLEAN_WITH_FINDINGS** — the CONTROL arm is intact and usable.

## 1. Broker truth — EXACT, from primary Alpaca FILL retrieval

> **Provenance upgrade (2026-08-28).** Broker economics below are now **exact per-trade
> values reconstructed directly from the Alpaca account FILL activity stream** (complete
> paginated retrieval: `retrievalComplete=true`, all 6 trades mapped by `client_order_id`,
> **unmapped fills = 0**, total **+$1,018.19**). This **replaces** the earlier
> equity-subtraction estimate and its Tier-A/B/C precision framing — every previously
> "UNRESOLVED" per-share fill is now individually priced. Equity change still corroborates
> the total to the cent, but is no longer the basis. Source: `scripts/broker-ledger.ts` run
> on the frozen paper-trades against the live paper account (READ-ONLY).

| Symbol | Broker P&L | Broker R | Exit reconstruction (primary fills) |
|---|---|---|---|
| NVDL | **−$468.16** | **−1.015** | 418 @36.46 → 418 @35.34 (stop); local == broker |
| WKSP | **−$15.14** | **−3.243** | 258 @0.5999 → 258 @0.5412 vwap (stop); local == broker |
| YYGH | **+$71.82** | **+0.678** | t1 = 798 @1.99 in **3 fragments 409+136+253**; stop = 798 @1.88 (492+306); full 1,596 exited |
| CRWD | **+$872.57** | **+3.552** | 85 @213.66 → t1/t2 223.9255 vwap; local == broker |
| CRM | **+$813.83** | **+2.851** | 77 @237.55 → t1/t2 248.12 vwap; local == broker |
| FWDI | **−$256.73** | **−0.924** | 2,711 @6.83 → **2,711 @≈6.7353 vwap** in **4 fragments 1,274+305+950+182** (one stop order) |
| **TOTAL** | **+$1,018.19** | | direct fill reconstruction — **no equity subtraction** |

- **YYGH is fully resolved:** the t1 target order filled **798 shares** in three fragments
  (409+136+253 @1.99); the local executor ingested only the first **409**. Adding the stop
  leg (798 @1.88), the **entire 1,596-share position** is accounted → **+$71.82 / +0.678R**.
- **FWDI is fully resolved:** the entire 2,711-share position exited on **one protective-stop
  order** in four fragments (1,274+305+950+182) at ≈6.7353 vwap → **−$256.73 / −0.924R**. The
  local executor booked only the **182-share** fragment; the other **2,529 exit shares are now
  priced from the fill stream** (previously omitted from local realized P&L).

**Exposure (supported claim):** *broker flat at EOD, no residual exposure identified,
protective broker execution occurred.* The fill stream additionally shows FWDI's exit was a
single ~1-second stop liquidation (see §5 and `OPERATIONAL_DIAGNOSIS.md`), not a prolonged
open-and-uncovered window.

## 2. Local executor accounting

| Symbol | Local P&L | Local R | Exit state | vs Broker | Class |
|---|---|---|---|---|---|
| NVDL | −$468.16 | −1.015 | verified | match | NONE |
| WKSP | −$15.14 | −3.243 | verified | match | NONE |
| CRWD | +$872.57 | +3.552 | closed | match | NONE |
| CRM | +$813.83 | +2.851 | verified | match | NONE |
| YYGH | +$32.92 | +0.311 | `discrepancy` | under-booked **win** by **+$38.90** (broker +$71.82; 389 t1 shares omitted) | **KNOWN_PARTIAL_EXIT_INGESTION** |
| FWDI | −$17.24 | −0.062 | `manual_review` | under-booked **loss** by **−$239.49** (broker −$256.73; 2,529 exit shares omitted) | **KNOWN_PARTIAL_EXIT_INGESTION** (largest $ under-book of the trial) |

**Net local +$1,218.79 vs broker +$1,018.19 → local − broker = +$200.60** (local overstated
net). Both discrepancies are Issue 1; broker/equity is authoritative. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

## 3. Strategy outcome (broker economics)

| Symbol | Setup | Signal ET | Sess | offHigh | Entry | Stop | Risk $ | Broker P&L | Broker R | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| NVDL | hod_break | 04:29 | pre | −0.01 | 36.45 | 35.3565 | 461.26 | −468.16 | −1.015 | Stop (clean) |
| WKSP | break_of_structure | 05:01 | pre | −0.03 | 0.5998 | 0.5818 | 4.67 | −15.14 | −3.243 | Stop (gap-through) |
| YYGH | break_of_structure | 06:26 | pre | **−3.59** | 1.88 | 1.8236 | 105.97 | +71.82 | +0.678 | t1 + trail stop (exact from fill ledger) |
| CRWD | opening_drive | 09:34 | reg | −0.77 | 213.98 | 210.77 | 245.62 | +872.57 | +3.552 | t1+t2 |
| CRM | opening_drive | 09:37 | reg | +0.10 | 237.41 | 233.84 | 285.41 | +813.83 | +2.851 | t1+t2 |
| FWDI | opening_range_break | 11:31 | reg | −0.65 | 6.83 | 6.7276 | 277.74 | −256.73 | −0.924 | Stop (exact from fill ledger; local book was ingestion-distorted) |

Aborted (90 s entry timeout, unfilled): OKTA, DAIC, CYPH.

**Broker-true summary:** 6 trades · 3W/3L · **+1.899R / +$1,018.19** (exact, from the fill
ledger) · win 50% · PF(broker R) ≈ 1.37 · mean R ≈ +0.317 · median R ≈ +0.308. **Guards:** premarket loss sub-budget (−$457.43)
**triggered** at −$483.30 (blocked BRNX/ANET/ANF); **daily-loss guard not approached**
(net-positive day). Strategy-vs-execution: NVDL clean −1R; WKSP excess to −3.24R is market-gap
on an illiquid $0.60 name; FWDI's book figure is accounting-distorted, not a strategy signal.

## 4. Off-high rule activity (frozen — report only)
- **DIRECT_REMOVAL:** `YYGH:break_of_structure:1.86`, offHigh **−3.59** (the only `< −3` in
  the book), local R **+0.311** → 2.395 − 0.311 = **+2.084R** (direct-only bound).
- **REPLACEMENT_ADMISSION:** `CRWD:break_of_structure:206.70`, offHigh −0.26, capacity-blocked
  in CONTROL by `max premarket trades (3)`; YYGH's removal frees a premarket slot → admitted,
  reconstructed **+2.888R** (`target_hit`, frictionless — the only non-exact component) →
  2.084 + 2.888 = **+4.972R**. CASCADE_DIFFERENCE = 0; UNCHANGED = 5. Full detail in
  [`SHADOW_VALIDATION.md`](SHADOW_VALIDATION.md).

## 5. Reconciliation note
Local **+$1,218.79** vs broker **+$1,018.19** → **local − broker = +$200.60**. Driver: **FWDI**
(local −$17.24/−0.062R vs broker **−$256.73/−0.924R** — an under-booked *loss*), partly offset by
**YYGH** (local +$32.92/+0.311R vs broker **+$71.82/+0.678R** — an under-booked *win*). Broker is
authoritative; broker flat at EOD. See [ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

## 6. Post-signal excursion — REVIEW-ONLY diagnostic (NOT part of the frozen criterion)
A nightly diagnostic that measures the full same-day price excursion of each signal regardless
of what the executor did. **It does not affect PASS/FAIL of the off-high hypothesis and is not
used to tune the threshold.** Coverage this session:
- **Signal-instance coverage: 3 / 10** (6 filled + 3 aborted + 1 blocked CRWD:bos = 10
  relevant instances; tapes for CRWD:opening_drive, CRWD:break_of_structure, FWDI).
- **Unique-symbol coverage: 2 / 9** (9 unique symbols; tapes only for CRWD, FWDI).

Descriptive findings only (see `EXECUTION_QUALITY_REVIEW.md` for the table): CRWD captured
76.5% of signal-anchored MFE R (67.4% fill-anchored) and never traded below entry (minimum
excursion +0.321R). FWDI spiked to +1.562R then reversed into a genuine adverse excursion past
its stop (−2.524R), closing −1.659R. The unfilled CRWD:bos replacement ran to +3.484R MFE with
a shallow −0.497R minimum — the +2.888R target-hit reconstruction is conservative vs that MFE.
**No stop/target/re-entry recommendation is made.**

## 7. Data quality
**CLEAN_WITH_FINDINGS.** CONTROL reconciles 6/6 and is faithful; findings are the operational
Issue-1 recurrence (FWDI severe + YYGH) and the excursion coverage limitation (3/10, 2/9). The
decisions log drifted **append-only, post-freeze** (317–327: 11 session-gated afterhours rows);
prefix integrity is proven and the review is unaffected — see `SESSION_MANIFEST.md` and
`OPERATIONAL_DIAGNOSIS.md`.

## 8. Interim discipline
No strategy verdict, no rule tuning. Three sessions in; the challenger is directionally
positive this session (direct-only +2.084R, reshuffle +4.972R) after a mixed Session 2. The
hypothesis verdict is computed once, after session 10.
