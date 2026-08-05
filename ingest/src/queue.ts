import { PgBoss, type JobResult } from "pg-boss";
import type pg from "pg";
import type { SourceEvent } from "./server.js";
import { ingestEvent } from "./ingest-event.js";
import { SOURCES, type Source } from "./sources.js";

// Per-source queues and DLQs (isolation: a poison billing job can never block CRM
// ingestion, and DLQ depth is inspectable per source).
//
// PRE-3 (#15), DELIBERATE AND NOT AN OVERSIGHT: the four `for (const source of SOURCES)`
// loops below — worker registration, DLQ depth, DLQ fetch and DLQ replay — keep
// iterating the whole REGISTRY, while the webhook doors in `server.ts` were narrowed to
// `enabledSources()` in the same wave. The asymmetry is the point. Narrowing the door
// closes a hole: new ingest into a lane no backfill and no reconcile covers. Narrowing
// the DRAIN would open a worse one — a disabled source's existing dead letters still need
// draining, and turning a source off is very often exactly why an operator is going to
// look at its DLQ. A drain surface that disappears the moment the source is disabled
// would strand the events. Pinned in test/disabled-source-door.test.ts so a later
// "finish the job" sweep has to argue with this comment first.
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

  // pg-boss emits queue-level failures (connection loss, maintenance errors) on this
  // channel — and this same createQueue runs in the LIVE service (main.ts), not just
  // tests, so swallowing them hides real outages. Log structured; never throw from a
  // listener. (Cold-review finding: the old no-op handler said "suppress in tests"
  // while silencing production.)
  boss.on("error", (err) => {
    console.error(JSON.stringify({ pgboss: "error", message: err instanceof Error ? err.message : String(err) }));
  });
  boss.on("warning", (w) => {
    console.warn(JSON.stringify({ pgboss: "warning", message: w instanceof Error ? w.message : String(w) }));
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

// Job envelope (2b-D4 expand): the event plus the wire bytes it arrived as, so the worker
// can store raw_body. Safe to put in pg-boss's jsonb job table: jsonb-unstorable payloads
// divert to quarantine BEFORE enqueue (server.ts), so any enqueued rawBody is a storable
// JSON string. null = the enqueuing door had no wire bytes.
export interface IngestJob {
  event: SourceEvent;
  rawBody: string | null;
  /**
   * SEC-I1. Without this field the queue was a tenant-ERASING seam: whatever tenant the
   * enqueuing door believed in was gone by the time the worker wrote. That leak was latent
   * only because the doors carried no tenant either (SEC-C1) — which is exactly why the
   * envelope had to land in the SAME change as the doors. A tenant-aware door over a
   * tenant-blind queue is strictly worse than either defect alone: it manufactures a
   * silent reassignment on every queued event that cannot happen today.
   *
   * Optional on the WIRE (see unwrapJob) purely for rolling-deploy tolerance; required on
   * every path that constructs one.
   */
  tenantId: string;
}

// Expand-phase tolerance: during a rolling deploy an old receiver can still enqueue BARE
// events while a new worker drains them (and old bare jobs can be sitting in the queue or
// DLQ). Unwrap both shapes; a bare event simply has no wire bytes. `event` cannot collide
// with real event content: enqueued events are schema-parsed, and the zod object strips
// unknown keys, so a stored SourceEvent never has an `event` property.
function unwrapJob(
  data: IngestJob | SourceEvent,
  // The deployment tenant this process was configured with, used ONLY for jobs enqueued
  // before the envelope carried one. Never a silent substitution — see the warn below.
  fallbackTenantId: string,
  context: string,
): { event: SourceEvent; rawBody: string | null; tenantId: string } {
  if (typeof data === "object" && data !== null && "event" in data) {
    const job = data as Partial<IngestJob> & { event: SourceEvent };
    if (!job.tenantId) {
      console.warn(
        `[ingest] ${context}: queued job carries no tenant (enqueued before SEC-I1) — attributing it to the configured deployment tenant ${fallbackTenantId}`,
      );
    }
    return { event: job.event, rawBody: job.rawBody ?? null, tenantId: job.tenantId || fallbackTenantId };
  }
  console.warn(
    `[ingest] ${context}: bare queued event with no envelope (pre-2b-D4) — attributing it to the configured deployment tenant ${fallbackTenantId}`,
  );
  return { event: data as SourceEvent, rawBody: null, tenantId: fallbackTenantId };
}

export async function enqueueEvent(
  boss: PgBoss,
  source: Source,
  event: SourceEvent,
  // SEC-I1: required, so a tenant-less enqueue is a compile error. rawBody rides in the
  // same object rather than as a trailing positional, so no call site can transpose them.
  opts: { tenantId: string; rawBody?: string }
): Promise<void> {
  if (!opts.tenantId) {
    throw new Error("tenant is required: refusing to enqueue with an empty tenantId");
  }
  const job: IngestJob = { event, rawBody: opts.rawBody ?? null, tenantId: opts.tenantId };
  await boss.send(queueName(source), job, {
    // Use queue-level defaults, but can be overridden per job if needed
  });
}

interface WorkerOptions {
  /** SEC-I1: the deployment tenant, used only for envelope-less legacy jobs (see unwrapJob). */
  tenantId: string;
  batchSize?: number;
  pollingIntervalSeconds?: number;
}

export async function startWorker(
  boss: PgBoss,
  pool: pg.Pool,
  workerOpts: WorkerOptions
): Promise<string[]> {
  // Demo-appropriate cadence: pg-boss defaults (batchSize 1, pollingIntervalSeconds 2)
  // process events one at a time roughly every ~1.6-2s, which makes a 50-event demo
  // take ~100s to drain. Pull a bigger batch on a faster poll so the queue drains in
  // a handful of seconds instead. Purely a throughput knob — does not touch retry
  // semantics (retryLimit/retryDelay/retryBackoff stay on the queue, set in createQueue).
  const options = {
    batchSize: workerOpts.batchSize ?? 10,
    pollingIntervalSeconds: workerOpts.pollingIntervalSeconds ?? 0.5,
  };

  // One worker per source queue; each keeps running after this function returns.
  const workerIds: string[] = [];
  for (const source of SOURCES) {
    const id = await boss.work(
      queueName(source),
      { ...options, perJobResults: true as const },
      async (jobs) => {
        // Per-job error isolation. Without it, one poison job failed the WHOLE batch (a bare
        // handler throw makes pg-boss fail every job it fetched), so healthy events co-batched
        // with a poison event were retried and dead-lettered alongside it. With perJobResults
        // (verified in pg-boss v12.26.1: Manager.#settlePerJob) the handler resolves with a
        // per-job disposition and pg-boss settles each job individually: 'completed' jobs are
        // completed with their own output, and 'failed' jobs run the SAME retry/dead-letter CTE
        // as a handler throw (plans.failJobsBody: retry while retry_count < retry_limit, then
        // terminal fail + DLQ route) — so the poison job's retry policy is unchanged. Any job
        // omitted from the result array is failed by pg-boss with a descriptive error, and a
        // handler throw still fails the whole batch, so the try/catch below must stay per-job.
        const results: JobResult[] = [];
        for (const job of jobs) {
          try {
            const { event, rawBody, tenantId } = unwrapJob(
              job.data as IngestJob | SourceEvent,
              workerOpts.tenantId,
              `worker ${queueName(source)}`,
            );
            await ingestEvent(pool, source, event, rawBody !== null ? { tenantId, rawBody } : { tenantId });
            results.push({ id: job.id, status: "completed" });
          } catch (err) {
            results.push({
              id: job.id,
              status: "failed",
              output: { message: err instanceof Error ? err.message : String(err) },
            });
          }
        }
        return results;
      }
    );
    workerIds.push(id);
  }
  return workerIds;
}

/**
 * OPS-C1: what a dead letter can tell you.
 *
 * This used to project each pg-boss job down to `{source, id, data, rawBody}` and throw the
 * rest away — including `output`, which is where OUR OWN worker records the handler's
 * failure message (`{message}`, see startWorker below). The panel read that as "the reason
 * exists on no shipped surface"; it is truer to say the reason was in the data all along and
 * this function did not select it. pg-boss's dead-letter CTE (`plans.js`, `failJobsBody`)
 * copies `r.output` onto the DLQ job, and `JobWithMetadata` additionally declares
 * `sourceId`, `sourceName`, `sourceCreatedOn` ("preserving its true age in the system across
 * the move") and `retryCount`. `findJobs` — which this already calls — returns all of them.
 *
 * So the reason, the job's TRUE original age, and how many times it was retried come from
 * the call we were already making. No reason-capture machinery had to be built.
 */
export interface DlqEntry {
  source: Source;
  id: string;
  data: SourceEvent;
  rawBody: string | null;
  tenantId: string;
  /** The handler's failure message, from the job's own `output`. Null when nothing recorded
   *  one — printed as `<none recorded>` rather than omitted, because "we do not know why"
   *  is itself information an operator needs. */
  reason: string | null;
  /** The id of the original job that failed, on its own queue. */
  sourceId: string | null;
  /** The queue it originally failed on. */
  sourceName: string | null;
  /** The ORIGINAL job's createdOn where pg-boss preserved it, else the DLQ job's own —
   *  i.e. the age that matters, not the age of the copy. */
  originalCreatedOn: Date;
  retryCount: number;
}

export async function fetchDlq(
  boss: PgBoss,
  /** SEC-I1: the deployment tenant, used only for envelope-less legacy DLQ jobs. */
  fallbackTenantId: string
): Promise<DlqEntry[]> {
  // Aggregate ALL pending jobs across every source's DLQ, tagging each with its source.
  // Drain-by-default (debt-burn A7, the AWS-CLI pagination contract): exhaustive
  // retrieval is the default and truncation must never be silent — the old 10-cap made
  // an 11+ queue list as 10 with no marker, so an operator read a false "done".
  // findJobs carries no internal limit (verified in pg-boss v12: plans.findJobs emits
  // no LIMIT clause), so this is the complete pending set.
  // Note: In pg-boss, a DLQ is just another queue, so we query each directly.
  // Jobs are unwrapped from the IngestJob envelope so callers keep seeing the event as
  // `data` (the CLI prints event_id/event_type from it); the wire bytes ride alongside.
  const aggregated: DlqEntry[] = [];
  for (const source of SOURCES) {
    const jobs = await boss.findJobs<IngestJob | SourceEvent>(dlqName(source));

    // Empirically verified (pg-boss v12.26.1): when a job dead-letters out of its source
    // queue, pg-boss inserts a BRAND NEW job into the DLQ queue with state 'created' (it does
    // not carry over 'failed'/'retry' state). So the DLQ queue's pending, unconsumed jobs are
    // exactly those in state 'created' or 'retry' — the opposite of what the old filter assumed.
    // This is a peek (read-only via findJobs), so jobs remain fetchable for the replay CLI.
    for (const job of jobs) {
      if (job.state === "created" || job.state === "retry") {
        const { event, rawBody, tenantId } = unwrapJob(job.data, fallbackTenantId, `dlq ${dlqName(source)}`);
        // `output` is declared `object`; ours is `{message}`. Anything else (a
        // library-generated timeout/heartbeat output) is stringified rather than dropped —
        // printing whatever is there beats printing nothing.
        const output = job.output as { message?: unknown } | null | undefined;
        const reason =
          output && typeof output === "object" && "message" in output
            ? String(output.message)
            : output && Object.keys(output).length > 0
              ? JSON.stringify(output)
              : null;
        aggregated.push({
          source,
          id: job.id,
          data: event,
          rawBody,
          tenantId,
          reason,
          sourceId: job.sourceId ?? null,
          sourceName: job.sourceName ?? null,
          originalCreatedOn: job.sourceCreatedOn ?? job.createdOn,
          retryCount: job.retryCount,
        });
      }
    }
  }
  return aggregated;
}

/** OPS-C1: a failure that reached only a counter is a diagnosis the system caught and threw
 *  away. Each failure carries the job it belonged to and the error's own message. */
export interface DlqReplayFailure {
  id: string;
  source: Source;
  eventId: string | null;
  message: string;
}

export async function replayDlq(
  boss: PgBoss,
  pool: pg.Pool,
  /** SEC-I1: the deployment tenant, used only for envelope-less legacy DLQ jobs. */
  fallbackTenantId: string
): Promise<{ replayed: number; failed: number; failures: DlqReplayFailure[] }> {
  const dlqJobs = await fetchDlq(boss, fallbackTenantId);

  let replayed = 0;
  const failures: DlqReplayFailure[] = [];

  for (const job of dlqJobs) {
    try {
      // ingestEvent is idempotent (ON CONFLICT DO NOTHING on (source, event_id)), so re-running it
      // here is safe even in the edge case where the original job actually succeeded before
      // dead-lettering. The wire bytes travel with the job envelope, so a DLQ replay stores
      // the same raw_body a first-attempt success would have.
      // The job's OWN tenant, carried on the envelope — a DLQ replay must not become the
      // second cross-tenant write path with C2's shape.
      await ingestEvent(
        pool,
        job.source,
        job.data,
        job.rawBody !== null ? { tenantId: job.tenantId, rawBody: job.rawBody } : { tenantId: job.tenantId },
      );

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
    } catch (err) {
      // Was `catch { failed++ }` — the error object discarded without being logged, counted
      // by reason, or attached to the job, so the CLI could print only `failed: 1` and the
      // operator had nowhere to go.
      failures.push({
        id: job.id,
        source: job.source,
        eventId: job.data.event_id ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { replayed, failed: failures.length, failures };
}

/**
 * OPS-I4: the five numbers that make a stuck queue diagnosable, per source. RUNBOOK's
 * remedy for "worker not draining" used to say "check ingest logs", which the panel
 * reproduced as useless — the logs carry startup lines, backfill results and errors, and
 * nothing about queue state. This is one pinned-API call per queue: `getQueues` returns
 * `QueueResult`, whose `readyCount` the vendor's own types document as "the true backlog"
 * (`queuedCount` includes deferred, not-yet-runnable jobs). Depth alone is not enough — the
 * age of the oldest pending job is what separates "busy" from "stuck", so it is here too.
 */
export interface QueueDepth {
  source: Source;
  ready: number;
  deferred: number;
  active: number;
  dlq: number;
  /** createdOn of the oldest pending job on the main queue, or null when it is empty. */
  oldestPending: Date | null;
}

export async function fetchQueueDepths(boss: PgBoss): Promise<QueueDepth[]> {
  const now = Date.now();
  const depths: QueueDepth[] = [];
  for (const source of SOURCES) {
    // Counted from a LIVE peek, not from QueueResult's cached counters. `getQueues` reads
    // `queue.ready_count` / `queued_count`, which the supervisor's maintenance cycle writes
    // periodically (plans.js's queue-stats cache) — so on the exact incident this surface
    // exists for, "the receiver is accepting faster than the worker drains", the cached
    // number can be minutes stale and read healthy. findJobs is a read-only peek that does
    // not lease, which is the same primitive fetchDlq already uses to decide what is pending.
    const jobs = await boss.findJobs(queueName(source));
    let ready = 0;
    let deferred = 0;
    let active = 0;
    let oldest: Date | null = null;
    for (const j of jobs) {
      if (j.state === "active") {
        active++;
        continue;
      }
      if (j.state !== "created" && j.state !== "retry") continue;
      // The vendor's own distinction, and the one that matters: a deferred (future-dated)
      // job is queued but NOT runnable, so counting it as backlog reads as a stuck worker.
      if (j.startAfter && j.startAfter.getTime() > now) deferred++;
      else ready++;
      if (oldest === null || j.createdOn < oldest) oldest = j.createdOn;
    }
    const dlqJobs = await boss.findJobs(dlqName(source));
    const dlq = dlqJobs.filter((j) => j.state === "created" || j.state === "retry").length;
    depths.push({ source, ready, deferred, active, dlq, oldestPending: oldest });
  }
  return depths;
}
