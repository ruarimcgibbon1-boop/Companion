# Replay fidelity

How the historical replay is kept fast, deterministic, and production-faithful, so
research done on it transfers to live. This is the map for anyone (human or a
research agent) running experiments.

## One decision engine

There is exactly one implementation of every strategy decision, and every surface
imports it:

| Concern | Single source | Imported by |
|---|---|---|
| Setup detection, scoring, all detector gates (anti-fade, acceptance, space, leg-maturity, quarantine) | `src/lib/setup-detectors.ts` | monitor route, `replay-day.ts` |
| Technicals / session levels (clock-injectable via `nowTs`) | `src/lib/technical.ts` | monitor route, `replay-day.ts` |
| Key levels | `src/lib/levels-engine.ts` | monitor route, `replay-day.ts` |
| **BUY/drop gate stack** (`classifyBuy`, `passesTrackingFloor`, all gate constants) | `src/lib/buy-log.ts` | `useMonitor` (live), `alert-daemon` (live), `backtest`, `diagnose`, `recall` |
| Bar-by-bar replay walk | `src/lib/replay-day.ts` | `backtest`, `recall` (and `diagnose`) |
| Outcome resolution + scaled P/L | `src/lib/eod-resolver.ts` | live EOD backfill, `backtest` |

The live client (`useMonitor`) and the replay (`backtest`) previously each kept a
private copy of the gate stack; those mirrors are gone. **Same setup + same
timestamp + same prior context ⇒ same verdict in live and replay**, because it is
the same function call. `tests/buy-log.test.ts` pins the verdicts, including the
win/loss-cap and failed-bounce stand-down paths that live and the backtest exercise
(and that the daemon/recall deliberately stub with `[]`).

One deliberate fidelity correction rode along with the consolidation: the replay's
per-symbol cap now defaults to the **production** value (`MAX_LOGS_PER_SYMBOL = 2`),
not the old replay-only `Infinity`. Override it the same way live can.

## Choosing days — `BACKTEST_DAYS`

```
BACKTEST_DAYS=2026-07-14                        # one day
BACKTEST_DAYS=2026-07-06,2026-07-14,2026-07-31  # a few
BACKTEST_DAYS=2026-07-06:2026-07-10             # an inclusive range
# (unset)                                        # the full research window (July)
```

## Offline / deterministic — `OFFLINE=1`

`OFFLINE=1` replays only tape already on disk (fixtures + research cache); it never
touches the network, so re-runs are deterministic and can't be rate-limited. Two
cache tiers:

1. **`tests/fixtures/replay-tape/`** — small, committed, deterministic. One
   symbol-day (`BATL 2026-07-07`) backs `tests/replay-day.test.ts`.
2. **research cache** — large, local only, **gitignored** (`FMP_CACHE_DIR`, default
   under the scratch dir; `data/research-cache/` is ignored if you point it there).

Reads consult fixtures first, then the research cache; writes only ever go to the
research cache, so the committed set stays minimal. Network fetch is the fallback
when a key is absent from both and `OFFLINE` is off.

## Timeframe — `TIMEFRAME=1m|5m`

