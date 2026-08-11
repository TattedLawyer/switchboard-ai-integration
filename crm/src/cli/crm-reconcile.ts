// Operator CLI — the terminal-state CLOSE PASS, then the five listings. Owner role: both the
// close pass and item 4 read `approval.proposals`, where `switchboard_crm` holds nothing,
// correctly — the owner is the only principal that can see proposal state and write
// `crm.follow_ups`, which is exactly why the close lives here.
//
// The close pass runs FIRST so the passed-on listing reflects rejections closed this tick.
//
// Usage: node --import tsx src/cli/crm-reconcile.ts
import { getOwnerPool } from "../db.js";
import { reconcile, formatReconcile, closeTerminatedFollowUps } from "../reconcile.js";

async function main(): Promise<void> {
  const pool = getOwnerPool();
  try {
    const closed = await closeTerminatedFollowUps(pool);
    if (closed.length > 0) {
      const rejected = closed.filter((c) => c.reason === "rejected").length;
      const reproposed = closed.length - rejected;
      console.log(
        `closed ${closed.length} terminal follow-up(s): ${rejected} rejected (stopped & ` +
          `surfaced), ${reproposed} expired/failed (re-proposed next day)`,
      );
    }
    console.log(formatReconcile(await reconcile(pool)));
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("crm-reconcile failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
