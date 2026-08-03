// CLOSE-3 Wave 1 — the tenant hops (SEC-C1 + SEC-C2 + SEC-I1).
//
// The lie these tests exist to kill: KNOWN-ISSUES Part II claimed a "tenant-safe ingest
// floor", but nothing PUT a tenant in (the webhook doors carried none, so every pushed
// event keyed to the nil tenant) and two remediation paths TOOK it back out (quarantine
// replay dropped the row's own tenant_id; the queue envelope had no tenant field at all).
//
// Every assertion below pins the STORED tenant_id, never a return value — the silent
// failure mode of this exact fix is a call site that passes a tenant into a seam that
// discards it, which a "replayed" return value cannot detect.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { replayQuarantined, quarantineEvent, listQuarantine } from "../src/quarantine.js";
import { ingestEvent, DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { createIngestApp } from "../src/server.js";
import { secretForSource, signBody } from "../src/hmac.js";
import { resolveDeploymentTenant } from "../src/config.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

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

const evt = (id: string) => ({
  event_id: id,
  event_type: "company.updated",
  occurred_at: new Date().toISOString(),
  data: { id: "DEMO-C-0001", name: "DEMO X", domain: "x.example.com" },
});

async function storedTenant(eventId: string): Promise<string | null> {
  const res = await pool.query(
    "select tenant_id from raw.raw_events where event_id = $1",
    [eventId],
  );
  return res.rowCount === 0 ? null : (res.rows[0].tenant_id as string);
}

describe("SEC-C2 — quarantine replay keeps the row in its own tenant's lane", () => {
  it("replayQuarantined ingests under the quarantine row's STORED tenant_id, not the default", async () => {
    const event = evt("evt-tenant-replay-a");
    await quarantineEvent(pool, "crm", event, "operator hold: tenancy pin", undefined, TENANT_A);
    const row = await pool.query(
      "select id from ingest.quarantine where payload->>'event_id' = $1",
      [event.event_id],
    );
    const id = Number(row.rows[0].id);

    expect(await replayQuarantined(pool, id, ingestEvent)).toBe("replayed");

    // The whole finding: before the fix this landed on DEFAULT_TENANT_ID — a cross-tenant
    // WRITE performed by the documented operator workflow, with no warning in the output.
    expect(await storedTenant(event.event_id)).toBe(TENANT_A);
  });

  it("listQuarantine scopes to one tenant — a bare sweep can no longer see another tenant's rows", async () => {
    await quarantineEvent(pool, "crm", { junk: "a" }, "schema validation failed", undefined, TENANT_A);
    await quarantineEvent(pool, "crm", { junk: "b" }, "schema validation failed", undefined, TENANT_B);

    const forA = await listQuarantine(pool, TENANT_A);
    const forB = await listQuarantine(pool, TENANT_B);
    expect(forA.some((r) => r.reason === "schema validation failed")).toBe(true);
    expect(forB.some((r) => r.reason === "schema validation failed")).toBe(true);
    // Disjoint: no row appears under both tenants.
    const idsA = new Set(forA.map((r) => r.id));
    expect(forB.some((r) => idsA.has(r.id))).toBe(false);
  });
});

describe("SEC-C1 — the webhook door expresses the deployment's configured tenant", () => {
  it("a signed webhook stores under the tenant the door was constructed with", async () => {
    const app = createIngestApp(pool, TENANT_A);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const event = evt("evt-tenant-door-a");
      const rawBody = JSON.stringify(event);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-switchboard-signature": signBody(rawBody, secretForSource("crm")),
        },
        body: rawBody,
      });
      expect(res.status).toBe(202);
      expect(await storedTenant(event.event_id)).toBe(TENANT_A);
    } finally {
      srv.close();
    }
  });

  it("a quarantined webhook payload is filed under the door's tenant, so replay cannot relocate it", async () => {
    const app = createIngestApp(pool, TENANT_B);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const bogus = { bogus: "door-tenant-b" };
      const rawBody = JSON.stringify(bogus);
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-switchboard-signature": signBody(rawBody, secretForSource("crm")),
        },
        body: rawBody,
      });
      expect(res.status).toBe(202);
      const q = await pool.query(
        "select tenant_id from ingest.quarantine where payload->>'bogus' = 'door-tenant-b'",
      );
      expect(q.rows[0].tenant_id).toBe(TENANT_B);
    } finally {
      srv.close();
    }
  });
});

describe("resolveDeploymentTenant — one configured tenant per deployment, resolved at boot", () => {
  it("defaults to DEFAULT_TENANT_ID when SWITCHBOARD_TENANT_ID is unset or empty", () => {
    expect(resolveDeploymentTenant({})).toBe(DEFAULT_TENANT_ID);
    expect(resolveDeploymentTenant({ SWITCHBOARD_TENANT_ID: "" })).toBe(DEFAULT_TENANT_ID);
  });

  it("accepts a uuid", () => {
    expect(resolveDeploymentTenant({ SWITCHBOARD_TENANT_ID: TENANT_A })).toBe(TENANT_A);
  });

  it("refuses a non-uuid at boot, naming the variable and echoing the rejected value", () => {
    expect(() => resolveDeploymentTenant({ SWITCHBOARD_TENANT_ID: "acme" })).toThrow(
      /SWITCHBOARD_TENANT_ID "acme"/,
    );
  });
});
