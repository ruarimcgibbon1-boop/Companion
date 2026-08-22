# Prospective Shadow Validation — off-high admission rule (FROZEN PROTOCOL)

**RESEARCH PROTOCOL ONLY. This document and `scripts/shadow-validate.ts` have no order
authority and do not alter live/paper admission, sizing, exits, alerts, or executor state.
The real paper executor remains the CONTROL and is unchanged.**

## Pre-registration provenance
- **Frozen at git HEAD:** `eead9b2810b080761a56a4c4fa53d081f728e684` (branch `improve-signal-quality`)
- **Protocol authored:** 2026-08-22 (Sat), before any validation-window session existed.
- **Rule code checksum:** `scripts/shadow-validate.ts` = sha256 `8af598fd4600a1c9289b8ec065efe1cc41768198c037b68983498357bed44d74`
- The commit that adds this file + the script is the immutable timestamp proving the rule was frozen before the validation data existed.

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
- The next **10 complete US trading sessions**: `2026-08-25, 08-26, 08-27, 08-28, 08-31, 09-01, 09-02, 09-03, 09-04, 09-08` (Labor Day 09-07 excluded).
- No early stop for good/bad results. No extension without explicit approval.
- A session with a process outage, missing/empty tape, corrupted logs, or market-data failure is marked **DATA_INCOMPLETE** and neither silently replaced nor omitted. Report the final usable session count.

## Shadow portfolio method (`scripts/shadow-validate.ts`)
Evaluated AFTER each session from the live decision stream + 1-minute tape:
1. Candidate stream = decision-log rows with `verdict === 'logged'` (executor-bound; `veto`/`dup` already rejected upstream), deduped by `setupId` (executor logs one trade per setup/day), sorted by decision timestamp.
2. Each candidate's R and exit time are resolved from 1-minute tape via the **shared** `scaledPnl` / `resolveLogAgainstCandles` / `slippageForSession` — the same modules the live P&L descends from, so shadow and live cannot drift. R is the laddered scale-out return ÷ one-R stop fraction.
3. Two chronological capacity portfolios are run with the committed caps
   (`DEFAULT_RISK`): `maxTradesPerDay 10`, `maxPremarketTrades 3`, `maxConcurrentPositions 3`,
   `maxPositionsPerSymbol 1`. A position occupies a slot from its decision timestamp until its
   tape-resolved exit; **rejecting a candidate frees its slot, so a later blocked candidate may be admitted** (reshuffle is the point).
4. Per-session record → `data/research-cache/shadow-offhigh/<day>.json` (git-ignored). Raw data preserved.

Reshuffle is classified per session: **DIRECT_REMOVAL** (admitted in control, off-high-rejected), **REPLACEMENT_ADMISSION** (blocked in control, admitted in experiment from a freed slot), **CASCADE_DIFFERENCE**, **UNCHANGED**. Replacement-admission R is reported separately.

## Fidelity limitations (documented, not fixed)
- **Signal/tape-reconstructed**, not live fills: no real limit-fill probability, partial fills, live slippage beyond the modeled session haircut, broker rejects, or latency.
- **Concurrency lifetime is tape-reconstructed.** In a smoke test, shadow-CONTROL admitted 4 vs ~9 live on 2026-08-21 — trades that ride to close hold a slot to EOD, so the concurrency cap can **under-admit** vs the live executor (which flattens premarket by the open and stops out fast). Therefore each session ALSO **reconciles shadow-CONTROL against the live executed paper-trades count** and reports the divergence. The clean within-method comparison is shadow-CONTROL vs shadow-EXPERIMENT (identical resolution); the live book is a reconciliation reference, not the experiment arm.
- **Dollar-based gates NOT modeled** (R-only shadow, no equity): `dailyLossLimitFraction 0.02`, `premarketLossLimitFraction 0.005`, `maxOpenRiskFraction 0.015`. Applied equally to both arms, so the delta is more robust than the absolutes.

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
