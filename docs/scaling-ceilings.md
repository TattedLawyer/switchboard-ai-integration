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

## 2. Full dbt rebuilds — and mart freshness

`dbt build` rebuilds every model from all raw events (seconds now; grows linearly
with event history). **Fix:** incremental models keyed on `received_at`/event id —
the standard dbt pattern — plus event-table partitioning by month when raw grows
past what a full scan tolerates.

The same ceiling has a **freshness** face: `customer_360` is a frozen dbt *table*
built over live staging *views*, so it reflects raw events only as of its last
build. In the demo and CI that is invisible — every run rebuilds the marts before
reading them — but under continuous ingestion the mart goes stale the moment new
events land, and nothing in the current system schedules a rebuild (there is no
orchestrator, and the mart carries no build-timestamp column to even measure the
lag). Production needs incremental mart models plus scheduled orchestration
(cron-triggered `dbt build` at minimum; a scheduler/orchestrator as volume grows)
and a freshness check so staleness is monitored rather than discovered.

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

## 4b. Two ceilings this doc previously omitted (added after the 2026-07 external audit)

- **`reconcile()` is unbounded in memory:** it loads the full event-id set for a
  source (no LIMIT) and parses the entire ledger into memory. The headline
  reliability proof OOMs before the ledger-file ceiling in §3 bites. Fix shape:
  stream the ledger and compare in sorted batches — Phase 2b/4, alongside the
  connector rework that replaces the ledger oracle anyway.
- **~~`ingest.outbox` grows forever and has no consumer~~ (paid, debt-burn
  B10):** renamed to `ingest.ingest_journal` (migration 011) — an
  in-transaction ingest audit row, not a transactional outbox (no relay or
  consumer exists; pg-boss provides the durability) — with a 30-day TTL
  enforced on insert, so the unbounded-growth ceiling is gone. Every staging
  model is still a full scan over `raw_events` with only the
  `(source, event_id)` unique index behind it; at real volume the fix is
  incremental materializations plus a `(source, event_type)` index, not more
  views.

## 5. Build-vs-buy escalation points

The hand-built reliability spine exists to demonstrate understanding, and the ADR
line holds at scale: past roughly "one team's integration volume," orchestration
moves to a durable-execution engine (Temporal-class) and transformation to a
warehouse-native stack. The point is knowing precisely where that line
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
