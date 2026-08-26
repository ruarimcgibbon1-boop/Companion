# OPERATIONAL DIAGNOSIS — Session 1 — 2026-08-25

## Anomalies
1. **Observer launch-config fault (Issue 3).** `EXEC_OBSERVER=1` omitted from the daemon
   launch → no EQ tape for the session. Resolved by persisting `EXEC_OBSERVER=1` in
   `.env.local`; verified working 2026-08-26.
2. **Partial-exit ingestion divergence (Issue 1), first observation.** Local P&L understated
   the broker loss by **$194.72** (local −1,781.07 vs broker ≈ −1,975.79) due to
   under-ingestion of fragmented exit fills. Entry quantities ingested correctly.
   Reconcile adopts broker truth.

## Broker-safety assertion
**Broker exposure safe throughout.** Both anomalies are observability/accounting defects,
not order-control defects. Account was **flat at EOD**.

## Recognition-latency note
No recognition-latency event this session. (The network-outage recognition delay is
Issue 2, first observed on 2026-08-26 — not applicable here.)

## Linked issues
- [Issue 1 — partial-exit-fill-ingestion](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion)
- [Issue 3 — execution-observer-launch-config](../ISSUE_LEDGER.md#issue-3--execution-observer-launch-config)

## Historical-orphan note
**BITO** carried position was closed per the orphan-cleanup procedure and excluded from the
session as **HISTORICAL_ORPHAN_CLEANUP** — outside the CONTROL book and the shadow arms.
