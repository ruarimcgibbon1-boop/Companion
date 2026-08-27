# ADJUSTMENTS / CORRECTIONS — Session 3 — 2026-08-27

Corrections recorded separately rather than silently rewriting an earlier report. Append-only.

| Date | Field corrected | From | To | Reason |
|------|-----------------|------|----|--------|
| 2026-08-27 | FWDI trade P&L / R | local −$17.24 / −0.062R | broker ≈ −$256.7 / −0.924R (est.) | Partial-exit ingestion (Issue 1): 2,529 of 2,711 exit shares un-ingested. Equity-constrained, YYGH-bounded estimate; per-share fills UNRESOLVED. Broker authoritative; local retained as observed. |
| 2026-08-27 | YYGH trade P&L / R | local +$32.92 / +0.311R | broker ≈ +$71.8 / +0.678R (bounded) | Under-booked 389-share t1 leg (Issue 1). Limit exit at 2.00 target, 798 qty known → tightly bounded. Broker authoritative. |
| 2026-08-27 | Session net P&L (economic truth) | local +$1,218.79 | broker +$1,018.19 (session exact, equity-anchored) | EOD reconciliation; local − broker = +$200.60 (local overstated net). |

## Precision tiers for broker economics  — ⚠️ SUPERSEDED 2026-08-28 (see the broker-ledger section below; broker economics are now exact per-trade from the Alpaca FILL stream, and rows 7–8 above are the superseded estimates)
_(retained append-only as the 2026-08-27 record)_
- **Tier A — exact & independent:** equity Δ **+$1,018.19**; four trades reconcile exactly
  (NVDL −468.16, WKSP −15.14, CRWD +872.57, CRM +813.83); **combined YYGH+FWDI = −$184.91**.
- **Tier B — bounded estimate:** YYGH ≈ +$71.8 / +0.678R; FWDI ≈ −$256.7 / −0.924R.
- **Tier C — UNRESOLVED:** FWDI's 2,529 un-ingested exit shares are not individually priced.
- The equity tie is **independent only at the pair/session level**; the FWDI trade-level figure
  is not independently pinned (equity constrains only the YYGH+FWDI *sum*), and the
  external-close-avg×2,711 route is corroborative, not proof.

## Rev.1 → rev.2 review corrections (audit pass — no data changed, wording/precision only)
| Item | Correction |
|------|-----------|
| Exposure language | "broker exposure safe throughout" → "broker flat at EOD, no residual exposure identified, protective broker execution occurred." |
| Operational classification | Mac "reliable" → three separated lanes (broker execution performed / local-state degraded / capacity-risk latent). |
| EQ freshness denominator | Reconciled to 29,361 incl. **7 quote-null + 16 trade-null** third state; fresh/stale no longer presented as exhaustive. |
| Latency definitions | Submit→broker-fill and broker-fill→recognition separated; NVDL "recognition delay" relabeled 3.39 s submit→local-fill (not separable); FWDI is the sole measurable broker-fill→recognition lag. |
| Excursion denominators | Both reported: **3/10 signal-instance**, **2/9 unique-symbol**. |
| Capture efficiency | Both anchors: CRWD **76.5% signal** / **67.4% fill**; CRM not computable (no tape). |
| Terminology | CRWD +0.321R relabeled **minimum excursion (never traded below entry)**, not adverse. |

## Integrity note — decisions artifact POST_FREEZE_APPEND_DRIFT
| Date | Field | From | To | Reason |
|------|-------|------|----|--------|
| 2026-08-27 | decisions on-disk hash / rows | frozen `826b136c…` / 316 rows | live `ac5063d8…` / 327 rows | Live Mac `alert-daemon.ts` appended 11 session-gated afterhours rows (17:47–18:21 ET) post-freeze. **Prefix integrity proven** (`head -n 316` = `826b136c…`); append-only; none touch the review. Analysis basis remains the frozen 316-row prefix. Daemon stopped at cutoff 2026-08-27T22:23:16Z. |

## 2026-08-28 — Broker-ledger provenance upgrade + FWDI diagnosis correction

Supersedes the estimate rows above (rows 7–8) and the Tier-A/B/C framing (which were the best
available on 2026-08-27, before direct fill retrieval). Broker economics are now **exact from
the complete Alpaca FILL activity stream** (`scripts/broker-ledger.ts`, READ-ONLY):
`retrievalComplete=true`, all 6 trades mapped by `client_order_id`, **unmapped = 0**, total
**+$1,018.19**, **direct fill reconstruction — no equity subtraction.**

| Field corrected | From (2026-08-27 estimate) | To (2026-08-28 exact, fill ledger) |
|---|---|---|
| FWDI trade P&L / R | broker ≈ −$256.7 / −0.924R (equity-constrained est., per-share UNRESOLVED) | **−$256.73 / −0.924R exact** — 2,711 exited @≈6.7353 vwap in 4 fragments (1,274+305+950+182); 2,529 shares omitted locally |
| YYGH trade P&L / R | broker ≈ +$71.8 / +0.678R (bounded) | **+$71.82 / +0.678R exact** — t1 = 798 @1.99 in 3 fragments (409+136+253); 389 omitted locally |
| Session net (economic truth) | broker +$1,018.19 (equity-anchored) | **+$1,018.19 (exact, per-trade fill sum; equity now corroboration, not basis)** |
| Broker-true CONTROL (info only) | ≈ +1.90R | **+1.899R** (exact broker R sum; frozen CONTROL stays +2.395R) |

**FWDI recognition-lag diagnosis corrected.** The FILL timestamps show the FWDI stop liquidated
the **entire 2,711-share position in a ~1-second burst at 13:56:41 ET**; local recognized it at
~13:57:24 ET. Supported **broker-fill → recognition lag ≈ 43 s** — **not ≈ 2h26m**. The 2h26m was
the **holding period** (stop placed 11:31 → executed 13:56:41), during which local qty was
*correct*, not stale. The **accounting defect stands** (2,529 FWDI + 389 YYGH exit shares omitted
from local realized P&L; session net overstated +$200.60); only the recognition-lag reading is
corrected. Tier-B "estimate" and Tier-C "UNRESOLVED" labels no longer apply — every share is now
individually priced.

## Notes
- **No strategy, gate, threshold, sizing, stop, target, or evaluator change** was made. All
  frozen. This file records only accounting/reconciliation/reporting corrections and the
  decisions-log integrity note. **Frozen off-high values unchanged:** CONTROL +2.395R,
  direct-only +2.084R, reshuffle +4.972R, removal YYGH +0.311R (frozen local), replacement
  CRWD:bos +2.888R, cascade 0, reconciliation 6/6.
- The FWDI recognition lag (≈43 s, corrected from ≈2h26m) is **Issue 1 (ingestion)**, **not**
  Issue 2 (network) — connectivity was healthy (4,376 continuous FWDI EQ observations).
- No raw artifact was altered. The daemon stop and operational snapshots are the only
  environment actions; DigitalOcean services were not touched.
