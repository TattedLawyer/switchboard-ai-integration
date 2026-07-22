import type express from "express";
import type http from "node:http";
import type { PgBoss } from "pg-boss";
import type pg from "pg";
import { getPool } from "./db.js";
import { createIngestApp, type SourceEvent } from "./server.js";
import type { Source } from "./sources.js";
import { createQueue, enqueueEvent, startWorker } from "./queue.js";
import { catchUp, CRM_SOURCE } from "./backfill.js";

const pool = getPool();
const port = Number(process.env.PORT ?? 4002);
const ingestRole = (process.env.INGEST_ROLE ?? "all").toLowerCase();
const crmBaseUrl = process.env.CRM_BASE_URL ?? "http://localhost:4001";
// Backfill cadence: pg-boss's boss.schedule() only supports cron-granularity (minimum
// 1-minute resolution) scheduling of a job insertion, and still needs a boss.work()
// consumer plus its own queue to actually run the poll — extra queue/DLQ wiring for no
// benefit here, since backfill has no per-run payload and no retry/DLQ semantics of its
// own (catchUp already retries internally). A plain setInterval in the receiver process
// is simpler, gives the same ~1-minute cadence, and needs no additional pg-boss objects.
const BACKFILL_INTERVAL_MS = Number(process.env.BACKFILL_INTERVAL_MS ?? 60_000);

// Factory to create a backfill runner with in-flight guard (prevents overlapping runs).
export function createBackfillRunner(
  pgPool: pg.Pool,
  baseUrl: string,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      console.log("backfill still running, skipping tick");
      return;
    }

    running = true;
    try {
      await catchUp(pgPool, CRM_SOURCE, baseUrl);
    } catch (err) {
      console.error("backfill round failed:", err);
    } finally {
      running = false;
    }
  };
}

async function main() {
  let boss: PgBoss | undefined;
  let app: express.Express | undefined;
  let server: http.Server | undefined;
  let backfillTimer: NodeJS.Timeout | undefined;

  // Role can be: "receiver", "worker", or "all" (default)
  const isReceiver = ingestRole === "receiver" || ingestRole === "all";
  const isWorker = ingestRole === "worker" || ingestRole === "all";

  if (isReceiver || isWorker) {
    // Create the queue infrastructure
    const connectionUrl = process.env.DATABASE_URL;
    if (!connectionUrl) throw new Error("DATABASE_URL is required");
    boss = await createQueue(connectionUrl);
  }

  if (isReceiver) {
    // Create the HTTP receiver app with queue integration
    const enqueue = boss
      ? async (_source: Source, event: SourceEvent): Promise<void> => {
          // Use the queue to enqueue events instead of processing directly.
          // Still a single queue until Task 3 — the source flows through the
          // signature now so Task 3 is queue-only.
          await enqueueEvent(boss!, event);
        }
      : undefined;

    app = createIngestApp(pool, { enqueue });
    server = app.listen(port, () =>
      console.log(`ingest receiver listening on :${port} (role: ${ingestRole})`)
    );
  }

  if (isWorker && boss) {
    // Start the worker
    await startWorker(boss, pool);
    console.log(`ingest worker started (role: ${ingestRole})`);
  }

  // Periodic backfill: recovers events whose webhook delivery was dropped/failed. Must not
  // run in a receiver-only process (that role only accepts pushes; backfill belongs with
  // the worker/all roles that also own event ingestion).
  if (isWorker) {
    const runBackfill = createBackfillRunner(pool, crmBaseUrl);
    runBackfill().catch(() => {
      /* initial run errors already logged */
    });
    backfillTimer = setInterval(() => {
      runBackfill().catch(() => {
        /* errors already logged */
      });
    }, BACKFILL_INTERVAL_MS);
    console.log(`backfill scheduled every ${BACKFILL_INTERVAL_MS}ms against ${crmBaseUrl}`);
  }

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    if (backfillTimer) {
      clearInterval(backfillTimer);
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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
