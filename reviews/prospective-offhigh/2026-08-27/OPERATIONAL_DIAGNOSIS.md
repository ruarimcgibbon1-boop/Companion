# OPERATIONAL DIAGNOSIS — Session 3 — 2026-08-27

Mac execution reliability is assessed on **three separate lanes** rather than as a single
"reliable/unreliable" verdict, because broker order control performed while local state was
materially wrong for extended spans.

## Lane 1 — Broker-side protective execution: PERFORMED
Stops/targets filled at the broker on all six trades; FWDI's protective stop executed the full
sell-down; **account flat at EOD** (Alpaca: no open positions, tradable). Supported claim:
*broker flat at EOD, no residual exposure identified, protective broker execution occurred.*
**Not** claimed: "exposure safe throughout" — the artifacts hold no continuous, timestamped
broker position/fill timeline, so instant-by-instant safety during FWDI's 11:31–13:57 ET window
is not provable, only that a protective stop was placed and ultimately executed.

## Lane 2 — Executor / local-state accuracy: DEGRADED (central finding)
Local `openQty` was materially wrong for extended spans:
- **FWDI:** local held 2,711 vs a declining true broker qty for **~2h26m** (11:31→13:57 ET);
  local booked P&L on only 182 of 2,711 shares. **Most severe partial-exit ingestion instance
  of the trial** (Issue 1).
- **YYGH:** local held 1,187 vs broker 798 for **~2h11m** (07:52→10:03 ET).

Local state was corrected only at reconciliation. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

**FWDI lag is Issue 1 (ingestion), NOT Issue 2 (network).** The EQ tape shows **4,376
continuous FWDI observations at steady 2 s cadence across the whole 11:31→13:57 window** —
connectivity was healthy; the executor simply failed to ingest broker exit fills. This must
**not** be classified as a HOWL-style network outage.

## Lane 3 — Capacity / risk-accounting implications of stale-high openQty: LATENT (no realized harm today)
A stale-high local `openQty` means local believed it held position/slot capacity the broker had
partially or wholly vacated. Implications:
- **Capacity:** local could keep a concurrent-position slot occupied and mis-block a new
  admission.
- **Risk-accounting:** daily-loss / open-risk gates run off local economics, which understated
  the FWDI loss (−$17 vs ≈ −$257) during the window, so loss-budget gating used wrong inputs.

**No actual mis-gate occurred today** — the book was quiet during FWDI's stale window (no
`entry_submitted`/`entry_blocked` between 11:31 and 13:57 ET) and the day never neared the
daily-loss limit. The latent exposure is real and is why nightly reconciliation is mandatory.

## Decisions log — POST_FREEZE_APPEND_DRIFT (resolved) + daemon stop
- The live Mac `alert-daemon.ts` (PIDs 83402/83413/83414, ~14h13m elapsed) remained running
  afterhours and **appended 11 session-gated rows** to the decisions log (17:47–18:21 ET),
  taking the on-disk file to 327 rows and changing its whole-file hash to `ac5063d8…`.
- **Prefix integrity PROVEN:** `head -n 316` of the live file hashes byte-for-byte to the frozen
  `826b136c…`. Frozen artifact preserved intact as the exact prefix; appended rows are
  append-only, all `verdict=session`, and **none touch the 6 filled setups, the DIRECT_REMOVAL
  (YYGH), or the REPLACEMENT (CRWD:bos)**. The review is unaffected.
- **Operational cutoff & daemon stop:** at **2026-08-27T22:23:16Z (18:23:16 ET)** the Mac
  `alert-daemon.ts` chain was stopped (SIGTERM to PIDs 83402/83413/83414). Verified afterward:
  no `alert-daemon.ts` process remains, and the decisions file is stable (327 rows / `ac5063d8…`
  constant across a verification interval). **DigitalOcean services were NOT touched.**
- Preserved snapshots: `data/research-cache/ops/decisions-2026-08-27-postfreeze-326rows.jsonl`
  and `data/research-cache/ops/decisions-2026-08-27-frozen-candidate.jsonl` (316 rows,
  sha256 `826b136c…`).
- **Follow-up (separate from this review):** the daemon running unbounded afterhours will drift
  every future session's decisions file the same way — freeze/snapshot at a defined EOD cutoff
  (or stop the daemon) before hashing future sessions.

## EQ observer
**HEALTHY** — 29,361 rows, 0 errors, 0 dropped, stable 2 s cadence. Issue 3 remains resolved.

## DigitalOcean — soak only (no order authority; evaluate as infrastructure)
- `companion-web` & `companion-daemon`: **active, enabled, NRestarts=0**, up since 00:04–00:05
  UTC (full day). Config `PAPER_TRADE=1 DRY_RUN=1 HALT=1 EXEC_OBSERVER=1`.
- Error scan: **no matching errors.** Memory 678/961 MiB used (283 avail), swap 38/2048 MiB —
  modest, healthy pressure. No instability observed.
- **Assessment: infrastructure STABLE for the soak day. Cloud *execution* reliability is NOT
  proven** — it held no order authority and ran dry-run/HALT. Do not mix cloud dry-run activity
  with the authoritative Mac paper execution.

## Broker-safety assertion
Broker **flat at EOD, no residual exposure identified, protective broker execution occurred.**
FWDI and YYGH are **local accounting** under-books (Issue 1), not exposure events. Not asserted:
continuous instant-by-instant safety (no continuous broker timeline in the artifacts).

## Linked issues
- [Issue 1 — partial-exit-fill-ingestion](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion) (FWDI severe + YYGH) — **most severe instance of the trial**
- [Issue 2 — network-outage-recognition-delay](../ISSUE_LEDGER.md#issue-2--network-outage-recognition-delay) — **not** implicated today (FWDI lag is ingestion, connectivity healthy)
- [Issue 3 — execution-observer-launch-config](../ISSUE_LEDGER.md#issue-3--execution-observer-launch-config) — remains resolved (29,361 EQ rows)
