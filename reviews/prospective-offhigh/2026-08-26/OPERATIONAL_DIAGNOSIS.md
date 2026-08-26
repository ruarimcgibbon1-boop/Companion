# OPERATIONAL DIAGNOSIS — Session 2 — 2026-08-26

## Anomalies
1. **HOWL — network-outage recognition delay (Issue 2).** The HOWL broker stop **filled
   normally (~11:13 ET)** and the broker position was **flat and safe**. A **user-location
   Wi-Fi outage** severed the local daemon's connectivity to Alpaca, so local state remained
   **stale** until connectivity returned; reconciliation observed broker-flat truth at
   **~14:35 ET**. The **~3h22m** span is the **network-outage duration**.
2. **ANF — fragmented-exit accounting (Issue 1).** Local under-booked the ANF winner
   (broker +$986.33 / +3.72R vs local +$619.50 / +2.34R), the main driver of the session's
   −$363.94 local-vs-broker gap.

## Broker-safety assertion
**Broker exposure safe throughout.** HOWL was flat at the broker during the entire local
blackout; ANF is an accounting under-book, not an exposure event. **Account flat at EOD.**

## Recognition-latency note — classification (explicit)
The HOWL ~3h22m delay is classified as
**NETWORK_OUTAGE / CONNECTIVITY_DEPENDENT_RECOGNITION_DELAY**.

- It is **NOT** intrinsic executor latency.
- It is **NOT** a broker-stop ingestion defect.
- It is **NOT** the partial-exit ingestion issue (Issue 1).

Root cause: user-location Wi-Fi outage severed local daemon → Alpaca connectivity. The local
laptop/network is a single point of failure for **timely** broker-state recognition; the
delay is bounded by outage duration, and the broker outcome (stop fill) was correct and on
time. Possible future mitigation (not in scope): remote/VPS daemon, liveness monitoring,
supervisor, connectivity watchdog.

## Linked issues
- [Issue 1 — partial-exit-fill-ingestion](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion) (ANF)
- [Issue 2 — network-outage-recognition-delay](../ISSUE_LEDGER.md#issue-2--network-outage-recognition-delay) (HOWL)
- [Issue 3 — execution-observer-launch-config](../ISSUE_LEDGER.md#issue-3--execution-observer-launch-config) — **resolved** this session (20,136 EQ rows).
