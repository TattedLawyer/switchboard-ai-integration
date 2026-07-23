#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
# All three sources under fault injection simultaneously — the source-agnostic-spine proof.
# Reconcile (ingest CLI) iterates INGEST_SOURCES and exits nonzero if ANY source has
# missing/extra/duplicate events, so PASS requires all three to reconcile clean.
export INGEST_SOURCES=crm,billing,support
# Absolute paths (mock workspace processes have different cwds). Per-source env consumed by
# the reconcile CLI; each mock still takes its own LEDGER_PATH at its start line below.
export LEDGER_PATH_CRM="$(pwd)/out/ledger-crm.jsonl"
export LEDGER_PATH_BILLING="$(pwd)/out/ledger-billing.jsonl"
export LEDGER_PATH_SUPPORT="$(pwd)/out/ledger-support.jsonl"

# CHAOS_SKIP_BACKFILL=1 is a RED-proof escape hatch: skip the backfill recovery step so that
# reconcile fails and lists the events lost to injected drops, proving the detector detects
# per source. CHAOS_SEED varies the fault plan (Task 11's workflow feeds it).
SKIP_BACKFILL="${CHAOS_SKIP_BACKFILL:-0}"
CHAOS_SEED="${CHAOS_SEED:-7}"

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

echo "3/8 clean state (raw, ingest.outbox, ingest.quarantine, ledgers, report artifacts)"
docker compose exec -T postgres psql -U switchboard -c \
  "truncate table raw.raw_events, ingest.outbox, ingest.quarantine restart identity;" > /dev/null
# Reset the backfill cursors too, otherwise a stale cursor from a prior chaos run would make
# the mocks' fresh /simulate events (which restart seq at 1) look already-consumed.
docker compose exec -T postgres psql -U switchboard -c \
  "delete from ingest.cursors;" > /dev/null
# Clear ALL queued jobs so stale jobs from pre-rename runs (old 'ingest-event' queue names)
# can never poison the settle-wait. Guarded: pgboss schema does not exist on a fresh DB.
docker compose exec -T postgres psql -U switchboard -c \
  "delete from pgboss.job;" > /dev/null 2>&1 || true
rm -f "$LEDGER_PATH_CRM" "$LEDGER_PATH_BILLING" "$LEDGER_PATH_SUPPORT" out/ledger.jsonl out/monday-report.md out/chaos-report.txt

echo "4/8 start ingest (receiver+worker) + mock crm/billing/support (shared default manifest seed 42 —
do NOT pass divergent seeds or cross-system correlation breaks)"
# BACKFILL_INTERVAL_MS pinned high so the in-process scheduled poller cannot fire mid-run —
# the RED-mode detector proof (CHAOS_SKIP_BACKFILL=1) depends on dropped events staying
# unrecovered until the explicit backfill step below.
PORT=4002 BACKFILL_INTERVAL_MS=600000 npm run start -w ingest & pids+=($!)
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm     LEDGER_PATH="$LEDGER_PATH_CRM"     npm run start -w mocks/crm     & pids+=($!)
PORT=4003 WEBHOOK_URL=http://localhost:4002/webhooks/billing LEDGER_PATH="$LEDGER_PATH_BILLING" npm run start -w mocks/billing & pids+=($!)
PORT=4004 WEBHOOK_URL=http://localhost:4002/webhooks/support LEDGER_PATH="$LEDGER_PATH_SUPPORT" npm run start -w mocks/support & pids+=($!)
sleep 2

echo "5/8 simulate 200 events per source with injected faults (seed $CHAOS_SEED, drop 0.2, dup 0.15, apiError 0.2)"
fault_body() { printf '{"count": 200, "fault_plan": {"seed": %s, "dropRate": 0.2, "dupRate": 0.15, "apiErrorRate": 0.2}}' "$CHAOS_SEED"; }
curl -sf -X POST http://localhost:4001/simulate -H 'content-type: application/json' -d "$(fault_body)" > /dev/null
curl -sf -X POST http://localhost:4003/simulate -H 'content-type: application/json' -d "$(fault_body)" > /dev/null
curl -sf -X POST http://localhost:4004/simulate -H 'content-type: application/json' -d "$(fault_body)" > /dev/null

echo "5b/8 bounded settle-wait for push-path (raw count stable + queue quiescent, NOT ==600 since ~20% are dropped)"
raw_count() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events" | tr -d ' '; }
queue_pending() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from pgboss.job where name like 'ingest-%' and state in ('created','active','retry')" | tr -d ' '; }
ledger_line_count() { wc -l < "$1" 2>/dev/null | tr -d ' ' || echo 0; }
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
echo "    settled: raw=$(raw_count) queue_pending=$(queue_pending) (ledgers: crm=$(ledger_line_count "$LEDGER_PATH_CRM") billing=$(ledger_line_count "$LEDGER_PATH_BILLING") support=$(ledger_line_count "$LEDGER_PATH_SUPPORT") events emitted by simulate)"

if [[ "$SKIP_BACKFILL" == "1" ]]; then
  echo "6/8 SKIPPED (CHAOS_SKIP_BACKFILL=1) — leaving dropped events unrecovered on purpose"
else
  echo "6/8 backfill all sources (retry up to 3x on exit 1 — 429 streaks can abort a run; cursors are resumable)"
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

echo "7/8 reconcile each source's ledger vs its raw rows (PASS requires ALL of: ${INGEST_SOURCES})"
set +e
npm run reconcile -w ingest
reconcile_status=$?
set -e

echo "7b/8 assert quarantine=0 and DLQ empty (all sources)"
quarantine_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from ingest.quarantine" | tr -d ' ')"
dlq_output="$(npm run replay -w ingest -- --list 2>&1)"
dlq_depth="$(echo "$dlq_output" | grep -o 'DLQ depth: [0-9]*' | grep -o '[0-9]*' || echo "unknown")"

echo "    quarantine=$quarantine_count dlq_depth=$dlq_depth"

if [[ "$reconcile_status" -ne 0 ]]; then
  echo "FAIL: reconciliation found discrepancies (see per-source report above)"
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
