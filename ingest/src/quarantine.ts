import { z } from "zod";
import type pg from "pg";
import type { SourceEvent } from "./server.js";

const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string(),
  data: z.record(z.unknown()),
});

// Exactly two string contents survive JSON.parse yet are unrepresentable in Postgres jsonb: an
// actual U+0000 (NUL, error 22P05) and a lone UTF-16 surrogate (the \ud800-style escape on the
// wire, error 22P02). isWellFormed() (ES2024; built into Node's runtime) is the lone-surrogate
// test: a string is non-well-formed iff it contains a surrogate without its pair.
function unstorableReason(s: string): string | null {
  if (s.includes("\u0000")) return "payload contains \\u0000 (NUL) — not representable in jsonb";
  if (!s.isWellFormed()) return "payload contains a lone UTF-16 surrogate — not representable in jsonb";
  return null;
}

// Detect jsonb-unstorable content anywhere in a parsed JSON value — string values AND object
// keys, since jsonb rejects either. Checks the PARSED value, not the serialized text, so the six
// literal characters "\u0000" (an escaped backslash on the wire, jsonb-safe) are NOT flagged.
// Returns the human-readable divert reason, or null when the value is jsonb-safe.
// ITERATIVE on purpose: nesting depth is source-controlled, and a recursive walk here blew the
// call stack near depth ~3600 (RangeError → 500) on payloads that JSON.parse/stringify and jsonb
// itself (5000+ deep) all handle fine. Traversal order doesn't matter — any hit diverts.
export function jsonbUnstorableReason(value: unknown): string | null {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") {
      const reason = unstorableReason(v);
      if (reason !== null) return reason;
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v !== null && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) {
        const reason = unstorableReason(key);
        if (reason !== null) return reason;
        stack.push(child);
      }
    }
  }
  return null;
}

export async function quarantineEvent(
  pool: pg.Pool,
  source: string,
  payload: unknown,
  reason: string
): Promise<void> {
  // A NUL- or lone-surrogate-bearing payload cannot go into the jsonb payload column (Postgres
  // 22P05 / 22P02) — quarantine must never itself throw on the payloads it exists to preserve.
  // Store the exact JSON text in raw_body instead (text holds the \u0000 / \ud800 escapes fine,
  // since JSON.stringify always emits them escaped); payload stays null for such rows, so
  // replayQuarantined reports them "still-invalid" — correct, since raw.raw_events is jsonb too.
  if (jsonbUnstorableReason(payload) !== null) {
    await pool.query(
      "insert into ingest.quarantine (source, raw_body, reason) values ($1, $2, $3)",
      [source, JSON.stringify(payload), reason]
    );
    return;
  }
  try {
    await pool.query(
      "insert into ingest.quarantine (source, payload, reason) values ($1, $2, $3)",
      [source, JSON.stringify(payload), reason]
    );
  } catch (err) {
    // Safety net: if Postgres still rejects the jsonb cast (22P05 unsupported-unicode-escape,
    // 22P02 invalid-text-representation — i.e. some jsonb-incompatible content the walk above
    // didn't anticipate), fall back to the same raw_body text row rather than throwing. The
    // invariant is that quarantine LITERALLY never throws on valid-JSON content: a payload that
    // reaches quarantine is preserved, full stop. Any other error (connection loss, constraint)
    // is a genuinely unhealthy DB and still propagates.
    const code = (err as { code?: string }).code;
    if (code === "22P05" || code === "22P02") {
      await pool.query(
        "insert into ingest.quarantine (source, raw_body, reason) values ($1, $2, $3)",
        [source, JSON.stringify(payload), reason]
      );
      return;
    }
    throw err;
  }
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
