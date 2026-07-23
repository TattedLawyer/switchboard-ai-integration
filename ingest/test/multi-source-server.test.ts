import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeEach(async () => { ({ pool, cleanup } = await freshTestDb()); });
afterEach(async () => { await cleanup(); });

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const post = async (app: ReturnType<typeof createIngestApp>, path: string, body: string, secret: string) => {
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-switchboard-signature": sign(body, secret) },
    body,
  });
  srv.close();
  return res;
};

const ev = JSON.stringify({
  event_id: "evt-1", event_type: "invoice.created",
  occurred_at: "2026-07-01T00:00:00.000Z", data: { id: "DEMO-I-0001" },
});

describe("multi-source webhook surface", () => {
  it("accepts a billing event signed with the billing secret and stores it under source='billing'", async () => {
    const res = await post(createIngestApp(pool), "/webhooks/billing", ev, "demo-secret-billing");
    expect(res.status).toBe(202);
    const row = await pool.query("select source, event_id from raw.raw_events");
    expect(row.rows).toEqual([{ source: "billing", event_id: "evt-1" }]);
  });
  it("rejects a billing event signed with the CRM secret (per-source secrets, D3)", async () => {
    const res = await post(createIngestApp(pool), "/webhooks/billing", ev, "demo-secret-crm");
    expect(res.status).toBe(401);
    // No stack traces or internal paths in the rejection body — a clean, fixed error shape only.
    expect(await res.json()).toEqual({ error: "invalid signature" });
  });
  it("404s an unknown source before any auth check", async () => {
    const res = await post(createIngestApp(pool), "/webhooks/hubspot", ev, "demo-secret-crm");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown source" });
  });
  it("same event_id under two sources = two rows (uniqueness is (source, event_id))", async () => {
    await post(createIngestApp(pool), "/webhooks/crm", ev, "demo-secret-crm");
    await post(createIngestApp(pool), "/webhooks/billing", ev, "demo-secret-billing");
    const n = await pool.query("select count(*)::int as n from raw.raw_events where event_id='evt-1'");
    expect(n.rows[0].n).toBe(2);
  });
});
