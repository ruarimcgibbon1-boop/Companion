# SESSION INDEX — Prospective Off-High Validation

One row per usable session. **No cumulative hypothesis conclusions are drawn here** — the
verdict is computed once, after session 10, in [`FINAL_TRIAL_REVIEW.md`](FINAL_TRIAL_REVIEW.md).

- R figures are the three arms: **CONTROL** (= live, exact), **Direct-only** (removals,
  empty slots — conservative bound), **Experiment** (reshuffle-aware).
- **P&L discrepancy $** convention: `local − broker`. A positive value means local
  **understated the loss** (local less negative than broker); a negative value means local
  **understated net** (e.g. an under-booked winner made local look worse than broker).
  Broker is the economic authority.

| # | Date | Status | Live admitted | Control R | Direct-only R | Experiment R | Direct removals | Replacements | Local P&L $ | Broker P&L $ | Discrepancy $ | EQ status | Broker flat EOD? | Data-quality | Operational findings | Notes |
|---|------|--------|---------------|-----------|---------------|--------------|-----------------|--------------|-------------|-------------|---------------|-----------|------------------|--------------|----------------------|-------|
| 1 | 2026-08-25 | USABLE | 9 | −6.027 | −6.027 | −6.027 | 0 | 0 | −1,781.07 | ≈ −1,975.79 | +194.72 | ABSENT (observer not launched) | Yes | CLEAN_WITH_FINDINGS | EXEC_OBSERVER=1 omitted (Issue 3, resolved); BITO excluded as HISTORICAL_ORPHAN_CLEANUP | 10 considered · 9 fills · 1 aborted; challenger **inert** (no off-high < −3 in the book) |
| 2 | 2026-08-26 | USABLE | 6 | −3.008 | −1.888 | −3.210 | 1 (NCPL −1.12R) | 1 (SMR −1.322R) | −931.66 | −567.72 | −363.94 | HEALTHY (20,136 rows) | Yes | USABLE | HOWL network-outage recognition delay (Issue 2); ANF fragmented-exit accounting (Issue 1) | matched setupIds = 6/6; ANF broker +$986.33/+3.72R vs local +$619.50/+2.34R |
| 3 | 2026-08-27 | USABLE | 6 | +2.395 | +2.084 | +4.972 | 1 (YYGH +0.311R) | 1 (CRWD:bos +2.888R) | +1,218.79 | +1,018.19 | +200.60 | HEALTHY (29,361 rows) | Yes | CLEAN_WITH_FINDINGS | Issue 1 — **largest $ under-book of trial** (FWDI **−$256.73**/−0.924R exact vs local −$17.24, 2,529 sh omitted; YYGH **+$71.82**/+0.678R exact vs local +$32.92, 389 omitted); Issue 4 decisions post-freeze append-drift (benign, prefix proven); Mac daemon stopped 22:23:16Z | matched 6/6; broker **exact from Alpaca FILL ledger** (retrievalComplete=true, unmapped=0, total +$1,018.19, no equity subtraction); FWDI recognition lag **≈43 s** (corrected from ≈2h26m — that was the holding period); excursion 3/10 signal-inst · 2/9 symbol; FWDI lag = Issue 1 not Issue 2 |
| 4 | 2026-08-28 | USABLE | 7 | −5.713 | −4.667 | −4.667 | 1 (CHGA −1.046R) | 0 | −1,929.21 | −2,344.97 | +415.76 | HEALTHY-WITH-FINDINGS (25,870 rows; ~82–83% stale, IEX-only) | Yes | CLEAN_WITH_FINDINGS (accounting **FAIL** — Issue 1) | Late ~19h26m EOD freeze (Issue 6, no true-EOD baseline); startup daemon-before-dev-server gap 04:29–04:33 ET (Issue 5); Issue 1 recurrence TE/UMC/PURR +$415.76 | 7 filled · 0W/7L · matched 7/7 · 0 open; challenger removed 1 loser (CHGA offHigh −12.67), 0 replacements; CHGA reconciles exact so +1.046R delta is broker-faithful; **REVIEW-ONLY**: CHGA stopped then ran to final target (+17.2R post-exit) |
| 5 | 2026-08-31 | PENDING | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 6 | 2026-09-01 | PENDING | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 7 | 2026-09-02 | PENDING | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 8 | 2026-09-03 | PENDING | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 9 | 2026-09-04 | PENDING | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 10 | 2026-09-08 | PENDING | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

### Excluded / non-usable dates (not counted toward the 10)

| Date | Status | Reason |
|------|--------|--------|
| 2026-08-24 | DATA_INCOMPLETE | No trading/capture processes running; no candidate stream or fills. Operational-window amendment only — replaced by 2026-09-08. |
| 2026-09-07 | EXCLUDED | Labor Day / US market closed. |

### Running usable-session count

- **Usable so far:** 4 of 10 (2026-08-25, 2026-08-26, 2026-08-27, 2026-08-28).
- **Remaining:** 6 (2026-08-31 → 2026-09-08, excluding 09-07).
