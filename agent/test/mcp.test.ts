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
  // The MCP test provisions its own fixture view so it doesn't depend on dbt having run:
  await pool.query(`create schema if not exists ${SCHEMA}`);
  await pool.query(`
    create or replace view ${SCHEMA}.stg_crm__companies as
    select 'DEMO-C-0001'::text as company_id, 'DEMO Retail Group 1'::text as name,
           'retail-1.example.com'::text as domain, now() as last_event_at
  `);
  const server = createMcpServer(pool);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTx);
});
afterAll(async () => { await pool.end(); });

describe("MCP server", () => {
  it("returns account health for a known company", async () => {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { company_id: "DEMO-C-0001" },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toMatchObject({
      company_id: "DEMO-C-0001",
      name: "DEMO Retail Group 1",
    });
  });

  it("returns isError for an unknown company", async () => {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { company_id: "DEMO-C-9999" },
    });
    expect(res.isError).toBe(true);
  });
});
