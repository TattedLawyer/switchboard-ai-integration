import { getPool } from "../db.js";
import { createQueue, fetchDlq, replayDlq } from "../queue.js";
import { resolveDeploymentTenant } from "../config.js";

async function main(): Promise<void> {
  const listOnly = process.argv.includes("--list");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const pool = getPool();
  const boss = await createQueue(connectionString);
  // SEC-I1: DLQ jobs carry their own tenant on the envelope. This is the fallback for jobs
  // enqueued before the envelope had one — a rolling-deploy leftover — and every use of it
  // is announced on the log by unwrapJob rather than substituted silently.
  const fallbackTenantId = resolveDeploymentTenant();

  try {
    const dlqJobs = await fetchDlq(boss, fallbackTenantId);
    // NOTE: exact line format is load-bearing — scripts/chaos.sh greps "DLQ depth: <n>".
    // The count is the TOTAL across all per-source DLQs.
    console.log(`DLQ depth: ${dlqJobs.length}`);

    if (listOnly) {
      for (const job of dlqJobs) {
        console.log(
          `  id=${job.id} source=${job.source} event_id=${job.data.event_id} event_type=${job.data.event_type}`,
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
