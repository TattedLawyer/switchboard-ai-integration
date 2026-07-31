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
  // L5: a NULL sum means "no single figure is true" — render the condition, never a
  // fabricated $0. Keyed off the NULL itself: with has_mixed_currency it names the cause
  // ("mixed currency"); any other NULL renders "⚠ unknown". Reachable since the L5.1
  // retraction: a source whose rows are UNIFORMLY unknown-currency refuses its sums
  // without being mixed — this branch is that rendering (the unknown-currency flag below
  // carries the row count) — and it remains the durable default for any future NULL
  // reason, so nothing ever falls through num() to $0 (F1 minor).
  const money = (a: Record<string, unknown>, k: string): string => {
    if (a[k] == null) {
      return a["has_mixed_currency"] === true ? "⚠ mixed currency" : "⚠ unknown";
    }
    return usd(num(a, k));
  };
  const flagsFor = (a: Record<string, unknown>): string[] => {
    const f: string[] = [];
    if (num(a, "failed_payment_count") > 0) f.push(`${num(a, "failed_payment_count")} failed payment(s)`);
    if (num(a, "open_invoice_count") > 0) f.push(`${num(a, "open_invoice_count")} open invoice(s)`);
    if (num(a, "sla_breach_count") > 0) f.push(`${num(a, "sla_breach_count")} SLA breach(es)`);
    if (a["avg_csat"] != null && Number(a["avg_csat"]) <= 2.5) f.push(`low CSAT (${a["avg_csat"]})`);
    // F1: the mart's honesty flags, finally read. L3 — amounts the safe-cast NULLed make
    // this entity's totals incomplete, not confidently rendered; F3 — CSAT rows whose
    // score was unusable, skipped by avg_csat and disclosed here.
    // A6: the sheet term joined has_unusable_amounts, and THIS branch preempts the
    // catch-all — without the sheet count a sheet-driven blank amount would render the
    // active lie "0 deal / 0 invoice". null_currency_sheet_count joins the
    // unknown-currency sum below for the same reason (cold review I1); only genuinely
    // FUTURE mart terms are the catch-all's to cover.
    if (a["has_unusable_amounts"] === true)
      f.push(`unusable amount(s): ${num(a, "null_amount_deal_count")} deal / ${num(a, "null_amount_invoice_count")} invoice / ${num(a, "null_amount_sheet_count")} sheet`);
    if (num(a, "null_score_count") > 0) f.push(`${num(a, "null_score_count")} unusable CSAT score(s)`);
    // Addendum: unknown-currency rows get a visible count. Since the L5.1 retraction any
    // such row refuses its source's sums (known + unknown = mixed; all-unknown = unknown).
    // Cold review I1 (A6): the sheet count is PART of this sum, not the catch-all's
    // problem — an entity with unknown currency in a ledger source AND sheets fires this
    // flag (which blocks the catch-all) and must state the whole count, never an
    // understated invoice+deal figure. Same defect class as the "0 deal / 0 invoice"
    // lie fixed for has_unusable_amounts above.
    const unknownCurrencyRows = num(a, "null_currency_invoice_count") + num(a, "null_currency_deal_count") + num(a, "null_currency_sheet_count");
    if (unknownCurrencyRows > 0) f.push(`${unknownCurrencyRows} row(s) with unknown currency`);
    // Cold review I-2: the loudest honesty condition, finally in the deterministic surface.
    // money() already refuses the figure; the Flags cell must name the refusal instead of
    // contradicting it with "ok" — and the watch list must carry the entity.
    if (a["has_mixed_currency"] === true) f.push("mixed currencies — totals refused");
    // CATCH-ALL (the structural fix — three rounds of this defect class prove the report's
    // component enumeration will always lag the mart): after all specific checks, any
    // FUTURE OR-term added to the mart's has_data_warnings reaches the watch list here
    // with zero report changes.
    if (a["has_data_warnings"] === true && f.length === 0) f.push("data quality warning — see mart counters");
    return f;
  };
  // Addendum: an average must carry its base size — "4.50 (n=2)" — so a one-review 5.00
  // and a fifty-review 5.00 stop looking identical. No csat at all stays "—".
  const csatCell = (a: Record<string, unknown>): string =>
    a["avg_csat"] == null ? "—" : `${a["avg_csat"]} (n=${num(a, "csat_score_count")})`;
  const tableRows = accounts.map((a) => {
    const flags = flagsFor(a);
    return `| ${a["entity_id"]} | ${a["entity_name"]} | ${money(a, "open_deal_amount_cents")} | ${money(a, "total_invoiced_cents")} / ${money(a, "total_paid_cents")} | ${num(a, "open_ticket_count")} | ${csatCell(a)} | ${flags.length ? "⚠ " + flags.join("; ") : "ok"} |`;
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
