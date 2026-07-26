import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
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

describe("ingest error handling — no internals leaked", () => {
  it("malformed JSON with a valid signature returns 400 JSON, no stack/path leakage", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;

    // ORDERING FACT (A4, corrected 2026-07-25): express.json() runs BEFORE the route's
    // HMAC check, so malformed JSON is rejected by the parser (400) regardless of
    // signature — an earlier comment here claimed the opposite. Verification is still
    // byte-correct (the json verify-hook captures the exact raw body), and Stripe's
    // raw-body requirement is about byte fidelity, not ordering; but pre-auth parsing
    // is disclosed in KNOWN-ISSUES. The companion test below pins the actual order.
    const rawBody = '{"event_id": "evt-1", "event_type": "company.updated", ';
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(rawBody, secretForSource("crm")) },
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

  it("A5: an oversized body (>100KB) returns 413, not 500 — 5xx tells a vendor 'server fault, retry'; RFC 9110 attributes an oversized body to the client", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const rawBody = JSON.stringify({ event_id: "evt-big", pad: "x".repeat(110 * 1024) });
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(rawBody, secretForSource("crm")) },
      body: rawBody,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
    srv.close();
  });

  it("A5: a non-JSON content-type returns 415, not 500 (previously: undefined body → not-null violation)", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const rawBody = '{"event_id":"evt-1"}';
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "text/plain", "x-switchboard-signature": signBody(rawBody, secretForSource("crm")) },
      body: rawBody,
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "unsupported media type: send application/json" });
    srv.close();
  });

  it("pins the middleware order honestly: malformed JSON is 400 even with NO signature (parse precedes auth)", async () => {
    // This is the disclosure test for the ordering above: an unauthenticated request
    // reaches the JSON parser. If verification ever moves ahead of the parser (the
    // stricter design), this test flips to 401 — update it AND the KNOWN-ISSUES entry.
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"broken": ',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid json" });
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
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(rawBody, secretForSource("crm")) },
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
