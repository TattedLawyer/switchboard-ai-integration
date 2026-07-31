import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type pg from "pg";
import express from "express";
import { createCasebusApp, type CasebusApp } from "../../mocks/casebus/src/index.js";
import { freshTestDb, type TestDbResult } from "./helpers/testdb.js";
import { BusReplayConnector, CASEBUS_SOURCE } from "../src/connectors/bus-replay.js";
import { listGaps } from "../src/connectors/types.js";

// Task D pair 3 — the subscribe/replay connector's own disciplines.
//
// This is the fourth paradigm and the only one where falling behind is unrecoverable BY
// CONSTRUCTION: there is no re-read of history, only a window that closes. The connector's
// job is therefore not "never lose anything" — it cannot promise that — but "never lose
// anything SILENTLY, and never stop making forward progress".
//
// Five disciplines, each pinned below:
//   1. The cursor is OURS. It advances only past events this connector verifiably
//      processed, never to a server-supplied resume hint (the Task B lesson).
//   2. Replay ids are OPAQUE. No arithmetic, no ordering assumptions beyond "the server
//      resumes after this one". The mock mints them at strides of 2..97 so cursor+1 is
//      provably wrong.
//   3. An invalid cursor has TWO causes and they must be told apart. The wire cannot tell
//      us — the vendor serves one error code for both — so the cause is derived from the
//      stream identity, whose change is the documented signature of a reset.
//   4. At-least-once means duplicates are NORMAL. They are absorbed by
//      (tenant, source, event_id) and COUNTED, never silently swallowed.
//   5. Poison isolation is a standing rule: a bad event between healthy batchmates
//      quarantines alone, and its batchmates land EXACTLY ONCE.

const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000000";
const TENANT_B = "33333333-3333-3333-3333-333333333333";

let db: TestDbResult;
let pool: pg.Pool;
const servers: Server[] = [];

beforeEach(async () => {
  db = await freshTestDb();
  pool = db.pool;
});
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  await db.cleanup();
});

function listen(app: CasebusApp | express.Express): string {
  const e = "app" in app ? app.app : app;
  const server = e.listen(0);
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function rawIds(p: pg.Pool, tenantId = DEFAULT_TENANT): Promise<string[]> {
  const res = await p.query<{ event_id: string }>(
    "select event_id from raw.raw_events where tenant_id = $1 and source = $2 order by event_id",
    [tenantId, CASEBUS_SOURCE],
  );
  return res.rows.map((r) => r.event_id);
}

async function cursorRow(p: pg.Pool, tenantId = DEFAULT_TENANT) {
  const res = await p.query<{ last_event_id: string | null; stream_id: string | null; last_seq: string }>(
    "select last_event_id, stream_id, last_seq from ingest.cursors where tenant_id = $1 and source = $2",
    [tenantId, CASEBUS_SOURCE],
  );
  return res.rowCount === 0 ? null : res.rows[0];
}

describe("the drain: subscribe, consume, persist a cursor that is OURS", () => {
  it("with no stored cursor it subscribes EARLIEST and ingests the whole retained window", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(37); // deliberately not a multiple of the batch size
    const c = new BusReplayConnector({ baseUrl: listen(mock), batchSize: 10 });

    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(37);
    expect(report.duplicates).toBe(0);
    expect(report.quarantined).toBe(0);
    expect(report.gaps).toEqual([]);
    expect(await rawIds(pool)).toEqual(mock.stream.retained().map((e) => e.event.id).sort());
  });

  it("persists the replay id of the LAST verified-ingested event, plus the stream it came from", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(12);
    const c = new BusReplayConnector({ baseUrl: listen(mock), batchSize: 5 });
    await c.catchUp(pool);

    const cur = await cursorRow(pool);
    expect(cur!.last_event_id).toBe(mock.stream.retained().at(-1)!.replay_id);
    expect(cur!.stream_id).toBe(mock.stream.streamId());
    // Reuses migration 008's opaque-cursor column; last_seq stays at its ledger-paradigm
    // default rather than gaining a third, non-ordinal meaning.
    expect(Number(cur!.last_seq)).toBe(0);
  });

  it("a second drain with nothing new ingests ZERO and leaves the cursor where it was", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(9);
    const baseUrl = listen(mock);
    await new BusReplayConnector({ baseUrl, batchSize: 4 }).catchUp(pool);
    const before = await cursorRow(pool);

    const second = await new BusReplayConnector({ baseUrl, batchSize: 4 }).catchUpWithReport(pool);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(0);
    expect(await cursorRow(pool)).toEqual(before);
  });

  it("resumes from the stored cursor across instances, ingesting only what is new", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(6);
    expect(await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool)).toBe(6);
    mock.stream.emit(7);
    expect(await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool)).toBe(7);
    expect((await rawIds(pool)).length).toBe(13);
  });

  it("has_more is the ONLY termination signal, and an unbounded stream is a LOUD bounded failure, not a wedge", async () => {
    // A server that always says has_more with a never-advancing cursor: the drain must
    // refuse to report a completion it did not reach.
    const app = express();
    app.get("/subscribe", (_req, res) => {
      res.type("application/x-ndjson").send(JSON.stringify({ status: { code: "OK", stream_id: "s", has_more: true, latest_replay_id: null } }) + "\n");
    });
    const c = new BusReplayConnector({ baseUrl: listen(app), batchSize: 10 });
    await expect(c.catchUpWithReport(pool, { maxRounds: 5 })).rejects.toThrow(/maxRounds/);
  });
});

