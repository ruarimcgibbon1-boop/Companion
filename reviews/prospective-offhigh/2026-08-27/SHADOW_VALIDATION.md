# SHADOW VALIDATION — Session 3 — 2026-08-27

- Evaluator: `scripts/shadow-validate.ts` (sha256 `fdaec3d8…7ef3a6`, v2-event-anchored) — **verified unchanged**
- Source: `data/research-cache/shadow-offhigh/2026-08-27.json`
- Source sha256: `b3b7ac84221f1afb4cf392374f020195b9312ddaabfca26fa4e24d52d5fcae08` (82 lines, 2,366 bytes)
- gitHead recorded in output: `null` · rule `offHighPct < -3` · model `v2-event-anchored`
- resolvedAtUtc: `2026-08-27T21:36:57.108Z`

All three arms and every reshuffle class below were **reproduced exactly** from the raw
artifacts. Frozen figures — not reinterpreted after seeing the result.

## Arms
| Arm | n | net R | mean R | win % | PF |
|---|---|---|---|---|---|
| control | 6 | **+2.395** | +0.399 | 50.0 | **1.554** |
| experimentDirectOnly | 5 | **+2.084** | +0.417 | 40.0 | 1.482 |
| experiment | 6 | **+4.972** | +0.829 | 50.0 | **2.151** |

**Control composition (local executor R, exact-by-definition):** NVDL −1.015, WKSP −3.243,
YYGH +0.311, CRWD +3.552, CRM +2.851, FWDI −0.062 → **+2.395R**. Gross win R 6.715 / gross
loss R 4.320 → PF **1.554**. 3W/3L → win 50%.

## Reshuffle classes
| Class | n | net R | setupIds / detail |
|---|---|---|---|
| DIRECT_REMOVAL | 1 | +0.311 | `YYGH:break_of_structure:1.86` — offHighPct −3.59 (only `< −3` in book), local R +0.311 |
| REPLACEMENT_ADMISSION | 1 | +2.888 | `CRWD:break_of_structure:206.70` — offHighPct −0.26, R +2.88805930091892, outcome `target_hit`, blockedFor `premarket` |
| CASCADE_DIFFERENCE | 0 | 0 | [] |
| UNCHANGED | 5 | — | — |

**Arithmetic.** Direct-only = control − YYGH = 2.395 − 0.311 = **+2.084**. Experiment =
direct-only + replacement = 2.084 + 2.888 = **+4.972**. The removal frees the premarket slot
YYGH occupied (premarket cap = 3, held by NVDL/WKSP/YYGH); CRWD:bos — logged 06:39 ET,
`entry_blocked: max premarket trades reached (3)` at 10:39 UTC — fills that freed slot.
CASCADE = 0: the replacement displaced no real trade (first-order model).

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
| capacity_reason_differences | `CRWD:break_of_structure:206.70` — controlReason `blocked_premarket` → experimentOutcome `admitted_replacement` |

**Fidelity flag:** none for CONTROL. `matched_setupIds (6) == live_admitted (6)`, `shadow_only`
empty. The single capacity-reason difference is the **intended** experiment behaviour
(replacement filling freed premarket capacity), not a CONTROL fidelity fault.

## Fidelity notes (from output)
- CONTROL = actual executor fills (exact, friction-inclusive R); shadow_control == live by construction.
- Reshuffle is FIRST-ORDER; CASCADE = 0 by construction (replacement displaced no real trade).
- REPLACEMENT_ADMISSION R (CRWD:bos +2.888) is a frictionless tape reconstruction — the only
  non-exact component; `experimentDirectOnly` (+2.084) is the conservative bound.
- Dollar gates not modeled — applied equally to both arms.

## Data-quality caveat (information only — does NOT alter the frozen figures or PASS/FAIL)
The frozen CONTROL/direct-only/reshuffle arms above are the **authoritative trial figures and
are unchanged.** Separately, for accounting context: CONTROL R is scored on the **local executor
fills by definition**, which under-booked YYGH (+0.311R local vs **+0.678R broker, exact**) and
FWDI (−0.062R local vs **−0.924R broker, exact**) — now measured directly from the Alpaca FILL
ledger (`retrievalComplete=true`, unmapped=0), see
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion). A broker-true CONTROL
would be **+1.899R**. This is **accounting context, NOT a reinterpretation of the frozen
evaluator** — the frozen **+2.395R** figure (local-defined CONTROL) stands as the validation
input and must not be rewritten with broker truth. Session 3 is one usable evidence point (3 of
10). No hypothesis verdict; no threshold tuning.
