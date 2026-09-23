# Candidate Learnings

Hypotheses discovered by the **pattern-miner** skill and stress-tested by the
**strategy-auditor** skill. Nothing here is a Companion rule yet — promotion to
`validated-learnings.md` is handled ONLY by the **promote-learning** skill.

> **PROVENANCE (2026-08-22).** Strategy-research entries here dated **before
> 2026-08-22** predate the committed shared-engine harness (`replayDay` +
> `classifyBuy`/`passesTrackingFloor`, committed `6b6e0bc`→`99e0e8a`→`7a62166`).
> Any result referencing **`JULY_2026_1M_BASELINE`** is **HISTORICAL until
> re-verified under the committed engine** — that baseline's exact equivalence to
> the current engine is **UNPROVEN** (only a 5-day/34-signal 5m parity check is on
> record, not the full 1-minute book), and the July 1m tape is not committed. The
> findings below are kept as-is; treat their numbers as pre-C2 observations.

Entry format (pattern-miner writes §1; strategy-auditor appends the Audit block):

```
## CANDIDATE <id> — <one-line title>
HYPOTHESIS       — a single testable claim
SAMPLE           — n, date range, source (replay / live CSV)
COMPARISON       — the two groups being contrasted
EVIDENCE FOR     — numbers, in R
EVIDENCE AGAINST — numbers, in R
POSSIBLE CONFOUNDERS
CONFIDENCE       — low / medium / high
NEXT VALIDATION TEST — the exact command / change
STATUS           — proposed / auditing / keep-testing / promoted / rejected

### Audit <date> (strategy-auditor)
RESULT           — REJECT / WEAK / KEEP TESTING / STRONG CANDIDATE
STRONGEST SUPPORT
STRONGEST OBJECTION
CONFOUNDERS
EVIDENCE STILL REQUIRED
```

All figures are in **R = P/L ÷ stop width** (the executor sizes by fixed dollar
risk, so R is the only measure comparable across setups). Judge on **net R**, not
avg/trade — a filter that raises the average by trading less is not an improvement.

---

## CANDIDATE C1 — Midday (10:00–14:00 ET) regular-hours entries are near-zero expectancy
HYPOTHESIS       — Entries in the 10:00–14:00 ET window have materially lower expectancy than premarket and the 09:30–10:00 open, so midday should carry a higher quality bar rather than the same gate.
SAMPLE           — 113 resolved signals, 2026-07-06 → 2026-07-31, FMP 20-day replay (cull4, production setup mix).
COMPARISON       — midday 10:00–14:00 (n=61) vs open 09:30–10:00 (n=32) vs premarket (n=20).
EVIDENCE FOR     — open +0.634R/trade (+20.3R), premarket +0.552R/trade, 61% win (+11.0R), midday +0.124R/trade, 33% win (+7.6R over 61 signals = 54% of the book for 20% of the net R).
EVIDENCE AGAINST — Midday is still net POSITIVE (+7.6R). A blunt cut removes money (the "better average, less money" trap). Its low win rate may be a setup-mix proxy (ORB/BOS cluster midday), not the clock.
POSSIBLE CONFOUNDERS — setup-type confounding (ORB/BOS concentration); ticker concentration (see whole-book note); in-sample (same days the gates were tuned on).
CONFIDENCE       — low-medium
NEXT VALIDATION TEST — session-scoped floor in classifyBuy for regular 10:00–14:00 only (require grade ≥ C AND RVOL ≥ 5), env-flagged; full replay + research.ts, segmented by session with median + per-ticker.
STATUS           — auditing

### Audit 2026-08-15 (strategy-auditor)
RESULT           — KEEP TESTING
STRONGEST SUPPORT — Midday earns +0.124R vs +0.55–0.63R elsewhere across a large share (61) of trades.
STRONGEST OBJECTION — Likely setup-type confounding, not a time effect; and a naive cut lowers net R.
CONFOUNDERS      — setup mix, ticker concentration, in-sample tuning.
EVIDENCE STILL REQUIRED — does the open/premarket lift survive removing the top-2 tickers (AEHR, IREN) and scoring on median R? Segment midday BY setup before blaming the clock.

---