describe("at-least-once delivery: duplicates are absorbed AND counted", () => {
  it("a stream that re-serves events in-batch ingests each identity once and reports the redeliveries", async () => {
    const mock = createCasebusApp({ seed: 5, duplicate: { seed: 5, rate: 1 } });
    mock.stream.emit(20);
    const c = new BusReplayConnector({ baseUrl: listen(mock), batchSize: 100 });

    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(20);
    expect(report.duplicates).toBe(20); // every event was delivered exactly twice
    expect(await rawIds(pool)).toEqual(mock.stream.retained().map((e) => e.event.id).sort());
  });

  it("duplicates never become silence: a re-drain of an unchanged stream reports its duplicates too", async () => {
    const mock = createCasebusApp({ seed: 5 });
    mock.stream.emit(8);
    const baseUrl = listen(mock);
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    // Force a re-read of the same window by clearing the cursor the way an operator
    // restoring from an older backup would.
    await pool.query("update ingest.cursors set last_event_id = null where source = $1", [CASEBUS_SOURCE]);
    const again = await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(again.ingested).toBe(0);
    expect(again.duplicates).toBe(8);
  });
});

describe("invalid cursor: two causes, told apart structurally because the wire will not say", () => {
  it("AGE-OUT → cause 'retention', bounds from the last ingested event to the earliest still retained, forward progress kept", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);

    const old = mock.stream.emit(5, { ageS: 70 * 3600 });
    expect(await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool)).toBe(5);
    const fresh = mock.stream.emit(6);
    mock.stream.advance(3 * 3600); // the old batch — and the cursor with it — ages out

    const report = await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(report.ingested).toBe(6); // forward progress FIRST
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({
      cause: "retention",
      fromEventId: old.at(-1)!.event.id,
      fromOccurredAt: old.at(-1)!.event.event_time,
      toEventId: fresh[0].event.id,
      toOccurredAt: fresh[0].event.event_time,
    });

    const stored = await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE);
    expect(stored).toHaveLength(1);
    expect(stored[0].cause).toBe("retention");
    expect(stored[0].acknowledgedAt).toBeNull();
  });

  it("RESET → cause 'reset', even though the cursor is minutes old and the wire error is byte-identical", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);

    mock.stream.emit(5);
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    const streamBefore = (await cursorRow(pool))!.stream_id;

    mock.stream.reset();
    mock.stream.emit(4);

    const report = await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(report.ingested).toBe(4);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].cause).toBe("reset");

    // The cursor now belongs to the NEW stream — otherwise the next invalidation would
    // be misdiagnosed as a second reset forever.
    const after = await cursorRow(pool);
    expect(after!.stream_id).not.toBe(streamBefore);
    expect(after!.stream_id).toBe(mock.stream.streamId());
    expect((await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE))[0].cause).toBe("reset");
  });

  it("re-running after a fallback does not record a second gap for the same loss", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(3, { ageS: 71 * 3600 });
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.emit(3);
    mock.stream.advance(2 * 3600);

    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE)).toHaveLength(1);
  });

  it("the fallback preset is configurable, and LATEST is the loss-maximizing choice it is: it abandons the retained window", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(4, { ageS: 71 * 3600 });
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.emit(9);
    mock.stream.advance(2 * 3600);

    const report = await new BusReplayConnector({ baseUrl, batchSize: 100, fallbackPreset: "LATEST" }).catchUpWithReport(pool);
    expect(report.ingested).toBe(0); // the 9 retained events are skipped, on purpose
    expect(report.gaps[0].cause).toBe("retention");
    // …and the gap says so: with LATEST there is no knowable far edge inside the window.
    expect(report.gaps[0].toEventId).toBeNull();
  });
});

