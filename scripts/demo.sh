#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
# A1 (Phase 3): the agent credential is REQUIRED, never derived from DATABASE_URL —
# agentConnectionString() fails closed. Pinned explicitly here so the agent never sees
# the full-privilege credential as its own fallback.
export AGENT_DATABASE_URL="${AGENT_DATABASE_URL:-postgres://switchboard_agent:switchboard_agent@localhost:5433/switchboard}"
# F-1c: the FLIPPED stack — the four sources the warehouse actually stages from.
# hubcrm is the CRM arm (thin webhooks + hydration), stripefeed the billing arm,
# casebus the support arm, and the 2a support mock remains for the csat arm only.
# The 2a crm mock is retired; the 2a billing mock feeds no model and does not run.
export INGEST_SOURCES=hubcrm,stripefeed,casebus,support

# Identity for THIS run's ingest process. /status echoes it back, and instance_wait refuses
# to proceed unless the process answering :4002 returns exactly this value -- proving we are
# driving the server we just started rather than one stranded by an earlier run.
export INGEST_INSTANCE_ID="${INGEST_INSTANCE_ID:-run-$$-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

# Demo runs on the published dev secrets by design (proves the mechanism, not secrecy).
# Production must set WEBHOOK_SECRET_* and LEDGER_HMAC_KEY instead — see A2 fail-closed.
export ALLOW_DEV_SECRETS=1
# Absolute paths (mock workspace processes have different cwds). Per-source env consumed by
# the reconcile CLI; each ledger-bearing mock still takes LEDGER_PATH at its start line.
# hubcrm's ledger is the EMISSION record (F-1c): every event the store emits, chained.
export LEDGER_PATH_HUBCRM="$(pwd)/out/ledger-hubcrm.jsonl"
export LEDGER_PATH_SUPPORT="$(pwd)/out/ledger-support.jsonl"
rm -f out/monday-report.md "$LEDGER_PATH_HUBCRM" "$LEDGER_PATH_SUPPORT" out/ledger.jsonl out/ledger-crm.jsonl out/ledger-billing.jsonl

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

echo "1/7 postgres up"
docker compose up -d postgres
ready=false
for i in $(seq 1 60); do
  if docker compose exec postgres pg_isready -U switchboard -q 2>/dev/null; then ready=true; break; fi
  sleep 1
done
$ready || { echo "FAIL: postgres not ready after 60s"; exit 1; }

echo "2/7 migrate"
npm run migrate -w ingest

echo "2b/7 clean state (raw, journal, quarantine, cursors, hydrated snapshots, gap ledger, queued jobs)
so re-runs (and runs after scripts/chaos.sh, whose mock processes restart their scripts) don't
collide with leftover rows from a prior run"
docker compose exec -T postgres psql -U switchboard -c \
  "truncate table raw.raw_events, ingest.ingest_journal, ingest.quarantine, ingest.hydrated_snapshots restart identity;" > /dev/null
docker compose exec -T postgres psql -U switchboard -c \
  "delete from ingest.cursors; delete from ingest.gap_ledger;" > /dev/null
docker compose exec -T postgres psql -U switchboard -c \
  "delete from pgboss.job;" > /dev/null 2>&1 || true

echo "3/7 start ingest + mock hubcrm/stripefeed/casebus/support (all mocks share the default
manifest seed 42 — do NOT pass divergent seeds or cross-system correlation breaks)"
mkdir -p out  # log redirects + ledgers land here; gitignored, absent on fresh clones
INGEST_INSTANCE_ID="$INGEST_INSTANCE_ID" PORT=4002 npm run start -w ingest > out/log-ingest.txt 2>&1 & pids+=($!)
PORT=4007 WEBHOOK_URL=http://localhost:4002/webhooks/hubcrm LEDGER_PATH="$LEDGER_PATH_HUBCRM" npm run start -w mocks/hubcrm > out/log-hubcrm.txt 2>&1 & pids+=($!)
PORT=4006 npm run start -w mocks/stripefeed > out/log-stripefeed.txt 2>&1 & pids+=($!)
PORT=4008 npm run start -w mocks/casebus    > out/log-casebus.txt    2>&1 & pids+=($!)
PORT=4004 WEBHOOK_URL=http://localhost:4002/webhooks/support LEDGER_PATH="$LEDGER_PATH_SUPPORT" npm run start -w mocks/support > out/log-support.txt 2>&1 & pids+=($!)

