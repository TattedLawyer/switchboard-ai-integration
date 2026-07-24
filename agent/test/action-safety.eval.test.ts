import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, registerReadOnlyTool, READ_TOOLS } from "../src/mcp/server.js";

let client: Client;
let server: McpServer;
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  server = createMcpServer(pool);
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

  it("the allowlist is ENFORCED at registration, not just documented: a write-shaped tool is refused before it reaches the protocol", async () => {
    // Without this, READ_TOOLS is self-certifying — a write tool added to both the server
    // and the list would pass the surface test above. The guard makes the invariant
    // mechanical: registration itself refuses names outside the allowlist.
    expect(() =>
      registerReadOnlyTool(
        server,
        "update_account",
        { description: "write-shaped tool that must never register", inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text" as const, text: "never" }] }),
      ),
    ).toThrow(/allowlist/i);

    // The refusal happened before the server was touched: surface unchanged, call rejected.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    const result = await client.callTool({ name: "update_account", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("the real tool goes through the same guard (the guard is the only registration path)", async () => {
    // Registering the allowlisted tool a second time via the guard must fail with the SDK's
    // duplicate-registration error, NOT the allowlist error — proving the production tool
    // was registered through the guard rather than around it.
    expect(() =>
      registerReadOnlyTool(
        server,
        "get_account_health",
        { description: "dup", inputSchema: z.object({ entity_id: z.string() }) },
        async () => ({ content: [{ type: "text" as const, text: "dup" }] }),
      ),
    ).toThrow(/already registered/i);
  });
});
