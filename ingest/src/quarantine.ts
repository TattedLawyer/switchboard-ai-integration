import { z } from "zod";
import type pg from "pg";
import type { SourceEvent } from "./server.js";

const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string(),
  data: z.record(z.unknown()),
});

// Detect an actual U+0000 anywhere in a parsed JSON value — string values AND object keys, since
// jsonb rejects a NUL in either. Checks the PARSED value, not the serialized text, so the six
// literal characters "\u0000" (an escaped backslash on the wire, jsonb-safe) are NOT flagged.
export function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => k.includes("\u0000") || containsNul(v));
  }
  return false;
}

export async function quarantineEvent(
  pool: pg.Pool,
  source: string,
  payload: unknown,
  reason: string
): Promise<void> {
  // A NUL-bearing payload cannot go into the jsonb payload column (Postgres 22P05) — quarantine
  // must never itself throw on the payloads it exists to preserve. Store the exact JSON text in
  // raw_body instead (text holds the \u0000 escape fine); payload stays null for such rows, so
  // replayQuarantined reports them "still-invalid" — correct, since raw.raw_events is jsonb too.
  if (containsNul(payload)) {
    await pool.query(
      "insert into ingest.quarantine (source, raw_body, reason) values ($1, $2, $3)",
      [source, JSON.stringify(payload), reason]
    );
    return;
  }
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
