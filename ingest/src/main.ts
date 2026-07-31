import type express from "express";
import type http from "node:http";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { getPool } from "./db.js";
import { createIngestApp, type SourceEvent } from "./server.js";
import { assertWebhookSecrets } from "./hmac.js";
import { baseUrlFor, enabledSources, type Source } from "./sources.js";
import { createQueue, enqueueEvent, startWorker } from "./queue.js";
import { catchUpReporter, connectorFor, formatUnclosableGap } from "./connectors/index.js";

const pool = getPool();
const port = Number(process.env.PORT ?? 4002);
const ingestRole = (process.env.INGEST_ROLE ?? "all").toLowerCase();
// Backfill cadence: pg-boss's boss.schedule() only supports cron-granularity (minimum
// 1-minute resolution) scheduling of a job insertion, and still needs a boss.work()
// consumer plus its own queue to actually run the poll — extra queue/DLQ wiring for no
// benefit here, since backfill has no per-run payload and no retry/DLQ semantics of its
// own (catchUp already retries internally). A plain setInterval in the receiver process
// is simpler, gives the same ~1-minute cadence, and needs no additional pg-boss objects.
const BACKFILL_INTERVAL_MS = Number(process.env.BACKFILL_INTERVAL_MS ?? 60_000);

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
      console.log("backfill still running, skipping tick");
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
        const report = await reporter.catchUpWithReport(pgPool, { baseUrl });
        for (const gap of report.gaps ?? []) console.error(formatUnclosableGap(source, gap));
      } else {
        await connector.catchUp(pgPool, { baseUrl });
      }
    } catch (err) {
      console.error("backfill round failed:", err);
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
