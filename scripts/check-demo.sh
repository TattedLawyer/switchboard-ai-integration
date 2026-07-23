#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"

f="out/monday-report.md"
[[ -s "$f" ]] || { echo "FAIL: $f missing or empty"; exit 1; }
grep -q "DEMO-C-" "$f" || { echo "FAIL: no DEMO-C- company ids in report"; exit 1; }
grep -q "# Monday Revenue-Risk Report" "$f" || { echo "FAIL: missing report header"; exit 1; }

# Per-source oracle: each source's ledger line count must equal its raw.raw_events and
# ingest.outbox counts. Stronger than a sum check — a shortfall in one source cannot be
# masked by an overshoot in another.
sources="${INGEST_SOURCES:-crm,billing,support}"
total_ledger=0; total_raw=0; total_outbox=0
fail=0
for source in ${sources//,/ }; do
  up="$(echo "$source" | tr '[:lower:]' '[:upper:]')"
  ledger_var="LEDGER_PATH_${up}"
  ledger="${!ledger_var:-out/ledger-${source}.jsonl}"
  [[ -s "$ledger" ]] || { echo "FAIL: [$source] ledger $ledger missing or empty"; exit 1; }
  ledger_count="$(wc -l < "$ledger" | tr -d ' ')"
  raw_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events where source='${source}'" | tr -d ' ')"
  outbox_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from ingest.outbox where source='${source}'" | tr -d ' ')"
  echo "[$source] ledger=$ledger_count raw=$raw_count outbox=$outbox_count"
  if [[ "$raw_count" != "$ledger_count" ]]; then
    echo "FAIL: [$source] oracle mismatch — ledger has $ledger_count events but raw.raw_events has $raw_count (async ingest pipeline has not fully drained)"
    fail=1
  fi
  if [[ "$outbox_count" != "$ledger_count" ]]; then
    echo "FAIL: [$source] oracle mismatch — ledger has $ledger_count events but ingest.outbox has $outbox_count (async ingest pipeline has not fully drained)"
    fail=1
  fi
  total_ledger=$((total_ledger + ledger_count))
  total_raw=$((total_raw + raw_count))
  total_outbox=$((total_outbox + outbox_count))
done
[[ "$fail" == "0" ]] || exit 1

echo "PASS: end-to-end demo produced a valid report (ledger=$total_ledger raw=$total_raw outbox=$total_outbox across ${sources})"
