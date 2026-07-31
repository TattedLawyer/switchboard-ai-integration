import { getPool } from "../db.js";
import { enabledSources } from "../sources.js";
import { connectorFor, formatUnclosableGap } from "../connectors/index.js";
import type { SheetReconcileReport } from "../connectors/sheet-snapshot.js";
import type { StripeFeedReconcileReport } from "../connectors/stripe-feed.js";
import type { HubReconcileReport } from "../connectors/hub-hydrate.js";

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
      } else if (connector.kind === "hub-hydrate") {
        // Task C standing checklist: the fourth paradigm's honest line — an object
        // store has no ledger file and no hash chain; what reconcile ACTUALLY verified
        // is that all three object listings were readable and every object was compared
        // against raw thin events + hydrated snapshots.
        console.log(
          `[${source}] object-store integrity: ok (company/contact/deal listings read; ` +
            "current state compared against raw thin events + hydrated snapshots)",
        );
      } else {
        console.log(`[${source}] ledger hash chain: ok`);
      }

      // integrity.ok with no skip guarantees a report; this satisfies the type checker without
      // inventing a fallback that would silently pass an unreconciled source.
      const report = result.report!;
      reconciledCount++;

      // Task C: hub-shaped reports reconcile OBJECTS against the vendor store, not
      // event ids against a ledger — label every count as what it actually is.
      const hub = connector.kind === "hub-hydrate" && "drifted" in report ? (report as HubReconcileReport) : undefined;

      if (connector.kind === "stripe-feed") {
        // The number is a 30-day WINDOW, not a ledger file — label it as what it is.
        console.log(`[${source}] retained window: ${report.ledger} event(s) (the feed's 30-day ledger-equivalent)`);
      } else if (hub !== undefined) {
        console.log(`[${source}] object store: ${report.ledger} live object(s) (the paradigm's ledger-equivalent)`);
      } else {
        console.log(`[${source}] ledger: ${report.ledger} distinct event_id(s)`);
      }
      if (hub !== undefined) {
        console.log(`[${source}] raw:    ${report.raw} thin event(s)`);
      } else {
        console.log(`[${source}] raw:    ${report.raw} distinct event_id(s)`);
      }
      console.log(`[${source}] raw duplicates: ${report.rawDuplicates}`);
      if (hub !== undefined) {
        console.log(`[${source}] missing (in the object store, never seen in raw — lost webhooks): ${report.missing.length}`);
      } else {
        console.log(`[${source}] missing (in ledger, not in raw): ${report.missing.length}`);
      }
      if (report.missing.length > 0) {
        for (const id of report.missing) console.log(`  - ${id}`);
      }
      if (hub !== undefined) {
        console.log(`[${source}] extra (in raw, absent from the store, no deletion event to explain it): ${report.extra.length}`);
      } else {
        console.log(`[${source}] extra (in raw, not in ledger): ${report.extra.length}`);
      }
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
      // Task C: the hydration paradigm's own buckets, each printed with its meaning.
      // tombstonedRaw is normal metabolism (deleted WITH a deletion event — context,
      // never gated). `drifted` and `missing` are the paradigm's admitted webhook
      // losses and they GATE. `hydration pending` gates too: limbo violates the
      // trichotomy oracle. The DLQ is DELIBERATELY not a failure by itself (stripefeed
      // quarantine precedent: one permanently-broken vendor object must not red every
      // reconcile forever) — it is counted and listed with reasons so the operator
      // looks in the right place.
      if (hub !== undefined) {
        console.log(`[${source}] tombstoned (deleted with a deletion event in raw — expected metabolism): ${hub.tombstonedRaw}`);
        console.log(`[${source}] drifted (store moved, no webhook told us — latest snapshot differs): ${hub.drifted.length}`);
        for (const key of hub.drifted) console.log(`  - ${key}`);
        console.log(`[${source}] hydration pending (no terminal state yet — the pump continues next run): ${hub.hydrationPending}`);
        console.log(`[${source}] hydration DLQ (terminal fetch failures, preserved — replay is an operator act): ${hub.hydrationDlq.length}`);
        for (const d of hub.hydrationDlq) console.log(`  - ${d.event_id} (${d.object_type}:${d.object_id}) ${d.reason}`);
      }

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
        (sf?.gaps.length ?? 0) === 0 &&
        (hub?.drifted.length ?? 0) === 0 &&
        (hub?.hydrationPending ?? 0) === 0;
      if (clean) {
        if (hub !== undefined) {
          console.log(`[${source}] PASS: store, raw thin events, and hydrated snapshots agree; nothing pending`);
        } else {
          console.log(`[${source}] PASS: raw matches ledger exactly, no duplicates`);
        }
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