# Liveness is not readiness. ready_wait proves only that SOMETHING answers on the port; it
# cannot tell our server from a previous script's leftover. Mocks derive their event script
# index from process-lifetime state, so an inherited server silently emits the wrong events.
# fresh_wait asserts that state instead.
fresh_wait() {
  local port="$1" name="$2" status=""
  ready_wait "$port" "$name"
  status="$(curl -s "http://localhost:${port}/status")"
  if ! printf '%s' "$status" | grep -q '"fresh":true'; then
    echo "FAIL: ${name} (port ${port}) answered but is NOT fresh: ${status}" >&2
    echo "  A previous run's mock still holds this port — 'npm run' does not reap its grandchild" >&2
    echo "  on SIGTERM (npm/cli#6684), so our own server never bound. Driving a mock whose script" >&2
    echo "  cursor has advanced emits a DIFFERENT event mix than requested (the hubcrm merges fire" >&2
    echo "  at script ops 210/230 and would be skipped entirely). Free the port and re-run:" >&2
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
    echo "  A stranded ingest from an earlier run holds this port, so ours never bound. Free it" >&2
    echo "  and re-run:" >&2
    echo "    lsof -ti :${port} | xargs kill -9" >&2
    exit 1
  fi
}

instance_wait 4002 ingest
fresh_wait 4007 hubcrm; fresh_wait 4006 stripefeed; fresh_wait 4008 casebus; fresh_wait 4004 support

raw_count_for() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events where source='$1'" | tr -d ' '; }
queue_pending() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from pgboss.job where name like 'ingest-%' and state in ('created','active','retry')" | tr -d ' '; }
# Bounded per-source drain gate (anchored to the EXPECTED count, not to any moving pair
# of counters — the 2026-07-25 chaos-workflow lesson).
wait_raw() {
  local source="$1" expected="$2" got=0
  for i in $(seq 1 120); do
    got="$(raw_count_for "$source")"
    if [[ "$got" -eq "$expected" && "$(queue_pending)" == "0" ]]; then return 0; fi
    sleep 1
  done
  echo "FAIL: ${source} did not drain to ${expected} within 120s (raw=${got} pending=$(queue_pending))"; exit 1
}

# hubcrm: 300 script ops in THREE chunks with a hydration-pump backfill between them.
# The chunk boundaries are the merge positions (the script's merges fire at ops 210 and
# 230 — the exported OPS_UNTIL_MERGES_COMPLETE constant's derivation): every object a
# merge consumes must be HYDRATED WHILE ALIVE (its snapshot is what merge_edges
# translates the consumed ids through), so a pump runs after ops 0-209 (both original
# merge-1 participants + C-0002 exist), after ops 210-229 (merge 1 fired; C-0022
# created at 220, before merge 2 at 230), and after the tail. 300 total = the CI
# fixture's derived count: >= OPS_UNTIL_MERGES_COMPLETE, >= 262 for support tier-1's
# contact P-0027 (created at op 261), whole cycles so the dupe-attached deals
# (D-0057/D-0059 at ops 282/292) reach staging and merge re-pointing is demonstrable.
echo "4/7 simulate: hubcrm 210+20+70 (pump between chunks), stripefeed 100 (all 16 customers),
casebus 80 (all 14 requesters via the first 20 cases), support 80 (csat arm)"
hub_total=0
for chunk in 210 20 70; do
  curl -sf -X POST http://localhost:4007/simulate \
    -H 'content-type: application/json' -d "{\"count\": ${chunk}}" > /dev/null
  hub_total=$((hub_total + chunk))
  wait_raw hubcrm "$hub_total"
  npm run backfill -w ingest   # the hydration pump (also a no-op drain of the still-empty pull sources)
done

curl -sf -X POST http://localhost:4006/simulate \
  -H 'content-type: application/json' -d '{"count": 100}' > /dev/null
curl -sf -X POST http://localhost:4008/simulate \
  -H 'content-type: application/json' -d '{"count": 80}' > /dev/null
curl -sf -X POST http://localhost:4004/simulate \
  -H 'content-type: application/json' -d '{"count": 80}' > /dev/null

echo "4b/7 drain: pull the feed/bus through their connectors; wait for the support push path"
npm run backfill -w ingest
wait_raw stripefeed 100
wait_raw casebus 80
wait_raw support 80

echo "4c/7 reconcile all four paradigms (object store / feed window / bus window / ledger-feed)"
npm run reconcile -w ingest

echo "5/7 dbt build"
docker compose run --rm dbt build

echo "5b/7 verify identity resolution against the seed manifest"
npx tsx scripts/verify-identity.ts

echo "6/7 generate report"
npm run report -w agent
mkdir -p out
# npm run report -w agent writes relative to agent workspace; copy artifact to repo-root out/ where check-demo.sh expects it
cp agent/out/monday-report.md out/monday-report.md

echo "7/7 check demo output"
./scripts/check-demo.sh
