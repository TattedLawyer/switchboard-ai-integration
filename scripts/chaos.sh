#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
# This script exercises the crm source only; billing/support arrive with their mocks (Tasks 6/7).
export INGEST_SOURCES=crm
# Absolute path (not spec's relative ./out/) because mock-crm workspace process has a different cwd.
# Per-source env consumed by the reconcile CLI; the mock process itself still takes LEDGER_PATH
# (its own file-path option, see mocks/crm/src/main.ts) — passed explicitly at its start line below.
export LEDGER_PATH_CRM="$(pwd)/out/ledger.jsonl"

# CHAOS_SKIP_BACKFILL=1 is a RED-proof escape hatch: skip the backfill recovery step so that
# reconcile fails and lists the events lost to injected drops, proving the detector detects.
SKIP_BACKFILL="${CHAOS_SKIP_BACKFILL:-0}"

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "1/8 postgres up"
docker compose up -d postgres
ready=false
for i in $(seq 1 60); do
  if docker compose exec postgres pg_isready -U switchboard -q 2>/dev/null; then ready=true; break; fi
  sleep 1
done
$ready || { echo "FAIL: postgres not ready after 60s"; exit 1; }

echo "2/8 migrate"
npm run migrate -w ingest

echo "3/8 clean state (raw, ingest.outbox, ingest.quarantine, ledger, report artifacts)"
docker compose exec -T postgres psql -U switchboard -c \
  "truncate table raw.raw_events, ingest.outbox, ingest.quarantine restart identity;" > /dev/null
# Reset the backfill cursor too, otherwise a stale cursor from a prior chaos run would make
# the mock CRM's fresh /simulate events (which restart seq at 1) look already-consumed.
docker compose exec -T postgres psql -U switchboard -c \
  "delete from ingest.cursors;" > /dev/null
# Clear ALL queued jobs so stale jobs from pre-rename runs (old 'ingest-event' queue names)
# can never poison the settle-wait. Guarded: pgboss schema does not exist on a fresh DB.
docker compose exec -T postgres psql -U switchboard -c \
  "delete from pgboss.job;" > /dev/null 2>&1 || true
rm -f out/ledger.jsonl out/monday-report.md out/chaos-report.txt

echo "4/8 start ingest (receiver+worker) + mock crm"
# BACKFILL_INTERVAL_MS pinned high so the in-process scheduled poller cannot fire mid-run —
# the RED-mode detector proof (CHAOS_SKIP_BACKFILL=1) depends on dropped events staying
# unrecovered until the explicit backfill step below.
PORT=4002 BACKFILL_INTERVAL_MS=600000 npm run start -w ingest & pids+=($!)
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm LEDGER_PATH="$LEDGER_PATH_CRM" npm run start -w mocks/crm & pids+=($!)
sleep 2

echo "5/8 simulate 200 events with injected faults (seed 7, drop 0.2, dup 0.15, apiError 0.2)"
curl -sf -X POST http://localhost:4001/simulate \
  -H 'content-type: application/json' \
  -d '{"count": 200, "fault_plan": {"seed": 7, "dropRate": 0.2, "dupRate": 0.15, "apiErrorRate": 0.2}}' > /dev/null

echo "5b/8 bounded settle-wait for push-path (raw count stable + queue quiescent, NOT ==200 since ~20% are dropped)"
raw_count() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events" | tr -d ' '; }
queue_pending() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from pgboss.job where name like 'ingest-%' and state in ('created','active','retry')" | tr -d ' '; }
stable_polls=0
prev="-1"
settled=false
for i in $(seq 1 60); do
  cur="$(raw_count)"
  pending="$(queue_pending)"
  if [[ "$cur" == "$prev" ]] && [[ "$pending" == "0" ]]; then
    stable_polls=$((stable_polls + 1))
  else
    stable_polls=0
  fi
  if [[ "$stable_polls" -ge 3 ]]; then settled=true; break; fi
  prev="$cur"
  sleep 1
done
$settled || { echo "FAIL: push-path did not settle within 60s (raw=$(raw_count) pending=$(queue_pending))"; exit 1; }
echo "    settled: raw=$(raw_count) queue_pending=$(queue_pending) (ledger has $(wc -l < out/ledger.jsonl | tr -d ' ') events emitted by simulate)"

if [[ "$SKIP_BACKFILL" == "1" ]]; then
  echo "6/8 SKIPPED (CHAOS_SKIP_BACKFILL=1) — leaving dropped events unrecovered on purpose"
else
  echo "6/8 backfill (retry up to 3x on exit 1 — 429 streaks can abort a run; cursor is resumable)"
  backfill_ok=false
  for attempt in 1 2 3; do
    code=0
    npm run backfill -w ingest || code=$?
    if [[ "$code" == "0" ]]; then
      backfill_ok=true
      break
    elif [[ "$code" != "1" ]]; then
      echo "FAIL: backfill exited with non-resumable code $code"; exit 1
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "    backfill attempt $attempt failed with exit 1 (resumable), retrying..."
    fi
  done
  $backfill_ok || { echo "FAIL: backfill did not succeed after 3 attempts (last exit code: 1)"; exit 1; }
fi

echo "7/8 reconcile ledger vs raw"
set +e
npm run reconcile -w ingest
reconcile_status=$?
set -e

echo "7b/8 assert quarantine=0 and DLQ empty"
quarantine_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from ingest.quarantine" | tr -d ' ')"
dlq_output="$(npm run replay -w ingest -- --list 2>&1)"
dlq_depth="$(echo "$dlq_output" | grep -o 'DLQ depth: [0-9]*' | grep -o '[0-9]*' || echo "unknown")"

echo "    quarantine=$quarantine_count dlq_depth=$dlq_depth"

if [[ "$reconcile_status" -ne 0 ]]; then
  echo "FAIL: reconciliation found discrepancies (see report above)"
  exit 1
fi
if [[ "$quarantine_count" != "0" ]]; then
  echo "FAIL: quarantine is not empty ($quarantine_count rows)"
  exit 1
fi
if [[ "$dlq_depth" != "0" ]]; then
  echo "FAIL: DLQ is not empty (depth=$dlq_depth)"
  exit 1
fi

echo "8/8 done"
echo "PASS: zero lost events under injected faults"
