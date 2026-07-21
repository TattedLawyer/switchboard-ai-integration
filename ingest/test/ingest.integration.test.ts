import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { getPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { createIngestApp } from "../src/server.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getPool();
  await runMigrations(pool);
  await pool.query("truncate raw.raw_crm_events");
});
afterAll(async () => { await pool.end(); });

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
    const rows = await pool.query("select event_id, event_type, payload from raw.raw_crm_events");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].event_id).toBe("evt-1");
    expect(rows.rows[0].payload.data.id).toBe("DEMO-C-0001");
    srv.close();
  });
});
