import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type pg from "pg";
import express from "express";
import { createCasebusApp, type CasebusApp } from "../../mocks/casebus/src/index.js";
import { freshTestDb, type TestDbResult } from "./helpers/testdb.js";
import { BusReplayConnector, CASEBUS_SOURCE } from "../src/connectors/bus-replay.js";
import { listGaps } from "../src/connectors/types.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { listenLoopback } from "@switchboard/mock-core";

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

async function listen(app: CasebusApp | express.Express): Promise<string> {
  const e = "app" in app ? app.app : app;
  const server = await listenLoopback(e);
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
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(mock), batchSize: 10 });

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
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(mock), batchSize: 5 });
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
    const baseUrl = await listen(mock);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 4 }).catchUp(pool);
    const before = await cursorRow(pool);

    const second = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 4 }).catchUpWithReport(pool);
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(0);
    expect(await cursorRow(pool)).toEqual(before);
  });

  it("resumes from the stored cursor across instances, ingesting only what is new", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);
    mock.stream.emit(6);
    expect(await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool)).toBe(6);
    mock.stream.emit(7);
    expect(await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool)).toBe(7);
    expect((await rawIds(pool)).length).toBe(13);
  });

  it("has_more with an EMPTY batch and no cursor progress fails immediately by NAME — never a slow, misdiagnosed maxRounds exhaustion (debt-burn A4)", async () => {
    // The structural check reconcile has had since Task D, one screen away: an empty
    // batch carrying has_more:true gives the loop nothing to advance on — it is
    // unterminating by construction, and maxRounds would convert it into a slow failure
    // blamed on depth. catchUp must name the wedge on the round that shows it.
    const app = express();
    app.get("/subscribe", (_req, res) => {
      res
        .type("application/x-ndjson")
        .send(JSON.stringify({ status: { code: "OK", stream_id: "s", has_more: true, latest_replay_id: null } }) + "\n");
    });
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(app), batchSize: 10 });
    await expect(c.catchUpWithReport(pool, { maxRounds: 50 })).rejects.toThrow(/has_more with an empty batch/);
  });

  it("has_more is the ONLY termination signal, and an unbounded stream is a LOUD bounded failure, not a wedge", async () => {
    // A server that always says has_more, each batch carrying a FRESH event so the
    // cursor genuinely advances every round (since A4, an empty batch fails by name
    // instead — this pin is about the depth budget, so the stream must be honest-deep).
    // The drain must refuse to report a completion it did not reach.
    let n = 0;
    const app = express();
    app.get("/subscribe", (_req, res) => {
      n++;
      const frame = {
        replay_id: `rpl_${n * 7}`,
        event: { id: `evt-deep-${n}`, type: "support.ticket.updated", event_time: new Date().toISOString(), payload: {} },
      };
      res
        .type("application/x-ndjson")
        .send(
          JSON.stringify(frame) +
            "\n" +
            JSON.stringify({ status: { code: "OK", stream_id: "s", has_more: true, latest_replay_id: null } }) +
            "\n",
        );
    });
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(app), batchSize: 10 });
    await expect(c.catchUpWithReport(pool, { maxRounds: 5 })).rejects.toThrow(/maxRounds/);
  });
});

describe("at-least-once delivery: duplicates are absorbed AND counted", () => {
  it("a stream that re-serves events in-batch ingests each identity once and reports the redeliveries", async () => {
    const mock = createCasebusApp({ seed: 5, duplicate: { seed: 5, rate: 1 } });
    mock.stream.emit(20);
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(mock), batchSize: 100 });

    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(20);
    expect(report.duplicates).toBe(20); // every event was delivered exactly twice
    expect(await rawIds(pool)).toEqual(mock.stream.retained().map((e) => e.event.id).sort());
  });

  it("duplicates never become silence: a re-drain of an unchanged stream reports its duplicates too", async () => {
    const mock = createCasebusApp({ seed: 5 });
    mock.stream.emit(8);
    const baseUrl = await listen(mock);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    // Force a re-read of the same window by clearing the cursor the way an operator
    // restoring from an older backup would.
    await pool.query("update ingest.cursors set last_event_id = null where source = $1", [CASEBUS_SOURCE]);
    const again = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(again.ingested).toBe(0);
    expect(again.duplicates).toBe(8);
  });
});

