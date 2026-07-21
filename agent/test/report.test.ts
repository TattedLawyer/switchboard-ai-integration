process.env.DBT_SCHEMA = "host_test_analytics";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { generateMondayReport } from "../src/host/report.js";
import { TemplateLlm } from "../src/host/llm.js";

const SCHEMA = process.env.DBT_SCHEMA ?? "public_analytics";
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`create schema if not exists ${SCHEMA}`);
  await pool.query(`
    create or replace view ${SCHEMA}.stg_crm__companies as
    select 'DEMO-C-0001'::text as company_id, 'DEMO Retail Group 1'::text as name,
           'retail-1.example.com'::text as domain, now() as last_event_at
  `);
});

afterAll(async () => {
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await pool.end();
});

describe("Monday report (stub)", () => {
  it("produces markdown naming each company from the unified model", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    expect(md).toContain("# Monday Revenue-Risk Report");
    expect(md).toContain("DEMO Retail Group 1");
    expect(md).toContain("DEMO-C-0001");
  });
});
