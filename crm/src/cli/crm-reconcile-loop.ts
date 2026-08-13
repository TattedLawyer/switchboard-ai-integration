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

  const pass = async (): Promise<void> => {
    const closed = await closeTerminatedFollowUps(pool);
    if (closed.length > 0) {
      const rejected = closed.filter((c) => c.reason === "rejected").length;
      console.log(
        `[close] closed ${closed.length} terminal follow-up(s): ${rejected} rejected ` +
          `(stopped & surfaced), ${closed.length - rejected} expired/failed (re-proposed)`,
      );
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
