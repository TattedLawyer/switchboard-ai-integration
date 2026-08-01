import type express from "express";
import type http from "node:http";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { getPool } from "./db.js";
import { createIngestApp, type SourceEvent } from "./server.js";
import { assertWebhookSecrets } from "./hmac.js";
import { baseUrlFor, enabledSources, type Source } from "./sources.js";
import { createQueue, enqueueEvent, startWorker } from "./queue.js";
import { catchUpReporter, connectorFor, formatUnclosableGap, type UnclosableGap } from "./connectors/index.js";
import type { SheetCatchUpReport } from "./connectors/sheet-snapshot.js";
import type { StripeFeedCatchUpReport } from "./connectors/stripe-feed.js";
import type { BusReplayCatchUpReport } from "./connectors/bus-replay.js";
import type { HubHydrationReport } from "./connectors/hub-hydrate.js";
import { choiceFromEnv, intFromEnv, MAX_TIMER_DELAY_MS } from "./config.js";

const pool = getPool();
// B1: strict boot parsing (config.ts) — a typo'd PORT/interval/role is a boot refusal
// naming the variable, never NaN into listen(), a ~1ms hot loop, or a role that
// silently does nothing.
const port = intFromEnv("PORT", 4002, { min: 1, max: 65535 });
const ingestRole = choiceFromEnv("INGEST_ROLE", "all", ["receiver", "worker", "all"]);
// Backfill cadence: pg-boss's boss.schedule() only supports cron-granularity (minimum
// 1-minute resolution) scheduling of a job insertion, and still needs a boss.work()
// consumer plus its own queue to actually run the poll — extra queue/DLQ wiring for no
// benefit here, since backfill has no per-run payload and no retry/DLQ semantics of its
// own (catchUp already retries internally). A plain setInterval in the receiver process
// is simpler, gives the same ~1-minute cadence, and needs no additional pg-boss objects.
const BACKFILL_INTERVAL_MS = intFromEnv("BACKFILL_INTERVAL_MS", 60_000, {
  min: 1,
  max: MAX_TIMER_DELAY_MS,
});

