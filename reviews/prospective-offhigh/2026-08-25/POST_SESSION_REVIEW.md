# POST-SESSION REVIEW — Session 1 — 2026-08-25

## Summary
First usable prospective session. **10 candidates considered, 9 filled, 1 aborted, 0 open at
EOD.** A losing session for the CONTROL book: net **−6.027R** across 9 fills (mean −0.67R,
win rate 22.2%, profit factor 0.161).

## Control (live) result
| n | net R | mean R | win % | PF |
|---|-------|--------|-------|----|
| 9 | −6.027 | −0.67 | 22.2 | 0.161 |

CONTROL = the executor's actual fills, read from the paper-trades file; friction-inclusive
and exact. `shadow_control == live` by construction. Reconciliation matched **9/9**
setupIds, `admission_count_delta = 0`, no `shadow_only` or `live_only` ids, no
`control_open_without_R`, no capacity-reason differences.

## Experiment result
**Challenger inert.** No admitted candidate had `offHighPct < -3`, so there were **0
DIRECT_REMOVALs** and **0 REPLACEMENT_ADMISSIONs**. Both EXPERIMENT_DIRECT_ONLY and
EXPERIMENT_RESHUFFLE_AWARE equal CONTROL exactly at **−6.027R**. The off-high rule had no
opportunity to act this session — a valid and expected outcome, not a data problem.

## Off-high rule activity
None. UNCHANGED = 9. The rule neither helped nor hurt on 2026-08-25.

## Reconciliation note
Local P&L **−$1,781.07** vs broker **≈ −$1,975.79** — a **$194.72 local understatement of
the loss**. This is the first observation of **Issue 1 (partial-exit-fill-ingestion)**: the
local process ingested only a subset of fragmented exit fills, closing trades on less loss
than the broker realized. Broker exposure remained safe; broker is authoritative. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

**BITO** was excluded as HISTORICAL_ORPHAN_CLEANUP (carried prior position, not a session-1
admission).

## Data quality
**CLEAN_WITH_FINDINGS** — the CONTROL book reconciles perfectly (9/9), so the shadow is
faithful; the "findings" are the operational items (observer absent, exit-ingestion
understatement), not data corruption.

## Interim discipline
No strategy verdict, no rule tuning from this session. One session, challenger inert. Verdict
is computed once, after session 10.
