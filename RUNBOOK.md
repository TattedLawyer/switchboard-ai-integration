# Switchboard runbook

Operational procedures for the demo stack. Everything here is runnable on a clean
clone with Docker (colima or Docker Desktop) and Node ≥22.

## Environment

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | no code default — export it (scripts set it for you) | ingest, agent, CLIs |
| `WEBHOOK_SECRET` | `demo-secret` (demo only — set per environment) | mock signing, ingest verification |
| `LEDGER_PATH` | no code default — export it (scripts set it for you) | mock, reconcile |
| `CRM_BASE_URL` | `http://localhost:4001` | backfill CLI |
| `INGEST_ROLE` | `all` (`receiver` \| `worker` \| `all`) | ingest main |
| `ANTHROPIC_API_KEY` | unset → deterministic template narrative | agent report |
| `DBT_SCHEMA` | `public_analytics` | agent, report worker |

## Start / stop

```bash
export DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard
docker compose up -d postgres            # DB (host port 5433)
npm run migrate -w ingest                # idempotent
PORT=4002 npm run start -w ingest        # receiver+worker+scheduled backfill
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm npm run start -w mocks/crm
```
Stop with SIGTERM — ingest drains gracefully (HTTP closed, queue stopped, backfill
interval cleared). `npm` may print a cosmetic `npm error 143` on SIGTERM; harmless.

## Proofs (run these before trusting anything)

```bash
./scripts/demo.sh    # end-to-end: 50 events → ledger=raw=outbox equality → report (~15s)
./scripts/chaos.sh   # 200 events under seeded faults → zero-loss reconciliation (~20s)
```
Both are self-cleaning at start and fail loudly with counts on any mismatch.

## Recovery procedures

- **Webhook outage / dropped events:** nothing to do — the scheduled backfill
  poller recovers via cursor. Manual catch-up: `npm run backfill -w ingest`
  (exit 1 = aborted after repeated upstream errors; state is consistent, output
  names the cursor; re-run to resume).
- **Poisoned/failed jobs:** `npm run replay -w ingest -- --list` to inspect the
  dead-letter queue; `npm run replay -w ingest` to re-ingest (idempotent) and
  consume. Processes up to 10 jobs per invocation — repeat for deeper queues.
- **Malformed payloads:** rows sit in `ingest.quarantine` with reasons; after a
  schema/mapping fix, replay via `replayQuarantined` (see `ingest/src/quarantine.ts`).
  Note: *unsigned* requests are rejected 401, never quarantined.
- **Integrity doubt:** `LEDGER_PATH=./out/ledger.jsonl npm run reconcile -w ingest` —
  verifies the ledger hash chain, then set-compares ledger vs raw and reports
  missing/extra/duplicates.

## Backup and restore

Backup = `pg_dump` of the database + a copy of the ledger file. The architecture's
restore story is stronger than the backup: because the ledger (production analog: the
source systems) is the source of truth and ingestion is idempotent, **restore is
replay** — an empty database rebuilt by the backfill poller converges to the same
state, which is exactly what the chaos test demonstrates on every run.

## Common failures

| Symptom | Cause / fix |
|---|---|
| `docker: command not found` / daemon errors | colima not running: `colima start`; compose plugin registered via `~/.docker/config.json` `cliPluginsExtraDirs` |
| Ports 4001/4002/5433 busy | `lsof -ti:4001,4002 \| xargs kill`; another Postgres on 5433 → change compose mapping |
| demo/chaos FAIL with count mismatch | Worker not draining — check ingest logs; the scripts' bounded waits print both counts on timeout |
| 401 on every webhook | `WEBHOOK_SECRET` mismatch between mock and ingest environments |
| Report generates with template banner | `ANTHROPIC_API_KEY` unset or LLM call failed — check the structured `llm` log line (fallback is by design; the report always generates) |
