import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { quarantineEvent } from "../src/quarantine.js";
import { secretForSource, signBody } from "../src/hmac.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { listenLoopback } from "@switchboard/mock-core";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterAll(async () => {
  await cleanup();
});

// A NUL (U+0000) inside any JSON string is valid JSON (as the \u0000 escape) and passes HMAC +
// schema validation, but Postgres jsonb cannot represent it (error 22P05). Before the fix, the
// raw_events insert threw, the jsonb quarantine fallback ALSO threw, and the endpoint 500'd —
// dropping a validly-signed payload and violating "nothing delivered is ever dropped". These
// tests pin the required invariant: NUL-bearing signed payloads are quarantined, never 500'd.
const postSigned = async (port: number, rawBody: string) =>
  fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-switchboard-signature": signBody(rawBody, secretForSource("crm")),
    },
    body: rawBody,
  });

describe("NUL-bearing payloads are quarantined, never 500'd, never dropped", () => {

  it("schema-VALID signed payload with \\u0000 in a field → 202 quarantined, payload preserved, no raw row", async () => {
    const app = createIngestApp(pool, DEFAULT_TENANT_ID);
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    const event = {
      event_id: "evt-nul-1",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { id: "DEMO-C-0001", name: "DEMO \u0000 Corp" },
    };
    const rawBody = JSON.stringify(event);
    const res = await postSigned(port, rawBody);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });

    // Preserved for inspection: the exact JSON text (NUL kept as its \u0000 escape) lives in
    // quarantine.raw_body and round-trips to the original event. Nothing was dropped.
    const q = await pool.query(
      "select raw_body, reason, replayed_at from ingest.quarantine where raw_body like '%evt-nul-1%'",
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].raw_body).toContain("\\u0000");
    expect(JSON.parse(q.rows[0].raw_body)).toEqual(event);
    expect(q.rows[0].reason).toMatch(/u0000|NUL/i);
    expect(q.rows[0].replayed_at).toBeNull();

    // And it must NOT have landed in the event store (jsonb cannot hold it).
    const raw = await pool.query(
      "select 1 from raw.raw_events where source = 'crm' and event_id = 'evt-nul-1'",
    );
    expect(raw.rowCount).toBe(0);

    srv.close();
  });

  it("schema-FAILING signed payload with \\u0000 → 202 quarantined (quarantine itself is NUL-safe)", async () => {
    const app = createIngestApp(pool, DEFAULT_TENANT_ID);
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    const payload = { bogus: "bad \u0000 field", marker: "nul-schema-fail" };
    const rawBody = JSON.stringify(payload);
    const res = await postSigned(port, rawBody);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });

    const q = await pool.query(
      "select raw_body from ingest.quarantine where raw_body like '%nul-schema-fail%'",
    );
    expect(q.rowCount).toBe(1);
    expect(JSON.parse(q.rows[0].raw_body)).toEqual(payload);

    srv.close();
  });

  it("queue mode: NUL payload is quarantined BEFORE enqueue — boss.send (jsonb) is never reached", async () => {
    // A NUL payload handed to pg-boss would throw at boss.send (jsonb) before any persistence.
    // The app must divert to quarantine first, so the enqueue hook must never see it.
    let enqueued = 0;
    const app = createIngestApp(pool, DEFAULT_TENANT_ID, {
      enqueue: async () => {
        enqueued++;
      },
    });
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    const event = {
      event_id: "evt-nul-queue-1",
      event_type: "invoice.created",
      occurred_at: new Date().toISOString(),
      data: { memo: "queued \u0000 memo" },
    };
    const rawBody = JSON.stringify(event);
    const res = await postSigned(port, rawBody);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });
    expect(enqueued).toBe(0);

    const q = await pool.query(
      "select raw_body from ingest.quarantine where raw_body like '%evt-nul-queue-1%'",
    );
    expect(q.rowCount).toBe(1);

    srv.close();
  });

  it("quarantineEvent itself does not throw on a NUL-bearing payload (defense in depth)", async () => {
    const payload = { event_id: "evt-nul-direct", data: { note: "\u0000" } };
    await expect(
      quarantineEvent(pool, "crm", payload, "test: direct NUL quarantine", undefined, DEFAULT_TENANT_ID),
    ).resolves.toBeUndefined();

    const q = await pool.query(
      "select raw_body, payload from ingest.quarantine where raw_body like '%evt-nul-direct%'",
    );
    expect(q.rowCount).toBe(1);
    expect(JSON.parse(q.rows[0].raw_body)).toEqual(payload);
  });

  it("non-NUL payloads are unaffected: literal backslash-u0000 TEXT (not a real NUL) still stores normally", async () => {
    const app = createIngestApp(pool, DEFAULT_TENANT_ID);
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    // The six literal characters \u0000 inside a string are jsonb-safe (the backslash itself is
    // escaped on the wire) and must NOT trip the NUL detector — this pins against a naive
    // substring check on the serialized body.
    const event = {
      event_id: "evt-literal-escape-1",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { note: "literal \\u0000 text" },
    };
    const rawBody = JSON.stringify(event);
    const res = await postSigned(port, rawBody);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: true });

    const raw = await pool.query(
      "select 1 from raw.raw_events where source = 'crm' and event_id = 'evt-literal-escape-1'",
    );
    expect(raw.rowCount).toBe(1);

    srv.close();
  });
});

