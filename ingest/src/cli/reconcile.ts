import { getPool } from "../db.js";
import { enabledSources } from "../sources.js";
import { connectorFor, formatUnclosableGap } from "../connectors/index.js";
import type { SheetReconcileReport } from "../connectors/sheet-snapshot.js";
import type { StripeFeedReconcileReport } from "../connectors/stripe-feed.js";

// Bounded listing for the stale bucket: unlike missing/extra (which converge toward
// empty on a healthy source), stale can be O(sheet) after a bulk edit — an operator
// needs the first row_keys to start fix-the-cell triage, not ten thousand lines.
const STALE_LIST_CAP = 20;

async function main(): Promise<void> {
  const pool = getPool();
  let reconciledCount = 0;
  let allClean = true;

  try {
    for (const source of enabledSources()) {
      const connector = connectorFor(source);
      const result = await connector.reconcile(pool);

      if (result.skipped) {
        console.log(`[${source}] skipped (${result.skipped})`);
        continue;
      }

      if (!result.integrity.ok) {
        console.log(`[${source}] FAIL: ${result.integrity.detail ?? "source record not trusted"}`);
        reconciledCount++;
        allClean = false;
        continue;
      }
      // Paradigm-honest integrity line (cold review Minor 6): say what reconcile
      // actually verified for THIS connector kind. The sheets paradigm has no ledger
      // file and no hash chain — printing "ledger hash chain: ok" there was false.
      if (connector.kind === "sheet-snapshot") {
        console.log(`[${source}] snapshot integrity: ok (sheet readable, metadata/key mapping consistent)`);
      } else if (connector.kind === "stripe-feed") {
        // Cold review I1 — the same dishonesty class Minor 6 fixed for sheets, which
        // the third paradigm silently reintroduced: no ledger file, no hash chain here.
        console.log(
          `[${source}] feed window integrity: ok (retained window fully drained, envelopes well-formed, feed advancing)`,
        );
      } else {
        console.log(`[${source}] ledger hash chain: ok`);
      }

      // integrity.ok with no skip guarantees a report; this satisfies the type checker without
      // inventing a fallback that would silently pass an unreconciled source.
      const report = result.report!;
      reconciledCount++;

      if (connector.kind === "stripe-feed") {
        // The number is a 30-day WINDOW, not a ledger file — label it as what it is.
        console.log(`[${source}] retained window: ${report.ledger} event(s) (the feed's 30-day ledger-equivalent)`);
      } else {
        console.log(`[${source}] ledger: ${report.ledger} distinct event_id(s)`);
      }
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

      // Cold review I1: sheet-shaped reports carry a fourth bucket the ledger paradigm
      // has no equivalent of — `stale` = present on both sides but content differs, the
      // snapshot paradigm's EVERYDAY drift (a human edits a cell after a clean ingest;
      // quarantined-current rows live here too). Ignoring it made a drifted sheet print
      // PASS. It is surfaced (bounded) and folded into the pass/fail decision below.
      const stale = "stale" in report ? (report as SheetReconcileReport).stale : undefined;
      if (stale !== undefined) {
        console.log(`[${source}] stale (present on both sides, content differs): ${stale.length}`);
        for (const rowKey of stale.slice(0, STALE_LIST_CAP)) console.log(`  - ${rowKey}`);
        if (stale.length > STALE_LIST_CAP) {
          console.log(`  ... and ${stale.length - STALE_LIST_CAP} more (listing capped at ${STALE_LIST_CAP})`);
        }
      }

      // Cold review C1/I2 — the retention paradigm's own buckets. agedOutRaw is the
      // window's normal metabolism (printed for context, never gated). `quarantined`
      // is retained-but-diverted: preserved in ingest.quarantine, replayable, NOT
      // ingestion loss — named and counted so the operator looks in the right place,
      // and deliberately not a failure by itself (one poisoned vendor event must not
      // red a month of reconciles). `gaps` are the paradigm's admitted permanent
      // losses and they GATE: a gap is never a PASS-silently condition. Exit-nonzero-
      // on-first-appearance is the deliberate v1 (per-process detection means a fresh
      // process after the fallback no longer sees it, so a permanent red is impossible
      // today); the acknowledged-gap workflow arrives with the durable gap ledger
      // (register follow-up, shared with the bus task).
      const sf = "gaps" in report ? (report as StripeFeedReconcileReport) : undefined;
      if (sf !== undefined) {
        console.log(`[${source}] aged out of window (in raw, ingested before expiry — expected): ${sf.agedOutRaw}`);
        console.log(
          `[${source}] quarantined (retained in feed, preserved in ingest.quarantine — not counted as missing): ${sf.quarantined.length}`,
        );
        for (const q of sf.quarantined) console.log(`  - ${q.event_id} (${q.count} quarantine row(s))`);
        for (const gap of sf.gaps) console.error(formatUnclosableGap(source, gap));
      }

      const clean =
        report.missing.length === 0 &&
        report.extra.length === 0 &&
        report.rawDuplicates === 0 &&
        (stale?.length ?? 0) === 0 &&
        (sf?.gaps.length ?? 0) === 0;
      if (clean) {
        console.log(`[${source}] PASS: raw matches ledger exactly, no duplicates`);
      } else if ((sf?.gaps.length ?? 0) > 0) {
        console.log(`[${source}] FAIL: unclosable gap(s) reported — permanent data loss at the retention boundary`);
        allClean = false;
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
