# Preregistration: "Where Do Movers Get Lost?"

Status: **FINAL — FROZEN**. Collection has **NOT** started. No collection-start
marker exists. This document is the frozen scientific reference for
`universe-capture-epoch-1`; none of the definitions below may be altered once
collection begins.

## Study identity

- **specVersion**: `v1-universe-capture-1`
- **epoch**: `universe-capture-epoch-1`
- **schemaVersion** (code): `1` (`UNIVERSE_JOURNAL_SCHEMA_VERSION`, `src/lib/research/universe-journal.ts`)
- **observerVersion** (code): `universe-capture-v1` (`UNIVERSE_OBSERVER_VERSION`, same file)
- **Marker path**: `~/.companion-universe-capture/universe-capture-epoch-1.collection-start.json` (not yet created)

## Primary research question

"When stocks later become major movers, where in Companion's discovery
pipeline were they first seen or lost?" Five causal layers are kept
structurally distinct throughout and never collapsed:

A. GAINERS ROUTE UNIVERSE
B. DAEMON EXECUTION UNIVERSE
C. MONITOR
D. SETUP
E. BASE DECISION

## Reference mover set

For each ET trading session: rank all eligible symbol-days by

```
adjustedChangePct = (adjustedClose_t / adjustedClose_t-1 - 1) * 100
```

descending. Eligibility (verified directly against the live
`src/app/api/gainers/route.ts`):

- Exchange ∈ {NASDAQ, NYSE, AMEX}
- `isExcluded(name, symbol, exchange)` is `false`, using the exact production
  rule: `EXCLUDED_TERMS` substring match on name; OR `/[WRU]$/` suffix with
  `symbol.length > 4`; OR exchange ∈ {CRYPTO, FOREX, COMMODITY}
- A valid adjusted previous-session close exists
- A valid adjusted current-session close exists
- **No EOD price floor. No EOD volume floor.**

The first 20 eligible symbol-days by this ranking are the frozen reference
mover set for that session.

**Tie rule**: verified against the historical Sep-21 reconstruction
methodology (`reviews/sep21-reconstruction/replay-config.json` and
`REPORT.md`, stash commit `8c653fd`) — no deterministic tie-handling was
documented there. Frozen now, per the preferred fallback:
`adjustedChangePct DESC, then symbol ASC`. Not changeable once collection
starts.

**Reference source**: **NOT yet vendor-locked.** The ex-post reference source
must supply, for the complete eligible universe, per trading date: symbol,
adjusted current close, adjusted previous-session close, and the
exchange/security metadata required by the frozen exclusions above. The same
source/methodology configuration must be used consistently across the whole
epoch, and must be frozen **before** the first ex-post reference-mover
calculation is ever run — it may not be selected or changed based on observed
study results. The vendor is an implementation detail, never part of the
scientific mover definition. (No Polygon grouped-daily endpoint exists
anywhere in this repo's tracked history; the only demonstrated working
ex-post EOD source is FMP's per-symbol `/historical-price-eod/full` — cited
as evidence of feasibility only, not as a binding choice.)

## Unit of analysis

- **Primary unit**: reference-mover symbol-day.
- **Supporting units**: trading session, sweep, symbol-day.
- Repeated same-session observations of a symbol collapse to one
  reference-mover symbol-day for Route Recall / Daemon Retention. Re-entry
  (leaving and re-entering the universe within a session) remains fully
  visible in the raw causal sweep timeline for exploratory analysis, never
  collapsed away.

## Primary metrics (frozen)

1. **Route Recall** — fraction of reference-mover symbol-days observed at
   least once in the `/api/gainers` route universe.
2. **Daemon Retention** — among route-observed reference movers, the fraction
   admitted at least once to the daemon execution universe.
3. **Daemon Admission Delay** = `daemonFirstEnteredAt - routeFirstSeenAt`.
   Isolates the daemon rerank/top-N stage specifically. `routeFirstSeenAt`
   and `daemonFirstEnteredAt` are also retained separately as primary
   descriptive timestamps. No "move start" timestamp is ever invented —
   both anchors are real, causally-observed schema fields.
4. **Rerank Loss** — reference movers observed by the route but **never**
   admitted to the daemon execution universe for the entire session. A stock
   initially excluded but later admitted counts as Admission Delay (#3), not
   Rerank Loss.
5. **Eventual Downstream Disposition** — for daemon-admitted reference
   movers, classify the session by precedence `TAKE > VETO > NO_TRIGGER >
   UNAVAILABLE`. Answers "did the stack eventually convert the mover," not
   first-contact behavior (exploratory only, see below). Raw sweep-level
   history remains available for that separate analysis.

## Three-way loss attribution (mutually exclusive, exhaustive)

- **Upstream discovery failure**: the reference mover never appeared in the
  route universe at all.
- **Daemon rerank loss**: appeared in the route universe, but was never
  admitted to the daemon execution universe, for the whole session.
- **Downstream loss**: reached the daemon execution universe but Eventual
  Downstream Disposition never resolved to TAKE.

Temporary daemon exclusion followed by later admission is **never** treated
as loss of any kind — it is Daemon Admission Delay.

## Sample minimum (frozen, not tunable after collection begins)

- **≥ 20 complete trading sessions**, AND
- **≥ 300 scorable reference-mover symbol-days**

Both conditions must be satisfied before any inferential conclusion is drawn.

## Partial / torn sweep rule

A surviving positive observation from a partial/torn sweep may count as
evidence that a symbol **was** seen. A partial/torn sweep may **never** be
used as evidence that a symbol was absent. It therefore cannot, by itself,
establish `firstAbsentObservedAt`, Upstream Discovery Failure, or Daemon
Rerank Loss — absence for those must be confirmed by a complete sweep
(`sweepCompleteness()` reporting `complete: true`).

## Timing / cache semantics

Use only the actual observed `routeComputedAt` / `sweepObservedAt` /
`snapshotAgeMs` fields per sweep. No fixed or estimated stale-sweep
percentage is assumed or preregistered anywhere in this design. For
disappearance, use only `lastSeenAt` / `firstAbsentObservedAt` — no exact
exit timestamp between sweeps is ever claimed.

## Secondary / exploratory metrics — never a primary-study redefinition

- Route momentum rank vs. daemon raw-`changePct` rank disagreement
- Rank trajectory over a symbol's time in the universe
- Time spent inside vs. outside the daemon top-15
- Snapshot-age distribution (aggregate `snapshotAgeMs`)
- First-contact downstream behavior (as distinct from Eventual Disposition)
- UI universe comparison (out of scope for this capture layer entirely)
- Mike universe comparison (out of scope for this capture layer entirely)

No exploratory finding may redefine any primary metric, the sample minimum,
the loss-attribution rule, or the reference mover set after collection
starts.

## Activation requirements

Collection may not begin until, in order:

1. The discovery-capture implementation is committed (this document is
   committed alongside it).
2. The producer SHA is known.
3. `schemaVersion` / `observerVersion` are frozen at `1` / `universe-capture-v1`.
4. This preregistration is finalized (this document).
5. The final frozen producer branch (`research/universe-capture-epoch1`) is
   known and pinned to that exact commit.
6. The collection-start marker is created with O_EXCL/create-new semantics
   at the path above.

`research/quality-only-shadow-epoch1` (QUALITY_ONLY epoch 1) remains
untouched, active, and frozen on its own producer SHA throughout all of the
above — this study is entirely independent of it.