// Two sibling failure modes of the same claim-breaker class ("validly-signed payload → 500 +
// dropped"), found in review of the NUL fix:
//   1. The NUL walk itself was recursive, so a deeply-nested NUL-FREE payload — perfectly
//      storable in jsonb — blew the call stack (RangeError → 500) before it ever reached the
//      raw_events insert that would have stored it fine.
//   2. A lone UTF-16 surrogate (the \ud800 escape on the wire — valid JSON, passes HMAC and
//      schema) is, like NUL, unrepresentable in jsonb; it slipped past the NUL-only divert and
//      500'd at insert, with the jsonb quarantine fallback throwing identically.
// Invariant pinned here: for ANY validly-signed payload, the endpoint never 500s while the DB is
// healthy, and the payload is never silently dropped.
describe("deep nesting and lone surrogates never 500, never drop a signed payload", () => {
  it("deeply-nested (999, at the depth bound) NUL-free payload takes the NORMAL path → 202 stored in raw.raw_events, NOT quarantined", async () => {
    const app = createIngestApp(pool, DEFAULT_TENANT_ID);
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    // 999 nested arrays sits exactly AT the depth bound for this event shape (root object +
    // data object + 999 arrays = 1001 containers, deepest at depth 1000 = the bound): the
    // deepest payload that must still take the normal path. Pins the under-side of the boundary — and that the walk itself is
    // iterative (a recursive walk with heavier frames died near ~3600 in an earlier revision).
    let deep: unknown = "leaf";
    for (let i = 0; i < 999; i++) deep = [deep];
    const event = {
      event_id: "evt-deep-1",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { nested: deep },
    };
    const rawBody = JSON.stringify(event);
    const res = await postSigned(port, rawBody);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: true });

    const raw = await pool.query(
      "select 1 from raw.raw_events where source = 'crm' and event_id = 'evt-deep-1'",
    );
    expect(raw.rowCount).toBe(1);

    // Normal path means normal path: it must NOT have been diverted to quarantine.
    const q = await pool.query(
      "select 1 from ingest.quarantine where raw_body like '%evt-deep-1%' or payload::text like '%evt-deep-1%'",
    );
    expect(q.rowCount).toBe(0);

    srv.close();
  });

  it("lone-surrogate payload → 202 quarantined, raw_body round-trips, no raw row, enqueue never called", async () => {
    let enqueued = 0;
    const app = createIngestApp(pool, DEFAULT_TENANT_ID, {
      enqueue: async () => {
        enqueued++;
      },
    });
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    // JSON.stringify serializes the lone surrogate as the 6-char \ud800 escape — the exact wire
    // form: valid JSON, valid signature, passes schema, but jsonb rejects it on insert.
    const event = {
      event_id: "evt-surrogate-1",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { name: "bad \ud800 char" },
    };
    const rawBody = JSON.stringify(event);
    const res = await postSigned(port, rawBody);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });
    expect(enqueued).toBe(0);

    // Preserved: raw_body (text, holds the escape fine) round-trips to the original event.
    const q = await pool.query(
      "select raw_body, reason, replayed_at from ingest.quarantine where raw_body like '%evt-surrogate-1%'",
    );
    expect(q.rowCount).toBe(1);
    expect(JSON.parse(q.rows[0].raw_body)).toEqual(event);
    expect(q.rows[0].reason).toMatch(/surrogate/i);
    expect(q.rows[0].replayed_at).toBeNull();

    // And nothing landed in the event store (jsonb cannot hold it).
    const raw = await pool.query(
      "select 1 from raw.raw_events where source = 'crm' and event_id = 'evt-surrogate-1'",
    );
    expect(raw.rowCount).toBe(0);

    srv.close();
  });

  it("quarantineEvent itself does not throw on a lone-surrogate payload (defense in depth)", async () => {
    const payload = { event_id: "evt-surrogate-direct", data: { note: "dangling \udc00 low" } };
    await expect(
      quarantineEvent(pool, "crm", payload, "test: direct lone-surrogate quarantine", undefined, DEFAULT_TENANT_ID),
    ).resolves.toBeUndefined();

    const q = await pool.query(
      "select raw_body from ingest.quarantine where raw_body like '%evt-surrogate-direct%'",
    );
    expect(q.rowCount).toBe(1);
    expect(JSON.parse(q.rows[0].raw_body)).toEqual(payload);
  });

  it("safety net: even a payload the pre-insert walk misses falls back to raw_body instead of throwing", async () => {
    // Contrived on purpose: a toJSON hook makes JSON.stringify emit a NUL escape the walker never
    // sees (it walks the object, stringify calls toJSON). Real webhook bodies come from JSON.parse
    // and can't do this — the test exists to pin the jsonb-error-code catch in quarantineEvent, so
    // that ANY future jsonb-incompatible-but-valid-JSON content is preserved rather than thrown.
    const sneaky = {
      toJSON: () => ({ event_id: "evt-sneaky-1", note: "hidden \u0000 nul" }),
    };
    await expect(
      quarantineEvent(pool, "crm", sneaky, "test: walker-miss fallback", undefined, DEFAULT_TENANT_ID),
    ).resolves.toBeUndefined();

    const q = await pool.query(
      "select raw_body, payload from ingest.quarantine where raw_body like '%evt-sneaky-1%'",
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].payload).toBeNull();
    expect(JSON.parse(q.rows[0].raw_body)).toEqual({ event_id: "evt-sneaky-1", note: "hidden \u0000 nul" });
  });
});

