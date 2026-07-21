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

  // Create the dead-letter queue first
  await boss.createQueue(INGEST_DLQ, {
    retryLimit: retryOpts?.retryLimit ?? 5,
    retryDelay: retryOpts?.retryDelay ?? 1,
    retryBackoff: retryOpts?.retryBackoff ?? true,
  });

  // Create the main queue with DLQ relationship
  await boss.createQueue(INGEST_QUEUE, {
    deadLetter: INGEST_DLQ,
    retryLimit: retryOpts?.retryLimit ?? 5,
    retryDelay: retryOpts?.retryDelay ?? 1,
    retryBackoff: retryOpts?.retryBackoff ?? true,
  });

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

export async function startWorker(
  boss: PgBoss,
  pool: pg.Pool
): Promise<string> {
  // Return the worker ID; this function will keep the worker running
  return boss.work(INGEST_QUEUE, async (jobs) => {
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

  // Return only failed/dead-lettered jobs (state !== 'created')
  return jobs
    .filter((job) => job.state !== "created" && job.state !== "retry")
    .slice(0, limit)
    .map((job) => ({
      id: job.id,
      data: job.data,
    }));
}
