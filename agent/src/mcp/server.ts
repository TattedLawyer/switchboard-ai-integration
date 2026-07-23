import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";
import { readDbtSchema } from "../host/schema.js";

export const READ_TOOLS = ["get_account_health"] as const;

// Unified customer_360 columns surfaced by get_account_health. The tool reads the mart —
// one row per CANONICAL entity after identity resolution — NOT the single-source
// stg_crm__companies staging view, which still contains merged-away duplicate company ids.
const HEALTH_COLUMNS = [
  "entity_id",
  "entity_name",
  "domain",
  "has_crm",
  "has_billing",
  "has_support",
  "is_complete",
  "open_deal_count",
  "open_deal_amount_cents",
  "total_invoiced_cents",
  "total_paid_cents",
  "open_invoice_count",
  "failed_payment_count",
  "open_ticket_count",
  "solved_ticket_count",
  "sla_breach_count",
  "avg_csat",
].join(", ");

export function createMcpServer(pool: pg.Pool): McpServer {
  const schema = readDbtSchema();
  const server = new McpServer({ name: "switchboard", version: "0.1.0" });

  server.registerTool(
    "get_account_health",
    {
      description:
        "Look up the unified health snapshot (CRM + billing + support) for one canonical entity by entity_id.",
      inputSchema: z.object({ entity_id: z.string().min(1) }),
    },
    async ({ entity_id }) => {
      const res = await pool.query(
        `select ${HEALTH_COLUMNS} from ${schema}.customer_360 where entity_id = $1`,
        [entity_id],
      );
      if (res.rowCount === 0) {
        return { isError: true, content: [{ type: "text", text: "entity not found" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(res.rows[0]) }] };
    },
  );

  return server;
}
