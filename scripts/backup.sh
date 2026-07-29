#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Logical backup of the whole database, in pg_restore's custom format.
#
# Custom format (-Fc) rather than plain SQL: it is compressed, and it lets restore.sh use
# --clean --if-exists to drop existing objects before recreating them, which is what makes a
# restore idempotent instead of a pile of "already exists" errors on a non-empty database.
#
# This is a LOGICAL backup — it captures schemas, data, roles' grants on objects, but not the
# cluster's roles themselves. Restoring into a fresh cluster therefore needs the roles to exist
# first; migration 005/006 create them, which is why restore.sh re-runs migrations when the
# target is empty. Documented rather than discovered later.

BACKUP_DIR="${BACKUP_DIR:-./out/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/switchboard-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

if ! docker compose exec -T postgres pg_isready -U switchboard -q 2>/dev/null; then
  echo "FAIL: postgres is not running (docker compose up -d postgres)" >&2
  exit 1
fi

# EXCLUDE the pg-boss schema, deliberately. Two reasons:
#
#   1. Correctness: pg-boss partitions its tables by date, and a partition's primary key is
#      INHERITED from its parent. `pg_restore --clean` tries to drop those constraints
#      individually and Postgres refuses ("cannot drop inherited constraint"), so a full-cluster
#      dump cannot actually be restored. A backup that will not restore is not a backup.
#   2. Semantics: pgboss holds in-flight job state, not business data, and pg-boss recreates its
#      schema on boot. Restoring a queue's internal partitions into a different point in time is
#      not something you want even when it works.
#
# TRADE-OFF, stated rather than buried: dead-lettered jobs live in pgboss and are therefore NOT
# in this backup. They are recoverable — every delivered event is in the source ledger, so
# backfill + reconcile rebuild what the DLQ was holding — but a restore does not preserve DLQ
# depth. If DLQ contents ever become independently precious, they need to be drained into a
# real table rather than left in the queue's internals.
docker compose exec -T postgres pg_dump -U switchboard -d switchboard -Fc \
  --exclude-schema=pgboss > "$OUT"

# A dump that exists but is empty or truncated is worse than no dump, because it looks like a
# backup. Verify the archive is readable by pg_restore before calling this a success.
if [[ ! -s "$OUT" ]]; then
  rm -f "$OUT"
  echo "FAIL: produced an empty dump" >&2
  exit 1
fi
# Verify by listing the archive's table of contents. NOTE: this must run against a real file
# inside the container, not `/dev/stdin` — pg_restore's custom format seeks within the archive
# to read its TOC, and a pipe is not seekable ("did not find magic string in file header").
# The same constraint applies to restore.sh.
docker compose cp "$OUT" postgres:/tmp/verify.dump >/dev/null 2>&1
if ! docker compose exec -T postgres pg_restore --list /tmp/verify.dump > /dev/null 2>&1; then
  docker compose exec -T postgres rm -f /tmp/verify.dump >/dev/null 2>&1 || true
  rm -f "$OUT"
  echo "FAIL: dump is not a readable pg_restore archive — refusing to keep a corrupt backup" >&2
  exit 1
fi
docker compose exec -T postgres rm -f /tmp/verify.dump >/dev/null 2>&1 || true

echo "wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, verified readable)"
