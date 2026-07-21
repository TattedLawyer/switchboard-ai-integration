import type express from "express";
import type { PgBoss } from "pg-boss";
import { getPool } from "./db.js";
import { createIngestApp, type CrmEvent } from "./server.js";
import { createQueue, startWorker } from "./queue.js";

const pool = getPool();
const port = Number(process.env.PORT ?? 4002);
const ingestRole = (process.env.INGEST_ROLE ?? "all").toLowerCase();

async function main() {
  let boss: PgBoss | undefined;
  let app: express.Express | undefined;

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
      ? async (event: CrmEvent): Promise<void> => {
          // Use the queue to enqueue events instead of processing directly
          await boss!.send("ingest-event", event);
        }
      : undefined;

    app = createIngestApp(pool, { enqueue });
    app.listen(port, () =>
      console.log(`ingest receiver listening on :${port} (role: ${ingestRole})`)
    );
  }

  if (isWorker && boss) {
    // Start the worker
    await startWorker(boss, pool);
    console.log(`ingest worker started (role: ${ingestRole})`);
  }

  // Handle graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down...");
    if (boss) {
      await boss.stop();
    }
    if (app) {
      // HTTP server close would happen automatically
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
