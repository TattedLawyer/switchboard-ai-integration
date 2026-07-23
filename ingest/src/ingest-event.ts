import type pg from "pg";
import type { SourceEvent } from "./server.js";

export async function ingestEvent(
  pool: pg.Pool,
  source: string,
  event: SourceEvent,
): Promise<"inserted" | "duplicate"> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const insertResult = await client.query(
      `insert into raw.raw_events (source, event_id, event_type, payload)
       values ($1, $2, $3, $4) on conflict (source, event_id) do nothing`,
      [source, event.event_id, event.event_type, JSON.stringify(event)],
    );

    if (insertResult.rowCount === 1) {
      // Insert was successful, write outbox row
      await client.query(
        "insert into ingest.outbox (source, event_id) values ($1, $2)",
        [source, event.event_id],
      );
      await client.query("commit");
      return "inserted";
    } else {
      // Duplicate event
      await client.query("commit");
      return "duplicate";
    }
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}
