import { getPool } from "../db.js";
import { baseUrlFor, enabledSources } from "../sources.js";
import { catchUpReporter, connectorFor, formatUnclosableGap } from "../connectors/index.js";

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
        const report = await reporter.catchUpWithReport(pool);
        const quarantineNote = report.quarantined > 0 ? `, quarantined ${report.quarantined}` : "";
        if (report.hydrated !== undefined) {
          // Hydration paradigm (Task C standing checklist): this connector's catchUp is
          // a hydration PUMP — thin events arrive by webhook push, so an "ingested 0"
          // line here would be a number-only truth hiding the actual work and the
          // actual failures. Print what the run really did.
          console.log(
            `backfill[${source}]: hydrated ${report.hydrated} snapshot(s), ` +
              `${report.tombstoned ?? 0} tombstone(s) (thin events arrive by webhook push; ` +
              `catchUp is the hydration pump)${quarantineNote} from ${baseUrl}`,
          );
          if ((report.hydrationDlq ?? 0) > 0) {
            console.error(
              `[${source}] HYDRATION DLQ: ${report.hydrationDlq} event(s) dead-lettered this run — ` +
                "terminal, preserved, listed by reconcile; replay is an operator act (RUNBOOK)",
            );
          }
          if ((report.hydrationPending ?? 0) > 0) {
            console.log(
              `backfill[${source}]: ${report.hydrationPending} event(s) still pending hydration ` +
                "(rate budget reached) — the next run continues",
            );
          }
        } else {
          console.log(`backfill[${source}]: ingested ${report.ingested} event(s)${quarantineNote} from ${baseUrl}`);
        }
        // Loud, on stderr, one shared phrasing (grep/alert target). Deliberate
        // semantics: the exit code stays 0 — the drain itself SUCCEEDED and forward
        // progress is real; reconcile is the gate that turns a gap into a red. A
        // nonzero here would teach cron to retry a loss no retry can close.
        for (const gap of report.gaps ?? []) console.error(formatUnclosableGap(source, gap));
        for (const note of report.degradations ?? []) console.error(`backfill[${source}] degradation: ${note}`);
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
        console.log(`state is consistent; re-run to resume from cursor ${cursor}`);
      } catch (cursorErr) {
        console.error("could not read cursor:", cursorErr);
      }
    }
  }

  await pool.end();
  process.exit(failed ? 1 : 0);
}

main();
