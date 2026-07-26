import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { ingestEvent } from "../src/ingest-event.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterAll(async () => { await cleanup(); });

const ev = (id: string) => ({ event_id: id, event_type: "company.updated",
  occurred_at: new Date().toISOString(), data: { id: "DEMO-C-0001", name: "DEMO X", domain: "x.example.com" } });

describe("ingestEvent", () => {
  it("inserts once and writes exactly one outbox row", async () => {
    expect(await ingestEvent(pool, "crm", ev("evt-1"))).toBe("inserted");
    expect(await ingestEvent(pool, "crm", ev("evt-1"))).toBe("duplicate");
    const raw = await pool.query("select count(*)::int as n from raw.raw_events where source='crm' and event_id='evt-1'");
    const ob = await pool.query("select count(*)::int as n from ingest.outbox where event_id='evt-1'");
    expect(raw.rows[0].n).toBe(1);
    expect(ob.rows[0].n).toBe(1);
  });
  it("survives concurrent duplicate ingestion", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestEvent(pool, "crm", ev("evt-2"))));
    expect(results.filter((r) => r === "inserted")).toHaveLength(1);
    const raw = await pool.query("select count(*)::int as n from raw.raw_events where source='crm' and event_id='evt-2'");
    expect(raw.rows[0].n).toBe(1);
  });
});
