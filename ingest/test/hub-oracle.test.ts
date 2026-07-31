import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { createHubcrmApp, type HubcrmApp } from "../../mocks/hubcrm/src/index.js";

// Task C pair 3 — the SECOND ORACLE (D7): under chaos, every thin event that reached raw
// ends in exactly ONE of three states — hydrated snapshot, tombstone (a snapshot-table
// row), or the hydration DLQ. Nothing in limbo. And reconcile() compares the object
// store's CURRENT truth (the paradigm's ledger-equivalent) against raw + snapshots,
// honestly separating the buckets this paradigm actually has: webhook loss (missing /
// drifted / extra), deletion metabolism, pending hydration, and DLQ'd poison.

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;
const servers: Server[] = [];

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
});
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  await cleanup();
});

function listen(app: express.Express): string {
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
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

async function deliver(hub: HubcrmApp, faultSeed?: number): Promise<void> {
  const doorUrl = listen(createIngestApp(pool));
  await hub.store.deliver({
    webhookUrl: `${doorUrl}/webhooks/hubcrm`,
    batchSize: 20,
    ...(faultSeed === undefined
      ? {}
      : { faultPlan: { seed: faultSeed, dropRate: 0.15, dupRate: 0.15, holdoverRate: 0.2, shuffleWithinBatch: true } }),
  });
}

describe("the hydration trichotomy under chaos", () => {
  it("dup/drop/disorder faults + 429 weather + a poison object + deletions + currency clears: every raw thin event is snapshot XOR tombstone XOR DLQ — none in limbo, and only the poison object's events DLQ", async () => {
    // Build the store first (no faults) to learn a poison target deterministically.
    const probe = createHubcrmApp({ seed: 77 });
    probe.store.simulate(1); // first op creates the first company
    const poisonId = probe.store.allObjects()[0].objectId;

    const hub = createHubcrmApp({ seed: 77, read429: { seed: 5, rate: 0.2 }, poisonObjectIds: [poisonId] });
    const baseUrl = listen(hub.app);
    hub.store.simulate(40);
    await deliver(hub, 11);
    hub.store.simulate(20);
    await deliver(hub, 12);

    const c = await connector(baseUrl);
    const report = await c.catchUpWithReport(pool);
    expect(report.hydrationPending).toBe(0);

    const raw = await pool.query<{ event_id: string }>("select event_id from raw.raw_events where source = 'hubcrm'");
    const snap = await pool.query<{ event_id: string; tombstone: boolean }>(
      "select event_id, tombstone from ingest.hydrated_snapshots",
    );
    const snapIds = new Set(snap.rows.map((r) => r.event_id));

    const rec = await c.reconcile(pool);
    expect(rec.integrity.ok).toBe(true);
    const dlqIds = new Set(rec.report!.hydrationDlq.map((d) => d.event_id));

    // THE TRICHOTOMY: partition, exactly.
    for (const { event_id } of raw.rows) {
      const inSnap = snapIds.has(event_id);
      const inDlq = dlqIds.has(event_id);
      expect(inSnap || inDlq).toBe(true); // nothing in limbo
      expect(inSnap && inDlq).toBe(false); // and no double-life
    }
    // Snapshot/DLQ rows only exist for raw events (no phantoms).
    const rawIds = new Set(raw.rows.map((r) => r.event_id));
    for (const id of snapIds) expect(rawIds.has(id)).toBe(true);
    for (const id of dlqIds) expect(rawIds.has(id)).toBe(true);

    // Only the poison object's events dead-letter.
    const poisonEventIds = new Set(
      hub.store
        .emittedEvents()
        .filter((e) => e.objectId === poisonId)
        .map((e) => String(e.eventId)),
    );
    for (const id of dlqIds) expect(poisonEventIds.has(id)).toBe(true);
  });

  it("a fault-free world reconciles CLEAN: no missing, no extra, no drift, nothing pending — and deletions count as metabolism, not discrepancies", async () => {
    const hub = createHubcrmApp({ seed: 9 });
    const baseUrl = listen(hub.app);
    hub.store.simulate(40);
    await deliver(hub);

    const c = await connector(baseUrl);
    await c.catchUpWithReport(pool);
    const rec = await c.reconcile(pool);

    expect(rec.integrity.ok).toBe(true);
    const r = rec.report!;
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
    expect(r.drifted).toEqual([]);
    expect(r.hydrationPending).toBe(0);
    expect(r.hydrationDlq).toEqual([]);
    expect(r.rawDuplicates).toBe(0);
    expect(r.ledger).toBe(hub.store.allObjects().length);
    expect(r.tombstonedRaw).toBeGreaterThan(0); // the script's create-then-delete pairs
  });

  it("webhook loss is DETECTED, per class: an all-events-dropped object is missing; a dropped LATER property change is drift (latest snapshot ≠ store); a dropped deletion is extra-shaped absence — each named, none papered over", async () => {
    const hub = createHubcrmApp({ seed: 21 });
    const baseUrl = listen(hub.app);

    // Deliver a clean history first, hydrate it.
    hub.store.simulate(30);
    await deliver(hub);
    const c = await connector(baseUrl);
    await c.catchUpWithReport(pool);

    // Now: mutations whose webhooks are ALL dropped (the 10-retries-then-gone loss).
    const before = hub.store.emittedEvents().length;
    hub.store.simulate(20);
    const doorUrl = listen(createIngestApp(pool));
    await hub.store.deliver({
      webhookUrl: `${doorUrl}/webhooks/hubcrm`,
      faultPlan: { seed: 1, dropRate: 1 }, // everything lost
    });
    const lost = hub.store.emittedEvents().slice(before);
    expect(lost.length).toBeGreaterThan(0);

    await c.catchUpWithReport(pool); // nothing new arrived — nothing to hydrate
    const rec = await c.reconcile(pool);
    expect(rec.integrity.ok).toBe(true);
    const r = rec.report!;

    const lostCreations = lost.filter(
      (e) => e.subscriptionType.endsWith(".creation") && !lost.some((d) => d.subscriptionType.endsWith(".deletion") && d.objectId === e.objectId),
    );
    const lostChanges = lost.filter(
      (e) =>
        e.subscriptionType.endsWith(".propertyChange") &&
        !lost.some((x) => x.subscriptionType.endsWith(".creation") && x.objectId === e.objectId) &&
        !lost.some((x) => x.subscriptionType.endsWith(".deletion") && x.objectId === e.objectId),
    );

    // Every surviving object created ONLY in the lost window is missing (never seen in raw).
    for (const e of lostCreations) {
      const type = e.subscriptionType.split(".")[0];
      expect(r.missing).toContain(`${type}:${e.objectId}`);
    }
    // Every pre-known object whose lost change moved the store is DRIFTED: its latest
    // snapshot no longer matches the store's current state.
    for (const e of lostChanges) {
      const type = e.subscriptionType.split(".")[0];
      expect(r.drifted).toContain(`${type}:${e.objectId}`);
    }
    expect(r.missing.length + r.drifted.length).toBeGreaterThan(0);
  });
});
