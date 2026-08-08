#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
# A1 (Phase 3): the agent credential is REQUIRED, never derived from DATABASE_URL —
# agentConnectionString() fails closed. Pinned explicitly here so the agent never sees
# the full-privilege credential as its own fallback.
export AGENT_DATABASE_URL="${AGENT_DATABASE_URL:-postgres://switchboard_agent:switchboard_agent@localhost:5433/switchboard}"
# All three sources under fault injection simultaneously — the source-agnostic-spine proof,
# now spanning TWO paradigms (F-1c): hubcrm (thin webhooks + hydration; the store is the
# reconcile truth) beside the 2a billing/support ledger-feeds. Reconcile (ingest CLI)
# iterates INGEST_SOURCES and exits nonzero if ANY source has discrepancies, so PASS
# requires all three to reconcile clean under their own paradigm's oracle.
export INGEST_SOURCES=hubcrm,billing,support

# Identity for THIS run's ingest process. /status echoes it back, and instance_wait refuses
# to proceed unless the process answering :4002 returns exactly this value -- proving we are
# driving the server we just started rather than one stranded by an earlier run.
export INGEST_INSTANCE_ID="${INGEST_INSTANCE_ID:-run-$$-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

# Demo runs on the published dev secrets by design (proves the mechanism, not secrecy).
# Production must set WEBHOOK_SECRET_* and LEDGER_HMAC_KEY instead — see A2 fail-closed.
export ALLOW_DEV_SECRETS=1
# Absolute paths (mock workspace processes have different cwds). Per-source env consumed by
# the reconcile CLI; each mock still takes its own LEDGER_PATH at its start line below.
# hubcrm's ledger is the EMISSION-side hash-chained record (F-1c): every event the store
# emits — including ones the fault plan drops — so losses are nameable against it.
export LEDGER_PATH_HUBCRM="$(pwd)/out/ledger-hubcrm.jsonl"
export LEDGER_PATH_BILLING="$(pwd)/out/ledger-billing.jsonl"
export LEDGER_PATH_SUPPORT="$(pwd)/out/ledger-support.jsonl"

# CHAOS_SKIP_BACKFILL=1 is a RED-proof escape hatch: skip the backfill/hydration recovery
# step so that reconcile fails per paradigm — the ledger-feeds red on the events lost to
# injected drops, and hubcrm reds on un-hydrated thin events (hydration pending violates
# the trichotomy) PLUS the dropped webhooks its red-mode fault plan injects (missing/
# drifted objects). Proves the detector detects per source. CHAOS_SEED varies the fault
# plan (Task 11's workflow feeds it).
SKIP_BACKFILL="${CHAOS_SKIP_BACKFILL:-0}"
CHAOS_SEED="${CHAOS_SEED:-7}"


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

# B2: job control ON — each backgrounded `npm run …` pipeline becomes its own process
# group, and the trap kills the GROUP (`kill -- -PGID`), not just npm's PID: npm has not
# forwarded SIGTERM to its child since 9.8.x/Node 20.5 (npm/cli#6684), so a PID-only
# kill strands the node grandchild on the port. Full mechanism rationale (and why
# setsid/pkill -P were refuted) in demo.sh's identical block; lsof guidance in the
# guards below remains the stale-state recovery path.
set -m
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill -- -"$p" 2>/dev/null || true; done; }
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

echo "3/8 clean state (raw, ingest.ingest_journal, ingest.quarantine, ledgers, report artifacts)"
docker compose exec -T postgres psql -U switchboard -c \
  "truncate table raw.raw_events, ingest.ingest_journal, ingest.quarantine, ingest.hydrated_snapshots restart identity;" > /dev/null
docker compose exec -T postgres psql -U switchboard -c \
  "delete from ingest.gap_ledger;" > /dev/null
# Reset the backfill cursors too, otherwise a stale cursor from a prior chaos run would make
# the mocks' fresh /simulate events (which restart seq at 1) look already-consumed.
docker compose exec -T postgres psql -U switchboard -c \
  "delete from ingest.cursors;" > /dev/null
