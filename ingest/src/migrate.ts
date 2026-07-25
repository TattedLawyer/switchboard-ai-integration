import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import { getPool } from "./db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(pool: pg.Pool): Promise<void> {
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  await grantAgentReadOnly(pool);
}

// The analytics schema name is runtime config (DBT_SCHEMA), so its grants can't live in
// a static migration file. Validated with the same rule as agent/src/host/schema.ts —
// operator config, but it lands in SQL identifier position, so never trust it raw.
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

async function grantAgentReadOnly(pool: pg.Pool): Promise<void> {
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
  await pool.query(
    `alter default privileges in schema ${schema} grant select on tables to switchboard_agent`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = getPool();
  runMigrations(pool).then(() => { console.log("migrated"); return pool.end(); });
}
