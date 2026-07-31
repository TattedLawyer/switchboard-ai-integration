import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { Server } from "node:http";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { secretForSource, signBody } from "../src/hmac.js";
import { createHubStore, type ThinEvent } from "../../mocks/hubcrm/src/index.js";

// Task C pair 3 — the BATCH webhook door (disclosed decision: the generic door in
// server.ts detects the hubcrm source and hands the whole request to the connector
// module's batch handler — vendor knowledge stays in ingest/src/connectors/hub-hydrate.ts,
// the door keeps its HMAC/media-type/unstorable machinery shared with every other source).
//
// The paradigm: HubSpot delivers up to 100 METADATA-ONLY events per request, unordered,
// re-delivered with attemptNumber+1. The door splits the batch and runs the EXISTING
// per-event pipeline on each element: vendor→door mapping → unstorable divert →
// shared schema gate (numeric contract included) → per-event quarantine or ingest.
// BATCH-FATAL IS FORBIDDEN: one bad event never blocks its batchmates — the register's
// STANDING RULE (co-batched poison isolation, pinned below with per-event count
// assertions, not idempotent end-state).

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let srv: Server;
let port: number;

beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  const app = createIngestApp(pool);
  srv = app.listen(0);
  port = (srv.address() as { port: number }).port;
});
afterAll(async () => {
  srv.close();
  await cleanup();
});

const postBatch = async (batch: unknown, opts?: { unsigned?: boolean }) => {
  const rawBody = JSON.stringify(batch);
  return fetch(`http://127.0.0.1:${port}/webhooks/hubcrm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts?.unsigned ? {} : { "x-switchboard-signature": signBody(rawBody, secretForSource("hubcrm")) }),
    },
    body: rawBody,
  });
};

/** A well-formed thin event with the researched field set. */
let nextId = 5_000_000_001;
const thin = (over: Partial<ThinEvent> = {}): ThinEvent => ({
  eventId: nextId++,
  subscriptionType: "deal.propertyChange",
  portalId: 24_000_042,
  occurredAt: Date.now(),
  objectId: 7_000_001,
  propertyName: "amount_cents",
  propertyValue: "125000",
  changeSource: "CRM_UI",
  attemptNumber: 0,
  ...over,
});

const rawRows = async (where = "source = 'hubcrm'") =>
  (await pool.query(`select event_id, event_type, payload, raw_body from raw.raw_events where ${where} order by event_id`)).rows;

describe("batch acceptance and the exactly-as-received store (D7)", () => {
  it("a signed batch of thin events lands per-event: event_id = String(eventId), event_type = subscriptionType, occurred_at = ISO of the ms epoch, data = the vendor event VERBATIM", async () => {
    const a = thin({ subscriptionType: "company.creation", propertyName: undefined, propertyValue: undefined });
    const b = thin();
    const c = thin({ subscriptionType: "deal.propertyChange", propertyName: "currency", propertyValue: null });
    const res = await postBatch([a, b, c]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: 3, duplicates: 0, quarantined: 0 });

    const rows = await rawRows(`source = 'hubcrm' and event_id in ('${a.eventId}','${b.eventId}','${c.eventId}')`);
    expect(rows).toHaveLength(3);
    for (const [sent, row] of [
      [a, rows.find((r) => r.event_id === String(a.eventId))],
      [b, rows.find((r) => r.event_id === String(b.eventId))],
      [c, rows.find((r) => r.event_id === String(c.eventId))],
    ] as const) {
      expect(row).toBeDefined();
      expect(row!.event_type).toBe(sent.subscriptionType);
      expect(row!.payload.occurred_at).toBe(new Date(sent.occurredAt).toISOString());
      // D7: the thin event is stored EXACTLY as received — vendor vocabulary, ms epoch,
      // sparse fields and explicit nulls all intact under data.
      expect(row!.payload.data).toEqual(JSON.parse(JSON.stringify(sent)));
    }
    // Disclosed raw_body decision: per-event wire bytes do not exist for a batch (the
    // request is the wire unit), and manufactured custody is forbidden — ingested rows
    // carry NULL, the same posture as the poll doors. Quarantined rows carry the full
    // batch text (see below), where preservation is what matters.
    for (const row of rows) expect(row.raw_body).toBeNull();
  });

  it("a non-array body on the hubcrm door is a 400 — this vendor's contract is 'the request is a batch'", async () => {
    const res = await postBatch(thin());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/array/i);
  });

  it("an unsigned batch is REJECTED 401, never quarantined — same authenticity rule as every push door", async () => {
    const res = await postBatch([thin()], { unsigned: true });
    expect(res.status).toBe(401);
  });

  it("re-delivery with attemptNumber+1 (same eventId) is an idempotent duplicate: raw keeps the FIRST delivery's payload, count stays 1", async () => {
    const e = thin();
    expect(await (await postBatch([e])).json()).toEqual({ stored: 1, duplicates: 0, quarantined: 0 });
    const redelivered = { ...e, attemptNumber: 1 };
    expect(await (await postBatch([redelivered])).json()).toEqual({ stored: 0, duplicates: 1, quarantined: 0 });
    const rows = await rawRows(`source = 'hubcrm' and event_id = '${e.eventId}'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.data.attemptNumber).toBe(0); // first delivery won
  });

  it("out-of-order delivery across batches: membership is complete regardless of order (ordering unguaranteed is the POINT — staging's occurred_at-wins owns sequencing)", async () => {
    const events = Array.from({ length: 5 }, (_, i) => thin({ occurredAt: Date.now() - i * 1000 }));
    // Deliver newest-first, split across two batches, interleaved.
    await postBatch([events[4], events[1]]);
    await postBatch([events[3], events[0], events[2]]);
    const ids = (await rawRows(`source = 'hubcrm' and event_id in (${events.map((e) => `'${e.eventId}'`).join(",")})`)).map(
      (r) => r.event_id,
    );
    expect(new Set(ids)).toEqual(new Set(events.map((e) => String(e.eventId))));
  });
});

