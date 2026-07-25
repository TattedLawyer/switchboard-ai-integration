import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { quarantineEvent, replayQuarantined } from "../src/quarantine.js";
import { ingestEvent } from "../src/ingest-event.js";
import { secretForSource, signBody } from "../src/hmac.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterAll(async () => {
  await cleanup();
});

const validEvent = {
  event_id: "evt-valid-1",
  event_type: "company.updated",
  occurred_at: new Date().toISOString(),
  data: { id: "DEMO-C-0001", name: "DEMO X", domain: "x.example.com" },
};

describe("quarantine", () => {
  it("invalid POST to /webhooks/crm returns 202 {quarantined: true} and creates quarantine row with reason", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;

    const invalidPayload = { bogus: true };
    const rawBody = JSON.stringify(invalidPayload);
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(rawBody, secretForSource("crm")) },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ quarantined: true });

    // Verify quarantine row was created
    const quarantineRows = await pool.query(
      "select id, payload, reason, received_at, replayed_at from ingest.quarantine where payload->>'bogus' = 'true'"
    );
    expect(quarantineRows.rowCount).toBe(1);
    expect(quarantineRows.rows[0].payload).toEqual(invalidPayload);
    expect(quarantineRows.rows[0].reason).toBe("schema validation failed");
    expect(quarantineRows.rows[0].replayed_at).toBeNull();

    srv.close();
  });

  it("replayQuarantined on invalid payload returns 'still-invalid' and doesn't modify row", async () => {
    const invalidPayload = { bogus: true };
    const insertResult = await pool.query(
      "insert into ingest.quarantine (payload, reason) values ($1, $2) returning id",
      [JSON.stringify(invalidPayload), "test quarantine"]
    );
    const quarantineId = insertResult.rows[0].id;

    const result = await replayQuarantined(pool, quarantineId, ingestEvent);
    expect(result).toBe("still-invalid");

    // Verify row is untouched
    const row = await pool.query(
      "select payload, reason, replayed_at from ingest.quarantine where id = $1",
      [quarantineId]
    );
    expect(row.rows[0].payload).toEqual(invalidPayload);
    expect(row.rows[0].replayed_at).toBeNull();
  });

  it("quarantineEvent then replayQuarantined with valid payload returns 'replayed', creates raw row, and sets replayed_at", async () => {
    // Insert valid payload directly into quarantine
    await quarantineEvent(pool, "crm", validEvent, "manual quarantine for testing");

    const quarantineRow = await pool.query(
      "select id, replayed_at from ingest.quarantine where payload->>'event_id' = $1",
      [validEvent.event_id]
    );
    expect(quarantineRow.rowCount).toBe(1);
    const quarantineId = quarantineRow.rows[0].id;
    expect(quarantineRow.rows[0].replayed_at).toBeNull();

    // Replay it
    const result = await replayQuarantined(pool, quarantineId, ingestEvent);
    expect(result).toBe("replayed");

    // Verify raw row was created
    const rawRow = await pool.query(
      "select event_id, event_type from raw.raw_events where source = 'crm' and event_id = $1",
      [validEvent.event_id]
    );
    expect(rawRow.rowCount).toBe(1);
    expect(rawRow.rows[0].event_id).toBe("evt-valid-1");
    expect(rawRow.rows[0].event_type).toBe("company.updated");

    // Verify replayed_at was set
    const updatedQuarantineRow = await pool.query(
      "select replayed_at from ingest.quarantine where id = $1",
      [quarantineId]
    );
    expect(updatedQuarantineRow.rows[0].replayed_at).not.toBeNull();
  });

  // L2-G2 ingest gate: staging orders latest-state by (payload->>'occurred_at')::timestamptz,
  // which THROWS on garbage — so garbage must never reach raw. Both doors into raw (webhook
  // schema gate here, replay gate below) must reject non-ISO-8601 occurred_at values into/back
  // into quarantine, never store them.
  describe("occurred_at ISO-8601 gate (L2-G2)", () => {
    const postSigned = async (port: number, payload: unknown) => {
      const rawBody = JSON.stringify(payload);
      return fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-switchboard-signature": signBody(rawBody, secretForSource("crm")),
        },
        body: rawBody,
      });
    };
    const gateEvent = (id: string, occurredAt: string) => ({
      event_id: id,
      event_type: "company.updated",
      occurred_at: occurredAt,
      data: { id: "DEMO-C-0009", name: "DEMO Gate", domain: "gate.example.com" },
    });

    it("an otherwise-valid signed event with occurred_at 'not-a-date' is quarantined, not stored", async () => {
      const app = createIngestApp(pool);
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        const res = await postSigned(port, gateEvent("evt-gate-garbage", "not-a-date"));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ quarantined: true });

        const q = await pool.query(
          "select reason from ingest.quarantine where payload->>'event_id' = 'evt-gate-garbage'",
        );
        expect(q.rowCount).toBe(1);
        expect(q.rows[0].reason).toBe("schema validation failed");
        const raw = await pool.query(
          "select 1 from raw.raw_events where event_id = 'evt-gate-garbage'",
        );
        expect(raw.rowCount).toBe(0);
      } finally {
        srv.close();
      }
    });

    it("a non-ISO-shaped date ('20260722') is quarantined, not stored", async () => {
      const app = createIngestApp(pool);
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        const res = await postSigned(port, gateEvent("evt-gate-basic-format", "20260722"));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ quarantined: true });
        const raw = await pool.query(
          "select 1 from raw.raw_events where event_id = 'evt-gate-basic-format'",
        );
        expect(raw.rowCount).toBe(0);
      } finally {
        srv.close();
      }
    });

    it("a valid, current ISO-8601 occurred_at still stores", async () => {
      // Relative date on purpose: a hardcoded literal would age out of the A6 window
      // and turn this into a time-bomb test.
      const app = createIngestApp(pool);
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        const res = await postSigned(port, gateEvent("evt-gate-valid", new Date().toISOString()));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ stored: true });
        const raw = await pool.query(
          "select 1 from raw.raw_events where event_id = 'evt-gate-valid'",
        );
        expect(raw.rowCount).toBe(1);
      } finally {
        srv.close();
      }
    });

    it("A6: occurred_at older than 30 days is quarantined — stale history must not pin latest-state", async () => {
      const app = createIngestApp(pool);
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
        const res = await postSigned(port, gateEvent("evt-gate-stale", stale));
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({ quarantined: true });
        const raw = await pool.query("select 1 from raw.raw_events where event_id = 'evt-gate-stale'");
        expect(raw.rowCount).toBe(0);
      } finally {
        srv.close();
      }
    });

    it("A6: occurred_at in the future beyond 5 minutes is quarantined — '9999-12-31' would otherwise pin an entity's state forever, undislodgeable by any later correct event", async () => {
      const app = createIngestApp(pool);
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        for (const [id, ts] of [
          ["evt-gate-future", new Date(Date.now() + 6 * 60 * 1000).toISOString()],
          ["evt-gate-doomsday", "9999-12-31T00:00:00.000Z"],
        ] as const) {
          const res = await postSigned(port, gateEvent(id, ts));
          expect(res.status).toBe(202);
          expect(await res.json()).toEqual({ quarantined: true });
          const raw = await pool.query("select 1 from raw.raw_events where event_id = $1", [id]);
          expect(raw.rowCount).toBe(0);
        }
      } finally {
        srv.close();
      }
    });

    it("A6: the window edges store — 29 days old and 4 minutes ahead (ordinary clock skew is tolerated)", async () => {
      const app = createIngestApp(pool);
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        for (const [id, ts] of [
          ["evt-gate-oldish", new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString()],
          ["evt-gate-skewed", new Date(Date.now() + 4 * 60 * 1000).toISOString()],
        ] as const) {
          const res = await postSigned(port, gateEvent(id, ts));
          expect(res.status).toBe(202);
          expect(await res.json()).toEqual({ stored: true });
          const raw = await pool.query("select 1 from raw.raw_events where event_id = $1", [id]);
          expect(raw.rowCount).toBe(1);
        }
      } finally {
        srv.close();
      }
    });

    it("replay is the same gate: a quarantined garbage-occurred_at event stays 'still-invalid' — it must never re-enter raw", async () => {
      // The replay path (quarantine.ts's own schema copy) is the SECOND door into raw. If it
      // stayed loose while the webhook gate tightened, an operator replay would put garbage
      // into raw and the staging timestamptz cast would take the whole build down.
      const garbage = gateEvent("evt-gate-replay", "not-a-date");
      await quarantineEvent(pool, "crm", garbage, "schema validation failed");
      const row = await pool.query(
        "select id from ingest.quarantine where payload->>'event_id' = 'evt-gate-replay'",
      );
      expect(row.rowCount).toBe(1);

      const result = await replayQuarantined(pool, row.rows[0].id, ingestEvent);
      expect(result).toBe("still-invalid");
      const raw = await pool.query(
        "select 1 from raw.raw_events where event_id = 'evt-gate-replay'",
      );
      expect(raw.rowCount).toBe(0);
    });
  });

  it("valid POST to /webhooks/crm returns 202 {stored: true} and creates raw row (direct ingest path)", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;

    const event = {
      event_id: "evt-direct-1",
      event_type: "company.created",
      occurred_at: new Date().toISOString(),
      data: { id: "DEMO-C-0002", name: "DEMO Y", domain: "y.example.com" },
    };
    const rawBody = JSON.stringify(event);
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-switchboard-signature": signBody(rawBody, secretForSource("crm")) },
      body: rawBody,
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ stored: true });

    // Verify raw row was created
    const rawRows = await pool.query(
      "select event_id, event_type from raw.raw_events where source = 'crm' and event_id = $1",
      [event.event_id]
    );
    expect(rawRows.rowCount).toBe(1);

    srv.close();
  });
});
