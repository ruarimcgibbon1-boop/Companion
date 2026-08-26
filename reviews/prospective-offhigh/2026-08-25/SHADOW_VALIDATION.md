# SHADOW VALIDATION — Session 1 — 2026-08-25

- Evaluator: `scripts/shadow-validate.ts` (sha256 `fdaec3d8…7ba6`, v2-event-anchored)
- Source: `data/research-cache/shadow-offhigh/2026-08-25.json`
- Source sha256: `e3aeb9b7762c6e7fea7709934798b55d9926900c8df78132f3a6faddfa3ca532` (66 lines, 1,922 bytes)
- gitHead recorded in output: `eead9b2` · rule `offHighPct < -3` · model `v2-event-anchored`
- resolvedAtUtc: `2026-08-25T20:21:08.034Z`

## Arms
| Arm | n | net R | mean R | win % | PF |
|---|---|---|---|---|---|
| control | 9 | −6.027 | −0.67 | 22.2 | 0.161 |
| experimentDirectOnly | 9 | −6.027 | −0.67 | 22.2 | 0.161 |
| experiment | 9 | −6.027 | −0.67 | 22.2 | 0.161 |

All three arms identical — the challenger is inert (no `offHighPct < -3` in the book).

## Reshuffle classes
| Class | n | net R | setupIds |
|---|---|---|---|
| DIRECT_REMOVAL | 0 | 0 | [] |
| REPLACEMENT_ADMISSION | 0 | 0 | [] |
| CASCADE_DIFFERENCE | 0 | 0 | [] |
| UNCHANGED | 9 | — | — |

## Reconciliation diagnostic (required)
| Field | Value |
|---|---|
| shadow_control_admitted | 9 |
| live_admitted | 9 |
| admission_count_delta | 0 |
| matched_setupIds | 9 |
| live_only_setupIds | [] |
| shadow_only_setupIds | [] |
| control_open_without_R | [] |
| capacity_reason_differences | [] |

**Fidelity flag:** none. `matched_setupIds (9) == live_admitted (9)`, `shadow_only` empty —
CONTROL is faithful.

## Fidelity notes (from output)
- CONTROL = actual executor fills (exact, friction-inclusive R); shadow_control == live by construction.
- Reshuffle is FIRST-ORDER; CASCADE = 0 by construction.
- REPLACEMENT_ADMISSION R (none this session) is the only non-exact component; `experimentDirectOnly` is the conservative bound.
- Dollar gates not modeled — applied equally to both arms.
