// Gate B claim pin for A1: "the agent is read-only" must be a property the DATABASE
// enforces, not a naming convention. Before this wave, the agent pool connected as the
// app superuser and the READ_TOOLS allowlist was the only thing between the agent and a
// write (external audit 2026-07-25, readiness R-series; OWASP Agentic ASI03 pattern).
// These tests run real statements through the agent role's own connection and assert
// Postgres refuses them with 42501 (insufficient_privilege) — and that the one thing the
// role exists to do (read the analytics schema) still works.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import pg from "pg";
import { runMigrations } from "../../ingest/src/migrate.js";
import { agentConnectionString } from "../src/host/agent-db.js";

const SCHEMA = "agent_priv_test";
// PRE-3 (#41): scoped to this suite instead of assigned at module top level. A bare
// `process.env.DBT_SCHEMA = ...` above the imports is a side effect of IMPORT, so it
// outlives this file the moment these suites share a process — which is exactly the
// parallelisation trigger the register entry names. `vi.stubEnv` undoes itself.
beforeAll(() => {
  vi.stubEnv("DBT_SCHEMA", SCHEMA);
});
afterAll(() => {
  vi.unstubAllEnvs();
});
let admin: pg.Pool;
let agent: pg.Pool;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // Fresh schema, then migrate: migration 005 creates the role; the dynamic step in
  // migrate.ts creates this DBT_SCHEMA and applies USAGE + SELECT + default privileges.
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await runMigrations(admin);
  // Fixture created AFTER migration, as the app role — proving default privileges carry
  // SELECT to relations dbt (re)creates later, not just ones existing at grant time.
  await admin.query(`create table ${SCHEMA}.mart_fixture (entity_id text primary key, amount int)`);
  await admin.query(`insert into ${SCHEMA}.mart_fixture values ('DEMO-C-0001', 42)`);
  agent = new pg.Pool({ connectionString: agentConnectionString(), max: 2 });
});

afterAll(async () => {
  if (agent) await agent.end();
  await admin.query(`drop schema if exists ${SCHEMA} cascade`);
  await admin.end();
});

describe("A1: agent role is read-only as a database fact", () => {
  it("reads the analytics schema — the one capability the role exists for", async () => {
    const r = await agent.query(`select entity_id, amount from ${SCHEMA}.mart_fixture`);
    expect(r.rows).toEqual([{ entity_id: "DEMO-C-0001", amount: 42 }]);
  });

  it("INSERT into the mart is refused by Postgres (42501)", async () => {
    await expect(
      agent.query(`insert into ${SCHEMA}.mart_fixture values ('DEMO-C-0002', 1)`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("UPDATE and DELETE are refused (42501)", async () => {
    await expect(agent.query(`update ${SCHEMA}.mart_fixture set amount = 0`)).rejects.toMatchObject(
      { code: "42501" },
    );
    await expect(agent.query(`delete from ${SCHEMA}.mart_fixture`)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("cannot SELECT raw or ingest schemas at all — least privilege, not read-everything", async () => {
    await expect(agent.query(`select count(*) from raw.raw_events`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(agent.query(`select count(*) from ingest.quarantine`)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("cannot CREATE tables in the analytics schema or public", async () => {
    await expect(agent.query(`create table ${SCHEMA}.evil (id int)`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(agent.query(`create table public.evil (id int)`)).rejects.toMatchObject({
      code: "42501",
    });
  });
});