// Factory to create a backfill runner with in-flight guard (prevents overlapping runs).
// A7: routed through the connector seam — connectorFor picks the right paradigm per
// source (ledger-feed sources keep the exact catchUp this loop always called, pinned by
// connector-seam.test.ts + the service-wiring regression pins; sheets gets the snapshot
// connector instead of a once-a-minute 404 against /events). One connector per runner,
// constructed once: the seam's registry may resolve construction-time config.
export function createBackfillRunner(
  pgPool: pg.Pool,
  source: Source,
  baseUrl: string,
): () => Promise<void> {
  const connector = connectorFor(source);
  let running = false;
  return async () => {
    if (running) {
      // B4: every per-source line carries its source — a multi-source service log
      // with anonymous lines cannot be triaged.
      console.log(`[${source}] backfill still running, skipping tick`);
      return;
    }

    running = true;
    try {
      // Gate-H cold review C1: the service loop consumes the REPORT where the connector
      // offers one — a retention-boundary fallback is not an error (the catch below
      // never fires for it), so without this the service log showed nothing at all
      // while events were permanently lost. Same shared phrasing as the CLIs.
      const reporter = catchUpReporter(connector);
      if (reporter) {
        // ── Exhaustive-consumption contract, SERVICE-LOG surface (Task F — the last of
        // checklist line 1's three surfaces to come under the compile wall; KNOWN-ISSUES
        // entry struck in the same commit). Same mechanism as cli/backfill.ts: each kind
        // rest-destructures its connector's OWN widened report shape and types the
        // remainder EMPTY, so a field added to any of the five shapes without a decided
        // service-log surface is a tsc error here before any test or reviewer. The
        // printing below reads ONLY these bindings; the `as` casts are the producer
        // guarantee (each connector's catchUpWithReport returns its own shape for its
        // own kind), exactly as in the CLIs.
        const report = await reporter.catchUpWithReport(pgPool, { baseUrl });
        let counts: { ingested: number; duplicates: number; quarantined: number };
        let gaps: readonly UnclosableGap[] | undefined;
        let degradations: readonly string[] | undefined;
        let hydration:
          | { hydrated: number; tombstoned: number; hydrationDlq: number; hydrationPending: number }
          | undefined;
        switch (connector.kind) {
          case "ledger-feed": {
            // No widened shape today — the base seam shape IS its contract (reachable
            // only if a ledger-feed connector ever grows a reporter), destructured full.
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
        // Cold review M3: the standing checklist is "both CLIs AND the service log", and
        // this loop consumed the failure fields while printing none of the WORK. For a
        // subscribe/replay source, where at-least-once redelivery is the steady state, a
        // loop that logs neither ingested nor absorbed counts is indistinguishable from
        // one that is doing nothing at all. Suppressed when the cycle was a genuine no-op
        // so a quiet system stays quiet.
        if (counts.ingested > 0 || counts.duplicates > 0 || counts.quarantined > 0) {
          console.log(
            `[${source}] catch-up: ingested ${counts.ingested}, ${counts.duplicates} duplicate(s) absorbed ` +
              `by idempotent ingest, ${counts.quarantined} quarantined`,
          );
        }
        // Hydration WORK surfaces on the same quiet-when-zero terms as the counts line:
        // for the pump paradigm, hydrated/tombstoned ARE the cycle's work product, and a
        // wall that consumed them into silence would satisfy the compiler while starving
        // the operator (checklist line 1 is "consumed AND printed, or discarded with a
        // named reason" — these are printed).
        if (hydration !== undefined && (hydration.hydrated > 0 || hydration.tombstoned > 0)) {
          console.log(
            `[${source}] hydration: ${hydration.hydrated} snapshot(s), ${hydration.tombstoned} tombstone(s) this cycle`,
          );
        }
        for (const gap of gaps ?? []) console.error(formatUnclosableGap(source, gap));
        // Sheets degradations reach the service log on the loud channel, matching the
        // CLI surface — previously consumed by the base-shape read and printed nowhere.
        for (const note of degradations ?? []) console.error(`[${source}] degradation: ${note}`);
        // Task C standing checklist: the hydration paradigm's failures reach the
        // service log on the same loud channel as gaps — a dead-lettered hydration is
        // an event whose full record we could not obtain, and a log that stays silent
        // about it is the exact class the Gate-H cold review caught (C1/I1).
        if ((hydration?.hydrationDlq ?? 0) > 0) {
          console.error(
            `[${source}] HYDRATION DLQ: ${hydration!.hydrationDlq} event(s) dead-lettered this run — ` +
              "terminal, preserved, listed by reconcile; replay is an operator act (RUNBOOK)",
          );
        }
        if ((hydration?.hydrationPending ?? 0) > 0) {
          console.log(
            `[${source}] hydration pending: ${hydration!.hydrationPending} event(s) waiting on the rate budget — next cycle continues`,
          );
        }
      } else {
        await connector.catchUp(pgPool, { baseUrl });
      }
    } catch (err) {
      console.error(`[${source}] backfill round failed:`, err);
    } finally {
      running = false;
    }
  };
}

/**
 * The service's per-source wiring, composed once so the interval loop and the nudge door
 * share the SAME runner — and therefore the same overlap guard (A7). `sheetsNudge` is
 * defined exactly when sheets is enabled: the nudge door's early catchUp IS the sheets
 * runner. A nudge that arrives while a cycle is running COALESCES — the guard skips it,
 * it is never queued — because the connector is stateless: the next cycle reads a fresh
 * snapshot and re-diffs from scratch anyway, so a queued re-run could only repeat the
 * same work the in-flight cycle is already doing.
 */
export interface ServiceWiring {
  runners: { source: Source; run: () => Promise<void>; baseUrl: string }[];
  sheetsNudge?: () => Promise<void>;
}

export function createServiceWiring(pgPool: pg.Pool, sources: Source[]): ServiceWiring {
  const runners = sources.map((source) => {
    const baseUrl = baseUrlFor(source);
    return { source, run: createBackfillRunner(pgPool, source, baseUrl), baseUrl };
  });
  const sheets = runners.find((r) => r.source === "sheets");
  return { runners, sheetsNudge: sheets?.run };
}

async function main() {
  // Fail closed at boot, not on first request: one aggregated error naming every
  // missing secret (A2). Demo/local runs opt in via ALLOW_DEV_SECRETS=1.
  assertWebhookSecrets(enabledSources());

  let boss: PgBoss | undefined;
  let app: express.Express | undefined;
  let server: http.Server | undefined;
  const backfillTimers: NodeJS.Timeout[] = [];

  // Role can be: "receiver", "worker", or "all" (default)
  const isReceiver = ingestRole === "receiver" || ingestRole === "all";
  const isWorker = ingestRole === "worker" || ingestRole === "all";

  if (isReceiver || isWorker) {
    // Create the queue infrastructure
    const connectionUrl = process.env.DATABASE_URL;
    if (!connectionUrl) throw new Error("DATABASE_URL is required");
    boss = await createQueue(connectionUrl);
  }

  // A7: the per-source wiring — seam-routed interval runners plus (when sheets is
  // enabled) the nudge hook that shares the sheets runner's overlap guard. Worker-role
  // only, for the same reason the interval loop is: backfill/catchUp belongs with the
  // roles that own event ingestion. A receiver-only process therefore hosts NO runner
  // and its nudge door keeps answering the honest 503 (see server.ts).
  const wiring = isWorker ? createServiceWiring(pool, enabledSources()) : undefined;

  if (isReceiver) {
    // Create the HTTP receiver app with queue integration
    const enqueue = boss
      ? async (source: Source, event: SourceEvent, rawBody: string): Promise<void> => {
          // Route each event onto its own source's queue; the wire bytes ride the job
          // envelope so the worker can store raw_body (2b-D4 expand).
          await enqueueEvent(boss!, source, event, rawBody);
        }
      : undefined;

    app = createIngestApp(pool, { enqueue, sheetsNudge: wiring?.sheetsNudge });
    server = app.listen(port, () =>
      console.log(`ingest receiver listening on :${port} (role: ${ingestRole})`)
    );
  }

  if (isWorker && boss) {
    // Start the per-source workers
    await startWorker(boss, pool);
    console.log(`ingest worker started (role: ${ingestRole})`);
  }

  // Periodic backfill: recovers events whose webhook delivery was dropped/failed. Must not
  // run in a receiver-only process (that role only accepts pushes; backfill belongs with
  // the worker/all roles that also own event ingestion). One runner + interval per enabled
  // source, each driving that source's own connector and cursor through the seam (A7) —
  // ledger-feed sources poll their /events feed exactly as before; sheets runs snapshot
  // catchUp cycles instead of 404ing a feed it never had.
  if (wiring) {
    for (const { source, run, baseUrl } of wiring.runners) {
      run().catch(() => {
        /* initial run errors already logged */
      });
      backfillTimers.push(
        setInterval(() => {
          run().catch(() => {
            /* errors already logged */
          });
        }, BACKFILL_INTERVAL_MS),
      );
      console.log(
        `backfill[${source}] scheduled every ${BACKFILL_INTERVAL_MS}ms against ${baseUrl}`,
      );
    }
  }

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    for (const timer of backfillTimers) {
      clearInterval(timer);
    }
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (boss) {
      await boss.stop();
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Only boot the service when this file IS the entrypoint. Tests import this module for
// createBackfillRunner; without the guard, the import itself started pg-boss against the
// real DATABASE_URL, bound the service port, and fired backfill fetches — a test-harness
// landmine whenever the suite ran against a shared database (cold/edge-review finding).
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