## CANDIDATE C2 — RVOL sweet-spot: the <5 tail dilutes, the 100+ tail loses
HYPOTHESIS       — Expectancy is concentrated in RVOL 5–100; RVOL <5 dilutes the book and RVOL 100+ is net-negative.
SAMPLE           — 113 resolved signals, 2026-07 replay (cull4).
COMPARISON       — RVOL <5 (n=74) vs 5–20 (n=20) vs 20–100 (n=11) vs 100+ (n=8).
EVIDENCE FOR     — rvol 5–20 +0.966R (63% win), 20–100 +1.099R (60% win); rvol <5 +0.164R (33% win, 65% of the book); rvol 100+ −0.579R (25% win).
EVIDENCE AGAINST — STRONG prior disconfirmation on file: an RVOL≥5 filter lifted avg/trade +0.179→+0.283R while REMOVING 79 signals worth +9.2R (better average, less money). RVOL <5 is still net +12.2R. The 100+ bucket is only 8 trades — one ticker could flip it.
POSSIBLE CONFOUNDERS — outcome bias; tiny 100+ sample; RVOL correlates with session (premarket surges).
CONFIDENCE       — low
NEXT VALIDATION TEST — test each tail INDEPENDENTLY (a floor, then a 100+ cap), never together; full replay judged on net R.
STATUS           — auditing

### Audit 2026-08-15 (strategy-auditor)
RESULT           — WEAK
STRONGEST SUPPORT — Clean monotone-ish lift in the 5–100 band.
STRONGEST OBJECTION — The RVOL≥5 filter is already recorded as "less money"; the negative 100+ bucket is 8 trades and could be one ticker.
CONFOUNDERS      — small sample in the decisive bucket, session correlation, in-sample.
EVIDENCE STILL REQUIRED — per-ticker decomposition of the 100+ bucket; whether any floor beats baseline on NET R, not avg. Do not run first.

---

## CANDIDATE C3 — Entry-timing confirmation: we buy the top tick of the leg
HYPOTHESIS       — Requiring ≥2 consecutive up-closes immediately before the trigger (MIN_GREEN_STREAK=2) raises expectancy by avoiding entries that die in the entry bar.
SAMPLE           — whole book (≥100 per arm); grounded in the live diagnosis that 12/18 live trades died in the entry bar (memory: entry-timing-finding).
COMPARISON       — MIN_GREEN_STREAK=0 (control) vs =2 (experiment); uniform across all long setups.
EVIDENCE FOR     — the live entry-bar-death diagnosis; the lever already exists (default 0) to test exactly this.
EVIDENCE AGAINST — the cousin lever MAX_LEG_RUNUP_PCT=20 was tested and HURT (thinner book); confirmation can arrive after the move. The 5-min replay fills on bar close, so it CANNOT fully see intra-bar entry deaths — a null replay result is not exoneration.
POSSIBLE CONFOUNDERS — 5-min-vs-1-min granularity (the effect lives sub-bar); may just delay entries into worse fills.
CONFIDENCE       — medium (best of the three: one uniform binary lever, low researcher degrees of freedom, targets the diagnosed mechanism)
NEXT VALIDATION TEST — `MIN_GREEN_STREAK=2 MAX_LOGS_PER_SYMBOL=2 RUN_TAG=greenstreak2 npx tsx scripts/backtest.ts`, compare vs cap-2 control on net R, median R, and MAE.
STATUS           — REJECTED ON 5-MINUTE REPLAY (2026-08-16). The broader entry-timing THESIS remains UNRESOLVED — see Result block; re-open on 1-min tape.

### Audit 2026-08-15 (strategy-auditor)
RESULT           — STRONG CANDIDATE (relative to C1/C2)
STRONGEST SUPPORT — known-at-decision-time (green streak is causal, pre-trigger); lowest overfitting risk of the three; tests the already-diagnosed failure.
STRONGEST OBJECTION — the 5-min replay cannot price it, so the backtest is only a partial judge; needs 1-min tape or forward paper testing.
CONFOUNDERS      — bar granularity; possible worse fills from delayed entry.
EVIDENCE STILL REQUIRED — a real replay run (blocked so far: network-bound), and MAE segmentation to confirm it cuts the entry-bar bleed.

### Descendant D1 (1-minute) — see below.

---

## CANDIDATE D1 — early adverse excursion (first 2 minutes) is predictive, not actionable
HYPOTHESIS       — A trade ≥0.5R adverse within its first two 1-minute bars has negative expectancy; one that holds shallower does not.
SAMPLE           — 167 clean-resolved trades of JULY_2026_1M_BASELINE (92 "held" MAE@2m > −0.5R, 75 "dipped" ≤ −0.5R).
COMPARISON       — held vs dipped cohort; then, within dipped, a blanket −0.5R exit vs current management.
EVIDENCE FOR     — Dipped cohort: 75 trades, 19% win, net −37.1R, avg −0.50R (net-negative on its own). Held cohort: 92 trades, 46% win, +73.9R. Separation survives session and (mostly) ticker/outlier controls; hod_break is the one setup that breaks it.
EVIDENCE AGAINST — POLICY VALUE FAILS. A blanket exit at −0.5R books 75 × −0.5 = −37.5R vs the realised −37.1R — 0.4R WORSE before slippage. The dipped cohort contains 14 recovering winners worth +33.0R (avg +2.36R, MFE +3.45R) that the current wide-stop/scale-out management captures and a blanket exit would destroy.
POSSIBLE CONFOUNDERS — Partial circularity (a trade already −0.5R down is nearer its stop); recovery discriminators are largely tautological (winning requires reclaiming entry).
CONFIDENCE       — the PREDICTION is strong; the POLICY value is absent as posed.
NEXT VALIDATION TEST — none as a blanket rule. A conditional exit that spares fast-reclaim recoveries would need its own study (recovery sample is only 14; non-reclaimers within ~5 min of the touch went 0/29).
STATUS           — CLOSED: predictive-only. Not actionable via a blanket −0.5R exit. Do not build.

