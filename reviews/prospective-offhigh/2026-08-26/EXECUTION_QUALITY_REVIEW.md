# EXECUTION-QUALITY REVIEW — Session 2 — 2026-08-26

- EQ tape: `~/.companion-execution-quality-2026-08-26.jsonl`
- sha256: `efb574b7283157a27d23528f8fb7f3fc08f74cd37faf9ed1d4fadb5df254a678`
- rows: **20,136** · bytes: 15,719,448
- Observer health: **HEALTHY** — first session with `EXEC_OBSERVER=1` active (Issue 3
  resolved). The observer produced a full, continuous tape.

## Findings
The observer captured a complete execution-quality tape for the session (20,136 rows),
covering the 6 filled trades' order lifecycle. This is the first EQ dataset in the trial and
establishes the baseline for per-session EQ comparison from here forward.

## Partial-exit ingestion check (Issue 1)
- **ANF** shows the session's fragmented-exit signature: **broker +$986.33 / +3.72R** vs
  **local +$619.50 / +2.34R**. The local process under-booked the winner on fragmented exit
  fills — a **$366.83 gross under-book on ANF alone**, the dominant contributor to the
  session's −$363.94 local-vs-broker gap. Entry ingested correctly; the divergence is on the
  exit side, consistent with Issue 1.
- The EQ tape corroborates the reconciliation finding: the exit fragmentation is visible in
  the fill stream, while local trade closure recorded a subset. Broker is authoritative.

## Note
This EQ review documents the observation; **no code change is made** (executor is CONTROL and
frozen). Ingestion repair is deferred (Issue 1). The standing mitigation — nightly
broker-vs-local reconciliation — captured the divergence.
