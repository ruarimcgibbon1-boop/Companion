# EXECUTION-QUALITY REVIEW — Session 4 — 2026-08-28

- EQ tape: `~/.companion-execution-quality-2026-08-28.jsonl` (frozen `snapshot/execution-quality.jsonl`)
- sha256: `bcb4a9b4b13762c0b00e10cff7bcc7151bc40f3e258e98e87cdb622419890978`
- rows: **25,870** · bytes: 20,513,450
- Observer health: **HEALTHY-WITH-FINDINGS** — `EXEC_OBSERVER=1` active; 0 errors, 0 dropped; but heavy quote/trade staleness (below). Issue 3 stays resolved.

## Tape summary
- Coverage: **04:45:59 → 11:09:12 ET** (ends when the last active position closed — TE
  updatedAt 11:09:13 ET; EQ observes only open trades, so post-11:09 has nothing to observe).
- Symbols covered: **all 7 traded names.** Per-symbol windows/rows (skewed to the three
  premarket names): TE 11,489 (04:46→11:09), UMC 7,201 (05:40→09:40), AFRM 6,533 (06:09→09:47),
  PD 304 (10:57→11:07), PURR 263 (10:39→10:47), CHGA 74 (10:13→10:15), CYCU 6 (09:57, ~10 s).
- `quoteStatus` all `ok` → **0 quote errors**. `tradeStatus` all `ok` → **0 trade errors**.
- `observationDropped` all `false` → **0 dropped iterations**; 0 aborted observations.
- `executionPath`: polled 21,432 / broker_stop 4,438. `observedFeed`: alpaca-iex (all);
  `feedConsolidated=false`.

## Freshness — FINDING (heavy staleness)
| Freshness | Quote | Trade |
|---|---|---|
| fresh | 4,598 (17.77%) | 4,328 (16.73%) |
| stale | 21,256 (82.16%) | 21,497 (83.09%) |
| null / undefined | 16 (0.06%) | 45 (0.17%) |
| **total** | **25,870** | **25,870** |

**~82% of quote observations and ~83% of trade observations were stale.** Staleness is
concentrated in the premarket names that dominate the row count (TE/UMC/AFRM; premarket IEX
quote age is large — the first TE observation at 04:45 ET carried `quoteAgeMs ≈ 4.6e7`, ~12.7 h).
The feed is **IEX only** (`feedConsolidated=false`), a known data-quality limitation. This is
recorded as an **instrumentation / data-quality finding**; it is **not** claimed to have caused
any trade decision — CONTROL admission is entry-driven and every stop ultimately executed at the
broker at ≈ −1R.

## Breach evidence
- `observedBreach=true`: **472** (of 25,870); 25,398 false. No breach is asserted on a null or
  stale observation as stop evidence. Broker-native stops trigger on trade prints, not the
  observer's bid; the observer is telemetry only.

## Latency — two distinct sub-latencies (not conflated)
The artifacts provide observer poll cadence and `observedAt`, but the `monitorRequestStartTs` /
`monitorResponseTs` pair was **not both populated**, so an independent poll round-trip latency is
**UNKNOWN** this session. For cleanly-filled trades the broker-fill instant and the local
recognition instant **cannot be separated**.

- **CYCU — measurable broker-vs-local timestamp anomaly.** The broker exit (sell 2188 @4.13) is
  stamped **13:57:15Z (09:57:15 ET)**, ~**35 s before** the local entry-fill recognition
  **13:57:50Z (09:57:50 ET)** — an ordering inversion for a near-instant enter-and-stop trade
  (EQ covered CYCU for only ~10 s / 6 rows). This is **suggestive of local-recognition lag** on a
  fast trade, but its precise magnitude is **UNKNOWN** (holding duration ≠ recognition latency;
  the two are not conflated). P&L still reconciles exactly (local == broker −$262.56), so this is
  a timestamp/recognition finding, not an economic one.

## Partial-exit ingestion check (Issue 1) — RECURRENCE (TE / UMC / PURR)
Confirmed at fill level from the broker ledger against the frozen trades:

- **TE** — entry 512; local `exits` booked **one 46-share stop leg** (P&L −$6.90); broker filled
  all 512 in 2 sells (46@4.88 + 466@4.87 = −$81.46). Trade note: *"broker flat but local held
  466 — closed by an unrecorded/external order"*; `reconciliationStatus=manual_review`.
  **Under-booked loss ≈ $74.56 / ≈ 0.97R.**
- **UMC** — entry 739; local booked **244** (243 stop + 1 external) at P&L −$168.29; broker
  filled 739 across 6 fills / 2 orders (−$487.29). Warnings: *"qty mismatch … adopting broker"*
  ×3, then *"broker flat but local held 1 …"*. **Under-booked loss ≈ $319.00 / ≈ 0.69R.**
- **PURR** — entry 1312; local booked **1197** (P&L −$227.43); broker 1312 across 5 fills
  (−$249.58). Warning: *"qty mismatch: local 115, broker 30 — adopting broker"*, then *"broker
  flat but local held 30 …"*. **Under-booked loss ≈ $22.15 / ≈ 0.10R.**

