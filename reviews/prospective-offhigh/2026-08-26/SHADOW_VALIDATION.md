# SHADOW VALIDATION — Session 2 — 2026-08-26

- Evaluator: `scripts/shadow-validate.ts` (sha256 `fdaec3d8…7ba6`, v2-event-anchored)
- Source: `data/research-cache/shadow-offhigh/2026-08-26.json`
- Source sha256: `291e813106f21f644b1d1265c63cf6dd925a36ff3c39a2350b8616aed182f935` (82 lines, 2,334 bytes)
- gitHead recorded in output: `eead9b2` · rule `offHighPct < -3` · model `v2-event-anchored`
- resolvedAtUtc: `2026-08-26T20:27:48.711Z`

## Arms
| Arm | n | net R | mean R | win % | PF |
|---|---|---|---|---|---|
| control | 6 | −3.008 | −0.501 | 16.7 | 0.437 |
| experimentDirectOnly | 5 | −1.888 | −0.378 | 20.0 | 0.553 |
| experiment | 6 | −3.210 | −0.535 | 16.7 | 0.421 |

## Reshuffle classes
| Class | n | net R | setupIds / detail |
|---|---|---|---|
| DIRECT_REMOVAL | 1 | −1.12 | `NCPL:breakout:0.45` |
| REPLACEMENT_ADMISSION | 1 | −1.322 | `SMR:hod_break:10.09` — offHighPct 0, R −1.3217, outcome `invalidated`, blockedFor `premarket` |
| CASCADE_DIFFERENCE | 0 | 0 | [] |
| UNCHANGED | 5 | — | — |

## Reconciliation diagnostic (required)
| Field | Value |
|---|---|
| shadow_control_admitted | 6 |
| live_admitted | 6 |
| admission_count_delta | 0 |
| matched_setupIds | 6 |
| live_only_setupIds | [] |
| shadow_only_setupIds | [] |
| control_open_without_R | [] |
| capacity_reason_differences | `SMR:hod_break:10.09` — controlReason `blocked_premarket` → experimentOutcome `admitted_replacement` |

**Fidelity flag:** none for CONTROL. `matched_setupIds (6) == live_admitted (6)`,
`shadow_only` empty. The single capacity-reason difference is the **intended** experiment
behaviour (replacement filling freed premarket capacity), not a CONTROL fidelity fault.

## Fidelity notes (from output)
- CONTROL = actual executor fills (exact, friction-inclusive R); shadow_control == live by construction.
- Reshuffle is FIRST-ORDER; CASCADE = 0 by construction (SMR displaced no real trade).
- REPLACEMENT_ADMISSION R (SMR −1.322) is a frictionless tape reconstruction — the only
  non-exact component; `experimentDirectOnly` (−1.888) is the conservative bound.
- Dollar gates not modeled — applied equally to both arms.
