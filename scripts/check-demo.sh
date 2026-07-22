#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"

f="out/monday-report.md"
[[ -s "$f" ]] || { echo "FAIL: $f missing or empty"; exit 1; }
grep -q "DEMO-C-" "$f" || { echo "FAIL: no DEMO-C- company ids in report"; exit 1; }
grep -q "# Monday Revenue-Risk Report" "$f" || { echo "FAIL: missing report header"; exit 1; }

ledger="out/ledger.jsonl"
[[ -s "$ledger" ]] || { echo "FAIL: $ledger missing or empty"; exit 1; }
ledger_count="$(wc -l < "$ledger" | tr -d ' ')"

raw_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events" | tr -d ' ')"
outbox_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from ingest.outbox" | tr -d ' ')"

if [[ "$raw_count" != "$ledger_count" ]]; then
  echo "FAIL: oracle mismatch — ledger has $ledger_count events but raw.raw_events has $raw_count (async ingest pipeline has not fully drained)"
  exit 1
fi

if [[ "$outbox_count" != "$ledger_count" ]]; then
  echo "FAIL: oracle mismatch — ledger has $ledger_count events but ingest.outbox has $outbox_count (async ingest pipeline has not fully drained)"
  exit 1
fi

echo "PASS: end-to-end demo produced a valid report (ledger=$ledger_count raw=$raw_count outbox=$outbox_count)"
