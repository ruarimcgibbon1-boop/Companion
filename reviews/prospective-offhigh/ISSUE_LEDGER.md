# ISSUE LEDGER — Prospective Off-High Validation

Append-only operational record. Issues are **operational**, not strategy defects; none of
them alters the frozen hypothesis, evaluator, or verdict standard. When an issue's status
or facts change, append a dated note — do not rewrite history.

Severity scale: **INFO / LOW / MEDIUM / HIGH / CRITICAL** (CRITICAL = broker exposure
unsafe; none observed).

---

## ISSUE 1 — partial-exit-fill-ingestion

| Field | Value |
|---|---|
| **Issue ID** | `partial-exit-fill-ingestion` |
| **First observed** | 2026-08-25 |
| **Last observed** | 2026-08-27 |
| **Status** | OPEN — fix DEFERRED during the frozen trial |
| **Severity** | MEDIUM → **HIGH watch** (2026-08-27 was the most severe instance; broker exposure still safe) |
| **Category** | LOCAL ACCOUNTING / EXIT-FILL INGESTION |

**Description.** During **fragmented exit fills**, the local process may ingest only a
subset of the broker's exit partial fills. **Entry quantities ingest correctly**; the first
divergence appears on the exit side. Because reconcile later adopts broker truth, the error
is transient in the record but real in the interim local accounting. It can **understate a
loss** or **understate a win**.

- **Broker exposure impact:** none. Broker exposure has remained safe; this is an
  accounting/observation defect, not an order-control defect.
- **Local accounting impact:** local P&L diverges from broker economics until reconcile.
  - 2026-08-25: local P&L **understated the broker loss by $194.72** (local −1,781.07 vs
    broker ≈ −1,975.79).
  - 2026-08-26: local **under-booked the ANF winner** (broker +$986.33 / +3.72R vs local
    +$619.50 / +2.34R), contributing to a **total local-vs-broker discrepancy of −$363.94**
    (local −931.66 vs broker −567.72).
  - 2026-08-27 (**most severe instance of the trial**): **FWDI** — broker sold the position
    down over ~2h26m but local ingested **none** of those exits, booking P&L on only **182 of
    2,711 shares** (local −$17.24 / −0.062R vs broker ≈ −$256.7 / −0.924R, an under-booked
    *loss*); plus **YYGH** — one 409-share t1 leg ingested of 798 (local +$32.92 / +0.311R vs
    broker ≈ +$71.8 / +0.678R, an under-booked *win*). Session total: local +$1,218.79 vs
    broker +$1,018.19 → **local overstated net by +$200.60**. Broker precision is tiered: the
    combined YYGH+FWDI figure (−$184.91) is exact via equity, the per-trade split is a bounded
    estimate, and FWDI's 2,529 un-ingested exit shares are **UNRESOLVED at fill level** (not
    individually priced). **FWDI's ~2h26m recognition lag is THIS issue (ingestion), NOT Issue 2
    (network)** — the EQ tape has 4,376 continuous FWDI observations at 2 s cadence across the
    lag, so connectivity was healthy.
- **Capacity/admission impact:** none directly; admission is entry-driven and entries
  ingest correctly.
- **Daily-loss-limit impact:** the daily-loss accounting is computed off local economics,
  so it **may diverge from broker truth** while an exit is under-booked. This is a
  reason the nightly reconciliation is mandatory.

**Evidence paths (path · sha256 · rows):**
- `~/.companion-paper-trades-2026-08-25.json` · `2d7ec7ff…3e7a` · 576 lines
- `~/.companion-paper-trades-2026-08-26.json` · `fc6ea10d…e1a7` · 5487 lines
- `~/.companion-paper-trades-2026-08-27.json` · `e1f2aff2…44a0f` · 9 trade objects (FWDI `manual_review`, YYGH `discrepancy`)
- `~/.companion-paper-events-2026-08-25.jsonl` · `b73614ad…acb78` · 79 lines
- `~/.companion-paper-events-2026-08-26.jsonl` · `23a725c5…6db0` · 55 lines
- `~/.companion-paper-events-2026-08-27.jsonl` · `23e486c0…6b34c` · 77 lines (FWDI `reconcile_qty_mismatch`/`reconcile_forced_flat`/`external_close_priced`; YYGH `reconcile_qty_mismatch`)
- Broker truth: Alpaca paper account activity + EOD equity anchor (reconciled EOD each session).

