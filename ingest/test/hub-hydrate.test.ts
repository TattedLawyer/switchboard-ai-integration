import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { freshTestDb } from "./helpers/testdb.js";
import { numericContractViolation } from "../src/numeric-contract.js";
import { createHubcrmApp, type HubcrmApp } from "../../mocks/hubcrm/src/index.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

// Task C pair 3 — hydration: thin events become full records, honestly.
//
// D7 (spec-locked): thin events stay in raw EXACTLY as received; hydrated full records
// live in a SEPARATE table keyed (tenant_id, event_id) with fetched_at — fetch-TIME
// state, never notify-time. Deleted-before-fetch → 404 → tombstone row. Hydrated
// snapshots are VENDOR DATA: the field contract applies to them, and a snapshot that
// fails it must be VISIBLE (quarantined with a named reason + hydration-DLQ'd), never
// silently stored and never silently skipped.

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;
let srv: Server | undefined;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  await cleanup();
});

function listen(app: express.Express): string {
  const s = app.listen(0);
  srv = s;
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

/** Deliver the mock's pending events through the REAL batch door (in-process app). */
async function deliverThroughDoor(hub: HubcrmApp): Promise<void> {
  const { createIngestApp } = await import("../src/server.js");
  const ingest = createIngestApp(pool, DEFAULT_TENANT_ID);
  const s = ingest.listen(0);
  try {
    const stats = await hub.store.deliver({
      webhookUrl: `http://127.0.0.1:${(s.address() as { port: number }).port}/webhooks/hubcrm`,
    });
    if (stats.failedBatches > 0) throw new Error("test delivery failed");
  } finally {
    s.close();
  }
}

async function connector(baseUrl: string, tenantId?: string) {
  const { HubHydrateConnector } = await import("../src/connectors/hub-hydrate.js");
  return new HubHydrateConnector({
    baseUrl,
    databaseUrl: dbUrl,
    timeoutMs: 3000,
    backoff: { baseMs: 1, capMs: 10, maxAttempts: 6 },
    ...(tenantId === undefined ? {} : { tenantId }),
  });
}

/** A hand-built object store: the reconcile-truth surface, with exactly the objects a test
 *  wants and nothing the mock's generator would add. Same two routes the connector uses. */
interface StoreObject {
  objectId: number | string;
  properties: Record<string, unknown>;
}
function storeApp(objects: Partial<Record<"company" | "contact" | "deal", StoreObject[]>>): express.Express {
  const app = express();
  app.get("/objects/:type", (req, res) => {
    res.json({ results: objects[req.params.type as keyof typeof objects] ?? [] });
  });
  app.get("/objects/:type/:id", (req, res) => {
    const found = (objects[req.params.type as keyof typeof objects] ?? []).find(
      (o) => String(o.objectId) === req.params.id,
    );
    if (found === undefined) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(found);
  });
  return app;
}

/** Insert a thin event straight into raw with an EXACT received_at. The door stamps
 *  received_at with now(), which cannot produce the identical-instant tie these tests are
 *  about; the stored payload shape is byte-for-byte what the door writes. */
async function insertThin(opts: {
  tenantId?: string;
  eventId: string;
  eventType: string;
  occurredAtMs: number;
  receivedAt: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const payload = {
    event_id: opts.eventId,
    event_type: opts.eventType,
    occurred_at: new Date(opts.occurredAtMs).toISOString(),
    data: opts.data,
  };
  await pool.query(
    `insert into raw.raw_events (tenant_id, source, event_id, event_type, payload, received_at)
     values ($1, 'hubcrm', $2, $3, $4, $5)`,
    [
      opts.tenantId ?? "00000000-0000-0000-0000-000000000000",
      opts.eventId,
      opts.eventType,
      JSON.stringify(payload),
      opts.receivedAt,
    ],
  );
}

const snapshotRows = async () =>
  (
    await pool.query(
      "select event_id, object_type, object_id, snapshot, tombstone, fetched_at from ingest.hydrated_snapshots order by event_id",
    )
  ).rows;

// ── migration 009 ───────────────────────────────────────────────────────────────────────

describe("migration 009 — the D7 snapshot table", () => {
  it("exists with the declared shape, dedupes on (tenant_id, event_id), and refuses a contentless non-tombstone row", async () => {
    await pool.query(
      `insert into ingest.hydrated_snapshots (event_id, object_type, object_id, snapshot, tombstone)
       values ('e-1', 'deal', '123', '{"a":1}'::jsonb, false)
       on conflict (tenant_id, event_id) do nothing`,
    );
    await pool.query(
      `insert into ingest.hydrated_snapshots (event_id, object_type, object_id, snapshot, tombstone)
       values ('e-1', 'deal', '123', '{"a":2}'::jsonb, false)
       on conflict (tenant_id, event_id) do nothing`,
    );
    const rows = await snapshotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot).toEqual({ a: 1 }); // first fetch wins; re-hydration is a no-op

    // A row with neither snapshot nor tombstone is a lie ("hydrated with nothing"):
    await expect(
      pool.query(
        `insert into ingest.hydrated_snapshots (event_id, object_type, object_id, snapshot, tombstone)
         values ('e-2', 'deal', '124', null, false)`,
      ),
    ).rejects.toThrow();
  });

  it("running migrations twice is a no-op (house idempotency)", async () => {
    const { runMigrations } = await import("../src/migrate.js");
    await runMigrations(pool); // second run over the already-migrated ephemeral db
    expect((await pool.query("select count(*)::int as n from ingest.hydrated_snapshots")).rows[0].n).toBe(0);
  });
});

// ── the sparse-null decision (register A2 design question, DECIDED here) ────────────────

describe("explicit null on an OPTIONAL field is ABSENT-EQUIVALENT (decided at the first sparse vendor source; pinned both ways)", () => {
  it("null currency (optional string) passes — a cleared field is 'no value now', not garbage", () => {
    expect(numericContractViolation("deal.updated", { amount_cents: 1000, currency: null })).toBeNull();
  });
  it("absent currency (optional string) passes — the pre-existing sparse mechanism, unchanged", () => {
    expect(numericContractViolation("deal.updated", { amount_cents: 1000 })).toBeNull();
  });
  it("null propertyValue on the hubcrm property-change contract passes — HubSpot serializes a cleared property as null", () => {
    expect(
      numericContractViolation("deal.propertyChange", {
        eventId: 1,
        objectId: 2,
        portalId: 3,
        attemptNumber: 0,
        occurredAt: Date.now(),
        propertyName: "currency",
        propertyValue: null,
      }),
    ).toBeNull();
  });
  it("null on a REQUIRED field still violates, naming the field — requiredness is about the value existing, and null says it does not", () => {
    const v = numericContractViolation("invoice.created", { amount_cents: null, currency: "USD" });
    expect(v).not.toBeNull();
    expect(v!.field).toBe("amount_cents");
    expect(v!.reason).toMatch(/null/);
  });
  it("null on an optional NUMERIC field is also absent-equivalent (the rule is about optionality, not type)", () => {
    expect(numericContractViolation("sheet.row_upserted", { amount_cents: null })).toBeNull();
  });
});

// ── hydration outcomes ──────────────────────────────────────────────────────────────────

describe("hydration: every thin event meets exactly one fate", () => {
  it("hydrates fetch-TIME state into the snapshot table: a mutation between notify and fetch means the snapshot is NEWER than the event (the D7 race, stored honestly)", async () => {
    const hub = createHubcrmApp({ seed: 42 });
    const baseUrl = listen(hub.app);
    hub.store.simulate(23); // includes multiple changes to the same objects
    await deliverThroughDoor(hub);

    const c = await connector(baseUrl);
    const report = await c.catchUpWithReport(pool);
    expect(report.hydrated + report.tombstoned).toBeGreaterThan(0);
    expect(report.hydrationPending).toBe(0);
    expect(report.hydrationDlq).toBe(0);

    const rows = await snapshotRows();
    const raw = await pool.query("select event_id, payload from raw.raw_events where source = 'hubcrm'");
    expect(rows.length).toBe(raw.rowCount);

    // Every NON-tombstone snapshot equals the store's CURRENT record for its object —
    // fetch-time state, regardless of which (possibly stale) event triggered the fetch.
    for (const row of rows) {
      if (row.tombstone) {
        expect(row.snapshot).toBeNull();
        continue;
      }
      const record = hub.store.get(row.object_type, Number(row.object_id));
      expect(record).toBeDefined();
      expect(row.snapshot.properties).toEqual(record!.properties);
    }
  });

  it("deleted-before-fetch: the 404 becomes a tombstone row (snapshot null, tombstone true) — the deletion event AND the orphaned creation both resolve", async () => {
    const hub = createHubcrmApp({ seed: 42 });
    const baseUrl = listen(hub.app);
    hub.store.simulate(30); // slots 8/9: create-then-delete in the same run
    await deliverThroughDoor(hub);

    const deletion = hub.store.emittedEvents().find((e) => e.subscriptionType === "deal.deletion");
    expect(deletion).toBeDefined();

    const c = await connector(baseUrl);
    await c.catchUpWithReport(pool);

    const rows = await snapshotRows();
    const forDeleted = rows.filter((r) => r.object_id === String(deletion!.objectId));
    expect(forDeleted.length).toBeGreaterThanOrEqual(2); // creation + deletion events
    for (const r of forDeleted) {
      expect(r.tombstone).toBe(true);
      expect(r.snapshot).toBeNull();
    }
  });

  it("429s are retried with bounded backoff inside the run and still hydrate; a PERSISTENTLY failing object exhausts its attempts into the hydration DLQ — and the pump never re-fetches a DLQ'd event", async () => {
    const hub = createHubcrmApp({ seed: 42, read429: { seed: 3, rate: 0.2 } });
    const baseUrl = listen(hub.app);
    hub.store.simulate(12);
    await deliverThroughDoor(hub);
    const poisonTarget = hub.store.allObjects()[0];

    // Rebuild the app with the same seed + a poison id so one object ALWAYS 500s.
    srv?.close();
    const hub2 = createHubcrmApp({ seed: 42, read429: { seed: 3, rate: 0.2 }, poisonObjectIds: [poisonTarget.objectId] });
    const baseUrl2 = listen(hub2.app);
    hub2.store.simulate(12);

    const c = await connector(baseUrl2);
    const report = await c.catchUpWithReport(pool);

    const poisonEventIds = hub.store
      .emittedEvents()
      .filter((e) => e.objectId === poisonTarget.objectId)
      .map((e) => String(e.eventId));
    expect(poisonEventIds.length).toBeGreaterThan(0);
    expect(report.hydrationDlq).toBe(poisonEventIds.length);
    expect(report.hydrationPending).toBe(0);

    // Everything NOT poisoned hydrated despite the 429 weather.
    const rows = await snapshotRows();
    const rawCount = (await pool.query("select count(*)::int as n from raw.raw_events where source='hubcrm'")).rows[0].n;
    expect(rows.length).toBe(rawCount - poisonEventIds.length);

    // Second run: DLQ'd events are terminal — not retried, not re-DLQ'd, not pending.
    const report2 = await c.catchUpWithReport(pool);
    expect(report2.hydrated).toBe(0);
    expect(report2.hydrationDlq).toBe(0);
    expect(report2.hydrationPending).toBe(0);
  });

  it("a hydrated snapshot is VENDOR DATA: a record failing the field contract is quarantined with a named reason + DLQ'd — visible, never silently stored (and null currency is NOT that case: cleared passes)", async () => {
    const hub = createHubcrmApp({ seed: 42 });
    const baseUrl = listen(hub.app);
    hub.store.simulate(23);
    await deliverThroughDoor(hub);

    // Corrupt one deal's amount in the STORE (vendor-side garbage): hydration meets it.
    const deal = hub.store.list("deal")[0];
    deal.properties.amount_cents = "12.3abc";
    const dealEventIds = hub.store
      .emittedEvents()
      .filter((e) => e.objectId === deal.objectId)
      .map((e) => String(e.eventId));

    const c = await connector(baseUrl);
    const report = await c.catchUpWithReport(pool);

    expect(report.quarantined).toBe(dealEventIds.length);
    expect(report.hydrationDlq).toBe(dealEventIds.length);
    const q = await pool.query(
      "select reason from ingest.quarantine where source = 'hubcrm' and reason like '%amount_cents%'",
    );
    expect(q.rowCount).toBe(dealEventIds.length);
    // No snapshot row for the garbage — failing the contract must not store.
    for (const id of dealEventIds) {
      expect((await pool.query("select 1 from ingest.hydrated_snapshots where event_id = $1", [id])).rowCount).toBe(0);
    }

    // The null-currency contrast: a CLEARED currency hydrates cleanly (absent-equivalent).
    const cleared = hub.store
      .emittedEvents()
      .find((e) => e.propertyName === "currency" && e.propertyValue === null && e.objectId !== deal.objectId);
    if (cleared) {
      const snap = await pool.query("select snapshot from ingest.hydrated_snapshots where event_id = $1", [
        String(cleared.eventId),
      ]);
      expect(snap.rowCount).toBe(1);
      expect(snap.rows[0].snapshot.properties.currency).toBeNull();
    }
  });
});

// ── the latest-event tiebreak (cold review F1) ──────────────────────────────────────────

describe("reconcile's latest-event tiebreak is TOTAL, including the event_id tail", () => {
  it("two events at the IDENTICAL received_at instant: the event_id tail decides, so the compared snapshot is the successor's — node-pg hands back Date objects, and `a === b` on two Dates is false", async () => {
    const baseUrl = listen(storeApp({ company: [{ objectId: 111, properties: { name: "current" } }] }));
    const occurredAtMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const receivedAt = "2026-01-01T12:00:01.000Z";

    // Same object, same occurred_at, same received_at — a FULL tie. Under
    // `occurred_at desc, received_at desc, event_id desc` the successor is `hub-b`.
    await insertThin({ eventId: "hub-a", eventType: "company.propertyChange", occurredAtMs, receivedAt, data: { objectId: 111, occurredAt: occurredAtMs } });
    await insertThin({ eventId: "hub-b", eventType: "company.propertyChange", occurredAtMs, receivedAt, data: { objectId: 111, occurredAt: occurredAtMs } });

    // The root cause, pinned rather than described: raw.received_at comes back as a Date.
    const probe = await pool.query("select received_at from raw.raw_events where event_id = 'hub-a'");
    expect(probe.rows[0].received_at).toBeInstanceOf(Date);

    // hub-a's snapshot AGREES with the store; hub-b's does not. So the bucket depends
    // entirely on which event reconcile calls "latest".
    await pool.query(
      `insert into ingest.hydrated_snapshots (event_id, object_type, object_id, snapshot, tombstone) values
         ('hub-a', 'company', '111', '{"properties":{"name":"current"}}'::jsonb, false),
         ('hub-b', 'company', '111', '{"properties":{"name":"stale"}}'::jsonb, false)`,
    );

    const rec = await (await connector(baseUrl)).reconcile(pool);
    expect(rec.integrity.ok).toBe(true);
    expect(rec.report!.hydrationPending).toBe(0);
    expect(rec.report!.drifted).toEqual(["company:111"]);
  });
});

// ── the hydration DLQ is per TENANT (cold review F2) ────────────────────────────────────

const TENANT_B = "11111111-1111-1111-1111-111111111111";

describe("the hydration DLQ is tenant-scoped, because raw uniqueness is (tenant_id, source, event_id)", () => {
  it("two tenants legitimately share a vendor event id: tenant A's DLQ'd event must not suppress tenant B's — B hydrates, and B's DLQ listing is its own", async () => {
    const baseUrl = listen(storeApp({ company: [{ objectId: 222, properties: { name: "b-co" } }] }));
    const occurredAtMs = Date.UTC(2026, 0, 2, 9, 0, 0);
    const sharedId = "3816279531"; // one vendor id, two tenants, two different events

    // Tenant A (default): names no hydratable object → terminal in the DLQ, no fetch.
    await insertThin({ eventId: sharedId, eventType: "company.propertyChange", occurredAtMs, receivedAt: "2026-01-02T09:00:01.000Z", data: { occurredAt: occurredAtMs } });
    // Tenant B: the same id, a perfectly hydratable event.
    await insertThin({ tenantId: TENANT_B, eventId: sharedId, eventType: "company.propertyChange", occurredAtMs, receivedAt: "2026-01-02T09:00:02.000Z", data: { objectId: 222, occurredAt: occurredAtMs } });

    const a = await connector(baseUrl);
    const reportA = await a.catchUpWithReport(pool);
    expect(reportA.hydrationDlq).toBe(1);

    const b = await connector(baseUrl, TENANT_B);
    const reportB = await b.catchUpWithReport(pool);
    expect(reportB.hydrated).toBe(1); // NOT skipped as "already terminal" — that is A's id
    expect(reportB.hydrationDlq).toBe(0);
    expect(reportB.hydrationPending).toBe(0);
    expect(
      (await pool.query("select 1 from ingest.hydrated_snapshots where tenant_id = $1 and event_id = $2", [TENANT_B, sharedId])).rowCount,
    ).toBe(1);

    // And B's reconcile reports B's world: no limbo, no borrowed dead letter.
    const recB = await b.reconcile(pool);
    expect(recB.integrity.ok).toBe(true);
    expect(recB.report!.hydrationDlq).toEqual([]);
    expect(recB.report!.hydrationPending).toBe(0);
    expect(recB.report!.missing).toEqual([]);
    expect(recB.report!.drifted).toEqual([]);
    expect(recB.report!.extra).toEqual([]);

    // A's own terminal record is still exactly one, still A's.
    const recA = await a.reconcile(pool);
    expect(recA.report!.hydrationDlq.map((d) => d.event_id)).toEqual([sharedId]);
  });
});

// ── "terminal" must not expire (cold review F3) ─────────────────────────────────────────

describe("a dead-lettered hydration is terminal in the RETENTION sense too", () => {
  it("the DLQ job's keep_until is decades out, not pg-boss's 14-day default — an operator-visible dead letter that evaporates would put the event back in limbo", async () => {
    await insertThin({ eventId: "hub-terminal", eventType: "company.propertyChange", occurredAtMs: Date.UTC(2026, 0, 3), receivedAt: "2026-01-03T00:00:01.000Z", data: { occurredAt: Date.UTC(2026, 0, 3) } });

    const c = await connector(listen(storeApp({})));
    expect((await c.catchUpWithReport(pool)).hydrationDlq).toBe(1);

    const { HYDRATE_DLQ } = await import("../src/connectors/hub-hydrate.js");
    const rows = (await pool.query("select keep_until from pgboss.job where name = $1", [HYDRATE_DLQ])).rows;
    expect(rows).toHaveLength(1);
    const yearsOut = (new Date(rows[0].keep_until).getTime() - Date.now()) / (365 * 24 * 3600 * 1000);
    expect(yearsOut).toBeGreaterThan(50);
  });
});
