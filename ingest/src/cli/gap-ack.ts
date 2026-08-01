// The operator path for the durable gap ledger (Task D).
//
// A gap is an ADMITTED PERMANENT LOSS: events that existed at the source, were never
// ingested, and are no longer served. No retry closes it — which is why reconcile cannot
// simply fail on it forever. A permanent red is a red people learn to skip, and a check
// people skip is worse than no check.
//
// So the workflow is: reconcile FAILS while a gap is unacknowledged (loud, exactly once,
// with the loss's bounds and cause), and PASSES once an operator has acknowledged it —
// after which the gap is STILL PRINTED on every reconcile, forever, as a standing
// disclosed condition. Acknowledging is not closing, hiding, or resolving. It is a human
// saying "I have seen this loss and accepted it", on the record, with their name on it.
//
// Deliberately a CLI rather than documented SQL (disclosed decision): the act needs an
// operator identity and a note to be worth anything, `acknowledged_by` should not be
// whatever database role the psql session happened to use, and a documented UPDATE
// invites a WHERE clause slip that acknowledges every open gap at once. This tool cannot
// express that: it acknowledges exactly one id, and refuses without a --by.
//
// Usage:
//   node --import tsx src/cli/gap-ack.ts --list [--source <source>]
//   node --import tsx src/cli/gap-ack.ts --source <source> --id <n> --by <operator> [--note "..."]

import { getPool } from "../db.js";
import { enabledSources, isSource } from "../sources.js";
import { DEFAULT_TENANT_ID } from "../ingest-event.js";
import { acknowledgeGap, formatGapLedgerRow, listGaps } from "../connectors/index.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const USAGE =
  "usage:\n" +
  "  gap-ack --list [--source <source>]\n" +
  "  gap-ack --source <source> --id <n> --by <operator> [--note \"why this loss is accepted\"]";

async function main(): Promise<void> {
  const pool = getPool();
  // Tenancy: the CLIs operate on the default tenant, like every other operator surface in
  // this repo. A multi-tenant deployment gets a --tenant flag when it gets a multi-tenant
  // operator story; inventing half of one here would be worse than the explicit limit.
  const tenantId = DEFAULT_TENANT_ID;

  try {
    const source = arg("source");
    if (source !== undefined && !isSource(source)) {
      console.error(`unknown source: ${source}`);
      console.error(USAGE);
      await pool.end();
      process.exit(1);
    }

    if (has("list") || (!has("id") && !has("by"))) {
      const sources = source !== undefined ? [source] : enabledSources();
      let total = 0;
      for (const s of sources) {
        for (const gap of await listGaps(pool, tenantId, s)) {
          console.log(formatGapLedgerRow(s, gap));
          total++;
        }
      }
      if (total === 0) console.log("no gaps recorded for the listed source(s) — no admitted permanent losses");
      await pool.end();
      process.exit(0);
    }

    // An anonymous acknowledgement is not an acknowledgement: the whole value of the act
    // is that a named human accepted the loss.
    const by = arg("by");
    if (by === undefined || by.trim() === "") {
      console.error("refusing to acknowledge a permanent data loss anonymously: --by <operator> is required");
      console.error(USAGE);
      await pool.end();
      process.exit(1);
    }
    const idRaw = arg("id");
    const id = Number(idRaw);
    if (idRaw === undefined || !Number.isInteger(id)) {
      console.error(`--id must be a gap id (see --list), got ${idRaw ?? "nothing"}`);
      console.error(USAGE);
      await pool.end();
      process.exit(1);
    }

    const acked = await acknowledgeGap(pool, { tenantId, id, by, note: arg("note") });
    if (acked === null) {
      // Never a silent success: an acknowledgement that matched no row would leave the
      // operator believing a loss was answered when it was not.
      console.error(`no gap #${id} for this tenant — nothing was acknowledged (see --list)`);
      await pool.end();
      process.exit(1);
    }
    console.log(`acknowledged gap #${acked.id} (${acked.cause}) by ${acked.acknowledgedBy} at ${acked.acknowledgedAt}`);
    console.log(formatGapLedgerRow(acked.source, acked));
    console.log(
      "the loss is unchanged — this records that it was seen and accepted. It stays on every " +
        "reconcile as a standing disclosed condition.",
    );
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("gap-ack failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
