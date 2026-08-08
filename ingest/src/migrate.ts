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
  await applyAppRolePassword(client);
}

/**
 * SEC-I3. Migration 006 mints `switchboard_app` with `login password 'switchboard_app'` —
 * a credential that does not vary per installation, which is CWE-1392's exact shape, and
 * the role holds select/insert/update/delete on every table in `raw` and `ingest`. The
 * literal is the LOCAL DEV value (same class as the committed compose password); this is
 * the override, in the same place and of the same shape as `AGENT_DB_PASSWORD` gives the
 * agent role — 006 itself is applied and immutable, so the override lives here.
 *
 * Deliberately NOT fail-closed. CWE-1392 rates "prohibit a value that does not vary per
 * installation" higher than "let the administrator change it", and a migration that
 * refuses to run without a new secret would be the stricter reading — but `npm run migrate`
 * is on the one-command demo path, and breaking that buys nothing in the single-tenant
 * demo posture. Migration 005 already set the internal precedent for exactly this trade.
 *
 * ROTATION (the note migration 005 carries and 006 does not): to rotate, either set
 * APP_DB_PASSWORD and re-run migrate, or
 *
 *     alter role switchboard_app password '<new secret>';
 *
 * A rotation done that way is NOT reset by re-migration when APP_DB_PASSWORD is unset —
 * this function only acts when the variable is set — and `scripts/restore.sh` creates the
 * role only `if not exists`, so recovery does not reset it either.
 *
 * Deferred with the wave (see KNOWN-ISSUES): narrowing the grant from
 * `select,insert,update,delete on all tables in raw, ingest` to least privilege. That is a
 * behaviour-changing privilege edit the isolation test depends on, and it is separable
 * from the credential defect, which is the urgent half.
 */
async function applyAppRolePassword(pool: pg.Pool | pg.PoolClient): Promise<void> {
  const password = process.env.APP_DB_PASSWORD;
  if (password === undefined || password === "") return;
  // Parameterised placeholders are not allowed in ALTER ROLE, so the value is quoted with
  // the server's own literal quoter rather than string-concatenated.
  await pool.query("select format('alter role switchboard_app password %L', $1::text) as stmt", [password])
    .then((res) => pool.query(res.rows[0].stmt as string));
  console.log("[migrate] switchboard_app password set from APP_DB_PASSWORD");
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
