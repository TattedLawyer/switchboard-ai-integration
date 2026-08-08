#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"

f="out/monday-report.md"
[[ -s "$f" ]] || { echo "FAIL: $f missing or empty"; exit 1; }
grep -q "DEMO-C-" "$f" || { echo "FAIL: no DEMO-C- company ids in report"; exit 1; }
grep -q "# Monday Revenue-Risk Report" "$f" || { echo "FAIL: missing report header"; exit 1; }

# Per-source oracle (F-1c: paradigm-aware). Ledger-bearing sources (hubcrm's emission
# ledger, the 2a support feed ledger) get the strong 3-way check: ledger line count ==
# raw.raw_events == ingest.ingest_journal (the journal is written once per accepted event
# in the ingest transaction). Pull paradigms (stripefeed, casebus) have no ledger FILE —
# their retained-window truth is reconciled by `npm run reconcile` in demo.sh step 4c —
# so here they get the 2-way check: journal == raw, both nonzero. Stronger than a sum
# check either way: a shortfall in one source cannot be masked by an overshoot in another.
sources="${INGEST_SOURCES:-hubcrm,stripefeed,casebus,support}"
total_ledger=0; total_raw=0; total_journal=0
fail=0
for source in ${sources//,/ }; do
  up="$(echo "$source" | tr '[:lower:]' '[:upper:]')"
  ledger_var="LEDGER_PATH_${up}"
  ledger="${!ledger_var:-}"
  raw_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events where source='${source}'" | tr -d ' ')"
  journal_count="$(docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from ingest.ingest_journal where source='${source}'" | tr -d ' ')"
  if [[ -n "$ledger" ]]; then
    [[ -s "$ledger" ]] || { echo "FAIL: [$source] ledger $ledger missing or empty"; exit 1; }
    ledger_count="$(wc -l < "$ledger" | tr -d ' ')"
    echo "[$source] ledger=$ledger_count raw=$raw_count journal=$journal_count"
    if [[ "$raw_count" != "$ledger_count" ]]; then
      echo "FAIL: [$source] oracle mismatch — ledger has $ledger_count events but raw.raw_events has $raw_count (async ingest pipeline has not fully drained)"
      fail=1
    fi
    if [[ "$journal_count" != "$ledger_count" ]]; then
      echo "FAIL: [$source] oracle mismatch — ledger has $ledger_count events but ingest.ingest_journal has $journal_count (async ingest pipeline has not fully drained)"
      fail=1
    fi
    total_ledger=$((total_ledger + ledger_count))
  else
    echo "[$source] raw=$raw_count journal=$journal_count (pull paradigm — window truth reconciled in demo step 4c)"
    if [[ "$raw_count" == "0" ]]; then
      echo "FAIL: [$source] no raw events — the pull connector never drained this source"
      fail=1
    fi
    if [[ "$journal_count" != "$raw_count" ]]; then
      echo "FAIL: [$source] oracle mismatch — raw has $raw_count events but ingest.ingest_journal has $journal_count"
      fail=1
    fi
  fi
  total_raw=$((total_raw + raw_count))
  total_journal=$((total_journal + journal_count))
done
[[ "$fail" == "0" ]] || exit 1

echo "PASS: end-to-end demo produced a valid report (ledger=$total_ledger raw=$total_raw journal=$total_journal across ${sources})"
