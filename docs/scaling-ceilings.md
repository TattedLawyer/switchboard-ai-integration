# Scaling ceilings: where this architecture breaks, in order

Honest engineering means knowing the failure order before anyone asks. These are
the ceilings as built, each with its measured-or-reasoned trigger and the standard
fix. Demo-scale numbers come from this repo's own runs; everything else is design
reasoning, not benchmark data.

## 1. The per-account report loop (first to break)

`generateMondayReport` calls the MCP tool once per company and inlines every
snapshot into a single LLM prompt. Fine at 20 accounts; breaks on context size and
latency somewhere in the hundreds. **Fix:** risk scoring moves into SQL (a ranked
mart), the LLM narrates only the top-N with the full table linked beneath — which
also caps cost per report regardless of account count.

## 2. Full dbt rebuilds

`dbt build` rebuilds every model from all raw events (seconds now; grows linearly
with event history). **Fix:** incremental models keyed on `received_at`/event id —
the standard dbt pattern — plus event-table partitioning by month when raw grows
past what a full scan tolerates.

## 3. Ledger mechanics (mock-only ceiling)

The mock's ledger reads the whole JSONL file per append (last-hash lookup) and per
/events page — O(n) on file size, single-process by assumption. Irrelevant in
production (real vendors are the source; the ledger is a test oracle), but stated
so nobody mistakes the harness for a production event store.

## 4. Single Postgres

One instance carries queue, raw store, and marts. Order of relief: read replica for
the analytics/MCP read path → raw-table partitioning → dedicated warehouse for
Layer 2 (dbt targets swap cleanly) with Postgres retained for queue + OLTP. pg-boss
rides the OLTP instance comfortably until job volume says otherwise.

## 5. Build-vs-buy escalation points

The hand-built reliability spine exists to demonstrate understanding, and the ADR
line holds at scale: past roughly "one team's integration volume," orchestration
moves to a durable-execution engine (Temporal-class) and transformation to a
warehouse-native stack. The portfolio point is knowing precisely where that line
sits and what the tools replace.

## The caching question (asked directly, answered directly)

This architecture needs no bolt-on cache layer, because its caches are already
structural: **dbt materializations are the query cache** (the scaling move is
view → table/incremental, not Redis); **the generated report artifact is the
LLM-output cache** (consumers read the file, never regenerate); **prompt caching is
enabled** in the LLM client. At real-vendor scale, cache OAuth tokens until expiry —
but never cache vendor list responses (cursored incremental fetch is strictly
better and can't serve stale records), and never cache anything on the ingest
write path, where idempotency and the ledger are correctness mechanisms a cache
would undermine. A second cache in front of dbt would create two staleness layers
with no single owner — the classic source of "the dashboard disagrees with the
report" incidents.
