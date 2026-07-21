import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createQueue, enqueueEvent, startWorker, fetchDlq, replayDlq } from "../src/queue.js";
import type { CrmEvent } from "../src/server.js";
import { PgBoss } from "pg-boss";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let connectionString: string;

beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  const originalUrl = process.env.DATABASE_URL;
  if (!originalUrl) throw new Error("DATABASE_URL is required");

  const dbResult = await pool.query("select current_database() as db");
  const dbName = dbResult.rows[0].db;

  connectionString = originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
});

afterAll(async () => {
  await cleanup();
});

const ev = (id: string): CrmEvent => ({
  event_id: id,
  event_type: "company.updated",
  occurred_at: new Date().toISOString(),
  data: { id: "DEMO-C-0001", name: "DEMO X", domain: "x.example.com" },
});

describe("replayDlq", () => {
  it("replays a real DLQ'd job with a healthy pool: ingests it and consumes the DLQ entry", async () => {
    // Poison-path pattern (from queue.test.ts): tiny retry options + a poisoned pool so a job
    // dead-letters quickly and predictably.
    const boss = await createQueue(connectionString, {
      retryLimit: 1,
      retryDelay: 1,
      retryBackoff: false,
    });
    try {
      const poisonPool = {
        connect: async () => {
          throw new Error("Pool is poisoned");
        },
      } as unknown as pg.Pool;

      await startWorker(boss, poisonPool);

      const event = ev("evt-replay-1");
      await enqueueEvent(boss, event);

      // Bounded poll (≤20s) for the job to land in the DLQ.
      const deadline = Date.now() + 20000;
      let dlqJob: { id: string; data: CrmEvent } | undefined;
      while (Date.now() < deadline) {
        const dlqJobs = await fetchDlq(boss);
        dlqJob = dlqJobs.find((j) => j.data.event_id === event.event_id);
        if (dlqJob) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(dlqJob).toBeDefined();

      // Sanity check: not ingested yet.
      const preResult = await pool.query(
        "select count(*)::int as n from raw.raw_crm_events where event_id=$1",
        [event.event_id]
      );
      expect(preResult.rows[0].n).toBe(0);

      // Replay with the HEALTHY pool.
      const result = await replayDlq(boss, pool);
      expect(result).toEqual({ replayed: 1, failed: 0 });

      // Raw row now exists.
      const postResult = await pool.query(
        "select count(*)::int as n from raw.raw_crm_events where event_id=$1",
        [event.event_id]
      );
      expect(postResult.rows[0].n).toBe(1);

      // DLQ job was consumed: a second fetch does not return it again.
      const dlqAfter = await fetchDlq(boss);
      expect(dlqAfter.find((j) => j.data.event_id === event.event_id)).toBeUndefined();
    } finally {
      await boss.stop();
    }
  }, 25000);
});
