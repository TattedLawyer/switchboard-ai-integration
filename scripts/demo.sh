#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
# All three sources: the ingest workers, backfill, and reconcile iterate this list.
export INGEST_SOURCES=crm,billing,support

# Identity for THIS run's ingest process. /status echoes it back, and instance_wait refuses
# to proceed unless the process answering :4002 returns exactly this value -- proving we are
# driving the server we just started rather than one stranded by an earlier run.
export INGEST_INSTANCE_ID="${INGEST_INSTANCE_ID:-run-$$-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

# Demo runs on the published dev secrets by design (proves the mechanism, not secrecy).
# Production must set WEBHOOK_SECRET_* and LEDGER_HMAC_KEY instead — see A2 fail-closed.
export ALLOW_DEV_SECRETS=1
# Absolute paths (not spec's relative ./out/) because each mock workspace process has a different
# cwd. Per-source env consumed by the reconcile CLI; each mock process itself still takes
# LEDGER_PATH (its own file-path option) — passed explicitly at its start line below.
# NOTE: crm ledger renamed from out/ledger.jsonl → out/ledger-crm.jsonl (three-source era).
export LEDGER_PATH_CRM="$(pwd)/out/ledger-crm.jsonl"
export LEDGER_PATH_BILLING="$(pwd)/out/ledger-billing.jsonl"
export LEDGER_PATH_SUPPORT="$(pwd)/out/ledger-support.jsonl"
rm -f out/monday-report.md "$LEDGER_PATH_CRM" "$LEDGER_PATH_BILLING" "$LEDGER_PATH_SUPPORT" out/ledger.jsonl

# Wait until a service answers HTTP on its port (any response, incl. 404, means listening).
# A bare sleep raced service startup on slow/loaded machines: first-run flake, exit 7.
ready_wait() {
  local port="$1" name="$2"
  for i in $(seq 1 60); do
    if curl -s -o /dev/null "http://localhost:${port}/"; then return 0; fi
    sleep 0.5
  done
  echo "FAIL: ${name} (port ${port}) not ready after 30s — see out/log-${name}.txt" >&2
  exit 1
}

# B2: job control ON, so every backgrounded `npm run …` pipeline below becomes its own
# process group (bash Set Builtin, -m: "All processes run in a separate process group"),
# and the trap kills the GROUP (POSIX kill: a negative pid signals the process group,
# `--` so it is not read as a flag). Killing only npm's PID strands the node grandchild
# that actually holds the port — npm has not forwarded SIGTERM to its child since
# npm 9.8.x/Node 20.5 (npm/cli#6684); that stranded listener is what contaminated CI run
# 30159422468. `setsid` was refuted for this fix (absent on macOS — dev half of the
# matrix); `pkill -P` too (direct children only, misses npm→sh→node). The fresh_wait /
# instance_wait guards below stay as the second line, and their lsof guidance remains
# the stale-state recovery path for leftovers from pre-fix runs or SIGKILLed scripts.
set -m
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill -- -"$p" 2>/dev/null || true; done; }
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

echo "2b/6 clean state (raw, ingest.ingest_journal, ingest.quarantine, cursors) so re-runs (and runs after
scripts/chaos.sh, whose mock processes restart event seq at 1) don't collide with leftover
rows from a prior run"
docker compose exec -T postgres psql -U switchboard -c \
  "truncate table raw.raw_events, ingest.ingest_journal, ingest.quarantine restart identity;" > /dev/null
docker compose exec -T postgres psql -U switchboard -c \
  "delete from ingest.cursors;" > /dev/null

echo "3/6 start ingest + mock crm/billing/support (all mocks share the default manifest seed 42 —
do NOT pass divergent seeds or cross-system correlation breaks)"
mkdir -p out  # log redirects + ledgers land here; gitignored, absent on fresh clones
INGEST_INSTANCE_ID="$INGEST_INSTANCE_ID" PORT=4002 npm run start -w ingest > out/log-ingest.txt 2>&1 & pids+=($!)
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm     LEDGER_PATH="$LEDGER_PATH_CRM"     npm run start -w mocks/crm     > out/log-crm.txt 2>&1 & pids+=($!)
PORT=4003 WEBHOOK_URL=http://localhost:4002/webhooks/billing LEDGER_PATH="$LEDGER_PATH_BILLING" npm run start -w mocks/billing > out/log-billing.txt 2>&1 & pids+=($!)
PORT=4004 WEBHOOK_URL=http://localhost:4002/webhooks/support LEDGER_PATH="$LEDGER_PATH_SUPPORT" npm run start -w mocks/support > out/log-support.txt 2>&1 & pids+=($!)

