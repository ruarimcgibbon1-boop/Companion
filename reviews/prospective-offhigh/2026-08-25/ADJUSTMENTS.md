# ADJUSTMENTS / CORRECTIONS — Session 1 — 2026-08-25

Corrections recorded separately rather than silently rewriting an earlier report.
Append-only.

| Date | Field corrected | From | To | Reason |
|------|-----------------|------|----|--------|
| 2026-08-25 | Broker P&L (economic truth) | local −1,781.07 | broker ≈ −1,975.79 | EOD reconciliation: local under-booked fragmented exit fills by $194.72 (Issue 1). Broker is authoritative; local figure retained as the observed local value, broker figure recorded as truth. |
| 2026-08-25 | EQ tape availability | expected | none (0 rows) | `EXEC_OBSERVER=1` omitted (Issue 3). Recorded as absent, not fabricated. |

Notes:
- **BITO** excluded as HISTORICAL_ORPHAN_CLEANUP — not a session-1 admission; not a
  correction to the arms, recorded here for completeness.
- **No strategy, gate, threshold, sizing, stop, target, or evaluator change** was made. All
  frozen. This file records only accounting/reconciliation/reporting corrections.
