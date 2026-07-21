import { PgBoss } from "pg-boss";
import type pg from "pg";
import type { CrmEvent } from "./server.js";
import { ingestEvent } from "./ingest-event.js";

export const INGEST_QUEUE = "ingest-event";
export const INGEST_DLQ = "ingest-event-dlq";

interface RetryOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
}

export async function createQueue(
  connectionString: string,
  retryOpts?: RetryOptions
): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    // Enable maintenance tasks for DLQ routing
    supervise: true,
  });

  // Suppress pg-boss logging in tests
  boss.on("error", () => {
    /* silenced */
  });
  boss.on("warning", () => {
    /* silenced */
  });

  await boss.start();

  const dlqOpts = {
    retryLimit: retryOpts?.retryLimit ?? 5,
    retryDelay: retryOpts?.retryDelay ?? 1,
    retryBackoff: retryOpts?.retryBackoff ?? true,
  };
  const queueOpts = {
    deadLetter: INGEST_DLQ,
    ...dlqOpts,
  };

  // pg-boss's createQueue is an idempotent INSERT (ON CONFLICT DO NOTHING under the hood): if the
  // queue already exists from a prior createQueue() call (e.g. an earlier test in the same shared
  // DB/schema), passing new retry options here is silently ignored. That bit us: a second test in
  // this suite called createQueue({retryLimit: 1, ...}) expecting fast retries, but the queue had
  // already been created by an earlier test with the default retryLimit of 5, so the tiny-retry
  // options never took effect and the poison-path test's dead-letter never landed inside its poll
  // window. Always upsert via updateQueue afterward so options passed here are actually applied.
  await boss.createQueue(INGEST_DLQ, dlqOpts);
  await boss.updateQueue(INGEST_DLQ, dlqOpts);

  await boss.createQueue(INGEST_QUEUE, queueOpts);
  await boss.updateQueue(INGEST_QUEUE, queueOpts);

  return boss;
}

export async function enqueueEvent(
  boss: PgBoss,
  event: CrmEvent
): Promise<void> {
  await boss.send(INGEST_QUEUE, event, {
    // Use queue-level defaults, but can be overridden per job if needed
  });
}

interface WorkerOptions {
  batchSize?: number;
  pollingIntervalSeconds?: number;
}

export async function startWorker(
  boss: PgBoss,
  pool: pg.Pool,
  workerOpts?: WorkerOptions
): Promise<string> {
  // Demo-appropriate cadence: pg-boss defaults (batchSize 1, pollingIntervalSeconds 2)
  // process events one at a time roughly every ~1.6-2s, which makes a 50-event demo
  // take ~100s to drain. Pull a bigger batch on a faster poll so the queue drains in
  // a handful of seconds instead. Purely a throughput knob — does not touch retry
  // semantics (retryLimit/retryDelay/retryBackoff stay on the queue, set in createQueue).
  const options = {
    batchSize: workerOpts?.batchSize ?? 10,
    pollingIntervalSeconds: workerOpts?.pollingIntervalSeconds ?? 0.5,
  };

  // Return the worker ID; this function will keep the worker running
  return boss.work(INGEST_QUEUE, options, async (jobs) => {
    // Process each job in the batch
    for (const job of jobs) {
      await ingestEvent(pool, job.data as CrmEvent);
    }
  });
}

export async function fetchDlq(
  boss: PgBoss,
  limit: number = 10
): Promise<{ id: string; data: CrmEvent }[]> {
  // Fetch all jobs from the DLQ queue
  // Note: In pg-boss, the DLQ is just another queue, so we query it directly
  const jobs = await boss.findJobs<CrmEvent>(INGEST_DLQ);

  // Empirically verified (pg-boss v12.26.1): when a job dead-letters out of its source
  // queue, pg-boss inserts a BRAND NEW job into the DLQ queue with state 'created' (it does
  // not carry over 'failed'/'retry' state). So the DLQ queue's pending, unconsumed jobs are
  // exactly those in state 'created' or 'retry' — the opposite of what the old filter assumed.
  // This is a peek (read-only via findJobs), so jobs remain fetchable for Task 7's replay CLI.
  return jobs
    .filter((job) => job.state === "created" || job.state === "retry")
    .slice(0, limit)
    .map((job) => ({
      id: job.id,
      data: job.data,
    }));
}
