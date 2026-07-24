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
  // Unified mart fixture (columns match warehouse/models/marts/customer_360.sql): the two
  // canonical companies plus one incomplete billing-only entity. The merged-away dupes
  // DEMO-C-0021/0022 have NO rows here — they only exist in the legacy staging view below,
  // which is provisioned deliberately so the old stg_crm__companies wiring goes RED.
  await pool.query(`
    create or replace view ${SCHEMA}.customer_360 as
    select 'DEMO-C-0001'::text as entity_id, 'DEMO Logistics Group 1'::text as entity_name,
           'logistics-1.example.com'::text as domain,
           true as has_crm, true as has_billing, true as has_support, true as is_complete,
           2::bigint as open_deal_count, 500000::bigint as open_deal_amount_cents,
           120000::bigint as total_invoiced_cents, 100000::bigint as total_paid_cents,
           1::bigint as open_invoice_count, 0::bigint as failed_payment_count,
           3::bigint as open_ticket_count, 1::bigint as solved_ticket_count,
           0::bigint as sla_breach_count, 4.50::numeric(3,2) as avg_csat
    union all
    select 'DEMO-C-0002', 'DEMO Manufacturing Group 2', 'manufacturing-2.example.com',
           true, false, false, true,
           1, 250000, 0, 0, 0, 0, 0, 0, 0, null
    union all
    select 'billing:B-0015', 'DEMO Orphan Billing', 'orphan.example.com',
           false, true, false, false,
           0, 0, 90000, 90000, 0, 1, 0, 0, 0, null
  `);
  await pool.query(`
    create or replace view ${SCHEMA}.stg_crm__companies as
    select 'DEMO-C-0001'::text as company_id, 'DEMO Logistics Group 1'::text as name,
           'logistics-1.example.com'::text as domain, now() as last_event_at
    union all select 'DEMO-C-0002', 'DEMO Manufacturing Group 2', 'manufacturing-2.example.com', now()
    union all select 'DEMO-C-0021', 'DEMO Logistics Group 1 Inc', 'logistics-1.example.com', now()
    union all select 'DEMO-C-0022', 'DEMO Manufacturing Group 2', 'manufacturing-2.example.com', now()
  `);
});

afterAll(async () => {
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await pool.end();
});

describe("Monday report (stub)", () => {
  it("lists each CANONICAL entity from customer_360 with unified fields", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    expect(md).toContain("# Monday Revenue-Risk Report");
    expect(md).toContain("DEMO-C-0001");
    expect(md).toContain("DEMO Logistics Group 1");
    expect(md).toContain("DEMO-C-0002");
    // Unified (billing/support) signals surfaced — impossible with single-source CRM staging:
    expect(md).toContain("total_invoiced_cents");
    expect(md).toContain("open_ticket_count");
  });

  it("keyless report is business-readable: no prompt echo, has a risk table + watch list", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    // The LLM prompt must never leak into the deliverable (old TemplateLlm echoed it).
    expect(md).not.toContain("Summarize account status");
    // A deterministic, human-readable table renders regardless of LLM availability.
    expect(md).toContain("| Account |");
    // Fixture DEMO-C-0001 has 1 open invoice → it must be flagged with a reason;
    // DEMO-C-0002 has no risk signals → it must not be in the watch list.
    expect(md).toContain("## Accounts to watch");
    const watch = md.split("## Accounts to watch")[1].split("##")[0];
    expect(watch).toContain("DEMO-C-0001");
    expect(watch).toContain("open invoice");
    expect(watch).not.toContain("DEMO-C-0002");
  });

  it("regression: merged-away duplicates DEMO-C-0021/0022 must NOT appear (canonicals only)", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    expect(md).not.toContain("DEMO-C-0021");
    expect(md).not.toContain("DEMO-C-0022");
  });
});