describe("invalid cursor: two causes, told apart structurally because the wire will not say", () => {
  it("AGE-OUT → cause 'retention', bounds from the last ingested event to the earliest still retained, forward progress kept", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);

    const old = mock.stream.emit(5, { ageS: 70 * 3600 });
    expect(await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool)).toBe(5);
    const fresh = mock.stream.emit(6);
    mock.stream.advance(3 * 3600); // the old batch — and the cursor with it — ages out

    const report = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
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
    const baseUrl = await listen(mock);

    mock.stream.emit(5);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    const streamBefore = (await cursorRow(pool))!.stream_id;

    mock.stream.reset();
    mock.stream.emit(4);

    const report = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
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
    const baseUrl = await listen(mock);
    mock.stream.emit(3, { ageS: 71 * 3600 });
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.emit(3);
    mock.stream.advance(2 * 3600);

    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE)).toHaveLength(1);
  });

  it("the fallback preset is configurable, and LATEST is the loss-maximizing choice it is: it abandons the retained window", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);
    mock.stream.emit(4, { ageS: 71 * 3600 });
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.emit(9);
    mock.stream.advance(2 * 3600);

    const report = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100, fallbackPreset: "LATEST" }).catchUpWithReport(pool);
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
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(mock), batchSize: 100 });

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
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(mock), batchSize: 100 }).catchUp(pool);

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
    const baseUrl = await listen(mock);
    mock.stream.emit(5, { ageS: 71 * 3600 });
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    await new BusReplayConnector({ baseUrl, batchSize: 100, tenantId: TENANT_B }).catchUp(pool);
    expect((await rawIds(pool)).length).toBe(5);
    expect((await rawIds(pool, TENANT_B)).length).toBe(5);

    mock.stream.emit(3);
    mock.stream.advance(2 * 3600);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);

    // Tenant A took the loss; tenant B's own cursor is separately stale and its gap is
    // its own row — one tenant's gap must never answer for another's.
    expect(await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE)).toHaveLength(1);
    expect(await listGaps(pool, TENANT_B, CASEBUS_SOURCE)).toHaveLength(0);
    await new BusReplayConnector({ baseUrl, batchSize: 100, tenantId: TENANT_B }).catchUpWithReport(pool);
    expect(await listGaps(pool, TENANT_B, CASEBUS_SOURCE)).toHaveLength(1);
  });
});

describe("audit-write failure is LOUD (debt-burn A2): the gap ledger is a precondition, not a best effort", () => {
  it("a gap-ledger insert failure fails the run with the cursor unmoved — and the next healthy run re-detects the same loss", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);
    mock.stream.emit(5, { ageS: 70 * 3600 });
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    const deadCursor = (await cursorRow(pool))!.last_event_id;
    mock.stream.emit(6);
    mock.stream.advance(3 * 3600); // the cursor ages out: the corrupted-cursor path is next

    // Fault injection on the ONE statement under test. Variadic wrapper (standing trap
    // 4): pool.query is invoked with (text), (text, values) and (config) shapes.
    const failing = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const first = args[0];
            const sql = typeof first === "string" ? first : ((first as { text?: string })?.text ?? "");
            if (/insert into ingest\.gap_ledger/i.test(sql)) {
              return Promise.reject(new Error("injected: gap_ledger insert failed"));
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as pg.Pool;

    // The WAL rule (research A2): the durable loss record is a PRECONDITION for forward
    // progress. Record fails => run fails. Never forward progress + exit 0 over a loss
    // whose only durable trace was dropped — the exit code IS this system's alarm.
    await expect(new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(failing)).rejects.toThrow(
      /gap_ledger insert failed/,
    );

    // Mechanism, not narrative: the cursor still names the dead replay id and no gap row
    // exists — so nothing was skipped past an unrecorded loss.
    expect((await cursorRow(pool))!.last_event_id).toBe(deadCursor);
    expect(await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE)).toHaveLength(0);

    // Self-healing: the next run against a healthy ledger re-detects, records, drains.
    const report = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(report.ingested).toBe(6);
    expect(report.gaps).toHaveLength(1);
    expect(await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE)).toHaveLength(1);
  });
});

