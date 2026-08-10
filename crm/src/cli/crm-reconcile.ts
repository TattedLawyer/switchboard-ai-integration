// Operator CLI — the four things worth looking at. Owner role: item 4 reads
// `approval.proposals`, where `switchboard_crm` holds nothing, correctly.
//
// Usage: node --import tsx src/cli/crm-reconcile.ts
import { getOwnerPool } from "../db.js";
import { reconcile, formatReconcile } from "../reconcile.js";

async function main(): Promise<void> {
  const pool = getOwnerPool();
  try {
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
