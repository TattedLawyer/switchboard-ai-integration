import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type pg from "pg";
import { createCrmApp } from "../../mocks/crm/src/server.js";
import { freshTestDb } from "./helpers/testdb.js";
import { pollOnce, catchUp, CRM_SOURCE } from "../src/backfill.js";

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

    const total = await catchUp(pool, baseUrl);
    expect(total).toBe(30);

    const raw = await pool.query("select count(*)::int as n from raw.raw_crm_events");
    expect(raw.rows[0].n).toBe(30);

    // Poll-path stored payloads must match push-path payloads byte-for-byte: none of the
    // CRM feed's pagination/chain fields (seq, prev_hash, hash) should leak into the stored
    // payload, since those are ledger transport metadata, not part of the CRM event itself.
    const payloads = await pool.query("select payload from raw.raw_crm_events order by event_id");
    for (const row of payloads.rows) {
      const payload = row.payload;
      expect(payload).not.toHaveProperty("seq");
      expect(payload).not.toHaveProperty("prev_hash");
      expect(payload).not.toHaveProperty("hash");
    }

    const cursor = await pool.query(
      "select last_seq from ingest.cursors where source = $1",
      [CRM_SOURCE],
    );
    expect(cursor.rows[0].last_seq).toBe("30");

    const second = await catchUp(pool, baseUrl);
    expect(second).toBe(0);

    const rawAfter = await pool.query("select count(*)::int as n from raw.raw_crm_events");
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

    await expect(pollOnce(pool, baseUrl)).rejects.toThrow();

    const cursor = await pool.query(
      "select last_seq from ingest.cursors where source = $1",
      [CRM_SOURCE],
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
      const runBackfill = createBackfillRunner(pool, baseUrl);

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
