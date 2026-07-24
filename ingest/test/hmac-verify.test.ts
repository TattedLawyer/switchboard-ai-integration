import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { secretForSource, signBody, verifySignature } from "../src/hmac.js";

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
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(body, secretForSource("crm")) },
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
    const sig = signBody(body, secretForSource("crm"));
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

// signBody/secretForSource are intentionally duplicated between ingest/src/hmac.ts and
// mocks/core/src/hmac.ts (separate workspaces, must not cross-import), synced only by
// keep-in-sync comments — the same landmine the ledger's canonicalHash had. Same interim
// guard as ledger-verify.test.ts, until the Phase 2b shared package: reproduce the MOCK
// side's exact algorithm here and assert the ingest side accepts/derives identically. If
// either copy drifts (prefix, encoding, digest, env naming, default-secret shape), these
// go red. Cross-compat is by construction: this IS the mock writer's algorithm.
function mocksSignBody(rawBody: string, secret: string): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}
function mocksSecretForSource(source: string): string {
  return process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`] ?? `demo-secret-${source}`;
}

describe("cross-compat: mock-side signing is accepted by ingest-side verification", () => {
  const bodies = [
    JSON.stringify(event),
    "", // empty body
    '{"name":"ünïcode ✓ 日本語","emoji":"👍"}', // multi-byte utf-8 — encoding drift shows here
    JSON.stringify({ nested: { deep: [1, 2, { x: "y" }] } }),
  ];

  it("a body signed with the MOCKS algorithm verifies under the ingest verifier, per source", () => {
    for (const source of ["crm", "billing", "support"] as const) {
      for (const body of bodies) {
        const header = mocksSignBody(body, mocksSecretForSource(source));
        expect(verifySignature(body, header, secretForSource(source))).toBe(true);
      }
    }
  });

  it("both copies derive the same secret: default fallback AND env override", () => {
    for (const source of ["crm", "billing", "support"] as const) {
      expect(secretForSource(source)).toBe(mocksSecretForSource(source));
    }
    const prev = process.env.WEBHOOK_SECRET_CRM;
    process.env.WEBHOOK_SECRET_CRM = "env-override-secret";
    try {
      expect(secretForSource("crm")).toBe("env-override-secret");
      expect(secretForSource("crm")).toBe(mocksSecretForSource("crm"));
    } finally {
      if (prev === undefined) delete process.env.WEBHOOK_SECRET_CRM;
      else process.env.WEBHOOK_SECRET_CRM = prev;
    }
  });

  it("signatures are per-source: the same body signed for billing fails crm verification", () => {
    const body = JSON.stringify(event);
    const billingHeader = mocksSignBody(body, mocksSecretForSource("billing"));
    expect(verifySignature(body, billingHeader, secretForSource("crm"))).toBe(false);
  });
});