### Audit 2026-08-16 (strategy-auditor) — Phase 2 recovery discriminators
RESULT           — WEAK / KEEP TESTING. The strongest separators (reclaim entry within 5 bars: W 100% / L 52%; above 9EMA at touch+3: W 100% / L 62%) are largely TAUTOLOGICAL — a recovery is defined by getting back above entry. The one non-circular signal (recoveries come on higher volume, touch+1..3 ratio 1.47 vs 1.02; and non-reclaimers within 5 min never recover, 0/29) rests on a 14-trade recovery sample and arrives late. Not rule-ready.

## CANDIDATE M1 — breakeven-after-T1 shakes out runners on shallow pullbacks (management)
HYPOTHESIS       — Moving the runner's stop to breakeven after T1 truncates continuations, because the pullbacks that trigger it rarely threaten the original stop.
SAMPLE           — JULY_2026_1M_BASELINE anatomy. 16 trades where the runner was stopped at breakeven after T1.
EVIDENCE FOR     — Those 16 forfeited +32.1R of subsequent MFE (median +1.76R/trade, all 16 later ran >1R past the BE exit). 15/16 had MAE > −0.9R (median −0.28R) — i.e. they pulled back to entry but NOT to the original stop, so a no-breakeven runner would have survived, not stopped. Forfeit survives removing the top-2 tickers (+24.5R of +32.1R) and is broad across setups (ORB +14.1, BOS +11.0, OD +5.4) and mostly regular session. ORB also has the lowest capture efficiency (medCE 0.75).
EVIDENCE AGAINST — "+32.1R forfeited" is unachievable hindsight MFE (selling the top); the realistic gain is the runner riding to T2, not MFE. The protection breakeven provides (on the ~1/16 post-T1 collapses that DO reach the original stop) is real but small in this sample. Cost AND benefit only settle in an A/B. Sample is 16.
POSSIBLE CONFOUNDERS — selection (only BE-fired trades observed); some forfeited upside is itself EOD-mark-dependent; breakeven interacts with the 50%-at-T1 fraction.
CONFIDENCE       — medium; robust descriptively, counterfactual unquantified.
NEXT VALIDATION TEST — A/B: BREAKEVEN_AFTER_T1 false (or a looser post-T1 stop) vs current, reported on BOTH baselines, decomposing captured-continuation vs extra give-back on post-T1 collapses. Requires making BREAKEVEN_AFTER_T1 env-configurable in the resolver (research gating). NOT YET RUN.
STATUS           — A/B RUN 2026-08-17 → KEEP TESTING (blanket rule fails robustness). See Result.

### Audit 2026-08-17 (strategy-auditor) — pre-A/B
RESULT           — KEEP TESTING / borderline STRONG. Robust across ticker/setup/session and not outlier-driven; the counterfactual protection is the open question and the forfeit figure is an MFE ceiling, not a realisable gain. Do not turn into a rule without the cost-AND-benefit A/B.

### Result 2026-08-17 — controlled A/B (BREAKEVEN_AFTER_T1 true vs false), pinned canonical book, signal parity verified under the then-current (pre-C2) research engine
The descriptive "+32.1R forfeited" was hindsight MFE and my "15/16 never approached the stop" used PRE-T1 MAE only (the resolver stops walking at T1). The real A/B corrects both:
| baseline | CONTROL (BE on) | EXPERIMENT (BE off) | Δ |
|---|--:|--:|--:|
| A marked (182) | +73.2R | +77.7R | +4.5R |
| B excl-15-expired (167) | +34.8R | +39.3R | +4.5R |
| C strict-realised | +24.7R | +27.9R | +3.2R |
Decomposition (16 affected): +8.6R gained via T2 (realised) + 1.4R via EOD-mark − 5.5R lost as 11 runners fell to the original stop (breakeven DID protect these). Gains exceed losses and C improves, so it is NOT EOD-mark-driven and NOT a case of losses>gains.
BUT ROBUSTNESS FAILS the pre-registered bar: ex-top-2 tickers the net flips to −0.6R (CRWG +2.7 & SKHU +2.4 carry it); ONE day (2026-07-21) contributes +5.1R — more than the entire net; max drawdown WORSENS −19.1R → −21.1R; strict-realised gain is +3.2R over 182 trades (~+0.018R/trade). The pre-registered "overwhelmingly dependent on one/two outlier trades" REJECT clause is essentially met.
VERDICT — do NOT ship the blanket rule. KEEP TESTING a targeted variant (structure/ATR trail instead of full removal, or setup-conditioned: gains sit in BOS/ORB, losses in opening_drive). Prediction ≠ policy confirmed: the realisable edge (+4.5R) was ~7× smaller than the descriptive MFE forfeit implied.
PRODUCTION UNCHANGED — BREAKEVEN_AFTER_T1 default stays true.

