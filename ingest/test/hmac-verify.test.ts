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
afterAll(async () => { await cleanup(); });

const event = {
  event_id: "evt-hmac-1",
  event_type: "company.updated",
  occurred_at: new Date().toISOString(),
  data: { id: "DEMO-C-0001", name: "DEMO Retail Group 1", domain: "retail-1.example.com" },
};

describe("webhook HMAC verification", () => {
  it("valid signature -> 202", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const body = JSON.stringify(event);
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(body) },
      body,
    });
    expect(res.status).toBe(202);
    srv.close();
  });

  it("tampered body -> 401, not quarantined", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const body = JSON.stringify(event);
    const sig = signBody(body);
    const tampered = JSON.stringify({ ...event, event_id: "evt-hmac-tampered" });
    const before = await pool.query("select count(*) from ingest.quarantine");
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": sig },
      body: tampered,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    const after = await pool.query("select count(*) from ingest.quarantine");
    expect(after.rows[0].count).toBe(before.rows[0].count);
    srv.close();
  });

  it("missing signature header -> 401", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    srv.close();
  });
});
