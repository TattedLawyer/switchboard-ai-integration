import { getPool } from "../db.js";
import { reconcile } from "../reconcile.js";

async function main(): Promise<void> {
  const ledgerPath = process.env.LEDGER_PATH ?? process.argv[2];
  if (!ledgerPath) {
    console.error("reconcile: LEDGER_PATH env var or path argument is required");
    process.exit(1);
  }

  const pool = getPool();
  try {
    const report = await reconcile(pool, ledgerPath);

    console.log(`ledger: ${report.ledger} distinct event_id(s)`);
    console.log(`raw:    ${report.raw} distinct event_id(s)`);
    console.log(`raw duplicates: ${report.rawDuplicates}`);
    console.log(`missing (in ledger, not in raw): ${report.missing.length}`);
    if (report.missing.length > 0) {
      for (const id of report.missing) console.log(`  - ${id}`);
    }
    console.log(`extra (in raw, not in ledger): ${report.extra.length}`);
    if (report.extra.length > 0) {
      for (const id of report.extra) console.log(`  - ${id}`);
    }

    const clean = report.missing.length === 0 && report.extra.length === 0 && report.rawDuplicates === 0;
    if (clean) {
      console.log("PASS: raw matches ledger exactly, no duplicates");
    } else {
      console.log("FAIL: reconciliation found discrepancies");
    }

    await pool.end();
    process.exit(clean ? 0 : 1);
  } catch (err) {
    console.error("reconcile failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