describe("the standard door: schema gate, quarantine, and honest raw_body custody", () => {
  it("a poison event between healthy batchmates quarantines ALONE — batchmates land exactly once (attempt COUNTS, not just presence)", async () => {
    const mock = createCasebusApp({ seed: 42, poisonEmissionIndexes: [1] });
    mock.stream.emit(3); // healthy, poison, healthy — one batch
    const c = new BusReplayConnector({ baseUrl: listen(mock), batchSize: 100 });

    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(2);
    expect(report.quarantined).toBe(1);

    const rows = await pool.query<{ event_id: string; n: number }>(
      "select event_id, count(*)::int as n from raw.raw_events where source = $1 group by 1",
      [CASEBUS_SOURCE],
    );
    expect(rows.rows.map((r) => r.n)).toEqual([1, 1]); // exactly once each, not twice
    const q = await pool.query<{ reason: string }>(
      "select reason from ingest.quarantine where source = $1",
      [CASEBUS_SOURCE],
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].reason).toContain("occurred_at");
    // The cursor advanced PAST the poison: one bad event must not wedge the stream on
    // itself forever.
    expect((await cursorRow(pool))!.last_event_id).toBe(mock.stream.retained().at(-1)!.replay_id);
  });

  it("raw_body is the GENUINE per-event wire line — not a re-serialization, and re-parseable to the event we stored", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(2);
    await new BusReplayConnector({ baseUrl: listen(mock), batchSize: 100 }).catchUp(pool);

    const res = await pool.query<{ event_id: string; raw_body: string | null }>(
      "select event_id, raw_body from raw.raw_events where source = $1 order by event_id",
      [CASEBUS_SOURCE],
    );
    for (const row of res.rows) {
      expect(row.raw_body).not.toBeNull();
      const parsed = JSON.parse(row.raw_body!);
      expect(parsed.event.id).toBe(row.event_id);
      expect(parsed.replay_id).toMatch(/^rpl_/);
    }
    // Custody, not construction: the stored text is byte-identical to a line the server
    // actually sent, so it round-trips to the exact frame including its replay id.
    const served = mock.stream.retained().map((e) => JSON.stringify(e));
    expect(res.rows.map((r) => r.raw_body).sort()).toEqual(served.sort());
  });
});

describe("tenancy — pinned with a NON-DEFAULT tenant (migration 006's floor, the Task C cold-review lesson)", () => {
  it("two tenants drain the same bus independently: separate cursors, separate raw rows, separate gaps", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(5, { ageS: 71 * 3600 });
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    await new BusReplayConnector({ baseUrl, batchSize: 100, tenantId: TENANT_B }).catchUp(pool);
    expect((await rawIds(pool)).length).toBe(5);
    expect((await rawIds(pool, TENANT_B)).length).toBe(5);

    mock.stream.emit(3);
    mock.stream.advance(2 * 3600);
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);

    // Tenant A took the loss; tenant B's own cursor is separately stale and its gap is
    // its own row — one tenant's gap must never answer for another's.
    expect(await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE)).toHaveLength(1);
    expect(await listGaps(pool, TENANT_B, CASEBUS_SOURCE)).toHaveLength(0);
    await new BusReplayConnector({ baseUrl, batchSize: 100, tenantId: TENANT_B }).catchUpWithReport(pool);
    expect(await listGaps(pool, TENANT_B, CASEBUS_SOURCE)).toHaveLength(1);
  });
});

describe("fetch discipline: a black-holed bus is a bounded failure, never a wedge", () => {
  it("a server that never answers times out loudly and leaves the cursor intact", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(4);
    const good = listen(mock);
    await new BusReplayConnector({ baseUrl: good, batchSize: 100 }).catchUp(pool);
    const before = await cursorRow(pool);

    const blackhole = express();
    blackhole.get("/subscribe", () => {
      /* never responds */
    });
    const c = new BusReplayConnector({ baseUrl: listen(blackhole), batchSize: 100, timeoutMs: 300 });
    await expect(c.catchUpWithReport(pool)).rejects.toThrow(/timed out/);
    expect(await cursorRow(pool)).toEqual(before);
  });
});

describe("reconcile: the retained window is the truth, read independently of the drain", () => {
  it("a clean world reconciles exactly; the report labels the window as the ledger-equivalent", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(15);
    const c = new BusReplayConnector({ baseUrl: listen(mock), batchSize: 4 });
    await c.catchUp(pool);

    const result = await c.reconcile(pool);
    expect(result.integrity.ok).toBe(true);
    expect(result.report).toMatchObject({ ledger: 15, raw: 15, missing: [], extra: [], rawDuplicates: 0, agedOutRaw: 0 });
    expect(result.report!.gaps).toEqual([]);
  });

  it("an unreadable bus produces NO report — an integrity failure, not confident meaningless diffs", async () => {
    const broken = express();
    broken.get("/subscribe", (_req, res) => res.status(500).send("boom"));
    const result = await new BusReplayConnector({ baseUrl: listen(broken) }).reconcile(pool);
    expect(result.integrity.ok).toBe(false);
    expect(result.report).toBeUndefined();
  });

  it("events ingested before they aged out are normal metabolism (agedOutRaw), never flagged as extra", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(4, { ageS: 71 * 3600 });
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.emit(5);
    mock.stream.advance(2 * 3600);
    const c = new BusReplayConnector({ baseUrl, batchSize: 100 });
    await c.catchUpWithReport(pool);

    const rec = (await c.reconcile(pool)).report!;
    expect(rec).toMatchObject({ ledger: 5, raw: 9, missing: [], extra: [], agedOutRaw: 4 });
    expect(rec.gaps).toHaveLength(1);
  });
});