# Liveness is not readiness. ready_wait proves only that SOMETHING answers on the port; it
# cannot tell our server from a previous script's leftover. Mocks derive their event script
# index from a process-lifetime counter, so an inherited server silently emits the wrong
# events. fresh_wait asserts that state instead.
fresh_wait() {
  local port="$1" name="$2" status=""
  ready_wait "$port" "$name"
  status="$(curl -s "http://localhost:${port}/status")"
  if ! printf '%s' "$status" | grep -q '"fresh":true'; then
    echo "FAIL: ${name} (port ${port}) answered but is NOT fresh: ${status}" >&2
    echo "  A previous run's mock still holds this port — 'npm run' does not reap its grandchild" >&2
    echo "  on SIGTERM (npm/cli#6684), so our own server never bound. Driving a mock whose script" >&2
    echo "  cursor has advanced emits a DIFFERENT event mix than requested (the crm merge events" >&2
    echo "  live at script indices 45/46 and would be skipped entirely). Free the port and re-run:" >&2
    echo "    lsof -ti :${port} | xargs kill -9" >&2
    exit 1
  fi
}

instance_wait() {
  local port="$1" name="$2" status="" got=""
  ready_wait "$port" "$name"
  status="$(curl -s "http://localhost:${port}/status")"
  got="$(printf '%s' "$status" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')"
  if [[ "$got" != "$INGEST_INSTANCE_ID" ]]; then
    echo "FAIL: ${name} (port ${port}) answered, but it is NOT the process this run started." >&2
    echo "  expected instance_id=${INGEST_INSTANCE_ID}, got: ${status}" >&2
    echo "  A stranded ingest from an earlier run holds this port, so ours never bound. It" >&2
    echo "  keeps polling its OWN feed on its OWN env -- which would let CHAOS_SKIP_BACKFILL=1" >&2
    echo "  reconcile clean and report PASS while proving nothing. Free it and re-run:" >&2
    echo "    lsof -ti :${port} | xargs kill -9" >&2
    exit 1
  fi
}

instance_wait 4002 ingest
fresh_wait 4001 crm; fresh_wait 4003 billing; fresh_wait 4004 support

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
# Anchor the gate to the EXPECTED total, not ledger==raw equality: those are two counters
# that move together (ledger-append precedes each delivery), so on a slow machine the
# equality holds continuously DURING emission and the old check could declare "drained"
# mid-simulate — dbt then built on a partial raw missing the crm tail (merges + late
# contacts). That is exactly how the first chaos-workflow run on GitHub failed its demo
# step (2026-07-25, run 30158941574) while every fast local run passed.
EXPECTED_TOTAL=288  # 108 crm + 100 billing + 80 support — keep in sync with step 4/6 above
drained=false
lc=0; rc=0
for i in $(seq 1 120); do
  lc="$(ledger_sum)"
  rc="$(raw_count)"
  if [[ "$lc" -eq "$EXPECTED_TOTAL" && "$rc" -eq "$EXPECTED_TOTAL" ]]; then drained=true; break; fi
  sleep 2
done
$drained || { echo "FAIL: ingest pipeline did not drain to $EXPECTED_TOTAL within 240s (ledger_sum=$lc raw=$rc)"; exit 1; }
echo "    drained: ledger_sum=$lc raw=$rc (expected $EXPECTED_TOTAL)"

echo "5/6 dbt build"
docker compose run --rm dbt build

echo "5b/6 verify identity resolution against the seed manifest"
npx tsx scripts/verify-identity.ts

echo "6/6 generate report"
npm run report -w agent
mkdir -p out
# npm run report -w agent writes relative to agent workspace; copy artifact to repo-root out/ where check-demo.sh expects it
cp agent/out/monday-report.md out/monday-report.md
./scripts/check-demo.sh
