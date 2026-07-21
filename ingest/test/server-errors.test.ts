import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { signBody } from "../src/hmac.js";

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

describe("ingest error handling — no internals leaked", () => {
  it("malformed JSON with a valid signature returns 400 JSON, no stack/path leakage", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;

    // The HMAC middleware verifies the raw body BEFORE JSON parsing, so a malformed-JSON
    // request still needs a valid signature over the exact (broken) raw string to reach the
    // body-parser stage where the SyntaxError is thrown.
    const rawBody = '{"event_id": "evt-1", "event_type": "company.updated", ';
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(rawBody) },
      body: rawBody,
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
    const body = JSON.parse(text);
    expect(body).toEqual({ error: "invalid json" });
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/at\s+\S+\s+\(/); // no stack frame lines
    srv.close();
  });

  it("a forced DB failure returns 500 JSON, no stack/path leakage", async () => {
    // Poison the pool so any query throws, forcing the route handler's error path into the
    // terminal error middleware.
    const poisonedPool = {
      connect: async () => {
        throw new Error("connection refused at /Users/someone/secret/path/db.ts:42");
      },
    } as unknown as pg.Pool;

    const app = createIngestApp(poisonedPool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;

    const event = {
      event_id: "evt-poison",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { id: "DEMO-C-0001" },
    };
    const rawBody = JSON.stringify(event);
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(rawBody) },
      body: rawBody,
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const text = await res.text();
    expect(() => JSON.parse(text)).not.toThrow();
    const body = JSON.parse(text);
    expect(body).toEqual({ error: "internal error" });
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/at\s+\S+\s+\(/);
    srv.close();
  });
});
