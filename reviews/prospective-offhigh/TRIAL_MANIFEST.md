# TRIAL MANIFEST — Prospective Off-High Validation

**Immutable identity record. Do not retro-edit the frozen fields.** Corrections are
appended as dated notes, never overwritten.

## Identity

| Field | Value |
|---|---|
| **Trial name** | Prospective off-high validation |
| **Purpose** | Prospectively test, on unseen forward sessions, whether rejecting weak-off-the-high candidates improves the paper strategy — without touching the live strategy. |
| **Hypothesis (PRIMARY RULE)** | Reject a candidate when `offHighPct < -3`. |
| **Threshold** | `-3` (frozen; no `-2 / -4 / -5` optimisation during the window). |
| **Strategy frozen at git HEAD** | `eead9b2810b080761a56a4c4fa53d081f728e684` (branch `improve-signal-quality`). |
| **Evaluator** | `scripts/shadow-validate.ts`, sha256 `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6`. |
| **Model / evaluator version** | `v2-event-anchored`. |
| **Initial protocol commit** | `9c3972f` — *research(protocol): freeze off-high shadow validation (RESEARCH ONLY)*. v1 evaluator (sha256 `8af598fd…44d74`), treated as PRE-VALIDATION INFRASTRUCTURE ONLY. |
| **Re-freeze (fidelity fix) commit** | `fb92844` — *research(protocol): re-freeze off-high shadow validation v2 (fidelity fix)*. Established the v2 event-anchored evaluator (the sha256 above). No prospective data existed yet, so hypothesis and verdict standard are unchanged from v1. |
| **Amended protocol commit** | `d9eb78c` — *research(protocol): operational-window amendment — 08-24 DATA_INCOMPLETE*. Window-only amendment. |

The re-freeze commit (`fb92844`) is the immutable timestamp proving the rule + evaluator
were frozen **before** any validation-window session existed.

## Field / sign semantics (exact — the shadow does not recompute this)

`offHighPct` is read **verbatim** from the live decision log
(`~/.companion-decisions-<day>.jsonl`). It is `technical.ts`
`distanceFromDayHighPct = (currentPrice − dayHigh)/dayHigh × 100`, with
`dayHigh = regularHigh ?? premarketHigh` over the candles **through the decision bar**
(no EOD / future-high leakage). **Negative = below the contemporaneous high;
`< -3` = more than 3% below the high at decision time.**

## Session schedule — final usable window (10 sessions)

| # | Date | Notes |
|---|---|---|
| 1 | 2026-08-25 | usable |
| 2 | 2026-08-26 | usable |
| 3 | 2026-08-27 | scheduled |
| 4 | 2026-08-28 | scheduled |
| 5 | 2026-08-31 | scheduled |
| 6 | 2026-09-01 | scheduled |
| 7 | 2026-09-02 | scheduled |
| 8 | 2026-09-03 | scheduled |
| 9 | 2026-09-04 | scheduled |
| 10 | 2026-09-08 | scheduled (replacement session — see amendment) |

### 2026-08-24 — DATA_INCOMPLETE amendment
No Companion / trading / capture processes were running for the session, so no candidate
stream or fills were recorded. Marked **DATA_INCOMPLETE**, not silently omitted. Because it
occurred **before any usable prospective data was collected**, the unusable session is
replaced by the next eligible US trading session, **2026-09-08**, preserving a 10-usable
horizon. This is an **operational-window amendment only** — no hypothesis, evaluator, or
verdict change. Originally frozen window was `08-24…09-04`; the amended usable schedule is
the table above.

### 2026-09-07 — excluded
Labor Day / US market closed. Excluded, not counted as a usable or unusable session.

## The three arms

| Arm | Definition |
|---|---|
| **CONTROL** | The current committed paper strategy, unchanged. In the evaluator, CONTROL = the executor's **actual** admission, read from `~/.companion-paper-trades-<day>.json`. R = `realizedPnl / plannedRisk`, exact and friction-inclusive. **shadow_control == live by construction.** |
| **EXPERIMENT_DIRECT_ONLY** | The same book with only `offHighPct < -3` rejections applied. A control-admitted trade with `offHighPct < -3` is a **DIRECT_REMOVAL** and its slot is left **empty** (no replacement). This is the **conservative, fully-exact lower bound** — it carries zero reconstruction assumption. |
| **EXPERIMENT_RESHUFFLE_AWARE** | DIRECT_ONLY **plus** first-order **REPLACEMENT_ADMISSION**: a control-blocked candidate may fill **only** the specific capacity a removal actually vacated (a removed trade's exact concurrent window `[entryTs, exitTs]`, or a freed premarket/day count). Reported as the `experiment` figure. |

## Capacity-conserving assumptions (frozen)

- Caps use committed `DEFAULT_RISK`: `maxTradesPerDay 10`, `maxPremarketTrades 3`,
  `maxConcurrentPositions 3`, `maxPositionsPerSymbol 1`.
- Every replacement consumes one global day-slot, so **total replacements ≤ removals** —
  `maxTradesPerDay` is never breached.
- Replacements **never displace a trade the executor really took**, so
  **CASCADE_DIFFERENCE = 0 by construction.** Higher-order cascades are intentionally not
  modeled (a never-executed candidate's true lifetime is unknown; modeling it would add
  curve-fit error, not fidelity).
- Replacement R + lifetime are reconstructed from 1-minute tape via the **shared**
  `scaledPnl` / `resolveLogAgainstCandles` / `slippageForSession` path.

## Known evaluator limitations (documented; scoped)

- **CONTROL is exact** (real fills, friction-inclusive R). The v2 correction eliminated the
  v1 candidate-identity divergence — no residual there.
- **Only REPLACEMENT_ADMISSION is frictionless** — a never-executed candidate has no real
  limit-fill probability, partial fills, live slippage beyond the session haircut, broker
  rejects, or latency. `experimentDirectOnly` carries none of this and **brackets the
  experiment from below.**
- **Reshuffle is first-order only.**
- **Dollar-based gates are NOT modeled** (R-only shadow, no equity):
  `dailyLossLimitFraction 0.02`, `premarketLossLimitFraction 0.005`,
  `maxOpenRiskFraction 0.015`. Applied equally to both arms, so the **delta** is more
  robust than the absolute R.

## Six frozen overall verdict conditions

A **CONFIRMED** verdict requires **ALL** of:

1. EXPERIMENT net R > CONTROL net R
2. EXPERIMENT profit factor > CONTROL profit factor
3. max drawdown not materially worse
4. improvement not explained by a single trade / single day
5. the directly-removed cohort remains net negative
6. slot replacements do not erase the advantage

- **MIXED:** direction favorable but ≥1 robustness condition fails.
- **NOT_CONFIRMED:** net R does not improve, PF deteriorates, or reshuffling
  eliminates / reverses the effect.
- **DATA_INCOMPLETE:** too few usable sessions to judge.

## Governing rules

- **Interim results cannot alter the strategy.** No threshold move, gate change, sizing,
  stop, target, or evaluator edit from what any interim session shows.
- **Operational safety can terminate or amend a session, but cannot silently alter the
  hypothesis, evaluator, or verdict standard.** A safety stop is an operational event,
  never re-cast as a strategy decision.
- The verdict is computed **once**, after the 10th usable session.

## August is NOT the validation set

August was inspected diagnostically (including the off-high winner/loser relationship). It
is not held out for this hypothesis. The `*_selftest.json` outputs (2026-08-20/08-21) are
infrastructure smoke tests, **excluded from the verdict.** The unseen sessions in the
schedule above are the validation set.
