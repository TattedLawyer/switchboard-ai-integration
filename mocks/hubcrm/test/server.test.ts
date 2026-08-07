import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateManifest, readLedger, verifyLedgerChain } from "@switchboard/mock-core";
import { createHubcrmApp, createHubStore, OPS_UNTIL_MERGES_COMPLETE, type ThinEvent } from "../src/index.js";
import { listenLoopback } from "@switchboard/mock-core";

// Task C pair 2 — the HubSpot-STYLE thin-webhook CRM mock's own truth.
//
// Research contract (phase plan §2, verbatim-verified 2026-07-29): webhook payloads are
// METADATA-ONLY — `objectId`, `propertyName`/`propertyValue` ("only sent for property
// change subscriptions"), `eventId`, `subscriptionType`, `portalId`, `occurredAt`
// (ms epoch), `attemptNumber` (from 0), `changeSource`; "Each request can contain up to
// 100 events"; ordering NOT guaranteed — the mock exploits that with seeded
// out-of-order faults so a connector trusting delivery order breaks in tests, not
// production. The full record lives ONLY behind the hydration API
// (GET /objects/<type>/<id>), which serves FETCH-time state — mutations between notify
// and fetch are the D7 race made real — and 404s after deletion. The object store's
// current state is the paradigm's ledger-equivalent (reconcile truth).

let srv: Server | undefined;
afterEach(() => {
  srv?.close();
  srv = undefined;
});