describe("STANDING RULE — co-batched poison isolation (batch-fatal is forbidden)", () => {
  it("a poison event sandwiched between healthy ones: healthy events process EXACTLY ONCE, the poison quarantines with a reason naming its field, nothing else is touched", async () => {
    const h1 = thin();
    // Poison: propertyValue must be a string-or-null on this paradigm; a number is
    // garbage (the contract names it). objectId stays valid so only the declared rule fires.
    const poison = thin({ propertyValue: 999 as unknown as string });
    const h2 = thin();

    const res = await postBatch([h1, poison, h2]);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: 2, duplicates: 0, quarantined: 1 });

    // Healthy: exactly one raw row each (attempt-count assertion, not end-state).
    for (const h of [h1, h2]) {
      const rows = await rawRows(`source = 'hubcrm' and event_id = '${h.eventId}'`);
      expect(rows).toHaveLength(1);
    }
    // Poison: zero raw rows, one quarantine row naming the field.
    expect(await rawRows(`source = 'hubcrm' and event_id = '${poison.eventId}'`)).toHaveLength(0);
    const q = await pool.query("select reason, attempts from ingest.quarantine where payload->>'event_id' = $1", [
      String(poison.eventId),
    ]);
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].reason).toContain("propertyValue");
    expect(q.rows[0].attempts).toBe(0); // quarantined once, never replayed

    // Re-delivery of the SAME batch (the vendor's retry): healthy become duplicates
    // (still exactly one row), the poison quarantines AGAIN (re-serve accumulates —
    // the stripefeed precedent), and still nothing dead-letters the batchmates.
    const res2 = await postBatch([h1, poison, h2]);
    expect(await res2.json()).toEqual({ stored: 0, duplicates: 2, quarantined: 1 });
    for (const h of [h1, h2]) {
      expect(await rawRows(`source = 'hubcrm' and event_id = '${h.eventId}'`)).toHaveLength(1);
    }
    const q2 = await pool.query("select count(*)::int as n from ingest.quarantine where payload->>'event_id' = $1", [
      String(poison.eventId),
    ]);
    expect(q2.rows[0].n).toBe(2);
  });

  it("a jsonb-unstorable element (NUL escape) diverts to text-safe quarantine carrying the FULL batch text as raw_body; batchmates land untouched", async () => {
    const h = thin();
    const unstorable = thin({ propertyValue: "broken\u0000value" });
    const rawBody = JSON.stringify([h, unstorable]);
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/hubcrm`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-switchboard-signature": signBody(rawBody, secretForSource("hubcrm")),
      },
      body: rawBody,
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ stored: 1, duplicates: 0, quarantined: 1 });
    expect(await rawRows(`source = 'hubcrm' and event_id = '${h.eventId}'`)).toHaveLength(1);
    const q = await pool.query(
      "select reason, raw_body from ingest.quarantine where source = 'hubcrm' and raw_body is not null order by id desc limit 1",
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].raw_body).toBe(rawBody); // byte-exact custody: the batch IS the wire unit
  });

  it("an out-of-window occurredAt quarantines that event alone (the A6 window gate, per-element)", async () => {
    const h = thin();
    const stale = thin({ occurredAt: Date.now() - 40 * 24 * 60 * 60 * 1000 }); // 40 days old
    const res = await postBatch([stale, h]);
    expect(await res.json()).toEqual({ stored: 1, duplicates: 0, quarantined: 1 });
    const q = await pool.query("select reason from ingest.quarantine where payload->>'event_id' = $1", [
      String(stale.eventId),
    ]);
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].reason).toContain("occurred_at");
  });
});

describe("STANDING RULE — batch-fatal is forbidden BY CONSTRUCTION, not by enumeration", () => {
  // Task C fix wave (review finding I1). Every VALIDATION failure was already isolated
  // per element, but the loop had no per-element try/catch: an unexpected throw from
  // ingestEvent/quarantineEvent (a transient DB error, or an unstorable class
  // jsonbUnstorableReason does not yet recognize) aborted the remaining batchmates and
  // 500'd the request. Not lossy — the vendor retries the batch and ingest is idempotent
  // — but the standing rule says batch-fatal is FORBIDDEN, and "prevented by enumerating
  // the throwers we thought of" is not that. These two tests inject the throw directly.

  /** The real pool, with one element's ingest (and optionally its quarantine) rigged to
   *  reject — the transient-DB-error shape, injected at the exact element boundary. */
  const poolFailingOn = (targetEventId: string, opts: { alsoQuarantine?: boolean } = {}): pg.Pool =>
    new Proxy(pool, {
      get(target, prop) {
        if (prop === "connect") {
          return async () => {
            const client = await pool.connect();
            const original = client.query.bind(client) as (...args: unknown[]) => unknown;
            // Variadic passthrough on purpose: pg's own pool.query calls client.query
            // with a CALLBACK third argument, and a 2-arg wrapper silently strips it —
            // the promise then never settles and the "failure" reads as a hang.
            (client as { query: unknown }).query = (...args: unknown[]) => {
              const [text, params] = args;
              if (
                typeof text === "string" &&
                text.includes("insert into raw.raw_events") &&
                Array.isArray(params) &&
                params[2] === targetEventId
              ) {
                return Promise.reject(new Error("simulated transient DB failure on one element"));
              }
              return original(...args);
            };
            return client;
          };
        }
        if (prop === "query" && opts.alsoQuarantine) {
          return (...args: unknown[]) => {
            const [, params] = args;
            if (Array.isArray(params) && params.some((p) => typeof p === "string" && p.includes(targetEventId))) {
              return Promise.reject(new Error("simulated quarantine failure on the same element"));
            }
            return (pool.query as (...a: unknown[]) => unknown).apply(pool, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as pg.Pool;

  it("an unexpected THROW mid-batch does not abort the batchmates: the thrower is quarantined with a reason naming the failure, the healthy events still land", async () => {
    const { handleHubcrmBatch } = await import("../src/connectors/hub-hydrate.js");
    const h1 = thin();
    const thrower = thin();
    const h2 = thin();
    const batch = [h1, thrower, h2];

    const outcome = await handleHubcrmBatch(
      poolFailingOn(String(thrower.eventId)),
      JSON.parse(JSON.stringify(batch)),
      JSON.stringify(batch),
    );

    expect(outcome.status).toBe(202);
    expect(outcome.body).toEqual({ stored: 2, duplicates: 0, quarantined: 1 });
    // The batchmates AFTER the thrower are the ones a batch-fatal abort would have lost.
    for (const h of [h1, h2]) {
      expect(await rawRows(`source = 'hubcrm' and event_id = '${h.eventId}'`)).toHaveLength(1);
    }
    expect(await rawRows(`source = 'hubcrm' and event_id = '${thrower.eventId}'`)).toHaveLength(0);
    const q = await pool.query("select reason from ingest.quarantine where payload->>'event_id' = $1", [
      String(thrower.eventId),
    ]);
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].reason).toContain("simulated transient DB failure");
  });

  it("when even the quarantine write fails for the throwing element, the batchmates STILL land and the element is COUNTED as failed — never silently dropped", async () => {
    const { handleHubcrmBatch } = await import("../src/connectors/hub-hydrate.js");
    const h1 = thin();
    const thrower = thin();
    const h2 = thin();
    const batch = [h1, thrower, h2];

    const outcome = await handleHubcrmBatch(
      poolFailingOn(String(thrower.eventId), { alsoQuarantine: true }),
      JSON.parse(JSON.stringify(batch)),
      JSON.stringify(batch),
    );

    expect(outcome.status).toBe(202);
    // Honest arithmetic: the element is neither stored nor quarantined, so it is reported
    // as `failed` rather than folded into a bucket it never reached.
    expect(outcome.body).toEqual({ stored: 2, duplicates: 0, quarantined: 0, failed: 1 });
    for (const h of [h1, h2]) {
      expect(await rawRows(`source = 'hubcrm' and event_id = '${h.eventId}'`)).toHaveLength(1);
    }
  });
});

describe("end-to-end: the mock's own signed delivery lands through the real door", () => {
  it("mocks/hubcrm deliver() → the door: every non-dropped emitted event is in raw exactly once, under fault-plan disorder and duplication", async () => {
    const store = createHubStore({ seed: 1234 });
    const emitted = store.simulate(60);
    const stats = await store.deliver({
      webhookUrl: `http://127.0.0.1:${port}/webhooks/hubcrm`,
      batchSize: 25,
      faultPlan: { seed: 8, dupRate: 0.2, holdoverRate: 0.2, shuffleWithinBatch: true },
    });
    expect(stats.failedBatches).toBe(0);
    const ids = new Set(
      (await rawRows(`source = 'hubcrm' and event_id in (${emitted.map((e) => `'${e.eventId}'`).join(",")})`)).map(
        (r) => r.event_id,
      ),
    );
    expect(ids).toEqual(new Set(emitted.map((e) => String(e.eventId))));
  });
});
