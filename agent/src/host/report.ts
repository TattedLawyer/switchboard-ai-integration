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

  // Deterministic, business-readable core — rendered from the snapshots the report
  // already fetched, with or without an LLM. The narrative (below) is additive.
  const accounts = snapshots.map((s) => JSON.parse(s) as Record<string, unknown>);
  const num = (a: Record<string, unknown>, k: string) => Number(a[k] ?? 0); // counts arrive as strings (pg bigint)
  const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  // L5: a NULL sum on a has_mixed_currency row means "currencies mixed — a single total
  // would be a lie". Render the condition, never a fabricated $0.
  const money = (a: Record<string, unknown>, k: string): string =>
    a[k] == null && a["has_mixed_currency"] === true ? "⚠ mixed currency" : usd(num(a, k));
  const flagsFor = (a: Record<string, unknown>): string[] => {
    const f: string[] = [];
    if (num(a, "failed_payment_count") > 0) f.push(`${num(a, "failed_payment_count")} failed payment(s)`);
    if (num(a, "open_invoice_count") > 0) f.push(`${num(a, "open_invoice_count")} open invoice(s)`);
    if (num(a, "sla_breach_count") > 0) f.push(`${num(a, "sla_breach_count")} SLA breach(es)`);
    if (a["avg_csat"] != null && Number(a["avg_csat"]) <= 2.5) f.push(`low CSAT (${a["avg_csat"]})`);
    return f;
  };
  const tableRows = accounts.map((a) => {
    const flags = flagsFor(a);
    return `| ${a["entity_id"]} | ${a["entity_name"]} | ${money(a, "open_deal_amount_cents")} | ${money(a, "total_invoiced_cents")} / ${money(a, "total_paid_cents")} | ${num(a, "open_ticket_count")} | ${a["avg_csat"] ?? "—"} | ${flags.length ? "⚠ " + flags.join("; ") : "ok"} |`;
  });
  const watch = accounts
    .map((a) => ({ a, flags: flagsFor(a) }))
    .filter(({ flags }) => flags.length > 0)
    .map(({ a, flags }) => `- **${a["entity_id"]}** (${a["entity_name"]}): ${flags.join("; ")}`);

  const narrative = await llm.complete(
    `Summarize account status from these ${snapshots.length} snapshots:\n${snapshots.join("\n")}`,
  );
  return [
    "# Monday Revenue-Risk Report",
    `_Generated ${new Date().toISOString()} · ${snapshots.length} canonical accounts · simulated data_`,
    "",
    narrative,
    "",
    "## Accounts to watch",
    ...(watch.length ? watch : ["- No accounts flagged this week."]),
    "",
    "## All accounts",
    "| Account | Name | Open deals | Invoiced / paid | Open tickets | CSAT | Flags |",
    "|---|---|---|---|---|---|---|",
    ...tableRows,
    "",
    "## Appendix: raw account snapshots",
    ...snapshots.map((s) => `- \`${s}\``),
    "",
    `_${incomplete.rows[0].n} billing/support-only entities (no CRM record) are pending manual review and excluded from the account list._`,
  ].join("\n");
}
