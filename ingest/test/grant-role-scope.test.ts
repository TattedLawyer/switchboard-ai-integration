import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { runMigrations } from "../src/migrate.js";

// B9 (debt-burn): the RUNTIME default-privilege grant in migrate.ts is not FOR ROLE-
// scoped. Postgres (ALTER DEFAULT PRIVILEGES): "Change default privileges for objects
// created by the target_role, or the current role if unspecified." So the unscoped form
// covers only relations later created BY THE MIGRATOR'S ROLE — if dbt connects as any
// other role, its drop-and-recreated tables silently carry no agent grant, the exact
// loss default privileges were chosen to prevent. Migration 007 fixed the STATIC grants
// (hardwired FOR ROLE switchboard, default schema); this pays the residual: the runtime
// grant that handles DBT_SCHEMA overrides needs the dbt role as runtime config too —
// a new validated env var, DBT_ROLE, with a membership precondition (the docs' caveat:
// the executor must be a member of the target role) and, when absent, the current
// behavior preserved WITH the limitation logged at migrate time.

let pool: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DBT_ROLE_NAME = `b9_dbt_${RUN_ID}`;
const OUTSIDER = `b9_outsider_${RUN_ID}`;

beforeAll(async () => {
  const r = await freshTestDb();
  pool = r.pool;
  url = r.url;
  cleanup = r.cleanup;
  await pool.query(`create role "${DBT_ROLE_NAME}"`);
  // A NON-superuser migrator that can read the tracking table (via switchboard
  // membership) but is NOT a member of the dbt role — the membership-precondition case.
  await pool.query(`create role "${OUTSIDER}" login password 'b9-test' in role switchboard`);
});
afterAll(async () => {
  await pool.query(`drop owned by "${OUTSIDER}"`).catch(() => {});
  await pool.query(`drop role if exists "${OUTSIDER}"`).catch(() => {});
  await pool.query(`drop owned by "${DBT_ROLE_NAME}"`).catch(() => {});
  await pool.query(`drop role if exists "${DBT_ROLE_NAME}"`).catch(() => {});
  await cleanup();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("B9: grantAgentReadOnly scopes default privileges FOR ROLE <dbt role>", () => {
  it("rejects a DBT_ROLE that is not a plain identifier, naming the variable", async () => {
    vi.stubEnv("DBT_ROLE", "bad-role; drop table x");
    await expect(runMigrations(pool)).rejects.toThrow(/invalid DBT_ROLE/);
  });

  it("rejects a DBT_ROLE that does not exist, naming role and remedy", async () => {
    vi.stubEnv("DBT_ROLE", "b9_role_that_does_not_exist");
    await expect(runMigrations(pool)).rejects.toThrow(
      /DBT_ROLE "b9_role_that_does_not_exist" does not exist/,
    );
  });

  it("with DBT_ROLE set, the catalog shows the default-privilege entry bound to the DBT ROLE, not the migrator", async () => {
    vi.stubEnv("DBT_ROLE", DBT_ROLE_NAME);
    await runMigrations(pool); // idempotent re-run: only the grant step has work to do
    const acl = await pool.query(
      `select r.rolname as target_role, d.defaclacl::text as acl
         from pg_default_acl d
         join pg_roles r on r.oid = d.defaclrole
         join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public_analytics' and d.defaclobjtype = 'r'
          and r.rolname = $1`,
      [DBT_ROLE_NAME],
    );
    expect(acl.rowCount).toBe(1);
    expect(acl.rows[0].acl).toContain("switchboard_agent=r");
  });

  it("a migrator that is NOT a member of DBT_ROLE gets the precondition error, not a raw Postgres failure", async () => {
    // Non-superuser executor (superusers pass every membership check, so the shipped
    // superuser config can never exercise this guard).
    const outsiderUrl = url.replace(/\/\/[^@]+@/, `//${OUTSIDER}:b9-test@`);
    const opool = new pg.Pool({ connectionString: outsiderUrl });
    try {
      vi.stubEnv("DBT_ROLE", DBT_ROLE_NAME);
      await expect(runMigrations(opool)).rejects.toThrow(
        new RegExp(`not a member of "${DBT_ROLE_NAME}"`),
      );
    } finally {
      await opool.end();
    }
  });

  it("DBT_ROLE absent → prior behavior preserved AND the limitation logged at migrate time (operator surface, wording pinned)", async () => {
    vi.stubEnv("DBT_ROLE", "");
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    await runMigrations(pool);
    const line = warns.find((w) => w.includes("DBT_ROLE"));
    expect(line).toBe(
      "[migrate] DBT_ROLE not set — default privileges bind to the migrator's own role, " +
        "so tables (re)created by a different dbt role will NOT carry the agent grant. " +
        "Set DBT_ROLE to the role dbt connects as to scope the grant FOR ROLE.",
    );
    // and the unscoped entry (bound to the current role) still lands — behavior preserved
    const acl = await pool.query(
      `select r.rolname as target_role
         from pg_default_acl d
         join pg_roles r on r.oid = d.defaclrole
         join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public_analytics' and d.defaclobjtype = 'r'
          and r.rolname = current_user`,
    );
    expect(acl.rowCount).toBe(1);
  });
});
