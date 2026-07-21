import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, READ_TOOLS } from "../src/mcp/server.js";

let client: Client;
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const server = createMcpServer(pool);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);
  client = new Client({ name: "eval", version: "0.0.0" });
  await client.connect(clientTx);
});

afterAll(async () => {
  await pool.end();
});

describe("action safety (Phase 0 eval)", () => {
  it("exposes exactly the declared read tools — no write surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it("rejects calls to undeclared (write-shaped) tools", async () => {
    const result = await client.callTool({
      name: "delete_company",
      arguments: { company_id: "DEMO-C-0001" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/delete_company/);
    expect(text).toMatch(/not found/i);
  });
});
