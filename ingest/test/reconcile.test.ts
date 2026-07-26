import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { reconcile } from "../src/reconcile.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let dir: string;
let ledgerPath: string;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  ledgerPath = join(dir, "ledger.jsonl");
});

afterEach(async () => {
  await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function ledgerLine(eventId: string, seq: number): string {
  return JSON.stringify({
    event_id: eventId,
    event_type: "company.updated",
    occurred_at: new Date().toISOString(),
    data: {},
    seq,
  });
}

async function insertRaw(pool: pg.Pool, eventId: string): Promise<void> {
  await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload)
     values ('crm', $1, 'company.updated', '{}'::jsonb)`,
    [eventId],
  );
}

describe("reconcile", () => {
  it("reports missing events when ledger has entries absent from raw", async () => {
    const { writeFileSync } = await import("node:fs");
    const lines = ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"]
      .map((id, i) => ledgerLine(id, i + 1))
      .join("\n");
    writeFileSync(ledgerPath, lines + "\n", "utf8");

    for (const id of ["evt-1", "evt-2", "evt-3", "evt-4"]) {
      await insertRaw(pool, id);
    }

    const report = await reconcile(pool, "crm", ledgerPath);

    expect(report.ledger).toBe(5);
    expect(report.raw).toBe(4);
    expect(report.missing).toEqual(["evt-5"]);
    expect(report.extra).toEqual([]);
    expect(report.rawDuplicates).toBe(0);
  });

  it("reports clean when ledger and raw sets are equal", async () => {
    const { writeFileSync } = await import("node:fs");
    const lines = ["evt-1", "evt-2", "evt-3"]
      .map((id, i) => ledgerLine(id, i + 1))
      .join("\n");
    writeFileSync(ledgerPath, lines + "\n", "utf8");

    for (const id of ["evt-1", "evt-2", "evt-3"]) {
      await insertRaw(pool, id);
    }

    const report = await reconcile(pool, "crm", ledgerPath);

    expect(report.ledger).toBe(3);
    expect(report.raw).toBe(3);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.rawDuplicates).toBe(0);
  });
});
