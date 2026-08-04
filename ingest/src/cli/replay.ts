// Operator CLI for the per-source event DLQs.
//   npm run replay -w ingest -- --list      what is dead-lettered, and WHY
//   npm run replay -w ingest -- --queues    per-source backlog, so a stuck queue is visible
//   npm run replay -w ingest                re-ingest every dead letter and consume it
import { getPool } from "../db.js";
import { createQueue, fetchDlq, fetchQueueDepths, replayDlq } from "../queue.js";
import { resolveDeploymentTenant } from "../config.js";

/** Human-readable age, so an operator reading a DLQ line at 3am does not subtract timestamps. */
function ageOf(when: Date): string {
  const ms = Date.now() - when.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

async function main(): Promise<void> {
  const listOnly = process.argv.includes("--list");
  const queuesOnly = process.argv.includes("--queues");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const pool = getPool();
  const boss = await createQueue(connectionString);
  // SEC-I1: DLQ jobs carry their own tenant on the envelope. This is the fallback for jobs
  // enqueued before the envelope had one — a rolling-deploy leftover — and every use of it
  // is announced on the log by unwrapJob rather than substituted silently.
  const fallbackTenantId = resolveDeploymentTenant();

  try {
    // OPS-I4: the queue surface. Deliberately separate from the DLQ listing and printed
    // before any replay decision — "is the worker draining?" is a different question from
    // "what is already dead?", and the RUNBOOK's remedy line points here for the first.
    if (queuesOnly) {
      const depths = await fetchQueueDepths(boss);
      console.log("per-source queue depth (ready = the true backlog; deferred jobs are not yet runnable)");
      for (const d of depths) {
        const oldest = d.oldestPending === null ? "<none pending>" : `${ageOf(d.oldestPending)} (${d.oldestPending.toISOString()})`;
        console.log(
          `  source=${d.source} ready=${d.ready} deferred=${d.deferred} active=${d.active} dlq=${d.dlq} oldest_pending=${oldest}`,
        );
      }
      const stuck = depths.filter((d) => d.ready > 0);
      if (stuck.length === 0) {
        console.log("every source's main queue is empty — nothing is waiting on the worker");
      }
      await boss.stop();
      await pool.end();
      process.exit(0);
    }

    const dlqJobs = await fetchDlq(boss, fallbackTenantId);
    // NOTE: exact line format is load-bearing — scripts/chaos.sh greps "DLQ depth: <n>".
    // The count is the TOTAL across all per-source DLQs.
    console.log(`DLQ depth: ${dlqJobs.length}`);

    if (listOnly) {
      // OPS-C1: at parity with `hydrate-rearm --list`, which has printed
      // "— DLQ reason: <reason>" for the hydration DLQ all along. The event DLQ was the
      // poorer twin: id, source, event_id, event_type and nothing about why.
      for (const job of dlqJobs) {
        console.log(
          `  id=${job.id} source=${job.source} event_id=${job.data.event_id} event_type=${job.data.event_type}` +
            ` age=${ageOf(job.originalCreatedOn)} retries=${job.retryCount}` +
            ` — DLQ reason: ${job.reason ?? "<none recorded>"}`,
        );
      }
      await boss.stop();
      await pool.end();
      process.exit(0);
    }

    if (dlqJobs.length === 0) {
      console.log("nothing to replay");
      await boss.stop();
      await pool.end();
      process.exit(0);
    }

    const result = await replayDlq(boss, pool, fallbackTenantId);
    console.log(`replayed: ${result.replayed}, failed: ${result.failed}`);
    // OPS-C1: one line per failure, not just a count. `replayed: 0, failed: 1` with nowhere
    // to go was the panel's single worst first-hour experience.
    for (const f of result.failures) {
      console.log(`  id=${f.id} source=${f.source} event_id=${f.eventId ?? "<none>"} replay failed: ${f.message}`);
    }
    if (result.failed > 0) {
      console.log("these jobs are still in the DLQ — `--list` shows each one's recorded reason and true age");
    }

    await boss.stop();
    await pool.end();
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error("replay failed:", err);
    await boss.stop();
    await pool.end();
    process.exit(1);
  }
}

main();
