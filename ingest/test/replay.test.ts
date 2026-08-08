import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createQueue, enqueueEvent, startWorker, fetchDlq, fetchQueueDepths, replayDlq } from "../src/queue.js";
import type { SourceEvent } from "../src/server.js";
import { PgBoss } from "pg-boss";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

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

const ev = (id: string): SourceEvent => ({
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

      await startWorker(boss, poisonPool, { tenantId: DEFAULT_TENANT_ID });

      // Use a NON-crm source so the test proves replayDlq re-ingests under the job's own
      // source (a hardcoded "crm" would fail this assertion).
      const event = ev("evt-replay-1");
      await enqueueEvent(boss, "billing", event, { tenantId: DEFAULT_TENANT_ID });

      // Bounded poll (≤20s) for the job to land in the DLQ.
      const deadline = Date.now() + 20000;
      let dlqJob: { source: string; id: string; data: SourceEvent } | undefined;
      while (Date.now() < deadline) {
        const dlqJobs = await fetchDlq(boss, DEFAULT_TENANT_ID);
        dlqJob = dlqJobs.find((j) => j.data.event_id === event.event_id);
        if (dlqJob) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(dlqJob).toBeDefined();
      expect(dlqJob!.source).toBe("billing");

      // Sanity check: not ingested yet.
      const preResult = await pool.query(
        "select count(*)::int as n from raw.raw_events where event_id=$1",
        [event.event_id]
      );
      expect(preResult.rows[0].n).toBe(0);

      // Replay with the HEALTHY pool.
      const result = await replayDlq(boss, pool, DEFAULT_TENANT_ID);
      expect(result).toMatchObject({ replayed: 1, failed: 0, failures: [] });

      // Raw row now exists — under the job's source, not a hardcoded one.
      const postResult = await pool.query(
        "select source from raw.raw_events where event_id=$1",
        [event.event_id]
      );
      expect(postResult.rowCount).toBe(1);
      expect(postResult.rows[0].source).toBe("billing");

      // DLQ job was consumed: a second fetch does not return it again.
      const dlqAfter = await fetchDlq(boss, DEFAULT_TENANT_ID);
      expect(dlqAfter.find((j) => j.data.event_id === event.event_id)).toBeUndefined();
    } finally {
      await boss.stop();
    }
  }, 25000);
});