// Build the raw JSON TEXT of a schema-valid event whose data.nested is `depth` nested arrays.
// Constructed as text on purpose: JSON.stringify could not produce the deep bodies (V8's
// stringify is recursive and dies near ~6.6k), and the raw wire text is exactly what the tests
// must round-trip against.
const deepEventText = (eventId: string, depth: number): string =>
  `{"event_id":"${eventId}","event_type":"company.updated",` +
  `"occurred_at":"${new Date().toISOString()}","data":{"nested":` +
  "[".repeat(depth) + '"leaf"' + "]".repeat(depth) + "}}";

// Third sibling of the same claim-breaker class: a validly-signed, NUL-free, schema-valid
// payload nested ~10k deep (~20KB, under the body limit) passed JSON.parse (iterative), the
// walk, and zod — then died in JSON.stringify at insert time (V8 stringify is RECURSIVE,
// ceiling ≈6.6k), and quarantine's own stringify died identically: RangeError has no .code, the
// jsonb-code catch rethrew → 500, zero rows anywhere. Postgres jsonb itself also rejects
// nesting ≥ ~13k (54001), so extreme depth is genuinely unstorable as jsonb — the depth cap
// diverts it to the raw_body quarantine, same home as NUL/lone-surrogates.
describe("depth-capped payloads are quarantined as raw text, never 500'd, never dropped", () => {
  it("10,000-deep signed payload → 202 quarantined, raw_body is the EXACT original request text, no raw row", async () => {
    // Direct-ingest mode on purpose: this is the reviewer's reproduction — the stringify at the
    // raw_events insert is the call that RangeErrors. (Queue mode dies the same way inside
    // boss.send's jsonb write; the divert point below is upstream of both.)
    const app = createIngestApp(pool, DEFAULT_TENANT_ID);
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    const rawBody = deepEventText("evt-depth-10k", 10000);
    const res = await postSigned(port, rawBody);

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });

    // Preserved byte-for-byte: raw_body must be the original wire text itself — asserted by
    // string equality, NOT via a parse→stringify round-trip (stringify is exactly what dies at
    // this depth). payload stays null (jsonb could not hold it past ~13k anyway).
    const q = await pool.query(
      "select raw_body, payload, reason, replayed_at from ingest.quarantine where raw_body like '%evt-depth-10k%'",
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].raw_body).toBe(rawBody);
    expect(q.rows[0].payload).toBeNull();
    expect(q.rows[0].reason).toMatch(/depth|nesting/i);
    expect(q.rows[0].replayed_at).toBeNull();

    const raw = await pool.query(
      "select 1 from raw.raw_events where source = 'crm' and event_id = 'evt-depth-10k'",
    );
    expect(raw.rowCount).toBe(0);

    srv.close();
  });

  it("boundary, over side: 1000 nested arrays (one container past the bound) → 202 quarantined", async () => {
    const app = createIngestApp(pool, DEFAULT_TENANT_ID);
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    const rawBody = deepEventText("evt-depth-1000", 1000);
    const res = await postSigned(port, rawBody);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ quarantined: true });

    const q = await pool.query(
      "select raw_body from ingest.quarantine where raw_body like '%evt-depth-1000%'",
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].raw_body).toBe(rawBody);

    srv.close();
  });

  it("safety net: quarantineEvent falls back to the caller's raw text when its own stringify RangeErrors", async () => {
    // A toJSON hook hides depth from the walker (which sees only {toJSON: fn}) but makes
    // JSON.stringify recurse 10k deep and throw RangeError. With the raw request text supplied,
    // quarantine must preserve THAT text rather than rethrow — the net for anything else that
    // ever makes stringify die. (Connection errors etc. must still propagate; only the
    // stringify-RangeError path is netted.)
    let deep: unknown = "leaf";
    for (let i = 0; i < 10000; i++) deep = [deep];
    const sneaky = { toJSON: () => ({ event_id: "evt-rangeerr-1", nested: deep }) };
    const rawText = '{"marker":"evt-rangeerr-1-raw-text"}';
    await expect(
      quarantineEvent(pool, "crm", sneaky, "test: stringify RangeError net", rawText, DEFAULT_TENANT_ID),
    ).resolves.toBeUndefined();

    const q = await pool.query(
      "select raw_body, payload from ingest.quarantine where raw_body like '%evt-rangeerr-1-raw-text%'",
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].raw_body).toBe(rawText);
    expect(q.rows[0].payload).toBeNull();
  });

  it("pin: well-formed astral-plane pairs (emoji) in a KEY and a VALUE are NOT false-positived → 202 stored", async () => {
    const app = createIngestApp(pool, DEFAULT_TENANT_ID);
    const srv = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    // An emoji is a full surrogate PAIR — well-formed, jsonb-safe. The lone-surrogate detector
    // must ignore it in both positions; this payload takes the normal path into raw.raw_events.
    const thumbsUp = "\u{1F44D}";
    const event = {
      event_id: "evt-emoji-1",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { [`reaction ${thumbsUp} key`]: `value with ${thumbsUp} emoji` },
    };
    const rawBody = JSON.stringify(event);
    const res = await postSigned(port, rawBody);

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: true });

    const raw = await pool.query(
      "select payload from raw.raw_events where source = 'crm' and event_id = 'evt-emoji-1'",
    );
    expect(raw.rowCount).toBe(1);
    expect(raw.rows[0].payload).toEqual(event);

    const q = await pool.query(
      "select 1 from ingest.quarantine where raw_body like '%evt-emoji-1%' or payload::text like '%evt-emoji-1%'",
    );
    expect(q.rowCount).toBe(0);

    srv.close();
  });
});
