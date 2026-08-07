import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { signBody } from "../src/hmac.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { listenLoopback } from "@switchboard/mock-core";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeEach(async () => { ({ pool, cleanup } = await freshTestDb()); });
afterEach(async () => { await cleanup(); });

const sign = (body: string, secret: string) => signBody(body, secret);

const post = async (app: ReturnType<typeof createIngestApp>, path: string, body: string, secret: string) => {
  const srv = await listenLoopback(app);
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
  // amount_cents present: the L1 numeric contract declares it required for invoice.created,
  // and this suite pins source/secret ROUTING — the event must be storable to exercise it.
  occurred_at: new Date().toISOString(), data: { id: "DEMO-I-0001", amount_cents: 12500 }, // relative: literals age out of the A6 window
});

describe("multi-source webhook surface", () => {
  it("accepts a billing event signed with the billing secret and stores it under source='billing'", async () => {
    const res = await post(createIngestApp(pool, DEFAULT_TENANT_ID), "/webhooks/billing", ev, "demo-secret-billing");
    expect(res.status).toBe(202);
    const row = await pool.query("select source, event_id from raw.raw_events");
    expect(row.rows).toEqual([{ source: "billing", event_id: "evt-1" }]);
  });
  it("rejects a billing event signed with the CRM secret (per-source secrets, D3)", async () => {
    const res = await post(createIngestApp(pool, DEFAULT_TENANT_ID), "/webhooks/billing", ev, "demo-secret-crm");
    expect(res.status).toBe(401);
    // No stack traces or internal paths in the rejection body — a clean, fixed error shape only.
    expect(await res.json()).toEqual({ error: "invalid signature" });
  });
  it("404s an unknown source before any auth check", async () => {
    const res = await post(createIngestApp(pool, DEFAULT_TENANT_ID), "/webhooks/hubspot", ev, "demo-secret-crm");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown source" });
  });
  it("same event_id under two sources = two rows (uniqueness is (source, event_id))", async () => {
    await post(createIngestApp(pool, DEFAULT_TENANT_ID), "/webhooks/crm", ev, "demo-secret-crm");
    await post(createIngestApp(pool, DEFAULT_TENANT_ID), "/webhooks/billing", ev, "demo-secret-billing");
    const n = await pool.query("select count(*)::int as n from raw.raw_events where event_id='evt-1'");
    expect(n.rows[0].n).toBe(2);
  });
});
