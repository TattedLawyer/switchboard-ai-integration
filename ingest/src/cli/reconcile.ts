import { getPool } from "../db.js";
import { reconcile, verifyLedgerChain } from "../reconcile.js";
import { enabledSources, ledgerPathFor } from "../sources.js";

async function main(): Promise<void> {
  const pool = getPool();
  let reconciledCount = 0;
  let allClean = true;

  try {
    for (const source of enabledSources()) {
      const ledgerPath = ledgerPathFor(source);
      if (!ledgerPath) {
        console.log(`[${source}] skipped (no LEDGER_PATH_${source.toUpperCase()})`);
        continue;
      }

      const chain = verifyLedgerChain(ledgerPath);
      if (!chain.ok) {
        console.log(`[${source}] FAIL: ledger hash chain broken at line ${chain.brokenAt}`);
        reconciledCount++;
        allClean = false;
        continue;
      }
      console.log(`[${source}] ledger hash chain: ok`);

      const report = await reconcile(pool, source, ledgerPath);
      reconciledCount++;

      console.log(`[${source}] ledger: ${report.ledger} distinct event_id(s)`);
      console.log(`[${source}] raw:    ${report.raw} distinct event_id(s)`);
      console.log(`[${source}] raw duplicates: ${report.rawDuplicates}`);
      console.log(`[${source}] missing (in ledger, not in raw): ${report.missing.length}`);
      if (report.missing.length > 0) {
        for (const id of report.missing) console.log(`  - ${id}`);
      }
      console.log(`[${source}] extra (in raw, not in ledger): ${report.extra.length}`);
      if (report.extra.length > 0) {
        for (const id of report.extra) console.log(`  - ${id}`);
      }

      const clean =
        report.missing.length === 0 && report.extra.length === 0 && report.rawDuplicates === 0;
      if (clean) {
        console.log(`[${source}] PASS: raw matches ledger exactly, no duplicates`);
      } else {
        console.log(`[${source}] FAIL: reconciliation found discrepancies`);
        allClean = false;
      }
    }

    if (reconciledCount === 0) {
      console.log("FAIL: no source had a ledger path set; nothing was reconciled");
    }

    await pool.end();
    process.exit(allClean && reconciledCount > 0 ? 0 : 1);
  } catch (err) {
    console.error("reconcile failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