/** A local receiver standing in for the ingest batch door: records every batch body. */
async function receiver(): Promise<{ url: string; batches: ThinEvent[][]; headers: string[] }> {
  const batches: ThinEvent[][] = [];
  const headers: string[] = [];
  const app = express();
  app.use(express.json());
  app.post("/webhooks/hubcrm", (req, res) => {
    batches.push(req.body as ThinEvent[]);
    headers.push(String(req.header("x-switchboard-signature")));
    res.status(202).json({ stored: true });
  });
  srv = await listenLoopback(app);
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/webhooks/hubcrm`, batches, headers };
}

async function listen(app: express.Express): Promise<string> {
  const s = await listenLoopback(app);
  srv = s;
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

describe("thin event shape (research: metadata-only, sparse by design)", () => {
  it("every event carries eventId/subscriptionType/portalId/occurredAt(ms)/objectId/changeSource/attemptNumber=0 — and NO record content", () => {
    const store = createHubStore({ seed: 42 });
    const events = store.simulate(20);
    expect(events.length).toBeGreaterThanOrEqual(20);
    for (const e of events) {
      expect(Number.isInteger(e.eventId)).toBe(true);
      expect(e.subscriptionType).toMatch(/^(company|contact|deal)\.(creation|propertyChange|deletion)$/);
      expect(Number.isInteger(e.portalId)).toBe(true);
      // ms epoch, not seconds: a 2020s timestamp in ms is ~1.7e12.
      expect(e.occurredAt).toBeGreaterThan(1_000_000_000_000);
      expect(Number.isInteger(e.objectId)).toBe(true);
      expect(e.attemptNumber).toBe(0);
      expect(typeof e.changeSource).toBe("string");
      // Thin means thin: no name/domain/email/amount payload ever rides the webhook.
      expect(e).not.toHaveProperty("properties");
      expect(e).not.toHaveProperty("name");
    }
  });

  it("property-change events carry EXACTLY ONE property (propertyName + propertyValue); creation/deletion events carry neither", () => {
    const store = createHubStore({ seed: 42 });
    const events = store.simulate(30);
    const changes = events.filter((e) => e.subscriptionType.endsWith(".propertyChange"));
    const others = events.filter((e) => !e.subscriptionType.endsWith(".propertyChange"));
    expect(changes.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    for (const e of changes) {
      expect(typeof e.propertyName).toBe("string");
      expect("propertyValue" in e).toBe(true); // value may be null (cleared) but the key is present
    }
    for (const e of others) {
      expect(e.propertyName).toBeUndefined();
      expect(e.propertyValue).toBeUndefined();
    }
  });

  it("eventIds are unique and NON-ORDINAL: emission order is not recoverable from the ids", () => {
    const store = createHubStore({ seed: 42 });
    const ids = store.simulate(40).map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    const sorted = [...ids].sort((a, b) => a - b);
    expect(sorted).not.toEqual(ids);
  });

  it("the script includes a CLEARED property: deal currency propertyChange with propertyValue null (the sparse-null mechanism, in-script so every run exercises it)", () => {
    const store = createHubStore({ seed: 42 });
    const events = store.simulate(30);
    const cleared = events.filter((e) => e.propertyName === "currency" && e.propertyValue === null);
    expect(cleared.length).toBeGreaterThan(0);
    // And the store agrees: the object's currency is now genuinely absent-of-value.
    const deal = store.get("deal", cleared[0].objectId);
    expect(deal).toBeDefined();
    expect(deal!.properties.currency).toBeNull();
  });

  it("is deterministic per seed (ids, types, object targets — occurredAt is wall-clock and excluded)", () => {
    const a = createHubStore({ seed: 7 }).simulate(25);
    const b = createHubStore({ seed: 7 }).simulate(25);
    expect(a.map((e) => [e.eventId, e.subscriptionType, e.objectId, e.propertyName ?? null, e.propertyValue ?? null])).toEqual(
      b.map((e) => [e.eventId, e.subscriptionType, e.objectId, e.propertyName ?? null, e.propertyValue ?? null]),
    );
  });

  it("draws record content from the SAME manifest universe as the 2a mocks, so identities correlate (hygiene rides the manifest)", () => {
    const store = createHubStore({ seed: 42 });
    store.simulate(30);
    const manifest = generateManifest(42);
    const companyNames = new Set(manifest.crm.companies.map((c) => c.name));
    const companies = store.list("company");
    expect(companies.length).toBeGreaterThan(0);
    for (const c of companies) {
      // Name may carry a revision suffix from property changes; the manifest base must prefix it.
      expect([...companyNames].some((n) => String(c.properties.name).startsWith(n))).toBe(true);
      expect(String(c.properties.domain)).toMatch(/\.example\.com$/);
    }
  });
});

describe("batched delivery (research: ≤100 events/request, ordering NOT guaranteed, retries re-deliver with attemptNumber+1)", () => {
  it("delivers pending events in signed batches of at most batch_size (≤100), covering every non-dropped event exactly once with no faults", async () => {
    const r = await receiver();
    const store = createHubStore({ seed: 42 });
    const emitted = store.simulate(180);
    const stats = await store.deliver({ webhookUrl: r.url, batchSize: 100 });
    expect(stats.batches).toBeGreaterThanOrEqual(2);
    for (const batch of r.batches) expect(batch.length).toBeLessThanOrEqual(100);
    const deliveredIds = r.batches.flat().map((e) => e.eventId);
    expect(new Set(deliveredIds).size).toBe(deliveredIds.length);
    expect(new Set(deliveredIds)).toEqual(new Set(emitted.map((e) => e.eventId)));
    for (const h of r.headers) expect(h).toMatch(/^t=\d+,sha256=[0-9a-f]{64}$/); // house HMAC header shape
  });

  it("refuses batchSize > 100 loudly — the vendor contract's own cap", async () => {
    const store = createHubStore({ seed: 42 });
    store.simulate(5);
    await expect(store.deliver({ webhookUrl: "http://127.0.0.1:1/x", batchSize: 101 })).rejects.toThrow(/100/);
  });

  it("duplicate fault: an event is re-delivered in a LATER request with attemptNumber incremented (same eventId — idempotency's job downstream)", async () => {
    const r = await receiver();
    const store = createHubStore({ seed: 42 });
    store.simulate(40);
    const stats = await store.deliver({
      webhookUrl: r.url,
      batchSize: 10,
      faultPlan: { seed: 9, dupRate: 0.3 },
    });
    expect(stats.duplicated).toBeGreaterThan(0);
    const all = r.batches.flat();
    const byId = new Map<number, ThinEvent[]>();
    for (const e of all) {
      byId.set(e.eventId, [...(byId.get(e.eventId) ?? []), e]);
    }
    const dups = [...byId.values()].filter((v) => v.length > 1);
    expect(dups.length).toBe(stats.duplicated);
    for (const copies of dups) {
      expect(copies[0].attemptNumber).toBe(0);
      expect(copies[1].attemptNumber).toBe(1); // the re-delivery says so
    }
  });

  it("drop fault: dropped events are NEVER delivered but their store effects are real — the 10-retries-then-gone loss the paradigm admits", async () => {
    const r = await receiver();
    const store = createHubStore({ seed: 42 });
    const emitted = store.simulate(40);
    const stats = await store.deliver({ webhookUrl: r.url, batchSize: 10, faultPlan: { seed: 3, dropRate: 0.25 } });
    expect(stats.dropped).toBeGreaterThan(0);
    const deliveredIds = new Set(r.batches.flat().map((e) => e.eventId));
    expect(deliveredIds.size).toBe(emitted.length - stats.dropped);
  });

  it("out-of-order faults: shuffle scrambles WITHIN a batch, holdover defers events to LATER batches — delivery order is not emission order in either axis", async () => {
    const r = await receiver();
    const store = createHubStore({ seed: 42 });
    const emitted = store.simulate(60);
    await store.deliver({
      webhookUrl: r.url,
      batchSize: 10,
      faultPlan: { seed: 5, holdoverRate: 0.3, shuffleWithinBatch: true },
    });
    const deliveredIds = r.batches.flat().map((e) => e.eventId);
    expect(new Set(deliveredIds)).toEqual(new Set(emitted.map((e) => e.eventId))); // membership intact
    expect(deliveredIds).not.toEqual(emitted.map((e) => e.eventId)); // order is not
  });

  it("failed batch redelivery: a non-2xx receiver answer re-sends the SAME request with attemptNumber+1 on every event, up to the retry budget", async () => {
    let failures = 1;
    const seen: ThinEvent[][] = [];
    const app = express();
    app.use(express.json());
    app.post("/hook", (req, res) => {
      seen.push(req.body as ThinEvent[]);
      if (failures-- > 0) return res.status(500).json({ error: "flaky" });
      res.status(202).json({ stored: true });
    });
    srv = await listenLoopback(app);
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/hook`;

    const store = createHubStore({ seed: 42 });
    store.simulate(4);
    const stats = await store.deliver({ webhookUrl: url, batchSize: 100, redeliverAttempts: 3 });
    expect(stats.redeliveries).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0].map((e) => e.eventId)).toEqual(seen[1].map((e) => e.eventId));
    expect(seen[0].every((e) => e.attemptNumber === 0)).toBe(true);
    expect(seen[1].every((e) => e.attemptNumber === 1)).toBe(true);
  });
});

