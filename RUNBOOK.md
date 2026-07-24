# Switchboard runbook

Operational procedures for the demo stack. Everything here is runnable on a clean
clone with Docker (colima or Docker Desktop) and Node ≥22.

## Environment

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | no code default — export it (scripts set it for you) | ingest, agent, CLIs |
| `WEBHOOK_SECRET_CRM` / `_BILLING` / `_SUPPORT` | `demo-secret-<source>` (demo only — set per environment; one secret **per source**, so a leaked secret compromises one source, not all) | mock signing, ingest verification |
| `LEDGER_HMAC_KEY` | `demo-ledger-key` (demo only — set per environment) | ledger writers (mocks), reconcile chain verification |
| `LEDGER_PATH` | no code default — export it (scripts set it for you) | each mock process (its own ledger file) |
| `LEDGER_PATH_CRM` / `_BILLING` / `_SUPPORT` | unset → that source is skipped by reconcile | reconcile CLI (per-source ledger lookup) |
| `INGEST_SOURCES` | `crm,billing,support` | which sources ingest polls/reconciles (scripts pin it explicitly) |
| `CRM_BASE_URL` / `BILLING_BASE_URL` / `SUPPORT_BASE_URL` | `http://localhost:4001` / `4003` / `4004` | backfill CLI |
| `INGEST_ROLE` | `all` (`receiver` \| `worker` \| `all`) | ingest main |
| `CHAOS_SEED` | `7` | chaos.sh fault-plan seed (CI feeds it as a workflow input; reproduce a red run by re-entering its seed) |
| `ANTHROPIC_API_KEY` | unset → deterministic report (risk table + watch list; a one-line notice replaces the AI narrative) | agent report |
| `DBT_SCHEMA` | `public_analytics` | agent, report worker |
| `DBT_PORT` | `5432` (CI sets `5433`) | dbt profile (host port of Postgres) |

## Start / stop

```bash
export DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard
docker compose up -d postgres            # DB (host port 5433)
npm run migrate -w ingest                # idempotent
PORT=4002 npm run start -w ingest        # receiver+worker+scheduled backfill, all sources
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm     LEDGER_PATH=./out/ledger-crm.jsonl     npm run start -w mocks/crm
PORT=4003 WEBHOOK_URL=http://localhost:4002/webhooks/billing LEDGER_PATH=./out/ledger-billing.jsonl npm run start -w mocks/billing
PORT=4004 WEBHOOK_URL=http://localhost:4002/webhooks/support LEDGER_PATH=./out/ledger-support.jsonl npm run start -w mocks/support
```
All mocks must share the same manifest seed (default 42) — divergent seeds break
cross-system identity correlation. Stop with SIGTERM — ingest drains gracefully
(HTTP closed, queues stopped, backfill interval cleared). `npm` may print a
cosmetic `npm error 143` on SIGTERM; harmless.

**Migration ordering note (viewless deploy window):** migration `003` CASCADE-drops
the legacy `raw.raw_crm_events` table *and* any dbt view still reading it. Between
`npm run migrate -w ingest` and the next `dbt build` those staging views don't
exist — always run migrate first, then build (the scripts already do). The views
are derived artifacts; the build recreates them.

## Proofs (run these before trusting anything)

```bash
./scripts/demo.sh    # end-to-end: 288 events, 3 sources → ledger=raw=outbox equality → identity oracle → report
./scripts/chaos.sh   # 600 events under seeded faults, all 3 sources → zero-loss reconciliation
```
Both are self-cleaning at start and fail loudly with counts on any mismatch.
`demo.sh` also runs `scripts/verify-identity.ts`, which set-compares the dbt
identity layer and `customer_360` against the seed manifest's planned match matrix.

## Recovery procedures

- **Webhook outage / dropped events:** nothing to do — the scheduled backfill
  poller recovers via per-source cursors. Manual catch-up:
  `npm run backfill -w ingest` — iterates every source in `INGEST_SOURCES`,
  printing `backfill[<source>]: ingested N event(s)` per source (exit 1 = one or
  more sources aborted after repeated upstream errors; state is consistent, the
  output names the resumable cursor; re-run to resume).
- **Poisoned/failed jobs:** each source has its own DLQ (`ingest-<source>-dlq`).
  `npm run replay -w ingest -- --list` prints total depth and per-job
  `source=... event_id=...` lines across all source DLQs;
  `npm run replay -w ingest` re-ingests (idempotent) and consumes. Processes up
  to 10 jobs per invocation (aggregated across all source DLQs) — repeat for
  deeper queues.
