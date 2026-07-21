import type pg from "pg";
import type { CrmEvent } from "./server.js";

export async function ingestEvent(pool: pg.Pool, event: CrmEvent): Promise<"inserted" | "duplicate"> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const insertResult = await client.query(
      "insert into raw.raw_crm_events (event_id, event_type, payload) values ($1, $2, $3) on conflict (event_id) do nothing",
      [event.event_id, event.event_type, JSON.stringify(event)],
    );

    if (insertResult.rowCount === 1) {
      // Insert was successful, write outbox row
      await client.query(
        "insert into ingest.outbox (event_id) values ($1)",
        [event.event_id],
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