// CLOSE-3 — OPS-C1 / OPS-I4.
//
// The lie: "the failure reason exists on no shipped surface." It was in the data all along.
// pg-boss's dead-letter CTE copies the failed job's `output` — which OUR worker populates
// with `{message}` — onto the DLQ job, and `JobWithMetadata` declares sourceId, sourceName,
// sourceCreatedOn and retryCount alongside it. `fetchDlq` already called `findJobs`; it just
// projected all of that away, so `--list` printed no reason and `replayDlq`'s bare
// `catch { failed++ }` threw the replay error away too. `replayed: 0, failed: 1` with
// nowhere to go was the worst first-hour experience the operability panel found.
describe("OPS-C1 — a dead letter says why, and a failed replay says why", () => {
  it("fetchDlq projects the recorded failure reason, the job's TRUE original age and its retry count", async () => {
    const boss = await createQueue(connectionString, { retryLimit: 1, retryDelay: 1, retryBackoff: false });
    try {
      const poisonPool = {
        connect: async () => {
          throw new Error("Pool is poisoned");
        },
      } as unknown as pg.Pool;
      await startWorker(boss, poisonPool, { tenantId: DEFAULT_TENANT_ID });

      const event = ev("evt-dlq-reason-1");
      const enqueuedAt = Date.now();
      await enqueueEvent(boss, "support", event, { tenantId: DEFAULT_TENANT_ID });

      const deadline = Date.now() + 20000;
      let entry: Awaited<ReturnType<typeof fetchDlq>>[number] | undefined;
      while (Date.now() < deadline) {
        entry = (await fetchDlq(boss, DEFAULT_TENANT_ID)).find((j) => j.data.event_id === event.event_id);
        if (entry) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(entry).toBeDefined();
      // The reason our own worker recorded — the whole finding.
      expect(entry!.reason).toContain("Pool is poisoned");
      // sourceCreatedOn preserves the ORIGINAL job's age across the move to the DLQ, so the
      // age an operator reads is the age of the incident, not of the copy.
      expect(entry!.originalCreatedOn.getTime()).toBeLessThanOrEqual(Date.now());
      expect(entry!.originalCreatedOn.getTime()).toBeGreaterThan(enqueuedAt - 60_000);
      expect(entry!.sourceName).toBe("ingest-support");
      expect(typeof entry!.retryCount).toBe("number");
    } finally {
      await boss.stop();
    }
  }, 25000);

  it("replayDlq returns the error for every failed replay instead of swallowing it into a count", async () => {
    const boss = await createQueue(connectionString, { retryLimit: 1, retryDelay: 1, retryBackoff: false });
    try {
      const poisonPool = {
        connect: async () => {
          throw new Error("Pool is poisoned");
        },
      } as unknown as pg.Pool;
      await startWorker(boss, poisonPool, { tenantId: DEFAULT_TENANT_ID });

      const event = ev("evt-dlq-replayfail-1");
      await enqueueEvent(boss, "support", event, { tenantId: DEFAULT_TENANT_ID });

      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if ((await fetchDlq(boss, DEFAULT_TENANT_ID)).some((j) => j.data.event_id === event.event_id)) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      // Replay with a pool that also fails: the failure must arrive with its message and the
      // job it belonged to, not as an anonymous increment.
      const result = await replayDlq(boss, poisonPool, DEFAULT_TENANT_ID);
      expect(result.failed).toBeGreaterThan(0);
      const failure = result.failures.find((f) => f.eventId === event.event_id);
      expect(failure).toBeDefined();
      expect(failure!.message).toContain("Pool is poisoned");
      expect(failure!.source).toBe("support");
    } finally {
      await boss.stop();
    }
  }, 25000);
});

describe("OPS-I4 — the queue has a depth surface at all", () => {
  it("fetchQueueDepths reports ready/deferred/active/dlq and the oldest pending job's age per source", async () => {
    const boss = await createQueue(connectionString);
    try {
      // No worker: the job stays pending, which is exactly the saturation shape the panel
      // said had no observable ("the receiver accepting faster than the worker drains").
      const event = ev("evt-queue-depth-1");
      await enqueueEvent(boss, "casebus", event, { tenantId: DEFAULT_TENANT_ID });

      // DISCRIMINATION NOTE (review minor 2). This test reds against a
      // `getQueues()`-based implementation, but only because that path reads
      // `queue.ready_count`, a cached column the supervisor refreshes on
      // `monitorIntervalSeconds` — pg-boss@12.26.1 defaults it to 60 (dist/attorney.js),
      // well outside the 10s poll below. The discrimination therefore rests on a VENDOR
      // DEFAULT, not on an explicit contrast between the two data sources. If that default
      // ever drops below this poll window, this test goes vacuous without failing: it would
      // pass against the stale-counter implementation too. If you are upgrading pg-boss,
      // re-check `monitorIntervalSeconds` — and if it has moved, replace this poll with a
      // direct assertion that the count is live (e.g. read a depth, enqueue, read again
      // inside one supervisor interval and require the second read to differ).
      const deadline = Date.now() + 10000;
      let row: Awaited<ReturnType<typeof fetchQueueDepths>>[number] | undefined;
      while (Date.now() < deadline) {
        row = (await fetchQueueDepths(boss)).find((d) => d.source === "casebus");
        if (row && row.ready > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(row).toBeDefined();
      expect(row!.ready).toBeGreaterThan(0);
      // Depth alone does not distinguish "busy" from "stuck"; age is the other half of the pair.
      expect(row!.oldestPending).not.toBeNull();
      expect(row!.oldestPending!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    } finally {
      await boss.stop();
    }
  }, 15000);
});
