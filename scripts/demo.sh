#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
export LEDGER_PATH="$(pwd)/out/ledger.jsonl"
rm -f out/monday-report.md out/ledger.jsonl
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "1/6 postgres up"
docker compose up -d postgres
until docker compose exec postgres pg_isready -U switchboard -q; do sleep 1; done

echo "2/6 migrate"
npm run migrate -w ingest

echo "3/6 start ingest + mock crm"
PORT=4002 npm run start -w ingest & pids+=($!)
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm npm run start -w mocks/crm & pids+=($!)
sleep 2

echo "4/6 simulate 50 events"
curl -sf -X POST http://localhost:4001/simulate \
  -H 'content-type: application/json' -d '{"count": 50}' > /dev/null
sleep 1

echo "5/6 dbt build"
docker compose run --rm dbt build

echo "6/6 generate report"
npm run report -w agent
mkdir -p out
cp agent/out/monday-report.md out/monday-report.md
./scripts/check-demo.sh
