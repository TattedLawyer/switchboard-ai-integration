import { getPool } from "../db.js";
import { baseUrlFor, enabledSources } from "../sources.js";
import {
  catchUpReporter,
  connectorFor,
  formatUnclosableGap,
  type UnclosableGap,
} from "../connectors/index.js";
import type { SheetCatchUpReport } from "../connectors/sheet-snapshot.js";
import type { StripeFeedCatchUpReport } from "../connectors/stripe-feed.js";
import type { BusReplayCatchUpReport } from "../connectors/bus-replay.js";
import type { HubHydrationReport } from "../connectors/hub-hydrate.js";

async function main(): Promise<void> {
  const pool = getPool();
  let failed = false;

  for (const source of enabledSources()) {
    // Reported for operator context only; the connector resolves its own source of truth.
    const baseUrl = baseUrlFor(source);
    const connector = connectorFor(source);
    try {
      // Gate-H cold review C1: when the connector can report more than a number, ASK IT
      // — the report is where retention-boundary losses live, and a CLI that called the
      // number-only path printed "ingested 6 event(s)" over a permanent 8-event loss.
      const reporter = catchUpReporter(connector);
      if (reporter) {
        // ── Exhaustive-consumption contract (docs/operator-surface-checklist.md line 1,
        // compile-time) ─────────────────────────────────────────────────────────────────
        // PER-KIND, over the WIDENED catch-up shapes — not just the seam's base
        // CatchUpReport. The house widening-method pattern means new fields are born on
        // the per-connector interfaces (that is exactly where `gaps` first appeared), and
        // a base-only destructure is blind to them (Task E cold review I1: a phantom on
        // StripeFeedCatchUpReport typechecked clean). Each case rest-destructures its
        // connector's OWN report shape and types the remainder EMPTY, so a field added to
        // any of the five shapes without a decided operator surface is a compile error in
        // this CLI before any test or reviewer. The printing below reads ONLY these
        // bindings; a deliberately-unprinted field must be discarded here with a comment
        // naming why. The `as` casts are the producer guarantee, as in reconcile.ts:
        // each connector's catchUpWithReport returns its own shape for its own kind.
        const report = await reporter.catchUpWithReport(pool);
        let counts: { ingested: number; duplicates: number; quarantined: number };
        let gaps: readonly UnclosableGap[] | undefined;
        let degradations: readonly string[] | undefined;
        let hydration:
          | { hydrated: number; tombstoned: number; hydrationDlq: number; hydrationPending: number }
          | undefined;
        switch (connector.kind) {
          case "ledger-feed": {
            // No widened shape today (ledger-feed connectors are number-only; this arm is
            // reachable only if one ever grows a reporter) — the base seam shape IS its
            // contract, destructured in full.
            const {
              ingested, duplicates, quarantined, gaps: g, degradations: d,
              hydrated, tombstoned, hydrationDlq, hydrationPending, ...rest
            } = report;
            rest satisfies Record<string, never>;
            counts = { ingested, duplicates, quarantined };
            gaps = g;
            degradations = d;
            hydration =
              hydrated !== undefined
                ? { hydrated, tombstoned: tombstoned ?? 0, hydrationDlq: hydrationDlq ?? 0, hydrationPending: hydrationPending ?? 0 }
                : undefined;
            break;
          }
          case "sheet-snapshot": {
            const { ingested, duplicates, quarantined, degradations: d, ...rest } =
              report as SheetCatchUpReport;
            rest satisfies Record<string, never>;
            counts = { ingested, duplicates, quarantined };
            degradations = d;
            break;
          }
          case "stripe-feed": {
            const { ingested, duplicates, quarantined, gaps: g, ...rest } =
              report as StripeFeedCatchUpReport;
            rest satisfies Record<string, never>;
            counts = { ingested, duplicates, quarantined };
            gaps = g;
            break;
          }
          case "bus-replay": {
            const { ingested, duplicates, quarantined, gaps: g, ...rest } =
              report as BusReplayCatchUpReport;
            rest satisfies Record<string, never>;
            counts = { ingested, duplicates, quarantined };
            gaps = g;
            break;
          }
          case "hub-hydrate": {
            const { ingested, duplicates, quarantined, hydrated, tombstoned, hydrationDlq, hydrationPending, ...rest } =
              report as HubHydrationReport;
            rest satisfies Record<string, never>;
            counts = { ingested, duplicates, quarantined };
            hydration = { hydrated, tombstoned, hydrationDlq, hydrationPending };
            break;
          }
        }
        const { ingested, duplicates, quarantined } = counts;
        const quarantineNote = quarantined > 0 ? `, quarantined ${quarantined}` : "";
        if (hydration !== undefined) {
          const { hydrated, tombstoned, hydrationDlq, hydrationPending } = hydration;
          // Hydration paradigm (Task C standing checklist): this connector's catchUp is
          // a hydration PUMP — thin events arrive by webhook push, so an "ingested 0"
          // line here would be a number-only truth hiding the actual work and the
          // actual failures. Print what the run really did.
          console.log(
            `backfill[${source}]: hydrated ${hydrated} snapshot(s), ` +
              `${tombstoned} tombstone(s) (thin events arrive by webhook push; ` +
              `catchUp is the hydration pump)${quarantineNote} from ${baseUrl}`,
          );
          if (hydrationDlq > 0) {
            console.error(
              `[${source}] HYDRATION DLQ: ${hydrationDlq} event(s) dead-lettered this run — ` +
                "terminal, preserved, listed by reconcile; replay is an operator act (RUNBOOK)",
            );
          }
          if (hydrationPending > 0) {
            console.log(
              `backfill[${source}]: ${hydrationPending} event(s) still pending hydration ` +
                "(rate budget reached) — the next run continues",
            );
          }
        } else {
          // Task D standing checklist: `duplicates` is printed whenever there are any.
          // For the subscribe/replay paradigm at-least-once delivery makes redeliveries
          // ROUTINE, not exceptional — and a source that redelivers everything looks
          // exactly like a source that ingests nothing unless the absorbed count is on
          // the log. Suppressed at zero so the other paradigms' lines are unchanged.
          const duplicateNote =
            duplicates > 0 ? `, ${duplicates} duplicate(s) absorbed by idempotent ingest` : "";
          console.log(
            `backfill[${source}]: ingested ${ingested} event(s)${duplicateNote}${quarantineNote} from ${baseUrl}`,
          );
        }
        // Loud, on stderr, one shared phrasing (grep/alert target). Deliberate
        // semantics: the exit code stays 0 — the drain itself SUCCEEDED and forward
        // progress is real; reconcile is the gate that turns a gap into a red. A
        // nonzero here would teach cron to retry a loss no retry can close.
        for (const gap of gaps ?? []) console.error(formatUnclosableGap(source, gap));
        for (const note of degradations ?? []) console.error(`backfill[${source}] degradation: ${note}`);
      } else {
        const ingested = await connector.catchUp(pool);
        console.log(`backfill[${source}]: ingested ${ingested} event(s) from ${baseUrl}`);
      }
    } catch (err) {
      failed = true;
      console.error(`backfill[${source}] failed:`, err);

      // Read final cursor position to show resumable state — the REAL cursor for this
      // paradigm (cold review I3): opaque-cursor sources resume from last_event_id;
      // last_seq is pinned at 0 for them and quoting it told the operator a wrong,
      // ledger-paradigm position in the middle of an incident.
      try {
        const endRes = await pool.query(
          "select last_seq, last_event_id from ingest.cursors where source = $1",
          [source],
        );
        const row = endRes.rows[0] as { last_seq?: unknown; last_event_id?: string | null } | undefined;
        const cursor = row?.last_event_id ?? String(Number(row?.last_seq ?? 0));
        // B4: prefixed in this file's own house style — the line prints mid-incident,
        // in a loop over sources, where an anonymous cursor is actively misleading.
        console.log(`backfill[${source}]: state is consistent; re-run to resume from cursor ${cursor}`);
      } catch (cursorErr) {
        console.error(`backfill[${source}] could not read cursor:`, cursorErr);
      }
    }
  }

  await pool.end();
  process.exit(failed ? 1 : 0);
}

main();