AFRM, CYCU, PD reconcile exactly (single clean stop); **CHGA** fragmented into 4 broker fills but
the aggregate VWAP matches local (rounding −$0.05), so it is **not** an under-booking.
Session total local −$1,929.21 vs broker −$2,344.97 → **local understated the loss by +$415.76**.
This is Issue 1 (ingestion), **not** Issue 2 (network) — the EQ tape shows continuous coverage
during each trade's life; connectivity was healthy. See
[ISSUE_LEDGER §1](../ISSUE_LEDGER.md#issue-1--partial-exit-fill-ingestion).

## Post-signal & post-exit excursion — REVIEW-ONLY diagnostic (outside the frozen criterion)
Full same-day excursion per **filled** signal, plus the post-terminal-exit path. **Does not
affect PASS/FAIL of the off-high hypothesis and is not used to tune the threshold, stops, or
targets.** Window: signal → 16:00 ET (not truncated at our exit); anchor: decision-time
`entryRef`; `riskPerShare = entryRef − originalStop`; all 7 riskPerShare > 0 (no UNKNOWN
normalization). Terminal exit = the broker fill at which position qty hit 0. Tape provenance:
CHGA/CYCU/PD/PURR/TE fetched fresh 2026-08-29; AFRM/UMC `cache-existing-legacy` (fetchedAt=null).

**Coverage:** signal — **7 / 7 filled tickers**; all 17 enumerated symbols have 1-min tape.

| Ticker | Setup | Entry ET | Term ET | Exit type | Frozen R | Broker R | Sig MFE_R | Sig MAE_R | Post-Hi | Post-Lo | Post MFE_R | Post MAE_R | Reclaim entry? | T1 after? | Final after? | min→reclaim | min→T1 | min→final | Label |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TE | BoS | 04:46 | 11:08 | stop (2 frag) | −0.089 | −1.054 | +0.79 | −2.27 | 4.88 | 4.66 | −0.81 | −2.27 | No | No | No | — | — | — | STOP_AND_CONTINUED_LOWER |
| UMC | BoS | 05:40 | 09:40 | stop (6 frag) | −0.364 | −1.055 | +0.65 | −1.93 | 20.42 | 19.59 | −0.60 | −1.93 | No | No | No | — | — | — | STOP_AND_CONTINUED_LOWER |
| AFRM | hod_break | 06:09 | 09:46 | stop | −1.062 | −1.062 | +1.18 | −3.70 | 86.01 | 77.60 | −0.49 | −3.70 | No | UNKNOWN¹ | UNKNOWN¹ | — | — | — | STOP_AND_CONTINUED_LOWER |
| CYCU | BoS | 09:57 | 09:57² | stop | −1.078 | −1.078 | +0.18 | −5.48 | 4.27 | 3.64 | +0.18 | −5.48 | **Yes** | No | No | 28 | — | — | STOP_AND_CONTINUED_LOWER (brief +0.18R reclaim) |
| **CHGA** | ORB | 10:13 | 10:14 | stop (4 frag) | −1.046 | −1.046 | **+17.22** | −1.19 | **0.2358** | 0.1370 | **+17.22** | −1.19 | **Yes** | **Yes** | **Yes** | 3 | 23 | 24 | **STOP_THEN_RAN_TO_FINAL_TARGET** |
| PURR | ORB | 10:39 | 10:47 | stop (5 frag) | −0.978 | −1.073 | +0.05 | −10.81 | 13.76 | 11.57 | −0.24 | −10.81 | No | No | No | — | — | — | STOP_AND_CONTINUED_LOWER |
| PD | BoS | 10:57 | 11:07 | stop | −1.096 | −1.096 | +0.08 | −3.03 | 13.91 | 13.50 | −1.10 | −3.03 | No | UNKNOWN¹ | UNKNOWN¹ | — | — | — | STOP_AND_CONTINUED_LOWER |

¹ AFRM & PD have **empty target arrays** in the signal → T1 / final-target-after-exit are
UNKNOWN. ² CYCU broker exit is stamped ~35 s **before** the local entry fill (timestamp anomaly
above); P&L still reconciles exactly — treat CYCU's fine-grained post-exit timing as
lower-confidence. All post-exit R values are normalized on **original** signal risk, not a moved
stop, and no excursion is truncated at our actual exit.

**Capture efficiency (realizedR / MFE_R):** **0 / 7 positive.** Every trade stopped for a loss
while showing positive favorable excursion → efficiency is not meaningful on a 0-win day.

**Portfolio-level (n = 7 — too small for inference):**
- Median signal MFE_R **+0.65**; median signal MAE_R **−3.03**.
- Stopped **7**; later reclaimed entry **2** (CYCU, CHGA); later reached T1 **1** (CHGA); later
  reached final target **1** (CHGA); continued materially lower (post-exit MAE ≤ −2R) **5**
  (TE, AFRM, CYCU, PURR, PD; UMC borderline −1.93R).
- Profitable terminal exits **0** → all "continuation after profit" counts = 0.
- Post-exit MFE_R median **−0.49**, mean **+2.02** (mean driven entirely by CHGA +17.2R);
  post-exit MAE_R median **−3.03**.

**Descriptive observations only (no stop/target/re-entry recommendation):** the single trade the
off-high rule removed (CHGA) is the only one that ran after its stop, all the way through its
original final target; the six retained trades stopped and mostly deteriorated further. This is a
one-session, seven-trade observation and must not be converted into a rule.

## Note
This EQ review documents observation; **no code change is made** (executor is CONTROL and
frozen). Ingestion repair is deferred (Issue 1). Standing mitigation — nightly broker-vs-local
reconciliation — captured all three Session-4 divergences.
