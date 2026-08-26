# SESSION MANIFEST — Session 1 — 2026-08-25

> **STATUS: ARCHIVED.** First usable prospective session.

| Field | Value |
|---|---|
| Date | 2026-08-25 |
| Session number | 1 |
| Strategy HEAD | `eead9b2` (frozen — confirmed) |
| Evaluator checksum | `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6` (unchanged — confirmed) |
| Rule | `offHighPct < -3` |
| Daemon runtime | premarket → EOD; shadow resolved 2026-08-25T20:21:08Z |
| Observer status | **ABSENT** — `EXEC_OBSERVER=1` omitted from launch (Issue 3, resolved next session) |

## Raw artifacts (path · sha256 · rows · bytes)
| Artifact | Path | sha256 | Rows | Bytes |
|---|---|---|---|---|
| Decision log | `~/.companion-decisions-2026-08-25.jsonl` | `72e2018c46ac5f99deb1e68d1460223739790e9988e51dd46b404780526ebba1` | 398 | 142,771 |
| Paper trades | `~/.companion-paper-trades-2026-08-25.json` | `2d7ec7ff71992563fe41b91e105743f34b3a290149ce5f28a087eb5d511e3e7a` | 576 | 18,838 |
| Paper events | `~/.companion-paper-events-2026-08-25.jsonl` | `b73614ad1a844abb0755296a756dab966c6f20acb6562147c7c1d00c55aacb78` | 79 | 21,552 |
| EQ observer tape | `~/.companion-execution-quality-2026-08-25.jsonl` | — (**not produced**; Issue 3) | 0 | 0 |
| Shadow cache | `data/research-cache/shadow-offhigh/2026-08-25.json` | `e3aeb9b7762c6e7fea7709934798b55d9926900c8df78132f3a6faddfa3ca532` | 66 | 1,922 |

## Counts
| Metric | Value |
|---|---|
| Decision rows | 398 |
| Event rows | 79 |
| EQ rows | 0 (observer absent) |
| Trades considered | 10 |
| Trades filled | 9 |
| Trades aborted | 1 |
| Open at EOD | 0 |

## Economics
| Metric | Value |
|---|---|
| Local P&L $ | −1,781.07 |
| Broker P&L $ | ≈ −1,975.79 |
| Difference (local − broker) $ | +194.72 (local **understated the loss**) |

## Shadow arms (R)
| Arm | Net R |
|---|---|
| Control | −6.027 |
| Direct-only | −6.027 |
| Experiment (reshuffle-aware) | −6.027 |
| Direct removals | 0 |
| Replacements | 0 |

The challenger is **inert** this session — no candidate in the admitted book carried
`offHighPct < -3`, so DIRECT_ONLY and EXPERIMENT equal CONTROL exactly.

## Close-out
| Check | Value |
|---|---|
| Broker-flat EOD confirmation | **Yes** — account flat EOD |
| Data-quality verdict | **CLEAN_WITH_FINDINGS** |
| Operational issues encountered | Issue 3 (observer launch-config); Issue 1 first divergence (−$194.72 exit-ingestion understatement) |
| Corrections/adjustments | see [`ADJUSTMENTS.md`](ADJUSTMENTS.md) |
| Final archive status | ARCHIVED |

## Exclusions
- **BITO** cleanup is excluded from this session as **HISTORICAL_ORPHAN_CLEANUP** — a
  carried prior position closed out per the orphan-cleanup procedure, not a session-1
  admission. It is not part of the CONTROL book and does not enter the shadow arms.