Both timeframes run the **same** production pipeline; they differ only in the tape
they see and the simulated bar-close clock (`replayDay`'s `barSeconds`). There is no
parallel simplified strategy. 1m and 5m tapes use distinct cache-key prefixes
(`m1_`, `m5_`) so they never collide.

## Research vs held-out validation (`src/lib/research-window.ts`)

- **Research / development:** July 2026 — optimise freely here.
- **Held-out validation:** August 2026 — untouched until a candidate is already
  chosen on July. Selecting an August day is refused unless `VALIDATE=1` and a
  `VALIDATION_NOTE` are set, and the use is appended to `data/validation-ledger.json`
  so August can never quietly become training data.

## Runtime

The replay walk re-runs the pipeline on a growing candle history each bar. Profiling
showed the cost was **not** the indicator math or the detectors (`keyLevels` 0.1%,
`detect` 0.0%) — it was **timezone conversion**: `etHHMM` / `isWeekendET` /
`etDayKey` each built a fresh `Intl.DateTimeFormat` and called `.format()`, and the
per-candle `isPremarket`/`isRegularHours` filters plus the per-bar `todayVol` filter
invoked them on every candle of every bar → O(bars²) Intl formats.

The fix was pure memoisation (reuse one formatter each + cache results per instant,
in `market-hours.ts` and `replay-day.ts`). These are deterministic functions of the
timestamp, so **identical inputs give identical outputs** — no boundary, detector, or
gate verdict moves. Measured on `BATL 2026-07-07`:

| timeframe | bars | before | after | speedup |
|---|--:|--:|--:|--:|
| 5m | 143 | 7.3 s | 0.1 s | ~73× |
| 1m | 662 | 244.7 s | 0.5 s | ~489× |

Trigger/logged counts were unchanged across the change (5m 7/1, 1m 23/0). Full-July
**5m offline dropped from ~35–40 min to ~12 s**; a single-day **1m backtest from
~74 min to ~7 s**. Full-window 1m is now compute-practical (~2–3 min offline); the
only remaining 1m cost is the **one-time fetch of 1-minute tape** (network,
rate-limited), after which `OFFLINE` runs are fast and deterministic.

The walk is still asymptotically O(bars²) in plain array work (each bar re-slices and
re-scans `soFar`), but with the Intl constant removed that term is now negligible at
these sizes. If it ever bites at larger scale, the next step is incremental session
state (running VWAP / session hi-lo / EMA) rather than re-scanning — deferred until
measurement shows it's needed.

## 1m vs 5m is a different book, not a finer view of the same one

Same day, same 18-name universe (2026-07-07), production strategy unchanged:

| | triggers | logged | signals | outcome |
|---|--:|--:|---|---|
| 5m | 41 | 2 | BATL ORB, JLHL ORB | 2W (+21.2%) |
| 1m | 123 | 4 | SKIN BOS, CLRO ORB, SKIN ORB, SKYQ ORB | 1W / 3L (−2.7%) |

The two logged sets **do not overlap at all** — 1m fires 3× the triggers, faces
very different gate pressure (veto/grade drops 37→78, volume 0→7, cap 0→3), and ends
up taking entirely different trades at different prices. The outcome column is n=2
vs n=4 (noise — do not read "5m wins"); the robust, decision-relevant finding is the
**structural divergence**: which trades exist and which clear the gates depends on
the bar width. This is exactly why the entry-timing thesis (knowledge C3, rejected
on 5m) must be retested on 1m — the 5m replay cannot see the trades the live 1-minute
scanner actually takes.

## The verified 5m baseline (new engine)

The consolidated engine reproduces the pre-consolidation book bit-for-bit. On the
five days whose tape is fully cached-or-fetched, the new engine and the old produced
the identical 34 signals (day, symbol, setup, time, outcome, P/L). Full-window July
5m baseline: **85 signals, 38% win, mean +0.73R, median −1.03R, net +60.9R, max
drawdown −22.5R** (cap-2, cull on) — the number every future experiment is measured
against.

## Current provenance (2026-08-22)

The committed shared-engine research harness is: **`6b6e0bc`** (replay
infrastructure — memoized ET + deterministic fixtures + `barSeconds`), **`99e0e8a`**
(held-out validation harness — `research-window`, `guardHeldOut`, the shared
`replayDay`/`classifyBuy` backtest), **`7a62166`** (post-T1 breakeven research
A/B lever, default unchanged).

Strategy artifacts produced **before 2026-08-22** are HISTORICAL until re-verified
under this engine. In particular **`data/JULY_2026_1M_BASELINE-signals.csv` is
UNPROVEN against the committed engine and is intentionally NOT committed** as the
current canonical baseline — the "verified 5m baseline" above rests on a 5-day/34-signal
parity check, not the full 1-minute book. To make it canonical: reacquire the July
1m tape, run the committed shared engine, diff against the historical CSV, explain
any difference, and only then promote the regenerated artifact.
