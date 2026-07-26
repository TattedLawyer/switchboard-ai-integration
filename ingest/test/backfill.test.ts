import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
import { createCrmApp } from "../../mocks/crm/src/server.js";
import { freshTestDb } from "./helpers/testdb.js";
import { pollOnce, catchUp } from "../src/backfill.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let dir: string;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  dir = mkdtempSync(join(tmpdir(), "backfill-"));
});
afterEach(async () => {
  await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("backfill", () => {
  it("catchUp recovers all events dropped by webhook delivery, idempotently on rerun", async () => {
    // webhookUrl points at a dead port; combined with dropRate: 1, every push delivery is
    // skipped entirely (never attempted), so all 30 events land only in the ledger and poll
    // is the only recovery path.
    const crm = createCrmApp({ webhookUrl: "http://127.0.0.1:1", ledgerPath: join(dir, "l.jsonl") });
    const srv: Server = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 30,
        fault_plan: { seed: 1, dropRate: 1, dupRate: 0, apiErrorRate: 0 },
      }),
    });

    const total = await catchUp(pool, "crm", baseUrl);
    expect(total).toBe(30);

    const raw = await pool.query("select count(*)::int as n from raw.raw_events where source = 'crm'");
    expect(raw.rows[0].n).toBe(30);

    // Poll-path stored payloads must match push-path payloads byte-for-byte: none of the
    // CRM feed's pagination/chain fields (seq, prev_hash, hash) should leak into the stored
    // payload, since those are ledger transport metadata, not part of the CRM event itself.
    const payloads = await pool.query("select payload from raw.raw_events where source = 'crm' order by event_id");
    for (const row of payloads.rows) {
      const payload = row.payload;
      expect(payload).not.toHaveProperty("seq");
      expect(payload).not.toHaveProperty("prev_hash");
      expect(payload).not.toHaveProperty("hash");
    }

    const cursor = await pool.query(
      "select last_seq from ingest.cursors where source = $1",
      ["crm"],
    );
    expect(cursor.rows[0].last_seq).toBe("30");

    const second = await catchUp(pool, "crm", baseUrl);
    expect(second).toBe(0);

    const rawAfter = await pool.query("select count(*)::int as n from raw.raw_events where source = 'crm'");
    expect(rawAfter.rows[0].n).toBe(30);

    srv.close();
  });

  it("pollOnce throws on non-2xx and leaves cursor untouched", async () => {
    const crm = createCrmApp({
      webhookUrl: "http://127.0.0.1:1",
      ledgerPath: join(dir, "l2.jsonl"),
    });
    const srv: Server = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 5, fault_plan: { seed: 1, dropRate: 0, dupRate: 0, apiErrorRate: 1 } }),
    });

    await expect(pollOnce(pool, "crm", baseUrl)).rejects.toThrow();

    const cursor = await pool.query(
      "select last_seq from ingest.cursors where source = $1",
      ["crm"],
    );
    expect(cursor.rowCount).toBe(0);

    srv.close();
  });

  it("overlap guard prevents concurrent backfill runs", async () => {
    const { createBackfillRunner } = await import("../src/main.js");

    const crm = createCrmApp({
      webhookUrl: "http://127.0.0.1:1",
      ledgerPath: join(dir, "l3.jsonl"),
    });
    const srv: Server = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 10,
        fault_plan: { seed: 1, dropRate: 1, dupRate: 0, apiErrorRate: 0 },
      }),
    });

    // Capture logs to verify skip message
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string, ...args: unknown[]) => {
      logs.push(msg);
      originalLog(msg, ...args);
    };

    try {
      const runBackfill = createBackfillRunner(pool, "crm", baseUrl);

      // First call should run (no guard triggered)
      const p1 = runBackfill();

      // Immediately call again while first is still in-flight
      const p2 = runBackfill();

      // Wait for both to complete
      await p1;
      await p2;

      // Check that second invocation was skipped
      const skipLog = logs.find((log) => log.includes("backfill still running, skipping tick"));
      expect(skipLog).toBeTruthy();
    } finally {
      console.log = originalLog;
      srv.close();
    }
  });
});

// The poll path is a THIRD door into raw.raw_events, alongside the webhook and the quarantine
// replay. Two load-bearing comments assert there are only two and that both are gated:
// quarantine.ts calls its predicate "the single definition used by BOTH doors into raw", and
// stg_crm__companies.sql:14-17 justifies its `(occurred_at)::timestamptz` cast as "acceptable
// ONLY because the ingest gate ... rejects non-ISO-8601 occurred_at before anything reaches
// raw". pollOnce handed feed events straight to ingestEvent, which validates nothing — so a
// feed could put a value in raw that fails the staging cast (taking down the whole dbt build
// and every model downstream of it), or a well-formed "9999-12-31" that wins every
// latest-state sort forever. Neither is recoverable: the quarantine CLI only reads
// ingest.quarantine, and nothing deletes from raw.
describe("backfill occurred_at gate (the third door)", () => {
  const feedWith = (events: unknown[]) => {
    const app = express();
    app.get("/events", (_req, res) => res.json({ events, last_seq: events.length }));
    return app;
  };

  const goodEvent = (id: string) => ({
    event_id: id, event_type: "company.updated", occurred_at: new Date().toISOString(),
    data: { id: "DEMO-C-0001", name: "Demo", domain: "demo.example.com" }, seq: 1,
  });

  it("quarantines a feed event whose occurred_at would throw the staging cast", async () => {
    const bad = { ...goodEvent("evt-bad"), occurred_at: "2026-13-45", seq: 1 };
    const srv: Server = feedWith([bad]).listen(0);
    const port = (srv.address() as { port: number }).port;

    await pollOnce(pool, "crm", `http://127.0.0.1:${port}`);
    srv.close();

    const raw = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(raw.rows[0].n).toBe(0);
    const q = await pool.query("select source, reason from ingest.quarantine");
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].source).toBe("crm");
  });

  it("quarantines a well-formed but out-of-window occurred_at that would pin state forever", async () => {
    const bad = { ...goodEvent("evt-9999"), occurred_at: "9999-12-31T00:00:00Z", seq: 1 };
    const srv: Server = feedWith([bad]).listen(0);
    const port = (srv.address() as { port: number }).port;

    await pollOnce(pool, "crm", `http://127.0.0.1:${port}`);
    srv.close();

    const raw = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(raw.rows[0].n).toBe(0);
    expect((await pool.query("select 1 from ingest.quarantine")).rowCount).toBe(1);
  });

  it("still ingests valid feed events, and advances the cursor past a quarantined one", async () => {
    const events = [goodEvent("evt-1"), { ...goodEvent("evt-2"), occurred_at: "nope", seq: 2 },
                    { ...goodEvent("evt-3"), seq: 3 }];
    const srv: Server = feedWith(events).listen(0);
    const port = (srv.address() as { port: number }).port;

    await pollOnce(pool, "crm", `http://127.0.0.1:${port}`);
    srv.close();

    const raw = await pool.query("select event_id from raw.raw_events order by event_id");
    expect(raw.rows.map((r) => r.event_id)).toEqual(["evt-1", "evt-3"]);
    expect((await pool.query("select 1 from ingest.quarantine")).rowCount).toBe(1);
    // A poison event must not stall the cursor — that would re-poll it forever.
    const cur = await pool.query("select last_seq from ingest.cursors where source = 'crm'");
    expect(Number(cur.rows[0].last_seq)).toBe(3);
  });
});