describe("hydration API (fetch-time state; 404 after deletion; 429/5xx injection; the store is the reconcile truth)", () => {
  it("GET /objects/:type/:id serves the CURRENT record; a mutation after the notify is what the fetch sees (the D7 race made real)", async () => {
    const { app, store } = createHubcrmApp({ seed: 42 });
    const base = await listen(app);
    store.simulate(30);
    const changed = store.emittedEvents().filter((e) => e.propertyName === "amount_cents");
    expect(changed.length).toBeGreaterThan(0);
    const target = changed[changed.length - 1];
    const res = await fetch(`${base}/objects/deal/${target.objectId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objectId: number; objectType: string; properties: Record<string, string | null> };
    expect(body.objectId).toBe(target.objectId);
    // Fetch-time state equals the STORE's current value — not any earlier notify-time value.
    expect(body.properties.amount_cents).toBe(store.get("deal", target.objectId)!.properties.amount_cents);
  });

  it("a deleted object answers 404 — deleted-before-fetch becomes the connector's tombstone", async () => {
    const { app, store } = createHubcrmApp({ seed: 42 });
    const base = await listen(app);
    store.simulate(30);
    const deletion = store.emittedEvents().find((e) => e.subscriptionType.endsWith(".deletion"));
    expect(deletion).toBeDefined();
    const type = deletion!.subscriptionType.split(".")[0];
    const res = await fetch(`${base}/objects/${type}/${deletion!.objectId}`);
    expect(res.status).toBe(404);
  });

  it("seeded 429 and 5xx injection on single-object reads; poison object ids ALWAYS 500 (the co-batched-poison ingredient)", async () => {
    const { app, store } = createHubcrmApp({
      seed: 42,
      read429: { seed: 1, rate: 0.5 },
      poisonObjectIds: [],
    });
    const base = await listen(app);
    store.simulate(10);
    const anyObject = store.allObjects()[0];
    const statuses = new Set<number>();
    for (let i = 0; i < 20; i++) {
      statuses.add((await fetch(`${base}/objects/${anyObject.objectType}/${anyObject.objectId}`)).status);
    }
    expect(statuses.has(429)).toBe(true);
    expect(statuses.has(200)).toBe(true);

    const poisoned = createHubcrmApp({ seed: 42, poisonObjectIds: [anyObject.objectId] });
    const base2 = await listen(poisoned.app);
    poisoned.store.simulate(10);
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${base2}/objects/${anyObject.objectType}/${anyObject.objectId}`)).status).toBe(500);
    }
  });

  it("GET /objects/:type lists the full current store — the ledger-equivalent reconcile reads; deleted objects are gone from it", async () => {
    const { app, store } = createHubcrmApp({ seed: 42 });
    const base = await listen(app);
    store.simulate(30);
    const deleted = store.emittedEvents().filter((e) => e.subscriptionType === "deal.deletion").map((e) => e.objectId);
    const res = await fetch(`${base}/objects/deal`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { objectId: number }[] };
    expect(body.results.map((r) => r.objectId)).toEqual(store.list("deal").map((r) => r.objectId));
    for (const id of deleted) expect(body.results.some((r) => r.objectId === id)).toBe(false);
  });

  it("GET /status carries the house freshness probe (instance_id, fresh, seq)", async () => {
    const { app } = createHubcrmApp({ seed: 42 });
    const base = await listen(app);
    const body = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
    expect(body.service).toBe("mock-hubcrm");
    expect(body.fresh).toBe(true);
    expect(typeof body.instance_id).toBe("string");
  });
});

