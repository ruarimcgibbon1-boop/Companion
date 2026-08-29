# OPERATIONAL DIAGNOSIS — Session 4 — 2026-08-28

Session 4 had **anomalies**. Three operational findings are recorded, none of which altered the
observed prospective comparison: **(A)** a startup daemon-before-dev-server gap, **(B)** a missed
contemporaneous EOD freeze (late ~9h freeze), and **(C)** the Issue 1 partial-exit ingestion
recurrence. Broker exposure was safe throughout (account flat at EOD).

## A. Startup incident — daemon started before local dev server (Issue 5)
- The alert daemon started **2026-08-28T08:29:03Z (04:29:03 ET)** while the local Next dev
  server was not yet serving; the daemon logged repeated **"sweep error (is the dev server up?):
  fetch failed"**. Local HTTP 200 was confirmed ~**08:33:00Z (04:33 ET)**.
- **Artifact evidence:** the first decision row is **04:33:47 ET** — i.e. the scanner emitted
  nothing during the ~4-minute gap (it could not; the scan API was down). The first admission
  (TE) was **~04:46 ET**, ~13 min after recovery. The window is entirely premarket.

**Determinations (do NOT strengthen UNKNOWN into NO):**

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

Reason the last five are NO: they concern **observed** Session-4 state. The observed removal
(CHGA, 10:13 ET), the observed empty replacement set, the observed cascade (0), executor
authority (no open positions during the gap — first fill 04:46 ET), and broker exposure (account
flat during the gap) were none of them affected. The first two are UNKNOWN because the scanner
was down in the gap, so the existence of a signal — and therefore whether it could have become a
CONTROL admission — is unobservable, and cannot logically be asserted as definitively NO. See
[ISSUE_LEDGER §5](../ISSUE_LEDGER.md#issue-5--daemon-startup-before-dev-server).

## B. Missed contemporaneous EOD freeze — late ~9h freeze (Issue 6)
- **No contemporaneous EOD freeze was performed.** At the start of validation the daemon was
  still running; after shutdown there was **no snapshot, no manifest, and no shadow output**, and
  every review doc was still a blank PENDING template.
- The evaluator and `session-freeze` were run **during validation on 2026-08-29 (~15:25Z), ~9 h
  after the 16:00 ET close**, against the now-static live files.
- The eventual snapshot passes `session-verify` **CLEAN** (all five files match the manifest;
  live drift clean, integrity OK).
- **However: CLEAN late-snapshot integrity does NOT retroactively establish an independent
  true-EOD baseline.** With no earlier baseline captured, there is no independent proof the live
  files were unaltered between 16:00 ET and the late freeze. Corroborating (not proof): the
  daemon was confirmed stopped; the decisions log is internally consistent (all 394 rows are
  2026-08-28 in ET, 04:33→20:00 ET); no artifact shows any rewrite.
- Classified as an **operational / trial-integrity finding**, **not** evidence corruption — no
  artifact evidence of tampering exists. This is the realized form of the risk Issue 4 flagged in
  Session 3 (daemon runs unbounded; freeze must precede hashing). See
  [ISSUE_LEDGER §6](../ISSUE_LEDGER.md#issue-6--missed-contemporaneous-eod-freeze) and
  [§4](../ISSUE_LEDGER.md#issue-4--decisions-log-post-freeze-append-drift).

## C. Executor / local-state accuracy — DEGRADED on 3 trades (Issue 1)
Local exit accounting under-booked three fragmented stop-outs (TE 46/512, UMC 244/739, PURR
1197/1312 shares), each self-flagged (`manual_review`, *"broker flat but local held … — closed
by an unrecorded/external order"*). Local −$1,929.21 vs broker −$2,344.97 → local understated the
loss by **+$415.76**. Corrected only at reconciliation; broker authoritative. This is Issue 1
(ingestion), **not** Issue 2 (network) — EQ coverage was continuous during each trade's life. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

### Capacity / risk-accounting implication (LATENT, no realized harm)
Under-booked exits mean local daily-loss/open-risk gates ran on economics that **understated**
the loss during the intraday windows. **No actual mis-gate occurred** — the day was a uniform
stop-out sequence, all positions flat by ~11:09 ET, and the daily-loss limit was not the binding
control. The latent exposure is real and is why nightly reconciliation is mandatory.

## Broker-safety assertion
Broker **flat at EOD, no residual exposure identified, protective broker execution occurred** —
all 7 trades `state=closed`, broker residual **0** on every trade, **0 unmapped** fills, and
every stop executed at the broker at ≈ −1R. Not asserted: continuous instant-by-instant safety
(the artifacts hold no continuous, timestamped broker position/fill timeline; and see the CYCU
recognition-timestamp anomaly in `EXECUTION_QUALITY_REVIEW.md`).

## EQ observer
**HEALTHY-WITH-FINDINGS** — 25,870 rows, 0 errors, 0 dropped; but ~82–83% stale quote/trade
observations on an IEX-only (`feedConsolidated=false`) feed. Instrumentation/data-quality
finding; no evidence it drove any trade decision. Issue 3 remains resolved (observer ran).

## Linked issues
- [Issue 1 — partial-exit-fill-ingestion](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion) — recurrence (TE/UMC/PURR, +$415.76)
- [Issue 2 — network-outage-recognition-delay](../ISSUE_LEDGER.md#issue-2--network-outage-recognition-delay) — **not** implicated (connectivity healthy; EQ continuous during trade lives)
- [Issue 3 — execution-observer-launch-config](../ISSUE_LEDGER.md#issue-3--execution-observer-launch-config) — remains resolved (25,870 EQ rows)
- [Issue 4 — decisions-log post-freeze append drift](../ISSUE_LEDGER.md#issue-4--decisions-log-post-freeze-append-drift) — related (daemon ran unbounded again; here the freeze was missed entirely, see Issue 6)
- [Issue 5 — daemon-startup-before-dev-server](../ISSUE_LEDGER.md#issue-5--daemon-startup-before-dev-server) — **new** (04:29–04:33 ET gap)
- [Issue 6 — missed-contemporaneous-eod-freeze](../ISSUE_LEDGER.md#issue-6--missed-contemporaneous-eod-freeze) — **new** (late ~9h freeze)
