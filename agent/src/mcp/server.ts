import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";
import { readDbtSchema } from "../host/schema.js";

export const READ_TOOLS = ["get_account_health"] as const;

// The allowlist is ENFORCEMENT, not documentation. All tool registration goes through this
// guard, which refuses any name not in READ_TOOLS before the MCP server is touched — so
// "anything beyond the declared read tools is rejected" is a mechanical property of the
// registration path, not a convention. (Adding a genuinely new read tool means adding it
// to READ_TOOLS first, which the action-safety eval pins against the live tool surface.)
// (registerTool's generic overloads defeat Parameters<> extraction, so the passthrough is
// loosely typed; handlers type their own params explicitly, and the zod inputSchema still
// validates at runtime.)
export function registerReadOnlyTool(
  server: McpServer,
  name: string,
  config: { title?: string; description?: string; inputSchema?: unknown },
  handler: (...args: never[]) => unknown,
): void {
  if (!(READ_TOOLS as readonly string[]).includes(name)) {
    throw new Error(
      `tool "${name}" is not in the READ_TOOLS allowlist — registration refused`,
    );
  }
  (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => void)(
    name,
    config,
    handler,
  );
}

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
  "null_amount_deal_count",
  "null_amount_invoice_count",
  "has_unusable_amounts",
  "billing_currency",
  "deal_currency",
  "has_mixed_currency",
  "failed_payment_count",
  "open_ticket_count",
  "solved_ticket_count",
  "sla_breach_count",
  "avg_csat",
  "null_score_count",
  "null_currency_invoice_count",
  "null_currency_deal_count",
  "csat_score_count",
  "has_data_warnings",
  // A6: the sheets source — presence, sums (own columns, never folded into deal/invoice
  // figures), and the honesty counters behind them.
  "has_sheets",
  "sheet_row_count",
  "sheet_amount_cents",
  "sheet_currency",
  "null_amount_sheet_count",
  "null_currency_sheet_count",
  // Wave 5 (Task G): the Unlikely Value counters — the precise "why" behind the
  // has_data_warnings term they feed (flagged for attention, never refused).
  "unlikely_amount_payment_count",
  "unlikely_amount_invoice_count",
].join(", ");

export function createMcpServer(pool: pg.Pool): McpServer {
  const schema = readDbtSchema();
  const server = new McpServer({ name: "switchboard", version: "0.1.0" });

  registerReadOnlyTool(
    server,
    "get_account_health",
    {
      description:
        "Look up the unified health snapshot (CRM + billing + support) for one canonical entity by entity_id.",
      inputSchema: z.object({ entity_id: z.string().min(1) }),
    },
    async ({ entity_id }: { entity_id: string }) => {
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
