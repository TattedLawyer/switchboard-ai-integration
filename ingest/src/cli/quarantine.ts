// A7: operator CLI for the quarantine — before this, quarantined events had NO shipped
// path back into the pipeline (the endpoint 202s, so the vendor never re-delivers).
//   npm run quarantine -- --list          show pending rows
//   npm run quarantine -- --replay <id>   replay one row through the ingest gate
//   npm run quarantine                    replay everything pending (gate re-validates;
//                                         unfixable rows stay put and are counted)
import { getPool } from "../db.js";
import { ingestEvent } from "../ingest-event.js";
import { listQuarantine, replayAllQuarantined, replayQuarantined } from "../quarantine.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const replayIdx = args.indexOf("--replay");
  const pool = getPool();

  try {
    const pending = await listQuarantine(pool);
    console.log(`quarantine depth (pending): ${pending.length}`);

    if (listOnly) {
      for (const row of pending) {
        console.log(
          `  id=${row.id} source=${row.source} event_id=${row.event_id ?? "<none>"} received_at=${row.received_at.toISOString()} reason=${row.reason}`,
        );
      }
      process.exit(0);
    }

    if (replayIdx !== -1) {
      const id = Number(args[replayIdx + 1]);
      if (!Number.isInteger(id)) throw new Error("--replay requires a numeric quarantine id");
      const outcome = await replayQuarantined(pool, id, ingestEvent);
      console.log(`id=${id}: ${outcome}`);
      process.exit(outcome === "replayed" ? 0 : 1);
    }

    if (pending.length === 0) {
      console.log("nothing to replay");
      process.exit(0);
    }
    const result = await replayAllQuarantined(pool, ingestEvent);
    console.log(`replayed: ${result.replayed}, still-invalid: ${result.stillInvalid}`);
    process.exit(0);
  } catch (err) {
    console.error("quarantine CLI failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
