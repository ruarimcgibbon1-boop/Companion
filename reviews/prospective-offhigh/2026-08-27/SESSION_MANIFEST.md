# SESSION MANIFEST — Session 3 — 2026-08-27

> **STATUS: ARCHIVED.** Third usable prospective session. CONTROL reconciles 6/6; the
> off-high challenger acted (1 removal, 1 replacement). Session verdict:
> **CLEAN_WITH_FINDINGS** — driven by the most severe partial-exit ingestion instance of the
> trial (FWDI), not by excursion incompleteness.

| Field | Value |
|---|---|
| Date | 2026-08-27 |
| Session number | 3 |
| Strategy HEAD | `eead9b2` (frozen — confirmed unchanged) |
| Evaluator checksum | `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6` (verified unchanged) |
| Rule | `offHighPct < -3` |
| Daemon runtime | premarket → EOD; shadow resolved 2026-08-27T21:36:57.108Z. Mac `alert-daemon.ts` was stopped **after** the review at the operational cutoff **2026-08-27T22:23:16Z (18:23:16 ET)** — see integrity note below and `OPERATIONAL_DIAGNOSIS.md`. |
| Observer status | **HEALTHY** — `EXEC_OBSERVER=1` active; 29,361 rows produced |

## Raw artifacts (path · sha256 · rows · bytes)
| Artifact | Path | sha256 (frozen basis) | Rows | Bytes |
|---|---|---|---|---|
| Decision log | `~/.companion-decisions-2026-08-27.jsonl` | `826b136ceae4fcf9aecbca970d57309afdf5916b28b84a423f4a9231d8393877` | **316** (frozen basis) | 117,265 (at freeze) |
| Paper trades | `~/.companion-paper-trades-2026-08-27.json` | `e1f2aff27e58e5af7f97b3abd4b328eb53ffedd0adf48a5bda60bbd555444a0f` | 484 (pretty-printed; 9 trade objects) | 14,479 |
| Paper events | `~/.companion-paper-events-2026-08-27.jsonl` | `23e486c00cae944b276e47c06d16323da241aaa58019807a17769f11df86b34c` | 77 | 20,667 |
| EQ observer tape | `~/.companion-execution-quality-2026-08-27.jsonl` | `c2b35887d66897b1cc5b91fe5c2782cbd9772fa967a7728d3e061d296e510aa8` | 29,361 | 23,328,766 |
| Shadow cache | `data/research-cache/shadow-offhigh/2026-08-27.json` | `b3b7ac84221f1afb4cf392374f020195b9312ddaabfca26fa4e24d52d5fcae08` | 82 | 2,366 |

> All five artifact hashes and the evaluator SHA were verified unchanged at review time; the
> decisions whole-file hash later drifted append-only (see below), with its frozen 316-row
> prefix preserved byte-for-byte.

## Decisions artifact — POST_FREEZE_APPEND_DRIFT (resolved, benign)

The Session 3 review was computed against the frozen decisions artifact
`sha256 826b136c…8393877` (**316 rows**). The live Mac `alert-daemon.ts` remained running
after the trading day and **appended 11 session-gated afterhours rows** (17:47–18:21 ET),
taking the on-disk file to **327 rows** with a changed whole-file hash
(`ac5063d86139f94e3e3b1cf5a887f8bbbf9f3d5d4a73977d0885822fae5f3fc6`).

- **Prefix integrity PROVEN:** `head -n 316` of the live file hashes **byte-for-byte** to the
  frozen `826b136c…`. The frozen artifact is preserved intact as the exact prefix; the later
  rows are **append-only**, no rewrite of frozen content.
- **None of the 11 appended rows are afterhours-*admitted*** — all carry `verdict=session`
  (session-gated) — and **none touch the 6 filled setups, the DIRECT_REMOVAL
  (`YYGH:break_of_structure:1.86`), or the REPLACEMENT (`CRWD:break_of_structure:206.70`)**.
  The two familiar tickers among them (WKSP, OKTA, CRWD) appear only as different afterhours
  momentum/breakout setupIds.
- **Preserved snapshots** (operational, not raw artifacts):
  `data/research-cache/ops/decisions-2026-08-27-postfreeze-326rows.jsonl`
  (as-captured, sha256 `ac5063d8…` at capture) and
  `data/research-cache/ops/decisions-2026-08-27-frozen-candidate.jsonl`
  (316 rows, sha256 `826b136c…`).
- **Root cause:** the Mac alert daemon (`scripts/alert-daemon.ts`, PIDs 83402/83413/83414)
  ran unbounded afterhours. It was stopped at the cutoff above; the decisions file is now
  stable. The review and its numbers are **unaffected**.

## Counts
| Metric | Value |
|---|---|
| Decision rows (frozen basis) | 316 |
| Event rows | 77 |
| EQ rows | 29,361 |
| Trades considered | 6 filled + 3 aborted (90 s entry timeout) + multiple `entry_blocked` |
| Trades filled | 6 |
| Trades aborted | 3 (OKTA, DAIC, CYPH — unfilled) |
| Open at EOD | 0 |

## Economics
| Metric | Value |
|---|---|
| Local P&L $ | **+1,218.79** |
| Broker P&L $ | **+1,018.19** (exact, from primary Alpaca FILL ledger — not equity subtraction) |
| Difference (local − broker) $ | **+200.60** — local **overstated net** (hid $239.49 of FWDI loss, offset by $38.90 of hidden YYGH gain) |

**Broker economics — EXACT per-trade (Alpaca FILL ledger; `retrievalComplete=true`, all 6
mapped, unmapped=0; see `POST_SESSION_REVIEW.md §1`):** NVDL −$468.16, WKSP −$15.14, YYGH
**+$71.82**, CRWD +$872.57, CRM +$813.83, FWDI **−$256.73** → total **+$1,018.19**. The prior
Tier-A/B/C equity-subtraction framing is superseded: every previously "UNRESOLVED" per-share
fill (FWDI's 2,529, YYGH's 389) is now individually priced. Equity Δ +$1,018.19 corroborates
the total to the cent.

## Shadow arms (R)
| Arm | Net R |
|---|---|
| Control (= live, exact-by-definition) | **+2.395** (PF 1.554, win 50%) |
| Direct-only | **+2.084** (PF 1.482) |
| Experiment (reshuffle-aware) | **+4.972** (PF 2.151) |
| Direct removals | 1 — `YYGH:break_of_structure:1.86` (offHigh −3.59, +0.311R local) |
| Replacements | 1 — `CRWD:break_of_structure:206.70` (offHigh −0.26, +2.888R, `target_hit`, frictionless) |

## Close-out
| Check | Value |
|---|---|
| Broker-flat EOD confirmation | **Yes** — Alpaca: no open positions, account tradable; protective broker execution occurred |
| Data-quality verdict | **CLEAN_WITH_FINDINGS** (CONTROL reconciles 6/6; findings = Issue 1 recurrence + excursion coverage) |
| Operational issues encountered | Issue 1 (partial-exit ingestion — FWDI severe + YYGH); decisions POST_FREEZE_APPEND_DRIFT (benign); daemon stopped at cutoff |
| Corrections/adjustments | see [`ADJUSTMENTS.md`](ADJUSTMENTS.md) |
| Final archive status | ARCHIVED |
