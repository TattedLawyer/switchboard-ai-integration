// The close daemon — the THIRD process of the unattended loop, and the one whose absence
// makes the other two rot.
//
// 🚨 WHY THIS EXISTS. Nothing in the proposer or the executor closes a follow-up whose
// proposal reached a terminal state. Trace a single rejection without this process running:
// the proposal goes `rejected` (terminal), the follow-up row stays OPEN with its action
// attached, and `next_due_at` holds only the 15-minute claim lease. Fifteen minutes later the
// proposer re-claims the contact, derives the SAME deterministic idempotency key for the same
// due date, and the door answers 409 terminal-replay — every quarter hour. After the next
// Manila midnight the key rolls, but now yesterday's row is an open follow-up at an EARLIER
// date, so `hasOpenFollowUpBefore` suppresses the contact permanently while `claimDue` keeps
// leasing it forever. A contact silenced for good, churning invisibly. The same shape applies
// to `expired` approvals and to `execution_failed` after a failed send — which is why
// `executor.ts` calls this pass MANDATORY rather than optional.
//
// 🚨 WHY IT IS A SEPARATE PROCESS AND NOT A THIRD JOB IN ONE OF THE OTHERS. It runs as the
// MIGRATION OWNER. The close pass reads `approval.proposals` (where `switchboard_crm` holds
// nothing) and writes `crm.follow_ups` (where `switchboard_approval` holds nothing), so it is
// the one principal that must see both — and neither daemon holds that credential, nor should
// it. Three processes, three credentials, and the widest one does the least.
import { getOwnerPool } from "../db.js";
import { reconcile, formatReconcile, closeTerminatedFollowUps } from "../reconcile.js";
import { runSheetAdoptionAll, DEFAULT_MAX_CHANGES, DEFAULT_MAX_DRIFT_PCT } from "../sheet-adopt.js";
import { sheetTransportFromEnv, SHEETS_KEY_FILE_ENV } from "../sheet-client.js";
import { startScheduler } from "../scheduler.js";

const DEFAULT_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const intervalMs = Number(process.env.CRM_RECONCILE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw new Error(`invalid CRM_RECONCILE_INTERVAL_MS "${process.env.CRM_RECONCILE_INTERVAL_MS}"`);
  }
  const verbose = process.argv.includes("--verbose");
  const pool = getOwnerPool();

  // Prove the credential before claiming the loop is running. A close daemon that cannot see
  // `approval.proposals` closes nothing and says nothing.
  await pool.query("select 1 from approval.proposals limit 1");

  // The sheet transport: DEGRADES OFF LOUDLY when unconfigured. Off means the linked
  // sheet's rows stop being adopted — a state the operator must know about at boot, once,
  // in plain words, rather than discover from a digest that quietly stopped mentioning
  // new contacts.
  const transport = sheetTransportFromEnv();
  if (transport === null) {
    console.error(
      `[sheet] ${SHEETS_KEY_FILE_ENV} is not set — SHEET ADOPTION IS OFF. Linked-sheet ` +
        `rows will not become contacts until the key file path is provided.`,
    );
  }
  const thresholds = {
    maxChanges: Number(process.env.CRM_SHEET_MAX_CHANGES ?? DEFAULT_MAX_CHANGES),
    maxDriftPct: Number(process.env.CRM_SHEET_MAX_DRIFT_PCT ?? DEFAULT_MAX_DRIFT_PCT),
  };

  const pass = async (): Promise<void> => {
    const closed = await closeTerminatedFollowUps(pool);
    if (closed.length > 0) {
      const rejected = closed.filter((c) => c.reason === "rejected").length;
      console.log(
        `[close] closed ${closed.length} terminal follow-up(s): ${rejected} rejected ` +
          `(stopped & surfaced), ${closed.length - rejected} expired/failed (re-proposed)`,
      );
    }
    // The adoption pass — owner-credentialed, per-sheet isolated, every outcome recorded
    // in `crm.sheet_reads`. Quiet when there is nothing to say; loud on any state change.
    if (transport !== null) {
      for (const r of await runSheetAdoptionAll(pool, transport, thresholds)) {
        if (!r.completed) {
          console.error(`[sheet] ${r.spreadsheetId}: ${r.detail}`);
        } else if (
          r.adopted + r.rebound + r.reactivated + r.blocked + r.recovered + r.rowErrors.length >
          0
        ) {
          console.log(`[sheet] ${r.spreadsheetId}: ${r.detail}`);
          for (const e of r.rowErrors) {
            console.error(`[sheet]   row ${e.rowIndex}: ${e.error}`);
          }
        }
      }
    }
    // The listings are the operator's surface, not the loop's work — printing them every
    // minute would bury the close lines that actually mean something happened.
    if (verbose) console.log(formatReconcile(await reconcile(pool)));
  };

  const stop = startScheduler(pass, intervalMs, true);
  console.log(`[close] reconcile daemon running every ${intervalMs}ms (owner role)`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[close] ${signal} — stopping`);
    stop();
    void pool.end().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