**Root cause.** Under-ingestion of a subset of broker exit partial fills when an exit
fragments into multiple fills; the local trade record closes on the fills it saw rather than
the full broker fill set.

**Mitigation (standing).** Nightly **broker-vs-local reconciliation** after every validation
session; broker figures are treated as authoritative and recorded alongside local in each
`SESSION_MANIFEST.md`.

**Deferred fix.** Repair deferred during the frozen trial (changing ingestion touches the
executor, which is CONTROL and must stay frozen). Tracked for post-trial work.

**Escalation criteria.** Escalate (and consider halting the session arm) if: broker
exposure is ever found unsafe; a discrepancy is large enough that the **daily-loss limit
would gate differently under broker truth than under local**; or the divergence stops
converging to broker truth at reconcile.

> **Do NOT associate HOWL's 3h22m delay with this issue.** That is Issue 2 (network outage),
> a distinct connectivity failure — not an exit-fill ingestion defect.

---

## ISSUE 2 — network-outage-recognition-delay

| Field | Value |
|---|---|
| **Issue ID** | `network-outage-recognition-delay` |
| **First observed** | 2026-08-26 (HOWL) |
| **Last observed** | 2026-08-26 |
| **Status** | OPEN — external cause; no code fix in scope for this trial |
| **Severity** | MEDIUM (operational; broker stayed safe) |
| **Category** | EXTERNAL NETWORK / CONNECTIVITY |

**Description.** On 2026-08-26, the HOWL broker **stop filled normally around 11:13 ET** and
the **broker position was flat and safe**. A **user-location Wi-Fi outage severed the local
daemon's connectivity to Alpaca**, so the local daemon could not refresh broker state. Local
state remained **stale** until connectivity returned; reconciliation observed the
**broker-flat truth at ≈ 14:35 ET**. The **≈ 3h22m** duration reflects the **network outage
duration** — **NOT intrinsic executor latency and NOT a broker-stop ingestion defect.**

- **Broker exposure impact:** none. The stop filled on time; the position was flat at the
  broker throughout the local blackout.
- **Local accounting impact:** the local slot/P&L state was stale for the outage duration;
  corrected at reconciliation.
- **Capacity/admission impact:** a stale local book can hold a slot occupied that the broker
  has already freed — **local capacity/slot release can lag** during a connectivity outage.
- **Daily-loss-limit impact:** while stale, local daily-loss accounting does not reflect the
  already-realized broker outcome until connectivity returns.

**Evidence paths:**
- `~/.companion-paper-trades-2026-08-26.json` · `fc6ea10d…e1a7` (HOWL lifecycle)
- `~/.companion-paper-events-2026-08-26.jsonl` · `23a725c5…6db0`
- Alpaca paper activity for HOWL (stop fill ≈ 11:13 ET); reconciliation timestamp ≈ 14:35 ET.

**Root cause.** User-location Wi-Fi outage severed local daemon → Alpaca connectivity. The
local laptop/network is a **single point of failure for timely broker-state recognition.**

**Mitigation (standing).** Nightly reconciliation catches the stale state and restores
broker truth. Operational awareness that recognition latency during an outage is bounded by
outage duration, not by the executor.

**Deferred fix / possible future mitigation.** Remote/VPS daemon, liveness monitoring, a
process supervisor, and a connectivity watchdog. **Not implemented within this task or this
trial.**

**Escalation criteria.** Escalate if an outage ever coincides with an **open, un-stopped**
position (exposure genuinely unknown locally), if outages recur frequently enough to
threaten session usability, or if a stale slot causes a real mis-admission.

---

## ISSUE 3 — execution-observer-launch-config