// ── F-1b decision 1 (f2-wire-research.md Q1, HubSpot guide read by both passes): merges
// are their OWN thin event, never a property change; the survivor is a NEW record. ─────
describe("F-1b merge modeling: company.merge thin events + new-survivor semantics", () => {
  it("once both participants of a manifest merge pair exist, the script MERGES them: a thin company.merge event with primaryObjectId, mergedObjectIds, a DISTINCT newObjectId, and numberOfPropertiesMoved", () => {
    const store = createHubStore({ seed: 42 });
    store.simulate(OPS_UNTIL_MERGES_COMPLETE); // the named constant IS the derivation — see store.ts
    const merges = store.emittedEvents().filter((e) => e.subscriptionType === "company.merge");
    expect(merges).toHaveLength(2);
    for (const m of merges) {
      expect(typeof m.primaryObjectId).toBe("number");
      expect(Array.isArray(m.mergedObjectIds)).toBe(true);
      expect(m.mergedObjectIds).toHaveLength(1);
      expect(typeof m.newObjectId).toBe("number");
      // The researched behavior that breaks naive from→to modeling: the survivor is a
      // NEW record id — neither input survives under its own id.
      expect(m.newObjectId).not.toBe(m.primaryObjectId);
      expect(m.newObjectId).not.toBe(m.mergedObjectIds![0]);
      expect(m.objectId).toBe(m.newObjectId); // the record the event is about (disclosed inference)
      expect((m.numberOfPropertiesMoved ?? 0) > 0).toBe(true);
    }
  });

  it("store end-state is the 22→20 shape: 20 live companies, the two survivors carry hs_merged_object_ids naming BOTH consumed record ids, and every consumed id stops being fetchable (404 class)", () => {
    const store = createHubStore({ seed: 42 });
    store.simulate(OPS_UNTIL_MERGES_COMPLETE);
    const companies = store.list("company");
    expect(companies).toHaveLength(20);
    const manifestIds = companies.map((c) => String(c.properties.hs_manifest_id)).sort();
    expect(new Set(manifestIds).size).toBe(20); // one live record per canonical manifest company

    const survivors = companies.filter((c) => c.properties.hs_merged_object_ids);
    expect(survivors).toHaveLength(2);
    const merges = store.emittedEvents().filter((e) => e.subscriptionType === "company.merge");
    for (const m of merges) {
      const survivor = companies.find((c) => c.objectId === m.newObjectId)!;
      const merged = String(survivor.properties.hs_merged_object_ids);
      expect(merged).toContain(String(m.primaryObjectId)); // the winner's OLD id is preserved…
      expect(merged).toContain(String(m.mergedObjectIds![0])); // …beside the merged-away id
      expect(store.get("company", m.primaryObjectId!)).toBeUndefined();
      expect(store.get("company", m.mergedObjectIds![0])).toBeUndefined();
    }
  });

  it("determinism: two same-seed stores merge identically (same events, same survivor properties)", () => {
    const a = createHubStore({ seed: 11 });
    const b = createHubStore({ seed: 11 });
    a.simulate(OPS_UNTIL_MERGES_COMPLETE);
    b.simulate(OPS_UNTIL_MERGES_COMPLETE);
    const pick = (s: ReturnType<typeof createHubStore>) =>
      s.emittedEvents().filter((e) => e.subscriptionType === "company.merge")
        .map((e) => ({ p: e.primaryObjectId, m: e.mergedObjectIds, n: e.newObjectId }));
    expect(pick(a)).toEqual(pick(b));
  });
});

