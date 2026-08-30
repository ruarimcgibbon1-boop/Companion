# ADJUSTMENTS / CORRECTIONS — Session 4 — 2026-08-28

Corrections recorded separately rather than silently rewriting an earlier report. Append-only.
This file records only accounting/reconciliation/reporting corrections and integrity notes.

## Frozen — NO strategy-side change deployed
- **NO strategy adjustment deployed.**
- **NO threshold adjustment** (`offHighPct < -3` frozen; no `-2 / -4 / -5` search).
- **NO stop adjustment.**
- **NO target adjustment.**
- **NO evaluator change** (sha256 `fdaec3d8…7ef3a6` verified unchanged).
- **NO CONTROL-definition change.**
- **The known partial-exit accounting fix (Issue 1) remains NOT DEPLOYED** during the frozen
  trial — changing exit-fill ingestion touches the executor, which is CONTROL and must stay
  frozen. Tracked for post-trial work.

Any engineering fixes suggested by Session 4 (Issue 1 ingestion repair; Issue 5 startup ordering
— start the dev server before the daemon / add a readiness gate; Issue 6 enforce an EOD
freeze-before-hash cutoff) are recorded as **deferred / post-trial** work. None is necessary for
immediate broker safety (broker exposure remained safe), so none is deployed mid-trial.

## Accounting reconciliations (broker authoritative; local retained as observed)
| Date | Field corrected | From (local) | To (broker) | Reason |
|------|-----------------|--------------|-------------|--------|
| 2026-08-28 | TE trade P&L / R | −$6.90 / −0.089R | −$81.46 / −1.054R | Partial-exit ingestion (Issue 1): 466 of 512 exit shares un-ingested (booked 46). Broker fill-level complete (residual 0). Broker authoritative. |
| 2026-08-28 | UMC trade P&L / R | −$168.29 / −0.364R | −$487.29 / −1.055R | Partial-exit ingestion (Issue 1): 495 of 739 exit shares un-ingested (booked 244 across 2 legs). Broker complete. Broker authoritative. |
| 2026-08-28 | PURR trade P&L / R | −$227.43 / −0.978R | −$249.58 / −1.073R | Partial-exit ingestion (Issue 1): 115 of 1312 exit shares un-ingested (booked 1197). Broker complete. Broker authoritative. |
| 2026-08-28 | Session net P&L (economic truth) | local −$1,929.21 | broker −$2,344.97 (complete, fill-level) | EOD reconciliation; local − broker = **+$415.76** (local **understated the loss**). |

**Precision note:** Session-4 broker truth is **complete at fill level**
(`retrievalComplete=true`) — every trade's exit qty reconciles to entry qty with residual 0, 34
mapped fills, 0 unmapped. This matches the **corrected Session-3 record** (research branch), where
FWDI/YYGH were likewise reconciled exactly from the Alpaca FILL ledger; no tiered/equity-estimate
step was needed for Session 4. AFRM/CYCU/PD reconcile exactly; CHGA differs by rounding only
(local −$458.75 vs broker −$458.80). **CHGA reconciles effectively exactly, so the observed
+1.046R experiment−control removal delta is NOT caused by the accounting defect.**

## Integrity note — LATE FREEZE (missed contemporaneous EOD freeze)
| Date | Field | From | To | Reason |
|------|-------|------|----|--------|
| 2026-08-29 | Session 4 freeze timing | intended contemporaneous EOD freeze (≤ 16:00 ET 2026-08-28) | actual freeze **2026-08-29 ~15:25Z (~19h26m / 1166 min late)** | No snapshot/manifest/shadow output existed at EOD; evaluator + `session-freeze` were run during validation. Snapshot passes `session-verify` **CLEAN**, but a late CLEAN snapshot **cannot** establish an independent true-EOD baseline. Operational/trial-integrity finding, **not** evidence corruption (no artifact evidence of tampering). See [ISSUE_LEDGER §6](../ISSUE_LEDGER.md#issue-6--missed-contemporaneous-eod-freeze). |

## Startup note — daemon before dev server
| Date | Field | From | To | Reason |
|------|-------|------|----|--------|
| 2026-08-28 | Prospective coverage 04:29–04:33 ET | scanner expected up at daemon start | scanner unavailable ~04:29–04:33 ET (daemon started before dev server) | "sweep error … fetch failed" until HTTP 200 ~04:33 ET; first decision 04:33:47 ET. Missed prospective signal / CONTROL admission in the gap = **UNKNOWN** (do not strengthen to NO); no observed admission/removal/replacement/cascade/authority/exposure affected. See [ISSUE_LEDGER §5](../ISSUE_LEDGER.md#issue-5--daemon-startup-before-dev-server). |

## Notes
- **No strategy, gate, threshold, sizing, stop, target, or evaluator change** was made. All
  frozen. This file records only accounting/reconciliation/reporting corrections and the
  freeze/startup integrity notes.
- The CHGA post-exit +17.2R run is **REVIEW-ONLY** and must **not** trigger stop/threshold/target
  tuning or re-entry logic. Sample = one session / seven trades.
- **No raw artifact was altered**; the frozen snapshot is untracked evidence and was not staged.
  The only environment actions were the read-only validation tooling runs (evaluator, freeze,
  verify, broker-ledger, acquire-signal-tapes). DigitalOcean services were not touched.