describe("the cursor-liveness probe: transient failure is NOT a verdict (debt-burn A1)", () => {
  /** Forward everything to the real mock except CUSTOM subscribes, which fail like a
   *  network blip. The reconcile DRAIN reads EARLIEST (one batch at batchSize 100), so
   *  the only CUSTOM request in the run is `replayIdIsServed`'s probe. */
  function transientProbeProxy(realUrl: string): express.Express {
    const proxy = express();
    proxy.get("/subscribe", async (req, res) => {
      if (String(req.query.replay_preset) === "CUSTOM") {
        res.status(500).send("transient upstream blip");
        return;
      }
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      const upstream = await fetch(`${realUrl}/subscribe?${qs}`);
      res.status(upstream.status).type("application/x-ndjson").send(await upstream.text());
    });
    return proxy;
  }

  it("a transient probe failure becomes integrity:{ok:false} for THIS source with its own wording — never a throw, never a gap row", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const realUrl = await listen(mock);
    mock.stream.emit(6);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: realUrl, batchSize: 100 }).catchUp(pool);

    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(transientProbeProxy(realUrl)), batchSize: 100 });
    const result = await c.reconcile(pool);

    // The window read succeeded; only the probe failed. The verdict is "this source's
    // liveness probe failed transiently", not "the cursor is dead".
    expect(result.integrity.ok).toBe(false);
    expect(result.integrity.detail).toMatch(/probe/i);
    expect(result.integrity.detail).toMatch(/transient/i);
    // Sibling-wording negatives (operator-surface checklist line 5): a transient blip
    // must not borrow the permanent-loss vocabulary of the corrupted-cursor path.
    // (Phrases, not bare words: the echoed URL legitimately contains "replay_preset".)
    expect(result.integrity.detail).not.toMatch(/PERMANENT DATA LOSS|unclosable|\(retention\)|\(reset\)|no longer valid/i);
    expect(result.report).toBeUndefined();
    // The mechanism under pin: a gap row is a PERMANENT-LOSS assertion, and a network
    // blip seconds after the same host served the whole window is no evidence of one.
    expect(await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE)).toHaveLength(0);
  });

  it("the vendor's corrupted-cursor rejection still takes the GAP path — classification absorbs the transport blip, never the definitive verdict", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);
    // Backfill while young; age the cursor out afterwards so reconcile's probe is the
    // first surface to meet the corrupted rejection.
    mock.stream.emit(4, { ageS: 71 * 3600 });
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.emit(3);
    mock.stream.advance(2 * 3600);

    const result = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).reconcile(pool);
    expect(result.integrity.ok).toBe(true); // the window itself read clean
    const gaps = await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].cause).toBe("retention");
  });
});

describe("fetch discipline: a black-holed bus is a bounded failure, never a wedge", () => {
  it("a server that never answers times out loudly and leaves the cursor intact", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(4);
    const good = await listen(mock);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: good, batchSize: 100 }).catchUp(pool);
    const before = await cursorRow(pool);

    const blackhole = express();
    blackhole.get("/subscribe", () => {
      /* never responds */
    });
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(blackhole), batchSize: 100, timeoutMs: 300 });
    await expect(c.catchUpWithReport(pool)).rejects.toThrow(/timed out/);
    expect(await cursorRow(pool)).toEqual(before);
  });
});

describe("reconcile: the retained window is the truth, read independently of the drain", () => {
  it("a clean world reconciles exactly; the report labels the window as the ledger-equivalent", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(15);
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(mock), batchSize: 4 });
    await c.catchUp(pool);

    const result = await c.reconcile(pool);
    expect(result.integrity.ok).toBe(true);
    expect(result.report).toMatchObject({ ledger: 15, raw: 15, missing: [], extra: [], rawDuplicates: 0, agedOutRaw: 0 });
    expect(result.report!.gaps).toEqual([]);
  });

  it("an unreadable bus produces NO report — an integrity failure, not confident meaningless diffs", async () => {
    const broken = express();
    broken.get("/subscribe", (_req, res) => res.status(500).send("boom"));
    const result = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await listen(broken) }).reconcile(pool);
    expect(result.integrity.ok).toBe(false);
    expect(result.report).toBeUndefined();
  });

  it("events ingested before they aged out are normal metabolism (agedOutRaw), never flagged as extra", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);
    mock.stream.emit(4, { ageS: 71 * 3600 });
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.emit(5);
    mock.stream.advance(2 * 3600);
    const c = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 });
    await c.catchUpWithReport(pool);

    const rec = (await c.reconcile(pool)).report!;
    expect(rec).toMatchObject({ ledger: 5, raw: 9, missing: [], extra: [], agedOutRaw: 4 });
    expect(rec.gaps).toHaveLength(1);
  });
});

