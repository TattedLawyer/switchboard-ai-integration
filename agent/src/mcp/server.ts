import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";

export const READ_TOOLS = ["get_account_health"] as const;

export function createMcpServer(pool: pg.Pool): McpServer {
  const schema = process.env.DBT_SCHEMA ?? "public_analytics";
  const server = new McpServer({ name: "switchboard", version: "0.1.0" });

  server.registerTool(
    "get_account_health",
    {
      description: "Look up current health snapshot for one account by company_id.",
      inputSchema: z.object({ company_id: z.string().min(1) }),
    },
    async ({ company_id }) => {
      const res = await pool.query(
        `select company_id, name, domain, last_event_at from ${schema}.stg_crm__companies where company_id = $1`,
        [company_id],
      );
      if (res.rowCount === 0) {
        return { isError: true, content: [{ type: "text", text: "company not found" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(res.rows[0]) }] };
    },
  );

  return server;
}
