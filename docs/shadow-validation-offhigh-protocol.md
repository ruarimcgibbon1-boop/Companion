# Prospective Shadow Validation — off-high admission rule (FROZEN PROTOCOL)

**RESEARCH PROTOCOL ONLY. This document and `scripts/shadow-validate.ts` have no order
authority and do not alter live/paper admission, sizing, exits, alerts, or executor state.
The real paper executor remains the CONTROL and is unchanged.**

## Pre-registration provenance
- **Strategy frozen at git HEAD:** `eead9b2810b080761a56a4c4fa53d081f728e684` (branch `improve-signal-quality`)
- **Protocol authored:** 2026-08-22 (Sat), before any validation-window session existed.
- **Evaluator: v2 (event-anchored).** `scripts/shadow-validate.ts` = sha256
  `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6`.
- **Supersedes commit `9c3972f`** (v1 evaluator, sha256 `8af598fd…44d74`) as **PRE-VALIDATION
  INFRASTRUCTURE ONLY** — corrected before the first prospective session; **no prospective
  validation data existed yet, so the HYPOTHESIS and VERDICT STANDARD are unchanged** (see below).
- The commit that re-freezes this file + the v2 script is the immutable timestamp proving the rule was frozen before the validation data existed.

### Why v2 (measurement-fidelity correction, 2026-08-22)
v1 re-derived CONTROL admission from the `classifyBuy` `logged` stream; a smoke test showed it
matched only 2/10 live admits on 2026-08-21 (shadow-CONTROL 4 vs live ~9) — it invented early
premarket admits, dropped targetless/geometry candidates (e.g. MSTX), and let `expired`
candidates ride to EOD saturating concurrency. **Root cause: candidate-identity + concurrency
reconstruction, not a tunable constant.** v2 fixes it by **anchoring CONTROL to the actual
executor event log** (see method); shadow-CONTROL now reconciles 10/10 on 08-21, 3/3 on 08-20.
No ad-hoc constants were introduced.

## Hypothesis (frozen — do not modify during the window)
- **PRIMARY RULE:** reject a candidate when `offHighPct < -3`.
- **CONTROL:** current committed paper strategy, unchanged.
- **EXPERIMENT:** identical strategy + only the rule above, with its OWN independent capacity state.
- **Threshold `-3` is frozen.** No `-2 / -4 / -5` optimisation during the window.
- Also frozen: session conditions, setup exclusions, grade floor, score floor, RVOL, stop width, target rules, sizing, exits.

## Field / sign semantics (exact, not recomputed)
- `offHighPct` is read verbatim from the LIVE decision log (`~/.companion-decisions-<day>.jsonl`).
- It is `technical.ts` `distanceFromDayHighPct = (currentPrice − dayHigh)/dayHigh × 100`, where
  `dayHigh = regularHigh ?? premarketHigh` computed over `soFar = candles through the decision bar`
  (`replay-day.ts:114`). **Negative = below high. No EOD/future-high leakage. `< -3` = >3% below the contemporaneous high.**
- The shadow does NOT recompute or reinterpret this field.

## Validation window (frozen)
- **10 usable US trading sessions** (as amended below): `2026-08-25, 08-26, 08-27, 08-28, 08-31, 09-01, 09-02, 09-03, 09-04, 09-08`. Labor Day 09-07 is a market holiday and excluded.
- No early stop for good/bad results. No extension without explicit approval.
- A session with a process outage, missing/empty tape, corrupted logs, or market-data failure is marked **DATA_INCOMPLETE** and neither silently replaced nor omitted. Report the final usable session count.

### Operational amendment — 2026-08-24 (window only; no hypothesis/evaluator/verdict change)
- **2026-08-24 = DATA_INCOMPLETE.** Reason: no Companion/trading/capture processes were running for the session, so no candidate stream or fills were recorded. Marked incomplete, not silently omitted.
- Because this occurred **before any usable prospective validation data was collected**, the unusable session is replaced by the next eligible US trading session, **2026-09-08**, preserving a 10-usable-session horizon.
- This is an **operational-window amendment only.** The originally frozen window was `08-24…09-04`; the amended usable schedule is the list above. 09-07 remains excluded (Labor Day).