// ── M4 (Task F, register): an identity-omitting status frame must not bind a NEW cursor
// to an OLD stream's identity ─────────────────────────────────────────────────────────────
//
// The wire's status frame is the only carrier of stream identity, and it may simply not
// carry it. setCursor's SQL coalesce filled that hole with whatever identity the row
// already had — remembered evidence presented as observed evidence. The simulated
// consequence (direction VERIFIED here, per the standing simulate-don't-reason rule): a
// cursor advanced on the NEW stream under an omitting frame keeps the OLD stream's id,
// so the next ordinary AGE-OUT compares stale-old vs current, sees a difference, and
// files the loss as "reset" — sending the operator to investigate an org migration that
// never happened (checklist line 5: a cause label wearing the wrong explanation).
describe("M4: status frames without stream_id — unknown identity stays unknown", () => {
  it("a cursor advanced under identity-omitting frames records NULL stream identity — never the PREVIOUS stream's id resurrected by coalesce", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);

    mock.stream.emit(3);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);
    const oldStreamId = (await cursorRow(pool))!.stream_id;
    expect(oldStreamId).not.toBeNull();

    // The stream resets; every frame of the recovery run omits stream_id.
    mock.stream.reset();
    mock.stream.emit(4);
    mock.omitStreamIdInStatusFrames(5);
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    mock.omitStreamIdInStatusFrames(0);

    const after = await cursorRow(pool);
    expect(after!.last_event_id).not.toBeNull(); // the cursor DID advance on the new stream
    expect(after!.stream_id).toBeNull(); // identity was never observed this run — say so
  });

  it("the downstream mislabel, end-to-end: after an omitting-frame recovery, an ordinary AGE-OUT must be cause 'retention' — not 'reset' derived from a stale coalesced identity", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);

    // Run 1: normal drain on stream 1 — cursor carries stream 1's identity.
    mock.stream.emit(3, { ageS: 70 * 3600 });
    await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUp(pool);

    // Run 2: the stream RESETS to stream 2, and every recovery frame omits stream_id.
    // (That recovery's own gap is conservatively labeled 'retention' — identity was
    // hidden at probe time; asserted below as the documented unknown-identity path.)
    mock.stream.reset();
    mock.stream.emit(4, { ageS: 70 * 3600 });
    mock.omitStreamIdInStatusFrames(5);
    const run2 = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    mock.omitStreamIdInStatusFrames(0);
    expect(run2.ingested).toBe(4);
    expect(run2.gaps).toHaveLength(1);
    expect(run2.gaps[0].cause).toBe("retention");

    // Run 3: stream 2 simply AGES OUT the cursor — the ordinary retention loss, no
    // reset anywhere near it. Frames now carry stream 2's identity normally.
    mock.stream.emit(1);
    mock.stream.advance(3 * 3600);
    const run3 = await new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(run3.gaps).toHaveLength(1);
    // Pre-fix: the coalesced stream-1 identity differs from stream 2's, and the loss
    // files as 'reset' — the wrong investigation. The truth of THIS loss is retention.
    expect(run3.gaps[0].cause).toBe("retention");

    const stored = await listGaps(pool, DEFAULT_TENANT, CASEBUS_SOURCE);
    expect(stored.map((g) => g.cause).sort()).toEqual(["retention", "retention"]);
  });

  it("boundary: identity observed EARLIER IN THE SAME RUN still binds — a mid-run omitting frame does not amnesia a cursor whose stream was just seen", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = await listen(mock);

    mock.stream.emit(5);
    // batchSize 2 → multiple rounds; frames 2+ omit stream_id, frame 1 carries it.
    mock.omitStreamIdInStatusFrames(0);
    const connector = new BusReplayConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl, batchSize: 2 });
    // First round observes the id; then the knob blinds the rest of the run.
    // (Set AFTER construction but BEFORE the drain's later rounds via a tiny shim:
    // the first /subscribe consumes no budget, later ones do.)
    const origFetch = globalThis.fetch;
    let served = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await origFetch(...args);
      if (String(args[0]).includes("/subscribe") && res.ok) {
        served++;
        if (served === 1) mock.omitStreamIdInStatusFrames(99);
      }
      return res;
    }) as typeof fetch;
    try {
      await connector.catchUp(pool);
    } finally {
      globalThis.fetch = origFetch;
      mock.omitStreamIdInStatusFrames(0);
    }

    const row = await cursorRow(pool);
    expect(row!.stream_id).toBe(mock.stream.streamId()); // run-observed identity carried forward
  });
});