## FINDING F1 — the July 1m baseline is 66% EOD-mark-dependent (accounting)
The marked book (Baseline A) is +73.2R; EOD close-marks contribute +48.5R of that (66%). 15 trades never reached T1 (many have no rated T1 at all), were held 100% to the close, and contribute +38.4R purely via the mark — 52% of the book. Baseline B (fully-resolved, 167 trades) is +34.8R; realised-only (no EOD marks anywhere) ≈ +24.7R. Every future management experiment must report BOTH baselines so it can't look better merely by changing EOD-marked exposure.

## CANDIDATE D2 — tight (<2%) stop width is mostly a proxy, not an independent edge
HYPOTHESIS       — Trades with <2% stop width outperform (descriptive: <2% +45.9R vs 2–4% −13.3R on clean-resolved).
SAMPLE           — 167 clean-resolved trades, JULY_2026_1M_BASELINE.
EVIDENCE AGAINST — The stop is set at ~1.3×ATR, so stop width ≈ a volatility proxy (median RVOL rises 2→4→33 across widening buckets). The edge REVERSES for break_of_structure (tight −0.8R vs wide +11.4R), holds only for opening_drive/ORB, and COLLAPSES +45.9R → +14.9R when the top-3 tickers are removed (one SHPH trade = +10.5R). Not a price proxy (≈$6 both) and not an RR proxy (RR≈2.6 all buckets).
CONFIDENCE       — low that stop width is independently informative.
STATUS           — CLOSED: proxy for low-ATR/clean-structure + best setups + a few outlier tickers. Not a lever.

### Result 2026-08-16 (promote-learning) — REJECTED ON 5-MINUTE REPLAY
Full 20-day July replay, then-current (pre-C2) production code, cap=2, single variable MIN_GREEN_STREAK 0→2.

| metric              | CONTROL (=0) | EXPERIMENT (=2) | Δ            |
|---------------------|-------------:|----------------:|-------------:|
| signals (resolved)  |           84 |              48 | −36 (−43%)   |
| per day             |          4.9 |             3.4 | −1.5         |
| win rate            |          38% |             31% | −7 pts       |
| avg R / trade       |      +0.726R |         +0.429R | −0.30R       |
| median R            |       −1.03R |          −1.05R | ~0           |
| net R (expectancy)  |      +60.9R  |         +20.6R  | −40.3R (−66%)|
| max drawdown        |       −22.5R |          −19.2R | +3.3R        |
| top-2 tickers % net |          47% |             96% | worse        |
| losses avg MAE      |       −4.75% |          −4.83% | ~0           |

WHY THE PROXY FAILED — The filter removed WINNERS, not losers. opening_range_break flipped +21.6R → −9.0R and hod_break +2.5R → −3.8R; win rate fell 38%→31%; net R collapsed −66%. The claimed mechanism did not appear: losers' average MAE was unchanged (−4.75%→−4.83%), so requiring two prior green 5-min closes did NOT select better-timed entries — it just thinned the book and left it more outlier/ticker-concentrated (top-2 tickers 47%→96%). Every pre-registered reject trigger fired (net R down, signals/day <4, no expectancy or MAE gain).

WHY THE THESIS SURVIVES — The 5-min replay fills on bar close and structurally cannot observe the intra-bar entry-bar death the thesis is about (memory: entry-timing-finding, 12/18 live trades died in the entry bar). This rejects the SPECIFIC PROXY (two prior 5-min green closes) ON 5-MIN TAPE, not the entry-timing thesis. Re-open as a new candidate once 1-minute replay exists (fidelity Priority 3).
NEW COMPANION BEHAVIOUR — none. MIN_GREEN_STREAK stays at its default 0 (off). Do not ship.
REVIEW TRIGGER — 1-minute replay available → retest entry-timing with a 1-min-native confirmation proxy.
