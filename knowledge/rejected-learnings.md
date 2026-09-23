# Rejected Learnings

Hypotheses that failed the **promote-learning** gate. Kept (not deleted) so the
same idea isn't re-proposed and re-tested from scratch every session.

> **PROVENANCE (2026-08-22).** Entries dated **before 2026-08-22** predate the
> committed shared-engine harness (`6b6e0bc`→`99e0e8a`→`7a62166`). Rejections
> referencing **`JULY_2026_1M_BASELINE`** or the July replay are **HISTORICAL until
> re-verified under the committed engine**; the July 1m baseline's equivalence to
> the current engine is **UNPROVEN**. Findings are kept as-is.

Entry format:

```
## RL-<n> — <rule / finding that failed>
CLAIM            — what was proposed
WHY REJECTED     — the evidence that killed it, in R
SAMPLE           — n and date range
DATE             — when rejected
DO NOT RE-TEST UNLESS — the condition that would make it worth revisiting
```

---

## RL-1 — MIN_GREEN_STREAK=2 (require 2 green closes before entry)
CLAIM            — Requiring ≥2 consecutive up-closes before the trigger avoids entries that die in the entry bar, raising expectancy.
WHY REJECTED     — 20-day July replay (cap=2, current code): net R +60.9R → +20.6R (−66%), signals 84→48, win rate 38%→31%, avg +0.726R→+0.429R. It removed WINNERS (opening_range_break +21.6R→−9.0R, hod_break +2.5R→−3.8R) and did not reduce losers' MAE (−4.75%→−4.83%), so the claimed mechanism never appeared. Book left more concentrated (top-2 tickers 47%→96%).
SAMPLE           — 84 (control) / 48 (experiment) resolved signals, 2026-07-06 → 2026-07-31.
DATE             — 2026-08-16
DO NOT RE-TEST UNLESS — on 1-MINUTE tape. The 5-min replay fills on bar close and cannot see intra-bar entry-bar death, which is the actual thesis. The broader entry-timing hypothesis is UNRESOLVED, not rejected — see candidate C3 Result block.

---

_See also candidate C3 in candidate-learnings.md — the parent entry-timing hypothesis remains open._

Historical rejections already encoded in production comments (fold in here as they
are re-confirmed against the knowledge store):
- **Strong-continuation override** (near-high + high-RVOL clears the grade floor / cap) — reverted 2026-08-07: added 38 signals but cut expectancy +0.76R → +0.41R/trade on the same pool.
- **momentum_pullback grade-floor exemption** — reverted 2026-08-05: flooded the book with below-grade losers (17→89 signals, +2.23 → −0.70%/trade).
- **Per-symbol cap 2→3** — diluted the book (106→137 signals, 46%→42% win, +1.25→+0.81%/trade).
