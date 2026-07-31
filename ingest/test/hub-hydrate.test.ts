import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { freshTestDb } from "./helpers/testdb.js";
import { numericContractViolation } from "../src/numeric-contract.js";
import { createHubcrmApp, type HubcrmApp } from "../../mocks/hubcrm/src/index.js";

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
  const ingest = createIngestApp(pool);
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

async function connector(baseUrl: string) {
  const { HubHydrateConnector } = await import("../src/connectors/hub-hydrate.js");
  return new HubHydrateConnector({
    baseUrl,
    databaseUrl: dbUrl,
    timeoutMs: 3000,
    backoff: { baseMs: 1, capMs: 10, maxAttempts: 6 },
  });
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
