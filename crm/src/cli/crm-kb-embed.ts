// Operator CLI — ONE kb embed pass, one shot. Added for the throwaway testboard
// (approval/src/testboard.ts), which spawns shipped CLIs rather than reimplementing
// passes; useful on its own for the same reason `crm-run-cycle` is — run it, read the
// output, run it again.
//
// ROLE: `switchboard_crm` via CRM_DATABASE_URL — the pass's documented least privilege
// (its grants are pinned through that role in crm/test/kb-embed-pass.test.ts; the
// reconcile loop's owner credential strictly exceeds them, a recorded excess this
// one-shot does not copy).
//
// The model is LOCAL and vendored (~560MB); `createEmbedder` dies naming the fetch
// script if it is missing. Nothing here reaches the network.
import { getCrmPool } from "../db.js";
import { createEmbedder } from "../kb/embedder.js";
import { runKbEmbedPass, formatKbEmbedReport } from "../kb/embed-pass.js";

async function main(): Promise<void> {
  const db = getCrmPool();
  try {
    const embedder = await createEmbedder();
    const report = await runKbEmbedPass(db, embedder, {});
    console.log(formatKbEmbedReport(report));
    for (const f of report.failures) console.error(`entry ${f.entryId}: ${f.error}`);
    await db.end();
    // Per-entry failures are isolated by the pass but must not exit 0 — a green exit
    // over failed entries is the silent-calm failure this repo names as its worst.
    process.exit(report.failures.length > 0 ? 1 : 0);
  } catch (err) {
    console.error("crm-kb-embed failed:", err instanceof Error ? err.message : err);
    await db.end().catch(() => {});
    process.exit(1);
  }
}

main();
