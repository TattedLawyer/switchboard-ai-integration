#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# G3 — durability. Proves two things that were previously only asserted in prose:
#
#   1. Data survives the container being destroyed and recreated.
#   2. A backup can actually be RESTORED — not merely produced.
#
# Both matter because the failure they guard against is silent and total. Before the named
# volume, `docker compose down` deleted the entire database and nothing anywhere said so; the
# RUNBOOK documented a pg_dump restore path that had never once been executed. "We have
# backups" is not a claim worth making until a restore has been watched working, which is why
# this script performs one rather than describing one.
#
# Run: ./scripts/verify-durability.sh   (destructive: it tears the database down on purpose)

BACKUP_DIR="${BACKUP_DIR:-./out/backups}"
PSQL=(docker compose exec -T postgres psql -U switchboard -d switchboard -tAc)

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $* =="; }

counts() {
  "${PSQL[@]}" "select
      (select count(*) from raw.raw_events)
      || '/' || (select count(*) from ingest.outbox)
      || '/' || (select count(*) from ingest.quarantine)" 2>/dev/null | tr -d ' \r'
}

wait_ready() {
  for _ in $(seq 1 60); do
    if docker compose exec -T postgres pg_isready -U switchboard -q 2>/dev/null; then return 0; fi
    sleep 1
  done
  fail "postgres did not become ready within 60s"
}

step "1/6 seed a known state"
docker compose up -d postgres >/dev/null 2>&1
wait_ready
# Any non-empty state works; the demo is the cheapest way to get a realistic one.
if [[ "$(counts)" == "0/0/0" || -z "$(counts)" ]]; then
  ./scripts/demo.sh >/dev/null 2>&1 || fail "demo.sh could not seed a state to test against"
fi
BEFORE="$(counts || true)"
[[ -n "$BEFORE" && "$BEFORE" != "0/0/0" ]] || fail "no data to test durability against (got '$BEFORE')"
echo "    raw/outbox/quarantine = $BEFORE"

step "2/6 destroy and recreate the container"
docker compose down >/dev/null 2>&1
docker compose up -d postgres >/dev/null 2>&1
wait_ready

step "3/6 assert the data survived"
# `|| true`: when the database is gone psql exits non-zero, and under `set -e` an unguarded
# command substitution would kill this script SILENTLY — reporting nothing about the very
# failure it exists to detect.
AFTER="$(counts || true)"
echo "    raw/outbox/quarantine = ${AFTER:-<database gone>}"
if [[ "$AFTER" != "$BEFORE" ]]; then
  fail "data did NOT survive 'docker compose down'. before=$BEFORE after=${AFTER:-<gone>}
  This is the defect G3 exists to close: without a named volume mounted at
  /var/lib/postgresql/data, the database lives inside the container's writable layer and is
  deleted with it."
fi
echo "    survived."

step "4/6 take a backup"
./scripts/backup.sh >/dev/null || fail "backup.sh failed"
LATEST="$(ls -t "$BACKUP_DIR"/switchboard-*.dump 2>/dev/null | head -1)"
[[ -n "$LATEST" ]] || fail "backup.sh produced no dump in $BACKUP_DIR"
[[ -s "$LATEST" ]] || fail "backup file is empty: $LATEST"
echo "    $LATEST ($(wc -c < "$LATEST" | tr -d ' ') bytes)"

step "5/6 destroy the DATA (not just the container) and restore from that backup"
# Dropping the schemas is a harsher test than dropping the container: it proves the restore
# rebuilds real content, not that the volume quietly still had it.
"${PSQL[@]}" "drop schema if exists raw cascade; drop schema if exists ingest cascade;" >/dev/null
WIPED="$(counts || echo "")"
[[ -z "$WIPED" || "$WIPED" == "//" ]] || fail "expected the wipe to remove the schemas, got '$WIPED'"
./scripts/restore.sh "$LATEST" >/dev/null || fail "restore.sh failed"

step "6/6 assert the restore reproduced the original state exactly"
RESTORED="$(counts || true)"
echo "    raw/outbox/quarantine = ${RESTORED:-<nothing>}"
[[ "$RESTORED" == "$BEFORE" ]] || fail "restore did not reproduce the original state. before=$BEFORE restored=${RESTORED:-<nothing>}"

echo
echo "PASS: data survived container destruction, and a backup was restored to an identical state ($BEFORE)"
