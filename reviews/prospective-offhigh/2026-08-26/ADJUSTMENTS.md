# ADJUSTMENTS / CORRECTIONS — Session 2 — 2026-08-26

Corrections recorded separately rather than silently rewriting an earlier report.
Append-only.

| Date | Field corrected | From | To | Reason |
|------|-----------------|------|----|--------|
| 2026-08-26 | ANF trade P&L / R | local +$619.50 / +2.34R | broker +$986.33 / +3.72R | Fragmented-exit under-book (Issue 1). Broker is authoritative; local retained as observed local value. |
| 2026-08-26 | Session net P&L (economic truth) | local −931.66 | broker −567.72 | EOD reconciliation; local − broker = −363.94, dominated by the ANF under-book. |
| 2026-08-26 | HOWL local slot/P&L state | stale during outage (~11:13→~14:35 ET) | broker-flat truth at reconciliation | Network-outage recognition delay (Issue 2). Local state corrected to broker truth once connectivity returned. |

Notes:
- **No strategy, gate, threshold, sizing, stop, target, or evaluator change** was made. All
  frozen. This file records only accounting/reconciliation/reporting corrections.
- The HOWL ~3h22m delay is recorded as a **network/connectivity** event, **not** executor
  latency and **not** Issue 1.
