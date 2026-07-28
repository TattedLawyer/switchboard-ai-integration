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
           1::bigint as open_invoice_count,
           0::bigint as null_amount_deal_count, 0::bigint as null_amount_invoice_count,
           false as has_unusable_amounts,
           'USD'::text as billing_currency, 'USD'::text as deal_currency,
           false as has_mixed_currency,
           0::bigint as failed_payment_count,
           3::bigint as open_ticket_count, 1::bigint as solved_ticket_count,
           0::bigint as sla_breach_count, 4.50::numeric(3,2) as avg_csat,
           0::bigint as null_score_count,
           -- Addendum columns: unknown-currency row counts + the usable-CSAT base size.
           0::bigint as null_currency_invoice_count, 0::bigint as null_currency_deal_count,
           2::bigint as csat_score_count
    union all
    select 'DEMO-C-0002', 'DEMO Manufacturing Group 2', 'manufacturing-2.example.com',
           true, false, false, true,
           1, 250000, 0, 0, 0, 0, 0, false, null, 'USD', false, 0, 0, 0, 0, null, 0, 0, 0, 0
    union all
    select 'DEMO-C-0003', 'DEMO Retail Group 3', 'retail-3.example.com',
           true, true, false, true,
           1, null, null, null, 0, 0, 0, false, null, null, true, 0, 0, 0, 0, null, 0, 0, 0, 0
    union all
    -- F1: the mart says this entity's amounts are unusable (L3 counters + flag) — the
    -- report must surface that, not render the partial sums as the whole story.
    select 'DEMO-C-0004', 'DEMO Services Group 4', 'services-4.example.com',
           true, true, false, true,
           1, 100000, 50000, 0, 0, 1, 2, true, 'USD', 'USD', false, 0, 0, 0, 0, null, 0, 0, 0, 0
    union all
    -- F3 report side: avg over usable scores only; 2 skipped NULL scores must be flagged.
    select 'DEMO-C-0005', 'DEMO Wholesale Group 5', 'wholesale-5.example.com',
           true, false, true, true,
           0, 0, 0, 0, 0, 0, 0, false, null, null, false, 0, 0, 2, 0, 4.00, 2, 0, 0, 3
    union all
    -- Minor: a NULL sum WITHOUT has_mixed_currency — unreachable from today's mart, but
    -- the renderer must degrade to "unknown", never a fabricated $0.
    select 'DEMO-C-0006', 'DEMO Media Group 6', 'media-6.example.com',
           true, true, false, true,
           1, null, 40000, 40000, 0, 0, 0, false, 'USD', null, false, 0, 0, 0, 0, null, 0, 0, 0, 0
    union all
    -- Addendum: USD+NULL invoices and one NULL-currency deal — refused (mixed) AND the
    -- unknown rows are counted (2 invoice + 1 deal = 3 rows with unknown currency).
    select 'DEMO-C-0007', 'DEMO Energy Group 7', 'energy-7.example.com',
           true, true, false, true,
           1, null, null, null, 0, 0, 0, false, null, null, true, 0, 0, 0, 0, null, 0, 2, 1, 0
    union all
    select 'billing:B-0015', 'DEMO Orphan Billing', 'orphan.example.com',
           false, true, false, false,
           0, 0, 90000, 90000, 0, 0, 0, false, 'USD', null, false, 1, 0, 0, 0, null, 0, 0, 0, 0
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

  it("a mixed-currency account (L5: sums NULL + has_mixed_currency) renders '⚠ mixed currency' in place of money figures — never a fabricated $0", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    const row = md.split("\n").find((l) => l.startsWith("| DEMO-C-0003"));
    expect(row).toBeDefined();
    expect(row!).toContain("⚠ mixed currency");
    expect(row!).not.toContain("$0 / $0"); // NULL sums must not degrade to a confident zero
  });

  // ── External review F1: the mart's honesty flags existed, but the report never read
  // them — an entity with unusable amounts or skipped CSAT scores rendered "ok".
  it("F1: an entity the mart flagged has_unusable_amounts is flagged in its row AND the watch list, with the deal/invoice counts", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    const row = md.split("\n").find((l) => l.startsWith("| DEMO-C-0004"));
    expect(row).toBeDefined();
    expect(row!).toContain("unusable amount(s): 1 deal / 2 invoice");
    const watch = md.split("## Accounts to watch")[1].split("##")[0];
    expect(watch).toContain("DEMO-C-0004");
    expect(watch).toContain("unusable amount(s): 1 deal / 2 invoice");
  });

  it("F3 report side: an entity with skipped NULL CSAT scores (null_score_count 2) is flagged — the average alone is not the whole story", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    const row = md.split("\n").find((l) => l.startsWith("| DEMO-C-0005"));
    expect(row).toBeDefined();
    expect(row!).toContain("2 unusable CSAT score(s)");
    const watch = md.split("## Accounts to watch")[1].split("##")[0];
    expect(watch).toContain("DEMO-C-0005");
  });

  it("minor: a NULL sum WITHOUT the mixed-currency flag renders '⚠ unknown' — any NULL amount must never degrade to a confident $0", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    const row = md.split("\n").find((l) => l.startsWith("| DEMO-C-0006"));
    expect(row).toBeDefined();
    expect(row!).toContain("⚠ unknown");
    expect(row!).not.toContain("$0");
  });

  // ── Research addendum: unknowns get a visible bucket, and an average carries its base.
  it("addendum: rows with unknown currency are counted in the flags — DEMO-C-0007's 2 invoice + 1 deal rows surface as '3 row(s) with unknown currency'", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    const row = md.split("\n").find((l) => l.startsWith("| DEMO-C-0007"));
    expect(row).toBeDefined();
    expect(row!).toContain("3 row(s) with unknown currency");
    const watch = md.split("## Accounts to watch")[1].split("##")[0];
    expect(watch).toContain("DEMO-C-0007");
    expect(watch).toContain("3 row(s) with unknown currency");
  });

  it("addendum: avg_csat carries its base size — DEMO-C-0001 renders '4.50 (n=2)'; a no-csat entity keeps '—'", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    const withCsat = md.split("\n").find((l) => l.startsWith("| DEMO-C-0001"));
    expect(withCsat).toBeDefined();
    expect(withCsat!).toContain("4.50 (n=2)");
    const without = md.split("\n").find((l) => l.startsWith("| DEMO-C-0002"));
    expect(without).toBeDefined();
    expect(without!).toContain("| — |"); // no csat → no fabricated base
  });

  it("regression: merged-away duplicates DEMO-C-0021/0022 must NOT appear (canonicals only)", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    expect(md).not.toContain("DEMO-C-0021");
    expect(md).not.toContain("DEMO-C-0022");
  });
});
