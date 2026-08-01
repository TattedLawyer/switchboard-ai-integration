import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type express from "express";
import { generateManifest, type Profile } from "../../mocks/core/src/index.js";
import { createCrmApp } from "../../mocks/crm/src/server.js";
import { createBillingApp } from "../../mocks/billing/src/server.js";
import { createSupportApp } from "../../mocks/support/src/server.js";

// Phase 2b Task E: `profile` threads through the three 2a mock servers the same way
// `seed` does — an optional opts field, defaulting to generic — and surfaces on the
// same read routes the connectors and demos use. This file lives in ingest/test
// because it exercises the three mock workspaces together (bus-cli precedent for
// cross-workspace imports); the mocks' own tests keep pinning the generic default.

let dir: string;
const servers: Server[] = [];

function baseOpts(): { webhookUrl: string; ledgerPath: string } {
  dir = mkdtempSync(join(tmpdir(), "profile-threading-"));
  // The webhook sink is never hit: these tests only read the paginated seed routes.
  return { webhookUrl: "http://127.0.0.1:9/unused-hook", ledgerPath: join(dir, "ledger.jsonl") };
}

async function getJson(app: express.Express, path: string): Promise<unknown> {
  const srv = app.listen(0);
  servers.push(srv);
  const port = (srv.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(res.status).toBe(200);
  return res.json();
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("profile threading — the seam is opts.profile, exactly like opts.seed", () => {
  it("crm serves the requested profile's companies on /companies", async () => {
    const body = (await getJson(
      createCrmApp({ ...baseOpts(), profile: "plumbing" }),
      "/companies?per_page=25",
    )) as { items: { id: string; name: string }[]; total: number };
    expect(body.total).toBe(22);
    expect(body.items.map((c) => c.name)).toEqual(
      generateManifest(42, "plumbing").crm.companies.map((c) => c.name),
    );
    expect(body.items[0].name).toMatch(/Plumbing/);
  });

  it("billing serves the requested profile's customers on /customers", async () => {
    const body = (await getJson(
      createBillingApp({ ...baseOpts(), profile: "saas" }),
      "/customers",
    )) as { items: { name: string }[] };
    expect(body.items.map((c) => c.name)).toEqual(
      generateManifest(42, "saas").billing.customers.map((c) => c.name),
    );
    expect(body.items[0].name).toMatch(/Software/);
  });

  it("support serves the requested profile's requesters on /requesters", async () => {
    const body = (await getJson(
      createSupportApp({ ...baseOpts(), profile: "realestate" }),
      "/requesters",
    )) as { items: { name: string; company_name: string }[] };
    expect(body.items.map((r) => r.company_name)).toEqual(
      generateManifest(42, "realestate").support.requesters.map((r) => r.company_name),
    );
    expect(body.items[0].company_name).toMatch(/Realty/);
  });

  it("NO profile means the generic baseline, byte-for-byte — callers that never heard of profiles are untouched", async () => {
    const generic = generateManifest(42);
    const crm = (await getJson(createCrmApp(baseOpts()), "/companies?per_page=25")) as { items: unknown[] };
    expect(crm.items).toEqual(JSON.parse(JSON.stringify(generic.crm.companies)));
    const billing = (await getJson(createBillingApp(baseOpts()), "/customers")) as { items: unknown[] };
    expect(billing.items).toEqual(JSON.parse(JSON.stringify(generic.billing.customers)));
    const support = (await getJson(createSupportApp(baseOpts()), "/requesters")) as { items: unknown[] };
    expect(support.items).toEqual(JSON.parse(JSON.stringify(generic.support.requesters)));
  });

  it("a bad profile name refuses AT STARTUP, naming the valid profiles — the operator sees the answer where the mistake was made", () => {
    for (const create of [createCrmApp, createBillingApp, createSupportApp]) {
      expect(() => create({ ...baseOpts(), profile: "logistics" as Profile })).toThrow(
        /unknown profile "logistics".*generic, plumbing, saas, realestate/,
      );
    }
  });
});
