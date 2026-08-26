# SESSION MANIFEST — Session 2 — 2026-08-26

> **STATUS: ARCHIVED.** Second usable prospective session. First session where the
> challenger acted (1 removal, 1 replacement) and first session with an EQ tape.

| Field | Value |
|---|---|
| Date | 2026-08-26 |
| Session number | 2 |
| Strategy HEAD | `eead9b2` (frozen — confirmed) |
| Evaluator checksum | `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6` (unchanged — confirmed) |
| Rule | `offHighPct < -3` |
| Daemon runtime | premarket → EOD; shadow resolved 2026-08-26T20:27:48Z |
| Observer status | **HEALTHY** — `EXEC_OBSERVER=1` active; 20,136 rows produced |

## Raw artifacts (path · sha256 · rows · bytes)
| Artifact | Path | sha256 | Rows | Bytes |
|---|---|---|---|---|
| Decision log | `~/.companion-decisions-2026-08-26.jsonl` | `ab7a8038e3da9a18d0b5b3468b4f0c6380926255cf98eb515c6d4d8b19a41334` | 401 | 144,636 |
| Paper trades | `~/.companion-paper-trades-2026-08-26.json` | `fc6ea10d63c773798f50f7886113a22fb2e2fdcb181886ff586b56a300e7e1a7` | 5,487 | 249,438 |
| Paper events | `~/.companion-paper-events-2026-08-26.jsonl` | `23a725c5596201584c01b61d6d7969d924566938ede38db05d21abb6d8cf6db0` | 55 | 14,380 |
| EQ observer tape | `~/.companion-execution-quality-2026-08-26.jsonl` | `efb574b7283157a27d23528f8fb7f3fc08f74cd37faf9ed1d4fadb5df254a678` | 20,136 | 15,719,448 |
| Shadow cache | `data/research-cache/shadow-offhigh/2026-08-26.json` | `291e813106f21f644b1d1265c63cf6dd925a36ff3c39a2350b8616aed182f935` | 82 | 2,334 |

## Counts
| Metric | Value |
|---|---|
| Decision rows | 401 |
| Event rows | 55 |
| EQ rows | 20,136 |
| Trades considered | 6 admitted + `entry_blocked` attempts (in decision/event logs) |
| Trades filled | 6 |
| Trades aborted | 0 recorded |
| Open at EOD | 0 |

## Economics
| Metric | Value |
|---|---|
| Local P&L $ | −931.66 |
| Broker P&L $ | −567.72 |
| Difference (local − broker) $ | −363.94 (local **understated net** — driven by an under-booked ANF winner) |

## Shadow arms (R)
| Arm | Net R |
|---|---|
| Control | −3.008 |
| Direct-only | −1.888 |
| Experiment (reshuffle-aware) | −3.210 |
| Direct removals | 1 — `NCPL:breakout:0.45` (−1.12R) |
| Replacements | 1 — `SMR:hod_break:10.09` (−1.322R) |

Removing the one `offHighPct < -3` candidate (NCPL) improved the **direct-only** bound to
−1.888R; the reshuffle-aware arm is **worse** (−3.210R) because the replacement (SMR) that
fills the freed premarket slot invalidated for −1.322R. The direct-only figure is the
conservative bound; the reshuffle figure is the frictionless first-order model.

## Close-out
| Check | Value |
|---|---|
| Broker-flat EOD confirmation | **Yes** — account flat EOD |
| Data-quality verdict | **USABLE** (CONTROL reconciles 6/6) |
| Operational issues encountered | Issue 2 (HOWL network-outage recognition delay); Issue 1 (ANF fragmented-exit accounting) |
| Corrections/adjustments | see [`ADJUSTMENTS.md`](ADJUSTMENTS.md) |
| Final archive status | ARCHIVED |
