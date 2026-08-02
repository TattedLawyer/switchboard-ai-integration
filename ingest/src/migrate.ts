import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import { getPool } from "./db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Advisory-lock identity for concurrent-boot serialization (close F14). Two-int32 form
 *  of pg_advisory_lock; the keyspace is per-database, so parallel test databases never
 *  contend. Values are ASCII 'SWBC'/'MIGR' — arbitrary but stable, and tests import
 *  THIS constant so the guarded key and the asserted key cannot drift. */
export const MIGRATION_LOCK_KEYS = [0x53574243, 0x4d494752] as const;

export interface AppliedMigration {
  filename: string;
  checksum: string;
  applied_at: Date;
}

/** What this database believes it has applied, in filename order. Accepts a checked-out
 *  client too, because the guarded section below must do ALL its reads and writes on the
 *  one connection that holds the advisory lock. */
export async function appliedMigrations(db: pg.Pool | pg.PoolClient): Promise<AppliedMigration[]> {
  const res = await db.query(
    "select filename, checksum, applied_at from ingest.schema_migrations order by filename",
  );
  return res.rows as AppliedMigration[];
}

/**
 * Applies any migration this database has not seen, and refuses to proceed if one it HAS seen
 * no longer matches the file on disk.
 *
 * Before tracking existed, every file re-ran on every start and correctness rested entirely on
 * each migration being hand-proven idempotent. That holds until someone edits an applied
 * migration or one fails halfway: the database's real shape then differs from what the files
 * say, and nothing anywhere notices. Recording a checksum turns that silent divergence into a
 * startup failure naming the offending file.
 *
 * Deliberately NOT a migration framework — no down-migrations, no out-of-order handling. Those
 * are real needs at real scale and pretending to solve them here would be worse than the gap.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  // ── Concurrent-boot serialization (close F14, researched) ─────────────────────────────
  // Two replicas booting against the same fresh database race this runner; 003's
  // `drop … cascade` makes that a real hazard, not cosmetic churn. The guard is a
  // SESSION-level pg_advisory_lock — chosen over pg_advisory_xact_lock deliberately,
  // because a transaction-level lock would force one transaction around the whole run
  // and change the per-file retry semantics below (each file recorded only after it
  // succeeds; a mid-file failure is retried next boot).
  //
  // THE LOCK MUST LIVE ON ONE DEDICATED CLIENT. This runner used to issue every
  // statement through pool.query, and successive pool.query calls may execute on
  // DIFFERENT pooled connections — a session lock taken that way binds to whichever
  // connection served that single call, and protects nothing that follows (a silent
  // no-op, the research's key finding). So: one pool.connect(), lock at entry, the
  // ENTIRE guarded section on that client, try/finally unlock; if the unlock cannot be
  // confirmed the client is DESTROYED rather than returned, so session end releases the
  // lock as the backstop and a pooled-but-still-locked connection can never deadlock
  // the next boot.
  //
  // Disclosed caveat: if a transaction-pooling proxy (e.g. PgBouncer, whose feature
  // table marks session advisory locks "Never" compatible with transaction pooling) is
  // ever put in front of this database, a session-level lock here silently stops
  // locking — revisit the mechanism then. Nothing in this stack runs one today.
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query("select pg_advisory_lock($1, $2)", [...MIGRATION_LOCK_KEYS]);
    try {
      await runMigrationsOn(client);
    } finally {
      try {
        await client.query("select pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK_KEYS]);
      } catch {
        destroyClient = true; // unlock unconfirmed — end the session instead of pooling it
      }
    }
  } finally {
    client.release(destroyClient);
  }
}

/** The guarded body: every statement on the ONE client that holds the advisory lock. */
async function runMigrationsOn(client: pg.PoolClient): Promise<void> {
  // Bootstrap: the tracking table cannot itself be tracked, so it is created idempotently on
  // every run. `ingest` may not exist yet on a virgin database.
  await client.query("create schema if not exists ingest");
  await client.query(`
    create table if not exists ingest.schema_migrations (
      filename   text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const seen = new Map(
    (await appliedMigrations(client)).map((m) => [m.filename, m.checksum] as const),
  );

  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const previous = seen.get(file);

    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `migration ${file} has CHANGED since it was applied ` +
            `(recorded ${previous.slice(0, 12)}…, on disk ${checksum.slice(0, 12)}…). ` +
            `This database and the repository disagree about what schema exists. ` +
            `Add a new migration rather than editing an applied one; if the edit was ` +
            `intentional and the change is already present, update the recorded checksum ` +
            `deliberately.`,
        );
      }
      continue; // already applied, unchanged — skip
    }

    await client.query(sql);
    // Recorded only AFTER the migration succeeds, so a failure mid-file leaves it unrecorded
    // and it is retried on the next start rather than being assumed done.
    await client.query(
      "insert into ingest.schema_migrations (filename, checksum) values ($1, $2) " +
        "on conflict (filename) do update set checksum = excluded.checksum",
      [file, checksum],
    );
  }

  await grantAgentReadOnly(client);
}

// The analytics schema name is runtime config (DBT_SCHEMA), so its grants can't live in
// a static migration file. Validated with the same rule as agent/src/host/schema.ts —
// operator config, but it lands in SQL identifier position, so never trust it raw.
// B9: DBT_ROLE (the role dbt connects as) is the same kind of config and passes the
// same identifier gate before landing in FOR ROLE position.
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

async function grantAgentReadOnly(pool: pg.Pool | pg.PoolClient): Promise<void> {
  const schema = process.env.DBT_SCHEMA ?? "public_analytics";
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid DBT_SCHEMA "${schema}": must match ${SCHEMA_RE}`);
  }
  // Created here (dbt tolerates a pre-existing schema) so USAGE and default privileges
  // can attach before dbt's first build; default privileges carry SELECT onto every
  // relation dbt later (re)creates, which plain GRANTs would lose on drop-and-recreate.
  await pool.query(`create schema if not exists ${schema}`);
  await pool.query(`grant usage on schema ${schema} to switchboard_agent`);
  await pool.query(`grant select on all tables in schema ${schema} to switchboard_agent`);

  // B9: ALTER DEFAULT PRIVILEGES binds to "the current role if unspecified" (Postgres
  // docs) — i.e. to whoever runs THIS migration, not to dbt. Unscoped, the entry covers
  // nothing a differently-rolled dbt later (re)creates, silently. The target role is
  // runtime config (DBT_ROLE); when set, the grant is scoped FOR ROLE after two
  // precondition checks the docs impose: the role must exist, and the executor must be
  // a member of it (superusers pass trivially). Absent → the pre-B9 unscoped statement
  // runs unchanged AND the limitation is logged, so no existing deployment breaks.
  // (Docs caveat carried here: per-schema default privileges ADD to any global ones —
  // scoping this entry narrows nothing granted elsewhere.)
  const dbtRole = process.env.DBT_ROLE;
  if (dbtRole === undefined || dbtRole === "") {
    // stdout, not stderr: this is a disclosed configuration limitation, not a failure —
    // stderr on this repo's operational surfaces is reserved for real problems (gap
    // disclosures, failures), and the CI fixture pins its own stderr EMPTY.
    console.log(
      "[migrate] DBT_ROLE not set — default privileges bind to the migrator's own role, " +
        "so tables (re)created by a different dbt role will NOT carry the agent grant. " +
        "Set DBT_ROLE to the role dbt connects as to scope the grant FOR ROLE.",
    );
    await pool.query(
      `alter default privileges in schema ${schema} grant select on tables to switchboard_agent`,
    );
    return;
  }
  if (!SCHEMA_RE.test(dbtRole)) {
    throw new Error(`invalid DBT_ROLE "${dbtRole}": must match ${SCHEMA_RE}`);
  }
  const exists = await pool.query("select 1 from pg_roles where rolname = $1", [dbtRole]);
  if (exists.rowCount === 0) {
    throw new Error(
      `DBT_ROLE "${dbtRole}" does not exist in this database cluster — ` +
        `create the role dbt connects as, or unset DBT_ROLE to keep the unscoped grant.`,
    );
  }
  const member = await pool.query(
    "select pg_has_role(current_user, $1::name, 'member') as is_member, current_user as who",
    [dbtRole],
  );
  if (!member.rows[0].is_member) {
    throw new Error(
      `cannot scope default privileges FOR ROLE "${dbtRole}": migrator role ` +
        `"${member.rows[0].who}" is not a member of "${dbtRole}" (ALTER DEFAULT PRIVILEGES ` +
        `requires membership — GRANT "${dbtRole}" TO "${member.rows[0].who}", or migrate as a member).`,
    );
  }
  await pool.query(
    `alter default privileges for role ${dbtRole} in schema ${schema} grant select on tables to switchboard_agent`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = getPool();
  runMigrations(pool).then(() => { console.log("migrated"); return pool.end(); });
}
