# Validated Learnings

Companion rules that survived pattern-mining AND an aggressive strategy audit AND
the **promote-learning** gate. Only the promote-learning skill writes here.

Prefer calibrated language ("Historically, X has shown higher expectancy…") over
absolutes ("Always do X"). The strength of the claim must match the strength of
the evidence.

Entry format:

```
## VL-<n> — <rule / finding>
RULE / FINDING   — the decision-useful statement
SCOPE            — where it applies (setup type, session, RVOL band, regime)
SAMPLE           — n and date range that support it
KEY STATISTICS   — win rate, avg R, median R, expectancy, MAE, MFE
EXCEPTIONS       — where it does NOT hold
CONFIDENCE       — low / medium / high
VALIDATED        — date
EVIDENCE SUMMARY — one paragraph, with the strongest objection that was overcome
WHAT WOULD INVALIDATE IT — the review trigger
```

Protected: no learning that increases max risk, removes stops, encourages
averaging down, or loosens loss limits may be promoted without explicit user
approval.

---

# Operational Learnings (execution / reconciliation)

These are demonstrated ENGINEERING facts about the execution layer, not strategy
edges — so they carry no R statistics and needed no sample-size gate. Each was
proven by real Alpaca broker evidence on 2026-08-17 plus a regression test that
reproduces the failure and confirms the fix. They only harden execution (they do
not touch risk, stops, sizing, or loss limits).

## OL-1 — Broker fills are authoritative over locally assumed execution state
RULE / FINDING   — Alpaca is the fact for whether an order filled, the actual qty, the fill price and the resulting position. Local strategy state expresses INTENT only and must never override broker FACT.
SCOPE            — the paper/live execution layer (`src/lib/execution/`), every order lifecycle.
EVIDENCE         — 2026-08-17: CAPR's stop filled in two partials (575 + 2007 @ 7.28, one Alpaca order) but the local record captured only the first partial and believed 2007 shares were still open; broker was flat. The account (broker truth) was correct; the local file was not.
BEHAVIOUR NOW    — `PaperExecutor.reconcile()` queries `broker.getPosition()` and adopts broker qty; local qty is only ever corrected toward broker truth, never the reverse. Regression: TEST E.
VALIDATED        — 2026-08-18.
WHAT WOULD INVALIDATE IT — never (this is a correctness invariant, not a hypothesis).

## OL-2 — Stale sell management must terminate when broker quantity reaches zero
RULE / FINDING   — Before submitting any SELL (exit or protective stop), verify the broker still holds the position. If broker qty is 0, do not sell: mark the trade closed, reconcile, and stop all further management. A quantity mismatch means reconcile from broker truth, not continue blindly.
SCOPE            — the execution layer's exit and protective-stop paths.
EVIDENCE         — 2026-08-17: FIGR was flattened by an EXTERNAL market sell (order 762fe788, a manual close). The daemon never saw a Companion fill, kept a stale 553-share "open" position, and re-submitted a protective stop that expired. On a shortable name this same stale-state bug could have opened an accidental SHORT.
BEHAVIOUR NOW    — reconcile runs before every sell and after qty/short rejections ("cannot be sold short", "insufficient qty", "stop price must be less than current price"); a broker-flat position is force-closed and quarantined, no new sell is submitted. Regression: TESTS C and D.
VALIDATED        — 2026-08-18.
WHAT WOULD INVALIDATE IT — never (correctness invariant).

## OL-3 — Only broker-verified executions may enter the learning dataset
RULE / FINDING   — A trade whose local record disagreed with Alpaca (`reconciliationStatus` = discrepancy or manual_review) is not trustworthy evidence and must be excluded from research / post-trade review until a human confirms it. Only `verified` trades auto-ingest.
SCOPE            — any future live-paper → research/learning pipeline.
EVIDENCE         — 2026-08-17: FIGR closed externally at an unknown-to-us price, so its P&L cannot be reconstructed from local data. Ingesting it would inject a wrong outcome into the learning system. (No such pipeline exists yet; this gate is installed before one is built.)
BEHAVIOUR NOW    — `PaperExecutor.verifiedClosedTrades()` is the sole sanctioned entry point; `reconciliationStatus` is persisted on every trade so a future reader can filter. FIGR resolves to `manual_review` and is excluded (TEST C asserts it is not in `verifiedClosedTrades()`).
VALIDATED        — 2026-08-18.
WHAT WOULD INVALIDATE IT — a future consumer reading the raw paper-trades file without filtering on `reconciliationStatus` (a contract violation to guard against in review).

---

_No validated STRATEGY learnings yet. Candidates live in `candidate-learnings.md`;
the first experiment queued for promotion is C3 (entry-timing confirmation)._
