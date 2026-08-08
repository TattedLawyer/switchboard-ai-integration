import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, registerReadOnlyTool, READ_TOOLS } from "../src/mcp/server.js";
import { recordProposal } from "../src/host/propose.js";

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

  // ── A1 extension: the proposal path did not add a write surface ─────────────────────
  //
  // A1 gave the agent host the ability to ask for a proposal to be recorded. The thing to
  // check is that this did NOT arrive as a tool. If it had, the model could call it —
  // and "the agent proposes" would silently have become "the model writes, via a door".
  // Two assertions, because the two failure modes are different: a new tool on the
  // surface, and a handler that persists instead of returning.

  it("A1 added no tool: the live surface is still exactly READ_TOOLS, and READ_TOOLS is read-shaped", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    // Vacuity guard: an empty allowlist would satisfy every "no write tools" assertion in
    // this file for free.
    expect(READ_TOOLS.length).toBeGreaterThanOrEqual(1);
    for (const name of READ_TOOLS) {
      expect(name, `${name} reads as a mutation`).not.toMatch(
        /^(create|update|delete|insert|write|send|propose|approve|set|remove|drop)_/,
      );
    }
  });

  it("`propose_action` is refused at registration like any other undeclared name", () => {
    // The specific name someone would reach for. The allowlist guard is the enforcement,
    // so this is a statement about the guard rather than about anyone's intentions.
    expect(() =>
      registerReadOnlyTool(
        server,
        "propose_action",
        { description: "the tool A1 must not have added", inputSchema: z.object({}) },
        async () => ({ content: [{ type: "text" as const, text: "never" }] }),
      ),
    ).toThrow(/allowlist/i);
  });

  it("the proposal client returns a value and performs no persistence itself", async () => {
    // `recordProposal` is host code, not a tool — reachable from the host's own path and
    // not from a `tools/call`. It hands the object across the boundary and returns what
    // the door said. It holds no pool, so there is nothing here for it to persist WITH.
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", state: "pending" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await recordProposal(
      {
        idempotencyKey: "eval-1",
        actionType: "send_email",
        payload: { to: "ops@example.com" },
        rationale: "eval",
      },
      { baseUrl: "http://door.invalid", token: "t", fetchImpl },
    );
    expect(result).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      state: "pending",
      duplicate: false,
    });
    // One outbound call, to the door, and nothing else happened.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://door.invalid/internal/proposals");
  });

  it("a door that answers 2xx WITHOUT an id is a failure, not an invented success", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 201 })) as unknown as typeof fetch;
    await expect(
      recordProposal(
        { idempotencyKey: "eval-2", actionType: "send_email", payload: {}, rationale: "eval" },
        { baseUrl: "http://door.invalid", token: "t", fetchImpl },
      ),
    ).rejects.toThrow(/NOT recorded/);
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
