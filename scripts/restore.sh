#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Restore a dump produced by scripts/backup.sh.
#
#   ./scripts/restore.sh out/backups/switchboard-<stamp>.dump
#   ./scripts/restore.sh                # restores the most recent dump
#
# DESTRUCTIVE: --clean --if-exists drops the objects in the dump before recreating them.
# That is deliberate — a restore that only works onto an empty database is not a restore you
# can use in the situation you actually need it in.

BACKUP_DIR="${BACKUP_DIR:-./out/backups}"
DUMP="${1:-}"

if [[ -z "$DUMP" ]]; then
  DUMP="$(ls -t "$BACKUP_DIR"/switchboard-*.dump 2>/dev/null | head -1 || true)"
  [[ -n "$DUMP" ]] || { echo "FAIL: no dump given and none found in $BACKUP_DIR" >&2; exit 1; }
  echo "restoring most recent: $DUMP"
fi

[[ -s "$DUMP" ]] || { echo "FAIL: $DUMP is missing or empty" >&2; exit 1; }

if ! docker compose exec -T postgres pg_isready -U switchboard -q 2>/dev/null; then
  echo "FAIL: postgres is not running (docker compose up -d postgres)" >&2
  exit 1
fi

# Roles are cluster-level and are NOT in a logical dump. Restoring into a fresh cluster would
# fail on every GRANT to switchboard_agent / switchboard_app. Creating them first makes the
# restore work against an empty cluster as well as an existing one.
docker compose exec -T postgres psql -U switchboard -d switchboard -v ON_ERROR_STOP=1 -q <<'SQL'
do $$
begin
  if not exists (select from pg_roles where rolname = 'switchboard_agent') then
    create role switchboard_agent login password 'switchboard_agent';
  end if;
  if not exists (select from pg_roles where rolname = 'switchboard_app') then
    create role switchboard_app login password 'switchboard_app';
  end if;
exception when duplicate_object then null;
end $$;
SQL

# --clean --if-exists: drop-then-recreate, tolerating objects that aren't there.
# --no-owner: the dump's ownership is re-applied by whoever runs the restore, so a restore into
# a differently-named role does not fail on every object.
# Exit status is checked explicitly: pg_restore warns on benign drop failures, so we assert on
# the RESULT (verify-durability.sh compares row counts) rather than treating any stderr as fatal.
# The archive is copied INTO the container rather than piped: pg_restore's custom format seeks
# within the file to read its table of contents, and a pipe is not seekable — piping it fails
# with "did not find magic string in file header" even though the dump is perfectly valid.
docker compose cp "$DUMP" postgres:/tmp/restore.dump >/dev/null

set +e
docker compose exec -T postgres pg_restore -U switchboard -d switchboard \
  --clean --if-exists --no-owner --single-transaction /tmp/restore.dump
code=$?
set -e
docker compose exec -T postgres rm -f /tmp/restore.dump >/dev/null 2>&1 || true

if [[ "$code" -ne 0 ]]; then
  echo "FAIL: pg_restore exited $code — the database may be partially restored." >&2
  echo "  --single-transaction means a failed restore rolls back rather than leaving a half-state." >&2
  exit 1
fi

echo "restored from $DUMP"
