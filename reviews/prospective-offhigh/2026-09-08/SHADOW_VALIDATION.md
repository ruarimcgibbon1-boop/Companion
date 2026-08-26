# SHADOW VALIDATION — Session 10 — 2026-09-08

> **STATUS: PENDING.** Template. Paste the evaluator output for the day.

- Evaluator: `scripts/shadow-validate.ts` (sha256 `fdaec3d8…7ba6`, v2-event-anchored)
- Source: `data/research-cache/shadow-offhigh/2026-09-08.json` (git-ignored raw)
- Source sha256: _pending_

## Arms
| Arm | n | net R | mean R | win % | PF |
|---|---|---|---|---|---|
| control | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| experimentDirectOnly | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| experiment | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

## Reshuffle classes
| Class | n | net R | setupIds |
|---|---|---|---|
| DIRECT_REMOVAL | _pending_ | _pending_ | _pending_ |
| REPLACEMENT_ADMISSION | _pending_ | _pending_ | _pending_ |
| CASCADE_DIFFERENCE | 0 (by construction) | 0 | — |
| UNCHANGED | _pending_ | — | — |

## Reconciliation diagnostic (required)
| Field | Value |
|---|---|
| shadow_control_admitted | _pending_ |
| live_admitted | _pending_ |
| admission_count_delta | _pending_ |
| matched_setupIds | _pending_ |
| live_only_setupIds | _pending_ |
| shadow_only_setupIds | _pending_ |
| control_open_without_R | _pending_ |
| capacity_reason_differences | _pending_ |

**Fidelity flag:** if `matched_setupIds < live_admitted` or `shadow_only_setupIds` is
non-empty, CONTROL is not faithful — flag the session.
