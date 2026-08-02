// The operator path for the hubcrm hydration DLQ (close D2 — the split's close half).
//
// A dead-lettered hydration is TERMINAL until an operator acts: the pump skips any event
// whose id is on the DLQ, so a vendor-side fix changes nothing until the DLQ row is
// consumed. The documented recovery used to be "delete the pg-boss job by hand" — a
// destructive psql/API act with no operator surface and no trace. This CLI is that act,
// scoped and printed: list a tenant's dead letters, re-arm exactly one by event id.
//
// Re-arm = CONSUME the DLQ row (boss.deleteJob — the same primitive replayDlq uses after
// handling a job). pg-boss retry()/resume() are deliberately NOT the mechanism: retryJobs
// updates only state='failed' rows and this store's jobs live in 'created' (a silent
// no-op), and a 'retry'-state row would still be skipped by the pump's listing. Because
// deletion destroys the row, THIS PROCESS'S OUTPUT IS THE AUDIT TRACE: every re-arm
// prints the full consumed entry (event id, object, recorded failure reason) and a count.
//
// The re-armed event is NOT fetched here. The pump owns fetching (budget, backoff,
// quarantine custody); this tool only returns the event to the pump's pending set, and
// says exactly that. The reconcile-driven REPAIR PUMP (automated re-arm) stays Phase 3,
// on the approval-queue spine — recorded in KNOWN-ISSUES.
//
// Usage:
//   node --import tsx src/cli/hydrate-rearm.ts --list [--tenant <uuid>]
//   node --import tsx src/cli/hydrate-rearm.ts --id <event_id> [--tenant <uuid>]

import { getPool } from "../db.js";
import { DEFAULT_TENANT_ID } from "../ingest-event.js";
import {
  listHydrationDlqJobs,
  rearmHydrationDlq,
  withHydrationDlqBoss,
  type HydrationDlqJob,
} from "../connectors/hub-hydrate.js";
import { hasRecordedTenantState, noRecordedStateMessage } from "./tenant-state.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const USAGE =
  "usage:\n" +
  "  hydrate-rearm --list [--tenant <uuid>]\n" +
  "  hydrate-rearm --id <event_id> [--tenant <uuid>]";

/** Every field a DLQ entry carries, printed — with the compile-time wall the other
 *  operator surfaces carry (checklist line 1): a field added to the DLQ entry shape
 *  without a decided print is a tsc error here before any test or reviewer. */
function formatDlqJob(job: HydrationDlqJob): string {
  const { jobId: _jobId, event_id, object_type, object_id, reason, ...rest } = job;
  rest satisfies Record<string, never>;
  return `event ${event_id} (${object_type}:${object_id}) — DLQ reason: ${reason}`;
}

async function main(): Promise<void> {
  const pool = getPool();
  // Bare-flag guard (house rule, identical wording to gap-ack/reconcile): a --tenant
  // whose value was swallowed must refuse, never silently act on the DEFAULT tenant.
  const tenantArg = arg("tenant");
  if (has("tenant") && (tenantArg === undefined || tenantArg.startsWith("--"))) {
    console.error("--tenant requires a tenant id");
    console.error(USAGE);
    await pool.end();
    process.exit(1);
  }
  const tenantId = tenantArg ?? DEFAULT_TENANT_ID;

  try {
    // Close F8's gate, applied to the new surface on arrival: an explicitly named tenant
    // this database has never seen refuses by name, never an empty-healthy listing.
    if (has("tenant") && !(await hasRecordedTenantState(pool, tenantId))) {
      console.error(noRecordedStateMessage(tenantId));
      await pool.end();
      process.exit(1);
    }

    const eventId = arg("id");
    if (!has("list") && (eventId === undefined || eventId.startsWith("--"))) {
      console.error(has("id") ? "--id requires an event id (see --list)" : USAGE);
      await pool.end();
      process.exit(1);
    }

    const code = await withHydrationDlqBoss(process.env.DATABASE_URL, async (boss) => {
      if (has("list")) {
        const jobs = await listHydrationDlqJobs(boss, tenantId);
        console.log(`hydration DLQ depth for tenant ${tenantId}: ${jobs.length}`);
        for (const job of jobs) console.log(`  ${formatDlqJob(job)}`);
        if (jobs.length === 0) {
          console.log("no dead-lettered hydrations for this tenant — nothing is waiting on an operator");
        }
        return 0;
      }

      const before = (await listHydrationDlqJobs(boss, tenantId)).length;
      const consumed = await rearmHydrationDlq(boss, tenantId, eventId!);
      if (consumed === null) {
        // Never a silent success: a re-arm that matched no row would leave the operator
        // believing a broken hydration was answered when it was not.
        console.error(
          `no hydration DLQ entry for event ${eventId} and this tenant — nothing was re-armed (see --list)`,
        );
        return 1;
      }
      // ── the audit trace: deletion destroyed the DLQ row, so THIS is the record ──────
      console.log(`re-armed ${formatDlqJob(consumed)}`);
      console.log(`re-armed 1 of ${before} dead-lettered hydration(s) for tenant ${tenantId}; ${before - 1} remain`);
      console.log(
        "the DLQ row is consumed — the pump will re-fetch this object on its next hydration " +
          "cycle (npm run backfill -w ingest, or the running service's interval runner). If the " +
          "vendor-side object is still broken it will re-quarantine and re-dead-letter with a fresh reason.",
      );
      return 0;
    });
    await pool.end();
    process.exit(code);
  } catch (err) {
    console.error("hydrate-rearm failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
