# ADJUSTMENTS / CORRECTIONS — Session 3 — 2026-08-27

Corrections recorded separately rather than silently rewriting an earlier report. Append-only.

| Date | Field corrected | From | To | Reason |
|------|-----------------|------|----|--------|
| 2026-08-27 | FWDI trade P&L / R | local −$17.24 / −0.062R | broker ≈ −$256.7 / −0.924R (est.) | Partial-exit ingestion (Issue 1): 2,529 of 2,711 exit shares un-ingested. Equity-constrained, YYGH-bounded estimate; per-share fills UNRESOLVED. Broker authoritative; local retained as observed. |
| 2026-08-27 | YYGH trade P&L / R | local +$32.92 / +0.311R | broker ≈ +$71.8 / +0.678R (bounded) | Under-booked 389-share t1 leg (Issue 1). Limit exit at 2.00 target, 798 qty known → tightly bounded. Broker authoritative. |
| 2026-08-27 | Session net P&L (economic truth) | local +$1,218.79 | broker +$1,018.19 (session exact, equity-anchored) | EOD reconciliation; local − broker = +$200.60 (local overstated net). |

## Precision tiers for broker economics (do not collapse into a single "exact" figure)
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

## Notes
- **No strategy, gate, threshold, sizing, stop, target, or evaluator change** was made. All
  frozen. This file records only accounting/reconciliation/reporting corrections and the
  decisions-log integrity note.
- The FWDI ~2h26m recognition lag is recorded as **Issue 1 (ingestion)**, **not** Issue 2
  (network) — connectivity was healthy (4,376 continuous FWDI EQ observations across the lag).
- No raw artifact was altered. The daemon stop and operational snapshots are the only
  environment actions; DigitalOcean services were not touched.
