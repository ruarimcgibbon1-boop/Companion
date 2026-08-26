# Prospective Off-High Validation — Durable Archive

**Scope: documentation / research infrastructure only.** Nothing in this directory has
order authority. It does not alter live/paper admission, sizing, stops, targets, exits,
alerts, gates, the off-high threshold, or the executor. The live paper executor remains
the **CONTROL** and is unchanged. The strategy is frozen at git HEAD
`eead9b2810b080761a56a4c4fa53d081f728e684`.

This archive is the permanent, human-readable record of a pre-registered prospective
shadow-validation trial. It exists so the trial's integrity can be audited long after the
window closes: what was frozen, what was observed each session, how raw artifacts map to
conclusions, and how the final verdict was reached — without trusting anyone's memory.

The authoritative frozen protocol lives at
[`docs/shadow-validation-offhigh-protocol.md`](../../docs/shadow-validation-offhigh-protocol.md)
and the evaluator at [`scripts/shadow-validate.ts`](../../scripts/shadow-validate.ts)
(sha256 `fdaec3d8c3941130c3121816314f7d8af3856b0e34cbe3aadf8adadbdb7ef3a6`). This archive
records around them; it does not restate or supersede them.

---

## Archive policy — after every usable session

1. **Preserve raw artifacts.** Do not mutate the decision log, paper-trades file,
   paper-events log, EQ observer tape, or the per-session shadow cache. They are the
   ground truth.
2. **Hash raw artifacts** where practical (sha256), and record byte size and row/line
   count. The hash is what proves the artifact was not altered after the fact.
3. **Save the shadow-validation result** — the per-session
   `data/research-cache/shadow-offhigh/<day>.json` output (path + hash + the extracted
   figures) into the session's `SHADOW_VALIDATION.md`.
4. **Save the post-session review** into `POST_SESSION_REVIEW.md`.
5. **Save the execution-quality review** into `EXECUTION_QUALITY_REVIEW.md` **when an EQ
   tape exists** for the session (EXEC_OBSERVER=1). If none exists, record that fact.
6. **Save the operational diagnosis** into `OPERATIONAL_DIAGNOSIS.md` **if anomalies
   occur** (outages, stale state, ingestion divergence, launch-config faults). Otherwise
   record "no anomalies".
7. **Record corrections separately** in `ADJUSTMENTS.md` and in
   [`ISSUE_LEDGER.md`](ISSUE_LEDGER.md) rather than silently rewriting an earlier report.
   History is append-only; a wrong number is struck through with a dated correction, not
   deleted.
8. **Update the session `SESSION_MANIFEST.md`** with the final figures and artifact
   provenance.
9. **Update [`SESSION_INDEX.md`](SESSION_INDEX.md)** — move the session row from PENDING
   to its final status and fill its columns.
10. **Reconcile local P&L to Alpaca broker truth.** Broker is the economic authority; the
    local accounting is the observed value. Record both and their exact discrepancy.
11. **Confirm broker-flat EOD state** — no carried paper position into the next session.
12. **Confirm the live strategy branch remains frozen** at `eead9b2` and the evaluator
    sha256 is unchanged.

## What is version-controlled vs. what stays out of Git

- **Version-controlled (this archive):** the human-readable reports, manifests, index,
  issue ledger, and — for each raw artifact — its **path, sha256, row count, byte size,
  metadata, and the conclusions drawn from it.**
- **Kept outside Git (raw, large, or volatile):** the decision logs
  (`~/.companion-decisions-<day>.jsonl`), paper-trades/events files, the EQ observer tape
  (`~/.companion-execution-quality-<day>.jsonl`, ~15 MB/session), and the per-session
  shadow cache (`data/research-cache/shadow-offhigh/<day>.json`, git-ignored). The archive
  points at these by path + hash; it does not vendor them into the repo.

If a raw artifact is ever needed for audit and is no longer at its recorded path, the hash
in the manifest is what lets a restored copy be verified as the same file.

## Directory map

```
reviews/prospective-offhigh/
  README.md               ← this file (archive policy)
  TRIAL_MANIFEST.md       ← immutable trial identity & frozen conditions
  SESSION_INDEX.md        ← one row per usable session (1 table)
  ISSUE_LEDGER.md         ← operational issues, append-only
  FINAL_TRIAL_REVIEW.md   ← verdict template (PENDING until session 10)
  <session-date>/
    SESSION_MANIFEST.md        ← provenance + figures for the session
    POST_SESSION_REVIEW.md     ← what happened, control vs experiment
    SHADOW_VALIDATION.md       ← the shadow evaluator output for the day
    EXECUTION_QUALITY_REVIEW.md← EQ observer findings (when tape exists)
    OPERATIONAL_DIAGNOSIS.md   ← anomalies / outages (when they occur)
    ADJUSTMENTS.md             ← corrections recorded separately
```

## Non-negotiable rules (restated from the frozen protocol)

- **Interim results cannot alter the strategy.** No rule tuning, no threshold move
  (`-3` is frozen; no `-2 / -4 / -5` search), no gate/sizing/stop/target change from
  what any session shows.
- **Operational safety can terminate or amend a *session*, but cannot silently alter the
  hypothesis, evaluator, or verdict standard.** A safety stop is logged as an operational
  event; it is never re-cast as a strategy decision.
- **The verdict is computed once, after the 10th usable session** — never mid-window.
