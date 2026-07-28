process.env.DBT_SCHEMA = "mcp_test_analytics";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";

const SCHEMA = process.env.DBT_SCHEMA ?? "public_analytics";
let pool: pg.Pool;
let client: Client;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // The MCP test provisions its own fixture views so it doesn't depend on dbt having run.
  // customer_360 is the UNIFIED mart the tool must read: one row per canonical entity,
  // columns matching warehouse/models/marts/customer_360.sql. The legacy single-source
  // stg_crm__companies view is ALSO provisioned — still containing the merged-away dupe
  // DEMO-C-0021 — so a regression to the old wiring surfaces the dupe and fails.
  await pool.query(`create schema if not exists ${SCHEMA}`);
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
           0::bigint as null_score_count
  `);
  await pool.query(`
    create or replace view ${SCHEMA}.stg_crm__companies as
    select 'DEMO-C-0001'::text as company_id, 'DEMO Logistics Group 1'::text as name,
           'logistics-1.example.com'::text as domain, now() as last_event_at
    union all
    select 'DEMO-C-0021', 'DEMO Logistics Group 1 Inc', 'logistics-1.example.com', now()
  `);
  const server = createMcpServer(pool);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTx);
});
afterAll(async () => {
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await pool.end();
});

describe("MCP server", () => {
  it("returns unified customer_360 health for a canonical entity", async () => {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { entity_id: "DEMO-C-0001" },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toMatchObject({
      entity_id: "DEMO-C-0001",
      entity_name: "DEMO Logistics Group 1",
      is_complete: true,
      has_crm: true,
      has_billing: true,
      has_support: true,
      open_deal_amount_cents: "500000",
      total_invoiced_cents: "120000",
      open_ticket_count: "3",
      null_score_count: "0", // F3 parity: the mart's new disclosure column reaches the tool
    });
  });

  it("regression: a merged-away duplicate (present only in single-source staging) is NOT resolvable", async () => {
    // DEMO-C-0021 exists in stg_crm__companies but was merged into DEMO-C-0001, so it has
    // no customer_360 row. The old stg_crm__companies wiring would happily return it.
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { entity_id: "DEMO-C-0021" },
    });
    expect(res.isError).toBe(true);
  });

  it("returns isError for an unknown entity", async () => {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { entity_id: "DEMO-C-9999" },
    });
    expect(res.isError).toBe(true);
  });
});
