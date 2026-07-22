import { PgBoss } from "pg-boss";
import type pg from "pg";
import type { SourceEvent } from "./server.js";
import { ingestEvent } from "./ingest-event.js";
import { SOURCES, type Source } from "./sources.js";

// Per-source queues and DLQs (isolation: a poison billing job can never block CRM
// ingestion, and DLQ depth is inspectable per source).
export function queueName(source: Source): string {
  return `ingest-${source}`;
}
export function dlqName(source: Source): string {
  return `ingest-${source}-dlq`;
}

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

  // pg-boss's createQueue is an idempotent INSERT (ON CONFLICT DO NOTHING under the hood): if the
  // queue already exists from a prior createQueue() call (e.g. an earlier test in the same shared
  // DB/schema), passing new retry options here is silently ignored. That bit us: a second test in
  // this suite called createQueue({retryLimit: 1, ...}) expecting fast retries, but the queue had
  // already been created by an earlier test with the default retryLimit of 5, so the tiny-retry
  // options never took effect and the poison-path test's dead-letter never landed inside its poll
  // window. Always upsert via updateQueue afterward so options passed here are actually applied.
  for (const source of SOURCES) {
    const queueOpts = {
      deadLetter: dlqName(source),
      ...dlqOpts,
    };

    await boss.createQueue(dlqName(source), dlqOpts);
    await boss.updateQueue(dlqName(source), dlqOpts);

    await boss.createQueue(queueName(source), queueOpts);
    await boss.updateQueue(queueName(source), queueOpts);
  }

  return boss;
}

export async function enqueueEvent(
  boss: PgBoss,
  source: Source,
  event: SourceEvent
): Promise<void> {
  await boss.send(queueName(source), event, {
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
): Promise<string[]> {
  // Demo-appropriate cadence: pg-boss defaults (batchSize 1, pollingIntervalSeconds 2)
  // process events one at a time roughly every ~1.6-2s, which makes a 50-event demo
  // take ~100s to drain. Pull a bigger batch on a faster poll so the queue drains in
  // a handful of seconds instead. Purely a throughput knob — does not touch retry
  // semantics (retryLimit/retryDelay/retryBackoff stay on the queue, set in createQueue).
  const options = {
    batchSize: workerOpts?.batchSize ?? 10,
    pollingIntervalSeconds: workerOpts?.pollingIntervalSeconds ?? 0.5,
  };

  // One worker per source queue; each keeps running after this function returns.
  const workerIds: string[] = [];
  for (const source of SOURCES) {
    const id = await boss.work(queueName(source), options, async (jobs) => {
      // Process each job in the batch
      for (const job of jobs) {
        await ingestEvent(pool, source, job.data as SourceEvent);
      }
    });
    workerIds.push(id);
  }
  return workerIds;
}

export async function fetchDlq(
  boss: PgBoss,
  limit: number = 10
): Promise<{ source: Source; id: string; data: SourceEvent }[]> {
  // Aggregate pending jobs across every source's DLQ, tagging each with its source.
  // Note: In pg-boss, a DLQ is just another queue, so we query each directly.
  const aggregated: { source: Source; id: string; data: SourceEvent }[] = [];
  for (const source of SOURCES) {
    const jobs = await boss.findJobs<SourceEvent>(dlqName(source));

    // Empirically verified (pg-boss v12.26.1): when a job dead-letters out of its source
    // queue, pg-boss inserts a BRAND NEW job into the DLQ queue with state 'created' (it does
    // not carry over 'failed'/'retry' state). So the DLQ queue's pending, unconsumed jobs are
    // exactly those in state 'created' or 'retry' — the opposite of what the old filter assumed.
    // This is a peek (read-only via findJobs), so jobs remain fetchable for the replay CLI.
    for (const job of jobs) {
      if (job.state === "created" || job.state === "retry") {
        aggregated.push({ source, id: job.id, data: job.data });
      }
    }
  }
  return aggregated.slice(0, limit);
}

export async function replayDlq(
  boss: PgBoss,
  pool: pg.Pool
): Promise<{ replayed: number; failed: number }> {
  const dlqJobs = await fetchDlq(boss);

  let replayed = 0;
  let failed = 0;

  for (const job of dlqJobs) {
    try {
      // ingestEvent is idempotent (ON CONFLICT DO NOTHING on (source, event_id)), so re-running it
      // here is safe even in the edge case where the original job actually succeeded before
      // dead-lettering.
      await ingestEvent(pool, job.source, job.data);

      // Consume the DLQ job so it isn't replayed again. fetchDlq() peeks jobs via findJobs() —
      // it does NOT fetch/lease them the way boss.work()/boss.fetch() do, so these jobs are still
      // sitting in state 'created'/'retry', not 'active'. boss.complete() only transitions jobs
      // that are currently 'active' (see pg-boss plans.js completeJobsUpdate: `WHERE ... state =
      // 'active'`), so calling complete() on a peeked job is a silent no-op — it would NOT mark
      // the job consumed and fetchDlq() would return it again on the next replay. boss.deleteJob()
      // deletes by name+id with no state precondition, which is what we actually want here: the
      // job has already been handled (ingested), so remove it from the DLQ outright.
      await boss.deleteJob(dlqName(job.source), job.id);
      replayed++;
    } catch {
      failed++;
    }
  }

  return { replayed, failed };
}
