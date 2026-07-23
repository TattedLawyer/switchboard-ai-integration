import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { quarantineEvent } from "../src/quarantine.js";
import { secretForSource, signBody } from "../src/hmac.js";

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
describe("NUL-bearing payloads are quarantined, never 500'd, never dropped", () => {
  const postSigned = async (port: number, rawBody: string) =>
    fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-switchboard-signature": signBody(rawBody, secretForSource("crm")),
      },
      body: rawBody,
    });

  it("schema-VALID signed payload with \\u0000 in a field → 202 quarantined, payload preserved, no raw row", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
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
    const app = createIngestApp(pool);
    const srv = app.listen(0);
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
    const app = createIngestApp(pool, {
      enqueue: async () => {
        enqueued++;
      },
    });
    const srv = app.listen(0);
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
      quarantineEvent(pool, "crm", payload, "test: direct NUL quarantine"),
    ).resolves.toBeUndefined();

    const q = await pool.query(
      "select raw_body, payload from ingest.quarantine where raw_body like '%evt-nul-direct%'",
    );
    expect(q.rowCount).toBe(1);
    expect(JSON.parse(q.rows[0].raw_body)).toEqual(payload);
  });

  it("non-NUL payloads are unaffected: literal backslash-u0000 TEXT (not a real NUL) still stores normally", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
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
