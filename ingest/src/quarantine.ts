import { z } from "zod";
import type pg from "pg";
import type { SourceEvent } from "./server.js";

const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string(),
  data: z.record(z.unknown()),
});

export async function quarantineEvent(
  pool: pg.Pool,
  source: string,
  payload: unknown,
  reason: string
): Promise<void> {
  await pool.query(
    "insert into ingest.quarantine (source, payload, reason) values ($1, $2, $3)",
    [source, JSON.stringify(payload), reason]
  );
}

export async function replayQuarantined(
  pool: pg.Pool,
  id: number,
  ingest: (pool: pg.Pool, source: string, event: SourceEvent) => Promise<"inserted" | "duplicate">
): Promise<"replayed" | "still-invalid"> {
  // Fetch the quarantined payload (and its recorded source, so replay re-ingests
  // under the same source the event originally arrived on)
  const result = await pool.query(
    "select payload, source from ingest.quarantine where id = $1",
    [id]
  );

  if (result.rowCount === 0) {
    throw new Error(`Quarantine row ${id} not found`);
  }

  const payload = result.rows[0].payload;

  // Validate the payload with the event schema
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) {
    return "still-invalid";
  }

  // If valid, ingest the event under its originally-recorded source
  await ingest(pool, result.rows[0].source, parsed.data);

  // Set replayed_at timestamp
  await pool.query(
    "update ingest.quarantine set replayed_at = now() where id = $1",
    [id]
  );

  return "replayed";
}