| Field | Value |
|---|---|
| **Issue ID** | `execution-observer-launch-config` |
| **First observed** | 2026-08-25 |
| **Last observed** | 2026-08-25 |
| **Status** | RESOLVED (configuration issue) |
| **Severity** | LOW |
| **Category** | LAUNCH CONFIGURATION / OBSERVABILITY |

**Description.** On 2026-08-25 the execution-quality observer produced no tape because
`EXEC_OBSERVER=1` was omitted from the daemon launch. No EQ review is possible for session 1.

- **Broker exposure impact:** none.
- **Local accounting impact:** none (observer is passive telemetry).
- **Capacity/admission impact:** none.
- **Daily-loss-limit impact:** none.

**Evidence paths:**
- Session 1: **no** `~/.companion-execution-quality-2026-08-25.jsonl` produced (absence is
  the evidence).
- Session 2: `~/.companion-execution-quality-2026-08-26.jsonl` · `efb574b7…a678` ·
  **20,136 rows** · 15,719,448 bytes — observer healthy after the fix.

**Root cause.** `EXEC_OBSERVER=1` not present in the daemon launch environment on 2026-08-25.

**Mitigation.** `EXEC_OBSERVER=1` persisted in `.env.local`.

**Resolution.** 2026-08-26: observer successfully produced **20,136 rows**. Resolved.

**Escalation criteria.** Re-open if an EQ tape is ever missing on a session where the
observer was expected (would indicate the persisted env var was lost).

---

## ISSUE 4 — decisions-log post-freeze append drift

| Field | Value |
|---|---|
| **Issue ID** | `decisions-log-postfreeze-append-drift` |
| **First observed** | 2026-08-27 |
| **Last observed** | 2026-08-27 |
| **Status** | RESOLVED for Session 3 (prefix preserved; daemon stopped) — **standing risk for future sessions** |
| **Severity** | LOW (integrity/observability; no impact on frozen analysis) |
| **Category** | ARTIFACT FREEZE / DAEMON LIFECYCLE |

**Description.** The live Mac `alert-daemon.ts` continued running afterhours on 2026-08-27 and
**appended 11 session-gated rows** to `~/.companion-decisions-2026-08-27.jsonl` (17:47–18:21 ET)
*after* the artifact freeze. The whole-file hash changed from the frozen
`826b136c…8393877` (316 rows) to `ac5063d8…3fc6` (327 rows).

- **Broker/accounting/capacity impact:** none. Appended rows are all `verdict=session`
  (session-gated), none admitted, none touching the 6 filled setups, the DIRECT_REMOVAL
  (`YYGH:break_of_structure:1.86`), or the REPLACEMENT (`CRWD:break_of_structure:206.70`).
- **Analysis impact:** none. **Prefix integrity PROVEN** — `head -n 316` of the drifted file
  hashes byte-for-byte to the frozen `826b136c…`; the frozen artifact survives intact as the
  exact prefix (append-only, no rewrite).

**Root cause.** The alert daemon has no EOD stop bound; it keeps emitting decision rows into the
day's file during afterhours as long as the process runs.

**Mitigation (this session).** Preserved operational snapshots
`data/research-cache/ops/decisions-2026-08-27-postfreeze-326rows.jsonl` and
`…-frozen-candidate.jsonl` (316 rows, `826b136c…`); stopped the Mac `alert-daemon.ts` chain
(PIDs 83402/83413/83414) at the operational cutoff **2026-08-27T22:23:16Z (18:23:16 ET)** and
verified the file stable. DigitalOcean services were **not** touched.

**Standing mitigation (future sessions).** Freeze/snapshot the decisions artifact at a defined
EOD cutoff (or stop the daemon) **before** computing its frozen hash, so future manifests cite a
stable whole-file hash rather than a prefix.

**Escalation criteria.** Escalate if a future decisions file is **not** an exact prefix of its
frozen hash (would indicate a rewrite, not an append), or if appended post-freeze rows are ever
found *admitted* (would contaminate the tradeable set).
