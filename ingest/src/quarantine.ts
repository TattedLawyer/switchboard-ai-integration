import type pg from "pg";
// The event schema and the occurred_at predicates live in event-schema.ts — the ONE
// definition applied at ALL doors into raw (webhook in server.ts, the replay below in
// replayQuarantined, the backfill poll in backfill.ts; the count is the invariant, so if a
// fourth door is ever added it applies there too). They historically lived HERE because
// importing them from server.ts would have been a runtime cycle; the leaf module makes
// that cycle impossible by construction.
import { eventSchema, type SourceEvent, isIsoOccurredAt, isAcceptableOccurredAt,
  OCCURRED_AT_MAX_AGE_MS, OCCURRED_AT_MAX_FUTURE_MS } from "./event-schema.js";
// Compatibility re-export of the occurred_at predicates, which historically lived here.
// Nothing in-repo imports them from this path today; the re-export exists so external or
// future callers that reach for the historical location still get the ONE definition.
export { isIsoOccurredAt, isAcceptableOccurredAt, OCCURRED_AT_MAX_AGE_MS, OCCURRED_AT_MAX_FUTURE_MS };

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
// keys, since jsonb rejects either — plus containers nested past MAX_JSONB_NESTING_DEPTH (below).
// Checks the PARSED value, not the serialized text, so the six
// literal characters "\u0000" (an escaped backslash on the wire, jsonb-safe) are NOT flagged.
// Returns the human-readable divert reason, or null when the value is jsonb-safe.
// ITERATIVE on purpose: nesting depth is source-controlled, and a recursive walk here blew the
// call stack near depth ~3600 (RangeError → 500) on payloads that JSON.parse/stringify and jsonb
// itself (5000+ deep) all handle fine. Traversal order doesn't matter — any hit diverts.
// Extreme nesting is the third unstorable shape, bounded by three separate ceilings: V8's
// JSON.stringify is RECURSIVE and blows the call stack near ~6.6k levels (every insert path
// stringifies the payload — JSON.parse survives, stringify dies, RangeError → 500), and
// Postgres rejects jsonb nested ≥ ~13k outright (error 54001). 1000 sits far below both — huge
// margin even if either ceiling shrinks — and far above any legitimate business payload, whose
// real nesting is single digits. Deeper payloads divert to raw_body quarantine like NUL/lone
// surrogates: genuinely unstorable as jsonb, preserved as text.
// Exported so tests (e.g. the property suite) can pin behavior AT the bound rather than
// hardcoding a magic 1000 that could silently drift from this constant.
export const MAX_JSONB_NESTING_DEPTH = 1000;

export function jsonbUnstorableReason(value: unknown): string | null {
  // depth = number of enclosing containers above the current value (root sits at 0); a
  // container popped past the bound means the payload nests deeper than any storable shape.
  const stack: { v: unknown; depth: number }[] = [{ v: value, depth: 0 }];
  const depthReason = `payload nesting depth exceeds ${MAX_JSONB_NESTING_DEPTH} — not safely representable in jsonb`;
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (typeof v === "string") {
      const reason = unstorableReason(v);
      if (reason !== null) return reason;
    } else if (Array.isArray(v)) {
      if (depth > MAX_JSONB_NESTING_DEPTH) return depthReason;
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
    } else if (v !== null && typeof v === "object") {
      if (depth > MAX_JSONB_NESTING_DEPTH) return depthReason;
      for (const [key, child] of Object.entries(v)) {
        const reason = unstorableReason(key);
        if (reason !== null) return reason;
        stack.push({ v: child, depth: depth + 1 });
      }
    }
  }
  return null;
}