# Clear ALL queued jobs so stale jobs from pre-rename runs (old 'ingest-event' queue names)
# can never poison the settle-wait. Guarded: pgboss schema does not exist on a fresh DB.
docker compose exec -T postgres psql -U switchboard -c \
  "delete from pgboss.job;" > /dev/null 2>&1 || true
rm -f "$LEDGER_PATH_HUBCRM" "$LEDGER_PATH_BILLING" "$LEDGER_PATH_SUPPORT" out/ledger.jsonl out/ledger-crm.jsonl out/monday-report.md out/chaos-report.txt

echo "4/8 start ingest (receiver+worker) + mock hubcrm/billing/support (shared default manifest seed 42 —
do NOT pass divergent seeds or cross-system correlation breaks)"
# BACKFILL_INTERVAL_MS pinned high so the in-process scheduled poller cannot fire mid-run —
# the RED-mode detector proof (CHAOS_SKIP_BACKFILL=1) depends on dropped events staying
# unrecovered until the explicit backfill step below.
mkdir -p out  # log redirects + ledgers land here; gitignored, absent on fresh clones
INGEST_INSTANCE_ID="$INGEST_INSTANCE_ID" PORT=4002 BACKFILL_INTERVAL_MS=600000 npm run start -w ingest > out/log-ingest.txt 2>&1 & pids+=($!)
PORT=4007 WEBHOOK_URL=http://localhost:4002/webhooks/hubcrm  LEDGER_PATH="$LEDGER_PATH_HUBCRM"  npm run start -w mocks/hubcrm  > out/log-hubcrm.txt 2>&1 & pids+=($!)
PORT=4003 WEBHOOK_URL=http://localhost:4002/webhooks/billing LEDGER_PATH="$LEDGER_PATH_BILLING" npm run start -w mocks/billing > out/log-billing.txt 2>&1 & pids+=($!)
PORT=4004 WEBHOOK_URL=http://localhost:4002/webhooks/support LEDGER_PATH="$LEDGER_PATH_SUPPORT" npm run start -w mocks/support > out/log-support.txt 2>&1 & pids+=($!)
# Liveness is not readiness — see the same guard in demo.sh. This script's own assumption
# (line ~57: "fresh /simulate events, which restart seq at 1") is only true if the mocks we
# talk to are ours. Assert it rather than comment it.
fresh_wait() {
  local port="$1" name="$2" status=""
  ready_wait "$port" "$name"
  status="$(curl -s "http://localhost:${port}/status")"
  if ! printf '%s' "$status" | grep -q '"fresh":true'; then
    echo "FAIL: ${name} (port ${port}) answered but is NOT fresh: ${status}" >&2
    echo "  A leftover mock from a previous run holds this port ('npm run' does not reap its" >&2
    echo "  grandchild on SIGTERM — npm/cli#6684), so our server never bound. Free it and re-run:" >&2
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
fresh_wait 4007 hubcrm; fresh_wait 4003 billing; fresh_wait 4004 support

# hubcrm runs 240 ops = the mock's exported OPS_UNTIL_MERGES_COMPLETE (both manifest
# merges fire — the chaos run exercises merge metabolism: consumed objects classify as
# mergedAwayRaw, never as loss). Its fault plan speaks the paradigm's own weather:
# duplicates (re-delivered requests), holdovers (cross-batch disorder), within-batch
# shuffle, and a bounded redelivery budget riding transient door errors. NO dropRate in
# the green path — a permanently dropped webhook is this paradigm's ADMITTED loss class
# (10-retries-then-gone) with no feed to backfill from; recovery machinery for it is a
# registered follow-up, and the RED mode below proves the detector sees the loss.
# billing/support keep the full 2a plan (drops recovered by feed backfill).
echo "5/8 simulate with injected faults (seed $CHAOS_SEED): hubcrm 240 ops (dup 0.15, holdover 0.15, shuffle), billing/support 200 events (drop 0.2, dup 0.15, apiError 0.2)"
fault_body() { printf '{"count": 200, "fault_plan": {"seed": %s, "dropRate": 0.2, "dupRate": 0.15, "apiErrorRate": 0.2}}' "$CHAOS_SEED"; }
if [[ "$SKIP_BACKFILL" == "1" ]]; then
  # RED mode: inject permanent webhook drops so reconcile must name missing objects.
  hub_fault_body() { printf '{"count": 240, "redeliver_attempts": 3, "fault_plan": {"seed": %s, "dropRate": 0.2, "dupRate": 0.15, "holdoverRate": 0.15, "shuffleWithinBatch": true}}' "$CHAOS_SEED"; }
else
  hub_fault_body() { printf '{"count": 240, "redeliver_attempts": 3, "fault_plan": {"seed": %s, "dupRate": 0.15, "holdoverRate": 0.15, "shuffleWithinBatch": true}}' "$CHAOS_SEED"; }
fi
curl -sf -X POST http://localhost:4007/simulate -H 'content-type: application/json' -d "$(hub_fault_body)" > /dev/null
curl -sf -X POST http://localhost:4003/simulate -H 'content-type: application/json' -d "$(fault_body)" > /dev/null
curl -sf -X POST http://localhost:4004/simulate -H 'content-type: application/json' -d "$(fault_body)" > /dev/null

echo "5b/8 bounded settle-wait for push-path (raw count stable + queue quiescent — no fixed total: billing/support drop ~20% and hubcrm absorbs duplicates)"
# Backoff-aware quiescence: queue_pending counts created/active AND retry jobs for the
# ingest queues, so a job parked in pg-boss retry backoff still holds the wait open. The
# bound must therefore cover worst-case cumulative retry backoff, not just steady-state
# throughput — the old 60s window flaked ~1-in-3 with ~20 jobs still in backoff (harness
# gave up early; no data loss). 240s default, overridable via CHAOS_SETTLE_TIMEOUT_S.
SETTLE_TIMEOUT_S="${CHAOS_SETTLE_TIMEOUT_S:-240}"
raw_count() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from raw.raw_events" | tr -d ' '; }
queue_pending() { docker compose exec -T postgres psql -U switchboard -tAc "select count(*) from pgboss.job where name like 'ingest-%' and state in ('created','active','retry')" | tr -d ' '; }
queue_breakdown() { docker compose exec -T postgres psql -U switchboard -tAc "select state || '=' || count(*) from pgboss.job where name like 'ingest-%' and state in ('created','active','retry') group by state" | tr '\n' ' '; }
ledger_line_count() { wc -l < "$1" 2>/dev/null | tr -d ' ' || echo 0; }
stable_polls=0
prev="-1"
settled=false
settle_start="$(date +%s)"
while (( $(date +%s) - settle_start < SETTLE_TIMEOUT_S )); do
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
$settled || { echo "FAIL: push-path did not settle within ${SETTLE_TIMEOUT_S}s (raw=$(raw_count) pending=$(queue_pending): $(queue_breakdown))"; exit 1; }
echo "    settled: raw=$(raw_count) queue_pending=$(queue_pending) (ledgers: hubcrm=$(ledger_line_count "$LEDGER_PATH_HUBCRM") billing=$(ledger_line_count "$LEDGER_PATH_BILLING") support=$(ledger_line_count "$LEDGER_PATH_SUPPORT") events emitted by simulate)"

if [[ "$SKIP_BACKFILL" == "1" ]]; then
  echo "6/8 SKIPPED (CHAOS_SKIP_BACKFILL=1) — leaving dropped events unrecovered and hubcrm un-hydrated on purpose"
else
  echo "6/8 backfill all sources (feed recovery for the ledger-feeds; the hydration pump for hubcrm; retry up to 3x on exit 1 — 429 streaks can abort a run; cursors are resumable)"
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

echo "7/8 reconcile each source under its own paradigm's oracle — hubcrm: store vs raw thin events vs hydrated snapshots; billing/support: ledger vs raw (PASS requires ALL of: ${INGEST_SOURCES})"
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
