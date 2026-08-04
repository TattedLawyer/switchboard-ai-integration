// A7: operator CLI for the quarantine — before this, quarantined events had NO shipped
// path back into the pipeline (the endpoint 202s, so the vendor never re-delivers).
//   npm run quarantine -- --list [--tenant <uuid>]   show that tenant's pending rows
//   npm run quarantine -- --replay <id>              replay one row through the ingest gate
//   npm run quarantine [-- --tenant <uuid>]          replay everything pending for that
//                                                    tenant (gate re-validates; unfixable
//                                                    rows stay put and are counted)
//
// SEC-C2: every listing and every sweep is scoped to ONE tenant, matching the three sibling
// operator CLIs (gap-ack, hydrate-rearm, reconcile) — same flag, same bare-flag guard, same
// zero-state refusal. Unscoped, this command listed every tenant's rows and, run bare,
// replayed all of them into the default tenant: a cross-tenant WRITE performed by the
// documented remediation workflow, with no warning in the output. `--replay <id>` takes no
// --tenant: that row carries its own tenant_id and replay now honours it, so a single-row
// replay can no longer relocate a payload either.
import { getPool } from "../db.js";
import { resolveDeploymentTenant } from "../config.js";
import { ingestEvent, DEFAULT_TENANT_ID } from "../ingest-event.js";
import { listQuarantine, replayAllQuarantined, replayQuarantined } from "../quarantine.js";
import { hasRecordedTenantState, noRecordedStateMessage } from "./tenant-state.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const USAGE =
  "usage:\n" +
  "  quarantine --list [--tenant <uuid>]\n" +
  "  quarantine --replay <id>\n" +
  "  quarantine [--tenant <uuid>]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const replayIdx = args.indexOf("--replay");
  const pool = getPool();

  // Bare-flag guard (house rule, identical wording to gap-ack/hydrate-rearm/reconcile): a
  // --tenant whose value was swallowed must refuse, never silently act on the DEFAULT tenant.
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
    // Single-row replay answers about one row, not about a tenant's depth — so it runs
    // before (and without) the tenant-scoped listing. Printing the default tenant's depth
    // ahead of a row that may belong to another tenant would be a misleading header.
    if (replayIdx !== -1) {
      const id = Number(args[replayIdx + 1]);
      if (!Number.isInteger(id)) throw new Error("--replay requires a numeric quarantine id");
      const outcome = await replayQuarantined(pool, id, ingestEvent);
      console.log(`id=${id}: ${outcome}`);
      process.exit(outcome === "replayed" ? 0 : 1);
    }

    // Close F8's gate, applied to this surface on arrival: an explicitly named tenant with
    // zero recorded state anywhere is more likely a typo than a truth, and a depth of 0
    // reads exactly like a healthy tenant. Explicit-flag-only, so bare single-tenant runs
    // are byte-identical to before.
    if (has("tenant") && !(await hasRecordedTenantState(pool, tenantId))) {
      console.error(noRecordedStateMessage(tenantId));
      await pool.end();
      process.exit(1);
    }

    const pending = await listQuarantine(pool, tenantId);
    console.log(`quarantine depth (pending) for tenant ${tenantId}: ${pending.length}`);

    if (listOnly) {
      for (const row of pending) {
        console.log(
          `  id=${row.id} source=${row.source} event_id=${row.event_id ?? "<none>"} received_at=${row.received_at.toISOString()} attempts=${row.attempts} last_attempt_at=${row.last_attempt_at?.toISOString() ?? "<never>"} reason=${row.reason}`,
        );
      }
      process.exit(0);
    }

    if (pending.length === 0) {
      console.log("nothing to replay");
      process.exit(0);
    }
    const result = await replayAllQuarantined(pool, ingestEvent, tenantId);
    console.log(`replayed: ${result.replayed}, still-invalid: ${result.stillInvalid}`);
    process.exit(0);
  } catch (err) {
    console.error("quarantine CLI failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
