# SESSION MANIFEST — Session 4 — 2026-08-28

> **STATUS: ARCHIVED.** Fourth usable prospective session. CONTROL reconciles **7/7**; the
> off-high challenger acted (1 removal, 0 replacements). All 7 filled trades were losers
> (0 wins). Session verdicts: **trial usability USABLE**, **operational cleanliness
> CLEAN_WITH_FINDINGS**, **accounting quality FAIL** (Issue 1 recurrence). Two operational
> findings dominate: a **late (~9h) EOD freeze** (no contemporaneous baseline) and a
> **startup daemon-before-dev-server gap** (~04:29–04:33 ET). Neither altered any observed
> admission, removal, replacement, cascade, execution-authority, or broker-exposure event.

| Field | Value |
|---|---|
| Date | 2026-08-28 |
| Session number | 4 |
| Strategy HEAD | `eead9b2` (frozen — confirmed unchanged; `~/.companion-producing-head-2026-08-28.txt` = `eead9b2810b080761a56a4c4fa53d081f728e684`) |
| Evaluator checksum | `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6` (verified unchanged on hardening + research checkouts and working-tree) |
| Snapshot tooling checkout | `hardening/readonly-session-integrity` @ `7f2c606dff2e914e895722af28a40e9094af93af` |
| Rule | `offHighPct < -3` |
| Daemon runtime | started **2026-08-28T08:29:03Z (04:29:03 ET)**; first decision row **04:33:47 ET** (after the dev-server startup gap cleared ~04:33 ET); scanner continued afterhours to last decision **20:00 ET**. All 7 positions closed by **~11:09 ET** (last paper-trade `updatedAt` 11:09:13 ET; last EQ observation 11:09:12 ET). |
| Observer status | **HEALTHY-WITH-FINDINGS** — `EXEC_OBSERVER=1` active; 25,870 rows; 0 errors, 0 dropped; but ~82–83% stale quote/trade observations (IEX-only, `feedConsolidated=false`) — see `EXECUTION_QUALITY_REVIEW.md`. |
| **EOD freeze timing** | **LATE.** No contemporaneous EOD freeze existed. Evaluator + `session-freeze` were run during validation on **2026-08-29 (~15:25Z, ~9h after the 16:00 ET close)**. Snapshot passes `session-verify` **CLEAN**, but a late freeze **cannot** establish an independent true-EOD baseline — see integrity note below and [ISSUE_LEDGER §6](../ISSUE_LEDGER.md#issue-6--missed-contemporaneous-eod-freeze). |

## Raw artifacts — frozen snapshot basis (path · sha256 · rows · bytes)

Frozen into `reviews/prospective-offhigh/2026-08-28/snapshot/` (files chmod 0444, atomically
promoted). `session-verify.ts` exit 0: snapshot integrity OK; live drift **CLEAN** on all five.
Manifest `frozenAtUtc = 2026-08-29T15:25:45.642Z`, `daemonRuntime = UNKNOWN` (honestly recorded).

| Artifact | Source path | sha256 (frozen) | Rows | Bytes |
|---|---|---|---|---|
| Decision log | `~/.companion-decisions-2026-08-28.jsonl` → `snapshot/decisions.jsonl` | `624f7498ff065de1fc6a2a6186360df6e7f03813856876ed89cc1fafb82a02a8` | 394 | 140,707 |
| Paper trades | `~/.companion-paper-trades-2026-08-28.json` → `snapshot/paper-trades.json` | `10f703e24ef443ca15951b06759ceeb65c9d422c06a2526a854167094bb649c4` | 395 (pretty-printed; **7 trade objects**) | 12,706 |
| Paper events | `~/.companion-paper-events-2026-08-28.jsonl` → `snapshot/paper-events.jsonl` | `55c20d88a206153869fbef96ef0a85d3f57d656f1dc6df7269b83f267c23e86a` | 64 | 16,265 |
| EQ observer tape | `~/.companion-execution-quality-2026-08-28.jsonl` → `snapshot/execution-quality.jsonl` | `bcb4a9b4b13762c0b00e10cff7bcc7151bc40f3e258e98e87cdb622419890978` | 25,870 | 20,513,450 |
| Shadow cache | `data/research-cache/shadow-offhigh/2026-08-28.json` → `snapshot/shadow-output.json` | `781a4507402f0e67f1d79b4cb63820d0cd15b9ba5908d3e28f5873dfac816b7d` | 69 | 1,989 |

> Manifest lives at `snapshot/MANIFEST.json`. The snapshot directory is **evidence and MUST
> remain untracked** — never staged. Broker-truth ledger (separate research artifact):
> `data/research-cache/broker-ledger/broker-ledger-2026-08-28.json`, contentSha
> `f0491f8e7379c0ac556ad77d86ca7dc0ad4ca61a509d799c25297cde32993b2b`.

## Integrity note — LATE FREEZE (no contemporaneous true-EOD baseline)

The intended contemporaneous Session 4 EOD freeze was **missed**. When validation began the
daemon was still running; after shutdown, **no snapshot, manifest, or shadow output existed**
and `SESSION_MANIFEST.md` was still the blank template. The evaluator and `session-freeze`
were therefore executed **~9 hours after the 16:00 ET close** against the now-static live
files.

- The eventual snapshot passes `session-verify` **CLEAN** (all five files match the manifest;
  live drift clean).
- **CLEAN late-snapshot integrity does NOT retroactively establish an independent true-EOD
  baseline.** Because no earlier baseline was captured, there is no independent proof that the
  live files were unaltered between 16:00 ET and the late freeze. File mtimes and the daemon
  shutdown indicate no mutation after the daemon stopped, and the decisions log is internally
  consistent (all 394 rows are 2026-08-28 in ET, 04:33→20:00 ET), but this is corroborative,
  not a substitute for a contemporaneous freeze.
- Treated as an **operational / trial-integrity finding**, **not** evidence corruption — no
  artifact evidence of tampering exists. See [ISSUE_LEDGER §6](../ISSUE_LEDGER.md#issue-6--missed-contemporaneous-eod-freeze).

## Counts
| Metric | Value |
|---|---|
| Decision rows | 394 (all 2026-08-28 ET; 04:33→20:00 ET) |
| Event rows | 64 |
| EQ rows | 25,870 |
| Trades considered | 7 filled + capacity-blocked/aborted attempts (see events) |
| Trades filled | 7 |
| Trades aborted | 0 filled-then-aborted; all 7 admitted fills closed |
| Open at EOD | 0 |

## Economics
| Metric | Value |
|---|---|
| Local P&L $ | **−1,929.21** |
| Broker P&L $ | **−2,344.97** (retrievalComplete=true; 1 page, 34 activities, 0 out-of-window, mapped 7/7, unmapped 0) |
| Difference (local − broker) $ | **+415.76** — local **understated the loss** (Issue 1: TE/UMC/PURR under-booked) |
| Broker-true CONTROL (accounting context) | ≈ **−7.464R** (sum of per-trade broker R); frozen canonical CONTROL remains **−5.713R** |

## Shadow arms (R) — frozen canonical
| Arm | Net R |
|---|---|
| Control (= live, exact-by-definition) | **−5.713** (PF 0, win 0%, mean −0.816) |
| Direct-only | **−4.667** (PF 0, mean −0.778) |
| Experiment (reshuffle-aware) | **−4.667** (PF 0) |
| Direct removals | 1 — `CHGA:opening_range_break:0.14` (offHighPct **−12.67**, −1.046R local) |
| Replacements | **0** |
| Cascade | 0 (by construction) |

## Close-out
| Check | Value |
|---|---|
| Broker-flat EOD confirmation | **Yes** — all 7 trades `state=closed`, broker residual 0 on every trade, 0 unmapped fills; no carried position |
| Trial usability | **USABLE** (see rationale in `POST_SESSION_REVIEW.md` §8) |
| Operational cleanliness | **CLEAN_WITH_FINDINGS** |
| Accounting quality | **FAIL** — local under-booked $415.76 (Issue 1, TE/UMC/PURR); broker layer complete and authoritative; decision sets unaffected |
| Operational issues encountered | Issue 1 (partial-exit ingestion — TE/UMC/PURR); Issue 5 (daemon-before-dev-server startup gap 04:29–04:33 ET); Issue 6 (missed contemporaneous EOD freeze; late ~9h freeze) |
| Corrections/adjustments | see [`ADJUSTMENTS.md`](ADJUSTMENTS.md) |
| Final archive status | ARCHIVED |
