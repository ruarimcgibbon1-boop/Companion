# POST-SESSION REVIEW — Session 2 — 2026-08-26

## Summary
Second usable prospective session. **6 filled, matched 6/6, 0 open at EOD.** A losing
CONTROL session (net −3.008R), and the **first session where the off-high challenger acted**:
one DIRECT_REMOVAL and one REPLACEMENT_ADMISSION.

## Control (live) result
| n | net R | mean R | win % | PF |
|---|-------|--------|-------|----|
| 6 | −3.008 | −0.501 | 16.7 | 0.437 |

CONTROL = actual executor fills; reconciliation matched **6/6** setupIds,
`admission_count_delta = 0`, no `shadow_only`/`live_only` ids, no `control_open_without_R`.
One capacity-reason difference is expected and benign: `SMR:hod_break:10.09` was
`blocked_premarket` under CONTROL and became `admitted_replacement` under EXPERIMENT.

## Experiment result
| Arm | n | net R | mean R | win % | PF |
|---|---|-------|--------|-------|----|
| experimentDirectOnly | 5 | **−1.888** | −0.378 | 20.0 | 0.553 |
| experiment (reshuffle) | 6 | **−3.210** | −0.535 | 16.7 | 0.421 |

- **Direct-only** removes NCPL (`offHighPct < -3`, −1.12R) and leaves its slot empty →
  net improves to −1.888R (the conservative, exact bound).
- **Reshuffle-aware** additionally admits the replacement SMR into the freed **premarket**
  capacity; SMR **invalidated for −1.322R**, so the reshuffle arm is **worse** than CONTROL
  at −3.210R. The two experiment figures **bracket** the true effect: direct-only above
  CONTROL, reshuffle below it.

## Off-high rule activity
- **DIRECT_REMOVAL:** `NCPL:breakout:0.45`, −1.12R (a real losing trade with
  `offHighPct < -3`). Removing it is the source of the direct-only improvement.
- **REPLACEMENT_ADMISSION:** `SMR:hod_break:10.09`, offHighPct 0, R −1.322, outcome
  `invalidated`, filled the freed `premarket` slot. Frictionless tape reconstruction (the
  only non-exact component). CASCADE_DIFFERENCE = 0 (SMR displaced no real trade).
- UNCHANGED = 5.

## Reconciliation note
Local P&L **−$931.66** vs broker **−$567.72** → **local − broker = −$363.94**. The driver is
**ANF**: broker **+$986.33 / +3.72R** vs local **+$619.50 / +2.34R** — the local process
under-booked the ANF winner on fragmented exit fills (**Issue 1**), making local look worse
than broker this session. Broker is authoritative; broker exposure remained safe.
See [ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

## HOWL — classification
**NETWORK_OUTAGE / CONNECTIVITY_DEPENDENT_RECOGNITION_DELAY.** The HOWL broker stop filled
normally (~11:13 ET, position flat and safe); a user-location Wi-Fi outage kept local state
stale until reconciliation observed broker-flat truth (~14:35 ET), a **~3h22m** span that
reflects the **outage duration, not executor latency and not a broker-stop ingestion
defect.** See [ISSUE_LEDGER §2](../ISSUE_LEDGER.md#issue-2--network-outage-recognition-delay).

> The 3h22m delay must **not** be classified as executor latency or attributed to Issue 1.

## Data quality
**USABLE.** CONTROL reconciles 6/6 and is faithful; the accounting divergence (ANF) and the
recognition delay (HOWL) are operational findings, recorded and reconciled, not data
corruption.

## Interim discipline
No strategy verdict, no rule tuning. Two sessions in; the challenger is directionally mixed
(direct-only better, reshuffle worse, both on a single removal). Verdict is computed once,
after session 10.