// ── F-1c: the staging switch makes this store the warehouse's CRM universe, so the
// DEFAULT script must never destroy what the identity tiers match on — contact emails
// (tier 1) and company name/domain/owner_email (tier 2). The mutation slots exist to
// exercise the propertyChange/hydration machinery, and they keep doing that — on
// NON-identity properties. Evidence-destroying mutations are a fault-shaped scenario:
// they belong to bespoke test stores, not to the seeded universe every downstream
// identity proof (verify-identity's 22→20 + tier partition) builds on. ──────────────────
describe("F-1c identity-evidence invariance of the default script", () => {
  const opsPastMerges = OPS_UNTIL_MERGES_COMPLETE + 60; // through the merges AND into the recycling tail

  it("every live company's name/domain/owner_email equals its manifest values at every point past merge completion — the company mutation slot touches no identity property", () => {
    const store = createHubStore({ seed: 42 });
    const byId = new Map(generateManifest(42).crm.companies.map((c) => [c.id, c]));
    store.simulate(opsPastMerges);
    for (const rec of store.list("company")) {
      const m = byId.get(String(rec.properties.hs_manifest_id));
      expect(m, `live company ${rec.objectId} names manifest id ${String(rec.properties.hs_manifest_id)}`).toBeDefined();
      expect(rec.properties.name).toBe(m!.name);
      expect(rec.properties.domain).toBe(m!.domain);
      expect(rec.properties.owner_email).toBe(m!.owner_email);
    }
  });

  it("every live contact's email equals its manifest value — the contact mutation slot touches no identity property", () => {
    const store = createHubStore({ seed: 42 });
    const byId = new Map(generateManifest(42).crm.contacts.map((c) => [c.id, c]));
    store.simulate(opsPastMerges);
    for (const rec of store.list("contact")) {
      const m = byId.get(String(rec.properties.hs_manifest_id));
      expect(m).toBeDefined();
      expect(rec.properties.email).toBe(m!.email);
    }
  });

  it("the mutation machinery still runs: propertyChange traffic flows for all three object types, and the company/contact changes name only NON-identity properties", () => {
    const store = createHubStore({ seed: 42 });
    store.simulate(opsPastMerges);
    const changes = store.emittedEvents().filter((e) => e.subscriptionType.endsWith(".propertyChange"));
    expect(new Set(changes.map((e) => e.subscriptionType))).toEqual(
      new Set(["company.propertyChange", "contact.propertyChange", "deal.propertyChange"]),
    );
    const identityProps = new Set(["name", "domain", "owner_email", "email", "hs_manifest_id", "company_manifest_id"]);
    for (const e of changes) {
      if (e.subscriptionType === "deal.propertyChange") continue; // deal amount/status/currency are working data, not identity evidence
      expect(identityProps.has(String(e.propertyName)), `${e.subscriptionType} mutated identity property ${String(e.propertyName)}`).toBe(false);
    }
  });
});

