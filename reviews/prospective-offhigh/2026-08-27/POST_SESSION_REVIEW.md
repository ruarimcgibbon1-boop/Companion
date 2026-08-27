# POST-SESSION REVIEW — Session 3 — 2026-08-27

## Summary
Third usable prospective session. **6 filled, matched 6/6, 0 open at EOD.** A **winning**
CONTROL session (net +2.395R / PF 1.554) in which the off-high challenger acted for the second
time: one DIRECT_REMOVAL (`YYGH`) and one REPLACEMENT_ADMISSION (`CRWD:break_of_structure`).
Both experiment arms were positive this session. The session's central finding is operational,
not strategic: the **most severe partial-exit ingestion instance of the trial (FWDI)**.
Session verdict **CLEAN_WITH_FINDINGS** — the CONTROL arm is intact and usable.

## 1. Broker truth — corrected precision tiers

Broker economics are stated in three tiers rather than as a single "exact" figure, because
FWDI's individual exit fills were not all ingested/priced.

**Tier A — exact & independent (Alpaca-reported):**
- EOD equity $91,485.34 → $92,503.53, **Δ = +$1,018.19**. Paper account carries no
  commissions/fees and was flat at EOD, so this delta equals total realized P&L (only
  assumption: no non-trade equity effects — holds for Alpaca paper).
- Four trades reconcile **local == broker exactly** (`verified`/matched): NVDL −$468.16,
  WKSP −$15.14, CRWD +$872.57, CRM +$813.83 → sum **+$1,203.10**.
- Therefore combined broker P&L of the two under-booked trades (**YYGH + FWDI**) =
  1,018.19 − 1,203.10 = **−$184.91** — exact and independent at the pair level.

**Tier B — estimated trade-level split of the −$184.91:**
- **YYGH is tightly bounded.** Broker held exactly 798 after t1 (`reconcile brokerQty=798`,
  entry 1596) → 798 sold at t1, 798 at stop. The stop leg (798 @1.88) is recorded; the t1 leg
  is a **limit sell at the 2.00 target** (409 recorded @1.99, 389 un-ingested). A limit exit
  fills at/above its limit → YYGH broker P&L ≈ **+$71.8 / +0.678R** (bounded ~+$71.4…+$72.2).
- **FWDI follows by subtraction:** −184.91 − (+71.8) ≈ **−$256.7 / −0.924R**.

**Tier C — UNRESOLVED (fill-level):** FWDI's **2,529 exit shares are not individually
ingested or priced** in the artifacts; only the aggregate is constrained.

**Is the equity tie genuinely independent?** *Partly.* The session/pair-level figure
(−$184.91 combined) is independent (equity minus four exactly-reconciled trades). The FWDI
**trade-level** −$256.73 is **not independently pinned** — equity constrains only the *sum*
YYGH+FWDI, so recovering FWDI requires the (well-bounded) YYGH estimate. The alternative
route (external-close avg 6.7353 × 2,711 = −$256.73) **applies the recorded price of the last
182 shares to 2,529 unobserved shares and is NOT independently confirmed by equity** — its
agreement is corroborative, not proof. Honest label: **FWDI ≈ −$256.7 / −0.924R is an
equity-constrained estimate (YYGH-bounded); per-share precision UNRESOLVED.**

**Exposure language (supported claim only):** *broker flat at EOD, no residual exposure
identified, and protective broker execution occurred (stops/targets filled at the broker).*
The artifacts contain **no continuous, timestamped broker position/fill timeline**, so
instant-by-instant safety during FWDI's 11:31–13:57 ET window is not provable — only that a
protective stop was placed and ultimately executed.

## 2. Local executor accounting

| Symbol | Local P&L | Local R | Exit state | vs Broker | Class |
|---|---|---|---|---|---|
| NVDL | −$468.16 | −1.015 | verified | match | NONE |
| WKSP | −$15.14 | −3.243 | verified | match | NONE |
| CRWD | +$872.57 | +3.552 | closed | match | NONE |
| CRM | +$813.83 | +2.851 | verified | match | NONE |
| YYGH | +$32.92 | +0.311 | `discrepancy` | under-booked **win** ≈ +$38.9 | **KNOWN_PARTIAL_EXIT_INGESTION** |
| FWDI | −$17.24 | −0.062 | `manual_review` | under-booked **loss** ≈ −$239.5 | **KNOWN_PARTIAL_EXIT_INGESTION** (most severe of trial) |

**Net local +$1,218.79 vs broker +$1,018.19 → local − broker = +$200.60** (local overstated
net). Both discrepancies are Issue 1; broker/equity is authoritative. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

## 3. Strategy outcome (broker economics)

| Symbol | Setup | Signal ET | Sess | offHigh | Entry | Stop | Risk $ | Broker P&L | Broker R | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| NVDL | hod_break | 04:29 | pre | −0.01 | 36.45 | 35.3565 | 461.26 | −468.16 | −1.015 | Stop (clean) |
| WKSP | break_of_structure | 05:01 | pre | −0.03 | 0.5998 | 0.5818 | 4.67 | −15.14 | −3.243 | Stop (gap-through) |
| YYGH | break_of_structure | 06:26 | pre | **−3.59** | 1.88 | 1.8236 | 105.97 | ≈+71.8ᵉ | ≈+0.678ᵉ | t1 + trail stop |
| CRWD | opening_drive | 09:34 | reg | −0.77 | 213.98 | 210.77 | 245.62 | +872.57 | +3.552 | t1+t2 |
| CRM | opening_drive | 09:37 | reg | +0.10 | 237.41 | 233.84 | 285.41 | +813.83 | +2.851 | t1+t2 |
| FWDI | opening_range_break | 11:31 | reg | −0.65 | 6.83 | 6.7276 | 277.74 | ≈−256.7ᵉ | ≈−0.924ᵉ | Stop (ingestion-distorted book) |

Aborted (90 s entry timeout, unfilled): OKTA, DAIC, CYPH.

**Broker-true summary:** 6 trades · 3W/3L · ≈ **+1.90R / +$1,018.19** · win 50% · PF(broker R)
≈ 1.37 · mean R ≈ +0.32 · median R ≈ +0.31. **Guards:** premarket loss sub-budget (−$457.43)
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
(local −$17.24/−0.062R vs broker ≈ −$256.7/−0.924R — an under-booked *loss*), partly offset by
**YYGH** (local +$32.92/+0.311R vs broker ≈ +$71.8/+0.678R — an under-booked *win*). Broker is
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