- **Malformed payloads:** rows sit in `ingest.quarantine` with reasons and their
  `source`; after a schema/mapping fix, replay via `replayQuarantined` (see
  `ingest/src/quarantine.ts`). Note: *unsigned* requests are rejected 401, never
  quarantined.
- **jsonb-unstorable payloads** (NUL escapes, lone UTF-16 surrogates, nesting
  depth > 1000): quarantined with `payload` null and the byte-exact wire text in
  `raw_body`. These are preserved-for-inspection — `replayQuarantined` reports
  them `still-invalid` by design (the event store is jsonb too). Check depth
  periodically: `select reason, count(*) from ingest.quarantine group by 1;` —
  nothing alerts on this table yet (tracked debt), so a growing count is only
  visible if someone looks.
- **Integrity doubt:** `npm run reconcile -w ingest` — for each source in
  `INGEST_SOURCES` with a `LEDGER_PATH_<SOURCE>` set, verifies that ledger's hash
  chain, then set-compares ledger vs `raw.raw_events where source = ...` and
  reports missing/extra/duplicates per source. Exit is nonzero if **any**
  reconciled source has discrepancies (sources without a ledger path are skipped
  and say so).
- **`manual_review` triage** (identity layer): rows in
  `public_analytics.manual_review` are external entities (billing customers,
  support requesters) that matched no CRM company — each row carries its
  `source`, `source_entity_id`, evidence, and `first_seen_at`. Flow: inspect the
  row and the source record → either fix the underlying data/mapping (e.g.
  correct a domain in the source system; the next dbt build re-resolves it and it
  stops being re-inserted) → or accept it as genuinely CRM-absent (it stays, and
  `customer_360` carries it flagged `is_complete = false`, never hidden).
  Disposition workflow (assign/resolve/dismiss) is a future-phase feature; the
  table is Switchboard operational state, not a system of record.

## Backup and restore

Backup = `pg_dump` of the database + copies of the three ledger files. Within
the demo's ledger-as-oracle model, the restore story is stronger than the
backup: because the ledgers (production analog: the source systems) are the
source of truth and ingestion is idempotent, **restore is replay** — an empty
database rebuilt by the backfill poller converges to the same state, which is
exactly what the chaos test demonstrates on every run.

**Production caveat:** that guarantee leans on a mock affordance — a complete,
replayable event history. Real vendors don't retain unbounded history (see
[real-connector delta](docs/real-connector-delta.md)): modified-since endpoints
have lookback limits, and a multi-year backfill must be scheduled within rate
budgets, not replayed in one pass. Production DR is therefore **pg backup as the
primary restore path, plus bounded vendor replay** to close the gap between the
backup timestamp and now — not unbounded ledger replay from empty.

## Common failures

| Symptom | Cause / fix |
|---|---|
| `docker: command not found` / daemon errors | colima not running: `colima start`; compose plugin registered via `~/.docker/config.json` `cliPluginsExtraDirs` |
| Ports 4001/4002/4003/4004/5433 busy | `lsof -ti:4001,4002,4003,4004 \| xargs kill`; another Postgres on 5433 → change compose mapping |
| demo/chaos FAIL with count mismatch | Worker not draining — check ingest logs; the scripts' bounded waits print both counts on timeout |
| 401 on every webhook for one source | `WEBHOOK_SECRET_<SOURCE>` mismatch between that mock and ingest environments (each source verifies with its own secret — check the right one) |
| Reconcile reports ledger hash chain broken but nothing was tampered with | `LEDGER_HMAC_KEY` mismatch between the mock (writer) and reconcile (verifier) environments — both must use the same key (default is fine for demo) |
| Reconcile prints `[<source>] skipped (no LEDGER_PATH_...)` | Export `LEDGER_PATH_<SOURCE>` pointing at that mock's ledger file (see demo.sh for the pattern) |
| Identity oracle FAILs after chaos.sh | Expected: marts are frozen tables over live staging views, and chaos truncates raw — re-run `demo.sh` (which rebuilds) before trusting mart state |
| Relation `stg_crm__companies` does not exist right after migrating | The viewless deploy window (see Start/stop) — run `dbt build` |
| Report generates with template banner | `ANTHROPIC_API_KEY` unset or LLM call failed — check the structured `llm` log line (fallback is by design; the report always generates) |
