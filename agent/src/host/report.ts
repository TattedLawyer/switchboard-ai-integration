import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp/server.js";
import type { LlmClient } from "./llm.js";
import { readDbtSchema } from "./schema.js";

export async function generateMondayReport(
  pool: pg.Pool,
  llm: LlmClient,
): Promise<string> {
  const schema = readDbtSchema();
  const server = createMcpServer(pool);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);
  const client = new Client({ name: "host", version: "0.1.0" });
  await client.connect(clientTx);

  // Canonical accounts come from the unified customer_360 mart (post identity-resolution),
  // NOT stg_crm__companies — the staging view still lists merged-away duplicate company ids.
  // has_crm limits the account list to the canonical CRM companies; billing/support-only
  // (incomplete) entities are surfaced separately as a manual-review count, not hidden.
  const ids = await pool.query(
    `select entity_id from ${schema}.customer_360 where has_crm order by entity_id`,
  );
  const incomplete = await pool.query(
    `select count(*)::int as n from ${schema}.customer_360 where not is_complete`,
  );
  const snapshots: string[] = [];
  for (const row of ids.rows) {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { entity_id: row.entity_id },
    });
    snapshots.push(((res.content as { text: string }[])[0]).text);
  }

  const narrative = await llm.complete(
    `Summarize account status from these ${snapshots.length} snapshots:\n${snapshots.join("\n")}`,
  );
  return [
    "# Monday Revenue-Risk Report",
    `_Generated ${new Date().toISOString()} · ${snapshots.length} canonical accounts · simulated data_`,
    "",
    narrative,
    "",
    "## Account snapshots",
    ...snapshots.map((s) => `- \`${s}\``),
    "",
    `_${incomplete.rows[0].n} billing/support-only entities (no CRM record) are pending manual review and excluded from the account list._`,
  ].join("\n");
}