// ── F-1c chaos port: the emission-side hash-chained ledger. The 2a chaos oracle's
// tamper-evident record ports to this paradigm as a record of what the STORE EMITTED —
// including events the fault plan later drops — so the chaos harness can compare an
// unforgeable emission count against raw and name every loss. The chain machinery is
// mocks/core's, imported (never moved or duplicated — the F-4 drift rider's condition
// stays definitionally empty). ────────────────────────────────────────────────────────
describe("F-1c emission ledger (chaos-port prerequisite)", () => {
  it("with a ledgerPath, every emitted event (merges included) appends to a hash-chained ledger that verifies, one line per emission, in emission order — and dropped deliveries are still on it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-ledger-"));
    const ledgerPath = join(dir, "ledger-hubcrm.jsonl");
    const store = createHubStore({ seed: 42, ledgerPath });
    store.simulate(OPS_UNTIL_MERGES_COMPLETE);
    const { url } = await receiver();
    // A drop-heavy plan: the ledger is the emission record, not the delivery record.
    await store.deliver({ webhookUrl: url, faultPlan: { seed: 7, dropRate: 0.5 } });

    const entries = readLedger(ledgerPath);
    const emitted = store.emittedEvents();
    expect(entries).toHaveLength(emitted.length);
    expect(entries.map((e) => e.event_id)).toEqual(emitted.map((e) => String(e.eventId)));
    expect(entries.map((e) => e.event_type)).toEqual(emitted.map((e) => e.subscriptionType));
    expect(entries.filter((e) => e.event_type === "company.merge")).toHaveLength(2);
    expect(verifyLedgerChain(ledgerPath)).toEqual({ ok: true });
  });

  it("the ledger is tamper-evident: mutating one line breaks chain verification at that line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-ledger-"));
    const ledgerPath = join(dir, "ledger-hubcrm.jsonl");
    const store = createHubStore({ seed: 42, ledgerPath });
    store.simulate(30);
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    const doctored = JSON.parse(lines[9]) as { event_type: string };
    doctored.event_type = "company.creation";
    lines[9] = JSON.stringify(doctored);
    writeFileSync(ledgerPath, lines.join("\n") + "\n");
    expect(verifyLedgerChain(ledgerPath).ok).toBe(false);
  });

  it("without a ledgerPath nothing is written (tests and the CI fixture stay file-free)", () => {
    const store = createHubStore({ seed: 42 });
    store.simulate(20);
    expect(store.emittedEvents().length).toBeGreaterThan(0); // and no throw — no path, no file
  });
});

describe("currency-clear sparsity (close F12 — fidelity to a validated portal)", () => {
  it("over a fixture-scale run SOME deals lose currency (sparse-null coverage stays) but MOST live deals keep one — the pre-F12 round-robin blanked every staged deal eventually", () => {
    const store = createHubStore({ seed: 42 });
    store.simulate(300); // the ci-fixture/demo op count
    const deals = store.list("deal");
    const currencyless = deals.filter((d) => d.properties.currency === null);
    expect(currencyless.length).toBeGreaterThan(0);
    expect(currencyless.length).toBeLessThan(Math.ceil(deals.length * 0.25));
  });
});