export async function quarantineEvent(
  pool: pg.Pool,
  source: string,
  payload: unknown,
  reason: string,
  // The exact request text the payload was parsed from, when the caller has it (server.ts
  // always does). Required for depth-diverted payloads: re-deriving text via JSON.stringify is
  // exactly the call that RangeErrors past ~6.6k nesting, so raw_body rows must come from the
  // original wire text, never a re-stringify.
  rawBody?: string,
  // A quarantined payload is still that tenant's data. Untagged, an operator replaying it
  // would inject it into whichever tenant's lane the default points at.
  tenantId: string = "00000000-0000-0000-0000-000000000000"
): Promise<void> {
  // A NUL- or lone-surrogate-bearing payload cannot go into the jsonb payload column (Postgres
  // 22P05 / 22P02), and one nested past the depth bound would kill JSON.stringify / jsonb
  // outright — quarantine must never itself throw on the payloads it exists to preserve.
  // Store the exact JSON text in raw_body instead (text holds the \u0000 / \ud800 escapes fine,
  // since JSON.stringify always emits them escaped); payload stays null for such rows, so
  // replayQuarantined reports them "still-invalid" — correct, since raw.raw_events is jsonb too.
  if (jsonbUnstorableReason(payload) !== null) {
    // Prefer the original wire text when supplied: byte-exact preservation, and the only safe
    // option for depth-diverted payloads (stringify would RangeError on them). The stringify
    // fallback is for direct callers without wire text, whose payloads usually stringify fine
    // — but a depth-diverted payload with NO wire text cannot be serialized by anything
    // in-process. Preservation is physically impossible there; the invariant that quarantine
    // never throws on the payloads it exists to preserve still holds: record a raw_body-less
    // row whose reason says loudly that the content was lost, instead of crashing the door.
    let text: string;
    try {
      text = rawBody ?? JSON.stringify(payload);
    } catch {
      const lossReason = `${reason} — payload unserializable in-process and no wire text supplied; content not preserved`;
      console.error(
        `[quarantine] CONTENT LOSS: ${source} payload could not be serialized (nesting beyond JSON.stringify limits) and no wire text was supplied — quarantine row records the reason only`,
      );
      await pool.query(
        "insert into ingest.quarantine (tenant_id, source, raw_body, reason) values ($1, $2, $3, $4)",
        [tenantId, source, null, lossReason]
      );
      return;
    }
    await pool.query(
      "insert into ingest.quarantine (tenant_id, source, raw_body, reason) values ($1, $2, $3, $4)",
      [tenantId, source, text, reason]
    );
    return;
  }
  try {
    await pool.query(
      "insert into ingest.quarantine (tenant_id, source, payload, reason) values ($1, $2, $3, $4)",
      [tenantId, source, JSON.stringify(payload), reason]
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
      // Safe to re-stringify here: reaching a Postgres error code means the stringify in the
      // try block already succeeded once.
      await pool.query(
        "insert into ingest.quarantine (tenant_id, source, raw_body, reason) values ($1, $2, $3, $4)",
        [tenantId, source, rawBody ?? JSON.stringify(payload), reason]
      );
      return;
    }
    // Second net, same invariant: JSON.stringify itself died (RangeError, no .code — e.g. depth
    // the walk didn't flag, reachable only via exotic shapes like toJSON hooks). Preservable
    // only when the caller supplied the wire text — the fallback must not re-stringify, that is
    // the call that just died. Everything else (connection loss, constraints) still propagates:
    // that is a genuinely unhealthy DB, not an unstorable payload.
    if (err instanceof RangeError && rawBody !== undefined) {
      await pool.query(
        "insert into ingest.quarantine (tenant_id, source, raw_body, reason) values ($1, $2, $3, $4)",
        [tenantId, source, rawBody, reason]
      );
      return;
    }
    throw err;
  }
}

// A7: the operator surface the `npm run quarantine` CLI wraps. Pending = never replayed.
// event_id is null for rows whose payload isn't an object with one (junk payloads and
// raw_body-only unstorable rows) — those are listable but can never auto-replay.
export interface QuarantineRow {
  id: number;
  source: string;
  reason: string;
  event_id: string | null;
  received_at: Date;
}

export async function listQuarantine(pool: pg.Pool): Promise<QuarantineRow[]> {
  const res = await pool.query(
    `select id, source, reason, payload->>'event_id' as event_id, received_at
       from ingest.quarantine
      where replayed_at is null
      order by id`,
  );
  return res.rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function replayAllQuarantined(
  pool: pg.Pool,
  ingest: (pool: pg.Pool, source: string, event: SourceEvent) => Promise<"inserted" | "duplicate">,
): Promise<{ replayed: number; stillInvalid: number }> {
  const pending = await listQuarantine(pool);
  let replayed = 0;
  let stillInvalid = 0;
  for (const row of pending) {
    const outcome = await replayQuarantined(pool, row.id, ingest);
    if (outcome === "replayed") replayed++;
    else stillInvalid++;
  }
  return { replayed, stillInvalid };
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
