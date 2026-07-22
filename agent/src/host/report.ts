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

  const ids = await pool.query(
    `select company_id from ${schema}.stg_crm__companies order by company_id`,
  );
  const snapshots: string[] = [];
  for (const row of ids.rows) {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { company_id: row.company_id },
    });
    snapshots.push(((res.content as { text: string }[])[0]).text);
  }

  const narrative = await llm.complete(
    `Summarize account status from these ${snapshots.length} snapshots:\n${snapshots.join("\n")}`,
  );
  return [
    "# Monday Revenue-Risk Report",
    `_Generated ${new Date().toISOString()} · ${snapshots.length} accounts · simulated data_`,
    "",
    narrative,
    "",
    "## Account snapshots",
    ...snapshots.map((s) => `- \`${s}\``),
  ].join("\n");
}
