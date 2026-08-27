# OPERATIONAL DIAGNOSIS — Session 3 — 2026-08-27

Mac execution reliability is assessed on **three separate lanes** rather than as a single
"reliable/unreliable" verdict, because broker order control performed while local state was
materially wrong for extended spans.

## Lane 1 — Broker-side protective execution: PERFORMED
Stops/targets filled at the broker on all six trades; **account flat at EOD** (Alpaca: no open
positions, tradable). The FILL ledger strengthens this: FWDI shows a single 2,711-share entry
(11:31 ET) and a single protective-stop liquidation of the full 2,711 at 13:56:41 ET, with the
stop resting in between — no evidence of an uncovered window. Supported claim: *broker flat at
EOD, no residual exposure identified, protective broker execution occurred, and FWDI was covered
by a resting stop until it executed.* **Not** claimed: a per-instant position snapshot (the
artifacts carry the fill stream, not a continuous position timeseries).

## Lane 2 — Executor / local realized-accounting accuracy: DEGRADED (central finding)

> **Corrected 2026-08-28 from primary Alpaca FILL timestamps.** The prior text described
> "stale local `openQty` for extended spans (FWDI ~2h26m, YYGH ~2h11m)." The fill stream does
> **not** support that: in both cases local qty was *correct* for most of the interval, and the
> defect is **omitted realized P&L on un-ingested exit fragments**, not a stale-quantity window.

- **FWDI.** The 2,711-share position was **legitimately open** (broker qty = local qty = 2,711)
  from stop placement (11:31 ET) until the stop liquidated the whole position in a **~1-second
  fill burst at 13:56:41 ET** (4 fragments, one stop order). Local recognized the change at
  ~13:57:24 ET — a **≈43-second broker-fill → recognition lag**. The **accounting defect:** local
  booked P&L on only the **182-share** fragment and **omitted 2,529 exit shares** (broker
  −$256.73/−0.924R vs local −$17.24/−0.062R). **Largest $ under-book of the trial.**
- **YYGH.** The t1 target order filled **798 shares** (11:52:08 ET, fragments 409+136+253);
  local ingested only the first **409**, and the qty mismatch was reconciled to 798 within
  **~seconds** (11:52:53 ET) — no stale-qty window. The **accounting defect:** the **389
  un-ingested t1 shares** were omitted from realized P&L (broker +$71.82/+0.678R vs local
  +$32.92/+0.311R).

Local realized P&L was materially wrong at EOD (session net overstated by +$200.60); it is now
reconstructed exactly from the FILL ledger. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

**Still Issue 1 (ingestion), NOT Issue 2 (network).** The EQ tape shows **4,376 continuous FWDI
observations at steady 2 s cadence across 11:31→13:57 ET** — connectivity was healthy; the
executor failed to ingest broker exit fills (it reconciles off an eventually-consistent
`getPosition`, which lagged the FILL stream by ~43 s). This is **not** a HOWL-style outage.

## Lane 3 — Capacity / risk-accounting implications: LATENT (no realized harm today)
The defect distorts **realized** accounting, not the open-position quantity (which was correct
until the stop fired). Implications remain latent:
- **Risk-accounting:** daily-loss / open-risk gates run off local economics; after the stop
  fired, local under-stated the FWDI loss (−$17 vs −$256.73) for the ~43 s until reconcile, and
  the omitted P&L persisted in local books through EOD — so loss-budget gating used wrong
  realized inputs.
- **Capacity:** a stale-high `openQty` *could* keep a concurrent slot occupied; here local qty
  tracked broker qty until the stop, so no slot was wrongly held.

**No actual mis-gate occurred today** — the book was quiet around FWDI's stop (no
`entry_submitted`/`entry_blocked` 11:31→13:57 ET) and the day never neared the daily-loss limit.
The latent exposure is real and is why nightly reconciliation (now fill-ledger–based) is mandatory.

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
Broker **flat at EOD, no residual exposure identified, protective broker execution occurred**;
FWDI was covered by a resting protective stop until its 13:56:41 ET liquidation. FWDI and YYGH
are **local accounting** under-books (Issue 1), not exposure events. Not asserted: a per-instant
position snapshot (the artifacts carry the FILL stream, not a continuous position timeseries).

## Linked issues
- [Issue 1 — partial-exit-fill-ingestion](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion) (FWDI + YYGH) — **largest $ under-book of the trial**; recognition lag corrected to ≈43 s (was mis-read as ≈2h26m)
- [Issue 2 — network-outage-recognition-delay](../ISSUE_LEDGER.md#issue-2--network-outage-recognition-delay) — **not** implicated today (FWDI lag is ingestion, connectivity healthy)
- [Issue 3 — execution-observer-launch-config](../ISSUE_LEDGER.md#issue-3--execution-observer-launch-config) — remains resolved (29,361 EQ rows)
