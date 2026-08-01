import { getPool } from "../db.js";
import { enabledSources } from "../sources.js";
import { connectorFor, formatGapLedgerRow, listGaps } from "../connectors/index.js";
import { DEFAULT_TENANT_ID } from "../ingest-event.js";
import type { SheetReconcileReport } from "../connectors/sheet-snapshot.js";
import type { StripeFeedReconcileReport } from "../connectors/stripe-feed.js";
import type { HubReconcileReport } from "../connectors/hub-hydrate.js";
import type { BusReconcileReport } from "../connectors/bus-replay.js";

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

      // Which losses were already on the record BEFORE this run. Taken as ids rather than
      // by comparing timestamps because `detected_at` is the DATABASE clock and this is
      // the app clock; an id-set diff needs no clock at all.
      const priorGapIds = new Set((await listGaps(pool, DEFAULT_TENANT_ID, source)).map((g) => g.id));

      const result = await connector.reconcile(pool);

      // ── the durable disclosure, printed BEFORE any degraded-path exit ──────────────
      //
      // Cold review I1: this read used to sit below the `skipped` and `!integrity.ok`
      // continues, so a source that was unreachable or unreadable printed its live
      // failure and NOTHING about the permanent losses already on its record — at exactly
      // the moment an operator is reading this output. The gate still held (exit nonzero),
      // but the disclosure is the point of the ledger: a row nobody prints is a row nobody
      // acts on. A standing loss is a fact about the past; it is not contingent on whether
      // the source answered the phone today.
      const ledgerGaps = await listGaps(pool, DEFAULT_TENANT_ID, source);
      const unacknowledged = ledgerGaps.filter((g) => g.acknowledgedAt === null);
      if (ledgerGaps.length > 0) {
        console.error(
          `[${source}] gap ledger: ${ledgerGaps.length} recorded permanent loss(es), ` +
            `${unacknowledged.length} unacknowledged — read from ingest.gap_ledger, independent of this run's live read`,
        );
      }
      // Every gap is printed, acknowledged or not: acknowledging a loss records that a
      // human accepted it, it does not make it stop being true. Each line says whether it
      // was already on the record or was found just now, so a standing loss is never
      // mistaken for fresh damage during an incident (and vice versa).
      for (const gap of ledgerGaps) {
        const when = priorGapIds.has(gap.id) ? "standing (recorded before this run)" : "detected in this run";
        console.error(`${formatGapLedgerRow(source, gap)} — ${when}`);
      }
      if (unacknowledged.length > 0) {
        // A red with no next step is how reconcile gets ignored. Print the exact command.
        console.error(
          `[${source}] ${unacknowledged.length} UNACKNOWLEDGED gap(s). No retry can close a gap — once you have ` +
            "accepted the loss, record it:\n" +
            `  node --import tsx src/cli/gap-ack.ts --source ${source} --id <n> --by <operator> --note "why"`,
        );
        // The gate is the ledger's, not the live read's: an unacknowledged permanent loss
        // reds the run even when this source was skipped or unreadable this time.
        allClean = false;
      }

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
      } else if (connector.kind === "bus-replay") {
        // Task D standing checklist: the FIFTH arm's honest line. A bus has no ledger
        // file and no hash chain — what reconcile ACTUALLY verified is that the whole
        // retained window was drained through to has_more=false, every frame carried an
        // identity, and the subscription kept advancing.
        console.log(
          `[${source}] event stream integrity: ok (retained window fully drained, every frame identified, subscription advancing)`,
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
      } else if (connector.kind === "bus-replay") {
        console.log(`[${source}] retained window: ${report.ledger} event(s) (the bus's 72h ledger-equivalent)`);
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

      // The two WINDOW-BOUNDED paradigms (stripefeed's 30-day feed, casebus's 72h bus)
      // report the same extra buckets, so they print through one branch: `agedOutRaw` is
      // the window's normal metabolism (context, never gated) and `quarantined` is
      // retained-but-diverted — preserved, replayable, and deliberately not a failure by
      // itself, because one poisoned vendor event must not red every reconcile for the
      // length of the window.
      const windowed =
        connector.kind === "stripe-feed" || connector.kind === "bus-replay"
          ? (report as StripeFeedReconcileReport | BusReconcileReport)
          : undefined;
      if (windowed !== undefined) {
        console.log(`[${source}] aged out of window (in raw, ingested before expiry — expected): ${windowed.agedOutRaw}`);
        console.log(
          `[${source}] quarantined (retained at the source, preserved in ingest.quarantine — not counted as missing): ${windowed.quarantined.length}`,
        );
        for (const q of windowed.quarantined) console.log(`  - ${q.event_id} (${q.count} quarantine row(s))`);
      }

      // The gap ledger was read and printed ABOVE, before the degraded-path exits — see
      // the cold-review I1 note there. `unacknowledged` is in scope from that read and is
      // what gates below; it is deliberately NOT re-read here, so the line an operator saw
      // and the verdict they get cannot disagree.
      const clean =
        report.missing.length === 0 &&
        report.extra.length === 0 &&
        report.rawDuplicates === 0 &&
        (stale?.length ?? 0) === 0 &&
        unacknowledged.length === 0 &&
        (hub?.drifted.length ?? 0) === 0 &&
        (hub?.hydrationPending ?? 0) === 0;
      if (clean) {
        // An acknowledged gap is a STANDING DISCLOSED CONDITION, not a clean bill of
        // health — so a PASS that has one says so on the same line.
        const ackNote =
          ledgerGaps.length > 0
            ? ` (with ${ledgerGaps.length} acknowledged permanent gap(s) standing — see above)`
            : "";
        // Paradigm-honest PASS line (cold review M1): the same class the integrity lines
        // above were rewritten for, left behind on the verdict itself. A bus and a feed
        // have no ledger; a sheet has no ledger file either. Say what actually matched.
        if (hub !== undefined) {
          console.log(`[${source}] PASS: store, raw thin events, and hydrated snapshots agree; nothing pending${ackNote}`);
        } else if (connector.kind === "bus-replay") {
          console.log(`[${source}] PASS: raw matches the bus's retained window exactly, no duplicates${ackNote}`);
        } else if (connector.kind === "stripe-feed") {
          console.log(`[${source}] PASS: raw matches the feed's retained window exactly, no duplicates${ackNote}`);
        } else if (connector.kind === "sheet-snapshot") {
          console.log(`[${source}] PASS: raw latest-state matches the sheet exactly, no duplicates${ackNote}`);
        } else {
          console.log(`[${source}] PASS: raw matches ledger exactly, no duplicates${ackNote}`);
        }
      } else if (unacknowledged.length > 0) {
        console.log(
          `[${source}] FAIL: ${unacknowledged.length} unacknowledged unclosable gap(s) reported — ` +
            "permanent data loss admitted at this source's boundary",
        );
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
