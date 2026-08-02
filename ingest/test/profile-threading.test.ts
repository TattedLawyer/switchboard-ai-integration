import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type express from "express";
import { generateManifest, type Profile } from "../../mocks/core/src/index.js";
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
  // (F-1c: the 2a crm mock is retired; hubcrm's profile threading is pinned in its own
  // 2b describe below — the seam premise holds through the faithful CRM now.)

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
    const billing = (await getJson(createBillingApp(baseOpts()), "/customers")) as { items: unknown[] };
    expect(billing.items).toEqual(JSON.parse(JSON.stringify(generic.billing.customers)));
    const support = (await getJson(createSupportApp(baseOpts()), "/requesters")) as { items: unknown[] };
    expect(support.items).toEqual(JSON.parse(JSON.stringify(generic.support.requesters)));
  });

  it("a bad profile name refuses AT STARTUP, naming the valid profiles — the operator sees the answer where the mistake was made", () => {
    for (const create of [createBillingApp, createSupportApp]) {
      expect(() => create({ ...baseOpts(), profile: "logistics" as Profile })).toThrow(
        /unknown profile "logistics".*generic, plumbing, saas, realestate/,
      );
    }
  });
});

// ── F-1 (KNOWN-ISSUES, Task E review I3): the FOUR 2b mocks join the same seam ──────────
//
// The break this closes is real, not stylistic: cross-system identity correlation is
// DOMAIN-based and domains are profile-derived, so a mixed-profile stack (2a mocks on a
// vertical, 2b mocks hardcoding generic) falsifies hubcrm's "SHARED universe" premise
// and collapses tier-2 matching. Each pin drives a 2b mock's own construction surface
// with a profile and asserts the emitted universe IS that profile's manifest — and each
// mock REFUSES an unknown profile at construction, naming the valid set (the same
// operator-surface refusal generateManifest provides the 2a mocks), instead of the
// pre-fix behavior: silently ignoring the option and serving generic.
import { createHubStore } from "../../mocks/hubcrm/src/store.js";
import { createFeed } from "../../mocks/stripefeed/src/feed.js";
import { createStream } from "../../mocks/casebus/src/stream.js";
import { createRowSource, COL } from "../../mocks/sheets/src/index.js";

describe("profile threading — the 2b mocks (hubcrm, stripefeed, casebus, sheets)", () => {
  it("hubcrm: a profiled store creates companies from THAT profile's manifest, correlating with the 2a universe at the same seed", () => {
    const store = createHubStore({ seed: 42, profile: "plumbing" } as never);
    store.simulate(1); // slot 0 creates manifest.companies[0]
    const created = store.list("company")[0];
    const expected = generateManifest(42, "plumbing").crm.companies[0];
    expect(created.properties.name).toBe(expected.name);
    expect(created.properties.domain).toBe(expected.domain);
    expect(String(created.properties.name)).toMatch(/Plumbing/);
  });

  it("stripefeed: a profiled feed emits THAT profile's customers", () => {
    const feed = createFeed({ seed: 42, profile: "saas" } as never);
    const [ev] = feed.emit(1); // slot 0: customer.created for billing.customers[0]
    expect(ev.type).toBe("customer.created");
    expect((ev.data.object as { name: string }).name).toBe(
      generateManifest(42, "saas").billing.customers[0].name,
    );
  });

  it("casebus: a profiled stream emits THAT profile's tickets", () => {
    const stream = createStream({ seed: 42, profile: "realestate" } as never);
    const [ev] = stream.emit(1); // slot 0: case.created for support.tickets[0]
    expect(ev.event.payload.subject).toBe(
      generateManifest(42, "realestate").support.tickets[0].subject,
    );
  });

  it("sheets: a profiled row source draws people and companies from THAT profile's universe", () => {
    const cells = (createRowSource as unknown as (s: number, p?: string) => { next(): string[] })(
      7,
      "plumbing",
    ).next();
    const m = generateManifest(42, "plumbing").crm;
    const companyNames = new Set(m.companies.map((c) => c.name));
    const contactEmails = new Set(m.contacts.map((c) => c.email));
    expect(companyNames.has(cells[COL.company])).toBe(true);
    expect(contactEmails.has(cells[COL.email])).toBe(true);
  });

  it("every 2b construction surface REFUSES an unknown profile by name — never a silent generic", () => {
    expect(() => createHubStore({ seed: 42, profile: "logistics" } as never)).toThrow(/valid profiles/);
    expect(() => createFeed({ seed: 42, profile: "logistics" } as never)).toThrow(/valid profiles/);
    expect(() => createStream({ seed: 42, profile: "logistics" } as never)).toThrow(/valid profiles/);
    expect(() =>
      (createRowSource as unknown as (s: number, p?: string) => unknown)(7, "logistics"),
    ).toThrow(/valid profiles/);
  });
});