## Shadow portfolio method — v2 event-anchored (`scripts/shadow-validate.ts`)
Evaluated AFTER each session:
1. **CONTROL = the executor's ACTUAL admission**, read from `~/.companion-paper-trades-<day>.json`
   (filled trades). R = `realizedPnl / plannedRisk` — **exact and friction-inclusive**. Entry/exit
   timestamps are the real `entryFilledAt → updatedAt` (open trades ride to the day's last event).
   So **shadow_control == live by construction.**
2. The full admission-attempt chronology = executed fills + `entry_blocked` events, each carrying the
   executor's REAL capacity reason (`premarket` / `concurrent` / `day`). `offHighPct` for any setupId
   is joined verbatim from the decision log.
3. **EXPERIMENT = the same book with one change** — reject `offHighPct < -3`:
   - a control-admitted trade with `offHighPct < -3` → **DIRECT_REMOVAL** (frees its capacity);
   - **REPLACEMENT_ADMISSION (first-order):** a control-blocked candidate may fill ONLY the specific
     capacity a removal actually vacated — a removed trade's exact concurrent window `[entryTs,exitTs]`,
     or a freed premarket/day count. Every replacement consumes one global day-slot, so **total
     replacements ≤ removals** (never breaches `maxTradesPerDay`). Replacements **never displace a
     trade the executor really took**, so **CASCADE_DIFFERENCE = 0 by construction**. Replacement R +
     lifetime are reconstructed from 1-minute tape via the **shared** `scaledPnl` /
     `resolveLogAgainstCandles` / `slippageForSession` (the only frictionless component).
   - Caps use committed `DEFAULT_RISK`: `maxTradesPerDay 10`, `maxPremarketTrades 3`,
     `maxConcurrentPositions 3`, `maxPositionsPerSymbol 1`.
4. Two experiment figures are reported: **experimentDirectOnly** (removals only, slots left empty —
   the conservative, fully-exact bound) and **experiment** (reshuffle-aware, first-order).
5. Per-session record → `data/research-cache/shadow-offhigh/<day>.json` (git-ignored). Raw data preserved.

Per-session reshuffle classes: **DIRECT_REMOVAL**, **REPLACEMENT_ADMISSION** (R reported separately),
**CASCADE_DIFFERENCE** (0 by design in the first-order model), **UNCHANGED**.

## Fidelity limitations (documented; residuals scoped & diagnosed)
- **CONTROL is exact** (real fills, friction-inclusive R). The v2 correction eliminated the v1
  candidate-identity divergence — no residual there.
- **Only REPLACEMENT_ADMISSION is frictionless** (never-executed candidates have no live fill): its R
  and lifetime are tape reconstructions — no real limit-fill probability, partial fills, live slippage
  beyond the session haircut, broker rejects, or latency. The **experimentDirectOnly** figure carries
  zero such assumption and brackets the experiment from below.
- **Reshuffle is first-order** (replacements fill only vacated capacity, never displace real trades).
  Higher-order cascades are intentionally not modeled because a never-executed candidate's true
  lifetime is unknown; modeling them would add curve-fit error, not fidelity.
- **Required reconciliation diagnostic, every session** (recorded in each `<day>.json`):
  `shadow_control_admitted`, `live_admitted`, `admission_count_delta`, `matched_setupIds`,
  `live_only_setupIds`, `shadow_only_setupIds`, `capacity_reason_differences`, `control_open_without_R`.
  If `matched_setupIds` ever `< live_admitted` or `shadow_only_setupIds` is non-empty, the session's
  CONTROL is not faithful and is flagged.
- **Dollar-based gates NOT modeled** (R-only shadow, no equity): `dailyLossLimitFraction 0.02`,
  `premarketLossLimitFraction 0.005`, `maxOpenRiskFraction 0.015`. Applied equally to both arms, so the
  delta is more robust than the absolutes.

## Pre-registered decision standard (frozen — do not retro-edit)
**CONFIRMED** requires ALL of:
1. EXPERIMENT net R > CONTROL net R
2. EXPERIMENT profit factor > CONTROL profit factor
3. max drawdown not materially worse
4. improvement not explained by a single trade/day
5. the directly-removed cohort remains net negative
6. slot replacements do not erase the advantage

**MIXED:** direction favorable but ≥1 robustness condition fails.
**NOT_CONFIRMED:** net R does not improve, PF deteriorates, or reshuffling eliminates/reverses the effect.
**DATA_INCOMPLETE:** too few usable sessions to judge.

## Output discipline during the window
Operational failures / data-incompleteness may be reported per session. **No strategy verdicts and no rule tuning from interim P&L.** The verdict is computed once, after the 10th usable session.

## August is NOT the validation set
August was inspected diagnostically (including the off-high winner/loser relationship). It is not held-out for this hypothesis. The next unseen sessions above are the validation set. The 2026-08-20/08-21 `*_selftest.json` outputs are infrastructure smoke tests, excluded from the verdict.
