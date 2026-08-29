# SHADOW VALIDATION — Session 4 — 2026-08-28

- Evaluator: `scripts/shadow-validate.ts` (sha256 `fdaec3d8…7ef3a6`, v2-event-anchored) — **verified unchanged**
- Source: `data/research-cache/shadow-offhigh/2026-08-28.json` (git-ignored raw; frozen into `snapshot/shadow-output.json`)
- Source sha256 (frozen): `781a4507402f0e67f1d79b4cb63820d0cd15b9ba5908d3e28f5873dfac816b7d` (69 lines, 1,989 bytes)
- gitHead recorded in output: **`eead9b2810b080761a56a4c4fa53d081f728e684`** · rule `offHighPct < -3` · model `v2-event-anchored`
- resolvedAtUtc: `2026-08-29T15:25:27.766Z` (**run ~9h after close — late freeze; see `SESSION_MANIFEST.md`**)

The evaluator was run once, unmodified, with `SHADOW_DAYS=2026-08-28` and
`GIT_HEAD=eead9b2…`. All three arms and every reshuffle class below are the frozen evaluator
output — not reinterpreted after seeing the result. CONTROL is anchored to the executor's
actual fills, so `shadow_control == live` by construction.

## Arms
| Arm | n | net R | mean R | win % | PF |
|---|---|---|---|---|---|
| control | 7 | **−5.713** | −0.816 | 0.0 | **0** |
| experimentDirectOnly | 6 | **−4.667** | −0.778 | 0.0 | 0 |
| experiment | 6 | **−4.667** | −0.778 | 0.0 | 0 |

**Control composition (local executor R, exact-by-definition):** TE −0.089, UMC −0.364,
AFRM −1.062, CYCU −1.078, CHGA −1.046, PURR −0.978, PD −1.096 → **−5.713R**. 0 wins → win 0%,
PF 0.

## Reshuffle classes
| Class | n | net R | setupIds / detail |
|---|---|---|---|
| DIRECT_REMOVAL | 1 | −1.046 | `CHGA:opening_range_break:0.14` — offHighPct **−12.67** (only `< −3` in book), local R −1.046 |
| REPLACEMENT_ADMISSION | 0 | 0 | [] — no capacity-blocked candidate with resolvable geometry + offHigh ≥ −3 filled the freed slot |
| CASCADE_DIFFERENCE | 0 | 0 | [] |
| UNCHANGED | 6 | — | — |

**Arithmetic.** Direct-only = control − CHGA = −5.713 − (−1.046) = **−4.667**. Experiment =
direct-only + replacements (0) = **−4.667**. Removing the single `offHighPct < −3` trade
(CHGA, a realized loser) improves the frozen day by **+1.046R**. The challenger was otherwise
**inert on the replacement side** this session.

## Reconciliation diagnostic (required)
| Field | Value |
|---|---|
| shadow_control_admitted | 7 |
| live_admitted | 7 |
| admission_count_delta | 0 |
| matched_setupIds | 7 |
| live_only_setupIds | [] |
| shadow_only_setupIds | [] |
| control_open_without_R | [] |
| capacity_reason_differences | [] |

**Fidelity flag:** none. `matched_setupIds (7) == live_admitted (7)`, `shadow_only` empty,
`live_only` empty → CONTROL is faithful.

## Fidelity notes (from output)
- CONTROL = actual executor fills (exact, friction-inclusive R); shadow_control == live by construction.
- Reshuffle is FIRST-ORDER; CASCADE = 0 by construction (no replacement displaced a real trade).
- `experimentDirectOnly` (−4.667) equals `experiment` this session because there were **0 replacements** — no frictionless reconstruction entered either arm.
- Dollar gates not modeled — applied equally to both arms.

## Data-quality caveat (information only — does NOT alter the frozen figures or PASS/FAIL)
CONTROL R is scored on the **local executor fills by definition**, which under-booked **TE**
(−0.089R local vs −1.054R broker), **UMC** (−0.364R local vs −1.055R broker), and **PURR**
(−0.978R local vs −1.073R broker) — Issue 1. A broker-true CONTROL would be ≈ **−7.464R**
(broker-true direct-only ≈ −6.418R). This is **accounting context, not a reinterpretation of
the frozen evaluator**; the frozen **−5.713R** figure stands as the validation input.

**Crucially, the accounting defect does not change the experiment−control delta.** The three
under-booked trades (TE/UMC/PURR) are **UNCHANGED in both arms** and cancel in the delta.
**CHGA reconciles effectively exactly** (local −$458.75 vs broker −$458.80, rounding only), so
the observed **+1.046R** removal delta is **not** caused by the accounting defect. Session 4 is
one usable evidence point (4 of 10). No hypothesis verdict; no threshold tuning; the verdict is
computed once, after session 10.
