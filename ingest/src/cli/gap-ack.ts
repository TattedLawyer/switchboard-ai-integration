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
//   node --import tsx src/cli/gap-ack.ts --list [--source <source>] [--tenant <uuid>]
//   node --import tsx src/cli/gap-ack.ts --source <source> --id <n> --by <operator> [--note "..."] [--tenant <uuid>]

import { getPool } from "../db.js";
import { resolveDeploymentTenant } from "../config.js";
import { enabledSources, isSource } from "../sources.js";
import { DEFAULT_TENANT_ID } from "../ingest-event.js";
import { acknowledgeGap, formatGapLedgerRow, listGaps } from "../connectors/index.js";
import { hasRecordedTenantState, noRecordedStateMessage } from "./tenant-state.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const USAGE =
  "usage:\n" +
  "  gap-ack --list [--source <source>] [--tenant <uuid>]\n" +
  "  gap-ack --source <source> --id <n> --by <operator> [--note \"why this loss is accepted\"] [--tenant <uuid>]";

async function main(): Promise<void> {
  const pool = getPool();
  // Tenancy (debt-burn A5): --tenant scopes both the listing and the acknowledgement;
  // the default stays the default tenant, so single-tenant operation is unchanged. The
  // ledger itself was always tenant-scoped — this flag makes the operator surface able
  // to say which tenant it means.
  const tenantArg = arg("tenant");
  if (has("tenant") && (tenantArg === undefined || tenantArg.startsWith("--"))) {
    console.error("--tenant requires a tenant id");
    console.error(USAGE);
    await pool.end();
    process.exit(1);
  }
  // CLOSE-3 fix round: the default is the DEPLOYMENT's tenant (SWITCHBOARD_TENANT_ID),
  // not a hardcoded nil — a bare run on a configured deployment used to operate on an
  // empty nil lane and report a clean zero. Unset resolves to the nil tenant, so default
  // deployments are byte-identical to before. An explicit --tenant still overrides.
  const tenantId = tenantArg ?? resolveDeploymentTenant();

  try {
    // Close F8: same refusal as reconcile's, same wording (checklist line 6). An unknown
    // explicit tenant listing "zero gaps" reads exactly like a healthy tenant — refuse
    // before either the listing or the acknowledgement path can answer for it.
    if (has("tenant") && !(await hasRecordedTenantState(pool, tenantId))) {
      console.error(noRecordedStateMessage(tenantId));
      await pool.end();
      process.exit(1);
    }
    const source = arg("source");
    if (source !== undefined && !isSource(source)) {
      // Record over config on the ACK path too (close F9): the listing learned this in
      // debt-burn A5, but the isSource gate here still made a loss on a source since
      // removed from the registry visible-but-unacceptable — seen forever, accepted
      // never. A source with recorded gap rows for this tenant is a real source of
      // record whatever the registry says today; only a source unknown to BOTH the
      // registry AND the recorded ledger is a typo, and refuses as before.
      const recorded = await pool.query(
        "select 1 from ingest.gap_ledger where tenant_id = $1 and source = $2 limit 1",
        [tenantId, source],
      );
      if (recorded.rowCount === 0) {
        console.error(
          `unknown source: ${source} — not in the SOURCES registry, and no gap is recorded under it for this tenant`,
        );
        console.error(USAGE);
        await pool.end();
        process.exit(1);
      }
    }

    if (has("list") || (!has("id") && !has("by"))) {
      // Default scope is ALL recorded gap state for the tenant (debt-burn A5): this is
      // the listing a reconcile failure points operators at, and a loss recorded on a
      // source later removed from INGEST_SOURCES must stay visible on it — recorded
      // state outranks configured scope on a diagnostic surface. `--source` narrows.
      const enabled = new Set<string>(enabledSources());
      const sources: string[] =
        source !== undefined
          ? [source]
          : (
              await pool.query<{ source: string }>(
                "select distinct source from ingest.gap_ledger where tenant_id = $1 order by source",
                [tenantId],
              )
            ).rows.map((r) => r.source);
      let total = 0;
      for (const s of sources) {
        for (const gap of await listGaps(pool, tenantId, s)) {
          // Disclosure, not noise: a row on a not-currently-enabled source stays listed
          // and says why this deployment's reconcile runs will not red on it.
          const flag = enabled.has(s)
            ? ""
            : "  [source not currently in INGEST_SOURCES — the recorded loss still stands]";
          console.log(formatGapLedgerRow(s, gap) + flag);
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
