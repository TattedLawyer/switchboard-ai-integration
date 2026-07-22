import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createQueue, enqueueEvent, startWorker, fetchDlq } from "../src/queue.js";
import type { SourceEvent } from "../src/server.js";
import { PgBoss } from "pg-boss";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let connectionString: string;

beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  // Extract connection string from pool config or environment
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) throw new Error("DATABASE_URL is required");

  // Get database name from freshTestDb-created pool
  const dbResult = await pool.query("select current_database() as db");
  const dbName = dbResult.rows[0].db;

  // Replace the database name in the original URL with the test DB name
  connectionString = originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
});

afterAll(async () => {
  await cleanup();
});

const ev = (id: string): SourceEvent => ({
  event_id: id,
  event_type: "company.updated",
  occurred_at: new Date().toISOString(),
  data: { id: "DEMO-C-0001", name: "DEMO X", domain: "x.example.com" },
});

describe("pg-boss queue", () => {
  it("(happy path) enqueue → worker → raw row + outbox row exist", async () => {
    const boss = await createQueue(connectionString);
    try {
      const event = ev("evt-queue-1");
      await enqueueEvent(boss, event);
      await startWorker(boss, pool);

      // Poll for raw row (bounded 10s)
      const deadline = Date.now() + 10000;
      let rawExists = false;
      let outboxExists = false;

      while (Date.now() < deadline) {
        const rawResult = await pool.query(
          "select count(*)::int as n from raw.raw_events where source='crm' and event_id=$1",
          [event.event_id]
        );
        const outboxResult = await pool.query(
          "select count(*)::int as n from ingest.outbox where event_id=$1",
          [event.event_id]
        );

        if (rawResult.rows[0].n === 1 && outboxResult.rows[0].n === 1) {
          rawExists = true;
          outboxExists = true;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(rawExists).toBe(true);
      expect(outboxExists).toBe(true);
    } finally {
      await boss.stop();
    }
  });

  it("(poison path) worker with failing handler → job lands in DLQ, not ingested", async () => {
    // Tiny retry options so the job exhausts retries and dead-letters within the poll window.
    const boss = await createQueue(connectionString, {
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false,
    });
    try {
      // ingestEvent calls pool.connect() first (see src/ingest-event.ts line 5), so reject there
      // with a realistic connection-pool error, not an incidental TypeError on a missing method.
      const poisonPool = {
        connect: async () => {
          throw new Error("Pool is poisoned");
        },
      } as unknown as pg.Pool;

      await startWorker(boss, poisonPool);

      const event = ev("evt-poison-4");
      await enqueueEvent(boss, event);

      // Bounded poll (≤20s, no fixed sleeps) for the job to land in the DLQ.
      const deadline = Date.now() + 20000;
      let dlqJob: { id: string; data: SourceEvent } | undefined;
      while (Date.now() < deadline) {
        const dlqJobs = await fetchDlq(boss);
        dlqJob = dlqJobs.find((j) => j.data.event_id === event.event_id);
        if (dlqJob) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(dlqJob).toBeDefined();
      expect(dlqJob!.data.event_id).toBe(event.event_id);

      // Verify the job did NOT result in an ingested event (raw table is empty)
      const rawResult = await pool.query(
        "select count(*)::int as n from raw.raw_events where source='crm' and event_id=$1",
        [event.event_id]
      );
      expect(rawResult.rows[0].n).toBe(0);
    } finally {
      await boss.stop();
    }
  }, 25000);
});
