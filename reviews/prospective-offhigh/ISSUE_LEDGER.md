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
| **Last observed** | 2026-08-26 |
| **Status** | OPEN — fix DEFERRED during the frozen trial |
| **Severity** | MEDIUM |
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
- **Capacity/admission impact:** none directly; admission is entry-driven and entries
  ingest correctly.
- **Daily-loss-limit impact:** the daily-loss accounting is computed off local economics,
  so it **may diverge from broker truth** while an exit is under-booked. This is a
  reason the nightly reconciliation is mandatory.

**Evidence paths (path · sha256 · rows):**
- `~/.companion-paper-trades-2026-08-25.json` · `2d7ec7ff…3e7a` · 576 lines
- `~/.companion-paper-trades-2026-08-26.json` · `fc6ea10d…e1a7` · 5487 lines
- `~/.companion-paper-events-2026-08-25.jsonl` · `b73614ad…acb78` · 79 lines
- `~/.companion-paper-events-2026-08-26.jsonl` · `23a725c5…6db0` · 55 lines
- Broker truth: Alpaca paper account activity (reconciled EOD each session).

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
