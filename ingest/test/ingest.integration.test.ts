import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterAll(async () => { await cleanup(); });

describe("ingest webhook", () => {
  it("stores a CRM event as raw jsonb", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const event = {
      event_id: "evt-1",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { id: "DEMO-C-0001", name: "DEMO Retail Group 1", domain: "retail-1.example.com" },
    };
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ stored: true });
    const rows = await pool.query("select event_id, event_type, payload from raw.raw_crm_events");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].event_id).toBe("evt-1");
    expect(rows.rows[0].payload.data.id).toBe("DEMO-C-0001");
    srv.close();
  });
});
