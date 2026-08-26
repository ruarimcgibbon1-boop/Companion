# FINAL TRIAL REVIEW — Prospective Off-High Validation

> **STATUS: TEMPLATE — verdict fields are PENDING until session 10 (2026-09-08) is
> complete and archived.** No cumulative hypothesis conclusion may be written here before
> then. This document is computed **once**, after the 10th usable session, per the frozen
> protocol.

- **Trial:** Prospective off-high validation
- **Frozen strategy HEAD:** `eead9b2810b080761a56a4c4fa53d081f728e684`
- **Frozen hypothesis:** reject candidate when `offHighPct < -3`
- **Evaluator sha256:** `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6`
  (`scripts/shadow-validate.ts`, v2-event-anchored)

---

## 1. Trial integrity
_PENDING._ Confirm at close: strategy HEAD never moved off `eead9b2`; evaluator sha256
unchanged across all sessions; hypothesis/threshold/verdict standard never edited mid-window;
protocol freeze predates the first session's data.

## 2. Usable / unusable sessions
_PENDING._ Final usable count (target 10). List each session's status. Note
2026-08-24 (DATA_INCOMPLETE, replaced by 09-08) and 2026-09-07 (Labor Day, excluded).

## 3. Cumulative CONTROL results
_PENDING._ Aggregate CONTROL net R, mean R, win rate, profit factor across usable sessions.

## 4. Cumulative direct-only results (EXPERIMENT_DIRECT_ONLY)
_PENDING._ Aggregate removals-only figures — the conservative, fully-exact bound.

## 5. Cumulative reshuffle-aware results (EXPERIMENT_RESHUFFLE_AWARE)
_PENDING._ Aggregate first-order reshuffle figures.

## 6. Direct removals
_PENDING._ Total count, per-session list, and net R of the directly-removed cohort.

## 7. Replacement behaviour
_PENDING._ Total replacements (must be ≤ removals), their net R, and per-session detail.
Confirm CASCADE_DIFFERENCE = 0 by construction held every session.

## 8. Session distribution
_PENDING._ Per-session contribution to the delta; check no single session dominates.

## 9. Capacity effects
_PENDING._ How often caps bound the book; premarket vs concurrent vs day-slot pressure;
whether removals meaningfully freed capacity.

## 10. Six-condition frozen verdict test

| # | Condition | Result |
|---|-----------|--------|
| 1 | EXPERIMENT net R > CONTROL net R | PENDING |
| 2 | EXPERIMENT profit factor > CONTROL profit factor | PENDING |
| 3 | max drawdown not materially worse | PENDING |
| 4 | improvement not explained by a single trade/day | PENDING |
| 5 | directly-removed cohort remains net negative | PENDING |
| 6 | slot replacements do not erase the advantage | PENDING |

## 11. Final hypothesis verdict
_PENDING._ One of **CONFIRMED** (all six pass) / **MIXED** (favorable but ≥1 robustness
condition fails) / **NOT_CONFIRMED** / **DATA_INCOMPLETE**.

## 12. Operational findings
_PENDING._ Summarize the [ISSUE_LEDGER](ISSUE_LEDGER.md): partial-exit ingestion,
network-outage recognition delay, observer launch config, and any new issues.

## 13. Broker-vs-local accounting findings
_PENDING._ Cumulative local-vs-broker discrepancy across sessions; direction and magnitude;
whether daily-loss accounting ever would have gated differently under broker truth.

## 14. Execution-quality findings
_PENDING._ Aggregate EQ observer signal across sessions where a tape exists (from 08-26
onward). Note session 1 has no tape (Issue 3).

## 15. Decision: promote / reject / extend validation
_PENDING._ Tie the decision explicitly to §10. **This decision changes strategy only if
CONFIRMED** and only via a separate, non-frozen change outside this archive — never silently.

## 16. Exact next experiment (if required)
_PENDING._ If MIXED / NOT_CONFIRMED / extend: state the precise next pre-registered
experiment (e.g. threshold sensitivity, longer horizon, friction modeling on replacements),
frozen before its own data exists.

---

_Do not fill any field above until session 10 is archived and reconciled._
