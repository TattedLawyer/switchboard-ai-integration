#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
# All three sources: the ingest workers, backfill, and reconcile iterate this list.
export INGEST_SOURCES=crm,billing,support
# Absolute paths (not spec's relative ./out/) because each mock workspace process has a different
# cwd. Per-source env consumed by the reconcile CLI; each mock process itself still takes
# LEDGER_PATH (its own file-path option) — passed explicitly at its start line below.
# NOTE: crm ledger renamed from out/ledger.jsonl → out/ledger-crm.jsonl (three-source era).
export LEDGER_PATH_CRM="$(pwd)/out/ledger-crm.jsonl"
export LEDGER_PATH_BILLING="$(pwd)/out/ledger-billing.jsonl"
export LEDGER_PATH_SUPPORT="$(pwd)/out/ledger-support.jsonl"
rm -f out/monday-report.md "$LEDGER_PATH_CRM" "$LEDGER_PATH_BILLING" "$LEDGER_PATH_SUPPORT" out/ledger.jsonl
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "1/6 postgres up"
docker compose up -d postgres
ready=false
for i in $(seq 1 60); do
  if docker compose exec postgres pg_isready -U switchboard -q 2>/dev/null; then ready=true; break; fi
  sleep 1
done
$ready || { echo "FAIL: postgres not ready after 60s"; exit 1; }

echo "2/6 migrate"
npm run migrate -w ingest

echo "2b/6 clean state (raw, ingest.outbox, ingest.quarantine, cursors) so re-runs (and runs after
scripts/chaos.sh, whose mock processes restart event seq at 1) don't collide with leftover
rows from a prior run"
docker compose exec -T postgres psql -U switchboard -c \
  "truncate table raw.raw_events, ingest.outbox, ingest.quarantine restart identity;" > /dev/null
docker compose exec -T postgres psql -U switchboard -c \
  "delete from ingest.cursors;" > /dev/null

echo "3/6 start ingest + mock crm/billing/support (all mocks share the default manifest seed 42 —
do NOT pass divergent seeds or cross-system correlation breaks)"
PORT=4002 npm run start -w ingest & pids+=($!)
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm     LEDGER_PATH="$LEDGER_PATH_CRM"     npm run start -w mocks/crm     & pids+=($!)
PORT=4003 WEBHOOK_URL=http://localhost:4002/webhooks/billing LEDGER_PATH="$LEDGER_PATH_BILLING" npm run start -w mocks/billing & pids+=($!)
PORT=4004 WEBHOOK_URL=http://localhost:4002/webhooks/support LEDGER_PATH="$LEDGER_PATH_SUPPORT" npm run start -w mocks/support & pids+=($!)
sleep 2

# crm 108 (was 80): identity resolution's SUPPORT tier-1 expectations (S-0006..S-0009) key on
# CRM contact emails at contact indices 20/22/24/26 (P-0021/P-0023/P-0025/P-0027). The crm
# script emits contact index floor(i/4) at slots i%4==1, so index 26 emits at i=105 — a count
# below 106 never stages those contacts and support tier-1 fails for a data-coverage reason,
# not a logic bug. 108 rounds up to a whole 4-slot cycle. Companies (all 22 by i=43) and both
# merges (i=45,46) were already covered at 80.
echo "4/6 simulate: crm 108 (22 companies + both merges + contacts through P-0027), billing 100 (all 16 customers), support 80 (all requesters via first 14 tickets)"
curl -sf -X POST http://localhost:4001/simulate \
  -H 'content-type: application/json' -d '{"count": 108}' > /dev/null
curl -sf -X POST http://localhost:4003/simulate \
  -H 'content-type: application/json' -d '{"count": 100}' > /dev/null
curl -sf -X POST http://localhost:4004/simulate \
  -H 'content-type: application/json' -d '{"count": 80}' > /dev/null

echo "4b/6 wait for async ingest pipeline to drain (raw total == sum of the three ledgers)"
ledger_sum() {
  local total=0 f lc
  for f in "$LEDGER_PATH_CRM" "$LEDGER_PATH_BILLING" "$LEDGER_PATH_SUPPORT"; do
    lc="$(wc -l < "$f" 2>/dev/null | tr -d ' ' || echo 0)"
    total=$((total + ${lc:-0}))
  done
  echo "$total"
}
raw_count() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events" | tr -d ' '; }
drained=false
for i in $(seq 1 60); do
  lc="$(ledger_sum)"
  rc="$(raw_count)"
  if [[ "$lc" -gt 0 && "$lc" == "$rc" ]]; then drained=true; break; fi
  sleep 2
done
$drained || { echo "FAIL: ingest pipeline did not drain within 120s (ledger_sum=$(ledger_sum) raw=$(raw_count))"; exit 1; }

echo "5/6 dbt build"
docker compose run --rm dbt build

echo "6/6 generate report"
npm run report -w agent
mkdir -p out
# npm run report -w agent writes relative to agent workspace; copy artifact to repo-root out/ where check-demo.sh expects it
cp agent/out/monday-report.md out/monday-report.md
./scripts/check-demo.sh
