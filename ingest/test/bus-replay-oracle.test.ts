import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type pg from "pg";
import { createCasebusApp, type CasebusApp } from "../../mocks/casebus/src/index.js";
import { freshTestDb, type TestDbResult } from "./helpers/testdb.js";
import { BusReplayConnector, CASEBUS_SOURCE } from "../src/connectors/bus-replay.js";
import type { BusReconcileReport } from "../src/connectors/bus-replay.js";
import { listGaps } from "../src/connectors/types.js";

// Task D pair 4 — the oracle: connector vs the REAL mock, seeded, in-process.
//
// The ledger-equivalent for this paradigm is the mock's retained window (the subscription
// IS the interface — no ledger file, no push channel, and no way to re-read what the
// window has dropped). Every oracle below compares against that truth.
//
// Cross-workspace src import is the established test-code convention (backfill.test.ts
// precedent; the no-cross-import rule protects src only).

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

function listen(app: CasebusApp): string {
  const s = app.app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

async function rawRows(p: pg.Pool): Promise<Map<string, { event_type: string; occurred_at: string; data: any }>> {
  const res = await p.query(
    `select event_id, event_type, payload->>'occurred_at' as occurred_at, payload->'data' as data
       from raw.raw_events where source = $1`,
    [CASEBUS_SOURCE],
  );
  return new Map(res.rows.map((r) => [r.event_id, { event_type: r.event_type, occurred_at: r.occurred_at, data: r.data }]));
}

describe("oracle 1 — full drain ⇄ the retained window, exactly", () => {
  it("drains everything the bus retains, payload-faithful, and a re-drain ingests ZERO", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(53); // deliberately not a multiple of the batch size
    const baseUrl = listen(mock);
    const c = new BusReplayConnector({ baseUrl, batchSize: 10 });

    const first = await c.catchUpWithReport(pool);
    expect(first.ingested).toBe(53);
    expect(first.duplicates).toBe(0);
    expect(first.quarantined).toBe(0);
    expect(first.gaps).toEqual([]);

    const raw = await rawRows(pool);
    expect(raw.size).toBe(53);
    for (const e of mock.stream.retained()) {
      const got = raw.get(e.event.id)!;
      expect(got.event_type).toBe(e.event.type);
      expect(got.occurred_at).toBe(e.event.event_time);
      // The payload survives verbatim, plus the replay id the connector deliberately
      // carries so a future gap can reconstruct its near edge.
      expect(got.data).toMatchObject({ ...e.event.payload, replay_id: e.replay_id });
    }

    const second = await new BusReplayConnector({ baseUrl, batchSize: 10 }).catchUpWithReport(pool);
    expect(second.ingested).toBe(0);
    expect((await rawRows(pool)).size).toBe(53);
  });
});

describe("oracle 2 — at-least-once duplicate absorption, COUNTED", () => {
  it("every event delivered twice lands once, and the redeliveries are reported rather than swallowed", async () => {
    const mock = createCasebusApp({ seed: 13, duplicate: { seed: 13, rate: 1 } });
    mock.stream.emit(30);
    const c = new BusReplayConnector({ baseUrl: listen(mock), batchSize: 7 });

    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(30);
    expect(report.duplicates).toBe(30);
    expect((await rawRows(pool)).size).toBe(30);

    // Reconcile agrees with the bus, duplicates and all — idempotency held end to end.
    const rec = (await c.reconcile(pool)).report as BusReconcileReport;
    expect(rec).toMatchObject({ ledger: 30, raw: 30, missing: [], extra: [], rawDuplicates: 0 });
  });

  it("partial redelivery (a realistic rate, not the everything knob) still converges exactly", async () => {
    const mock = createCasebusApp({ seed: 8, duplicate: { seed: 3, rate: 0.35 } });
    mock.stream.emit(40);
    const c = new BusReplayConnector({ baseUrl: listen(mock), batchSize: 6 });
    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(40);
    expect(report.duplicates).toBeGreaterThan(0); // the fault really fired
    expect((await rawRows(pool)).size).toBe(40);
  });
});

describe("oracle 3 — crash mid-drain: resume from the persisted cursor, no loss and no double-ingest", () => {
  it("a drain killed after one batch resumes exactly where it stopped", async () => {
    const mock = createCasebusApp({ seed: 42 });
    mock.stream.emit(35);
    const baseUrl = listen(mock);

    // "Crash": a bounded run that stops mid-window. maxRounds makes the connector refuse
    // to CLAIM a finished drain — the cursor is still consistent, which is the property
    // this oracle is really testing.
    await expect(
      new BusReplayConnector({ baseUrl, batchSize: 10 }).catchUpWithReport(pool, { maxRounds: 2 }),
    ).rejects.toThrow(/maxRounds/);
    const partial = (await rawRows(pool)).size;
    expect(partial).toBe(20);

    const resumed = await new BusReplayConnector({ baseUrl, batchSize: 10 }).catchUpWithReport(pool);
    expect(resumed.ingested).toBe(15); // exactly the remainder — nothing re-ingested
    expect(resumed.duplicates).toBe(0);
    const raw = await rawRows(pool);
    expect(raw.size).toBe(35);
    expect([...raw.keys()].sort()).toEqual(mock.stream.retained().map((e) => e.event.id).sort());
  });
});

describe("oracle 4 — age-out mid-run: the honest, bounded loss report", () => {
  it("aged-out cursor → gap with cause 'retention', correct bounds, forward progress, and a durable record", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);

    // Chapter 1: history ingested while the window still holds it (70h old — inside both
    // the bus's 72h window and the ingest door's occurred_at gate).
    const batch1 = mock.stream.emit(9, { ageS: 70 * 3600 });
    expect(await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool)).toBe(9);

    // Chapter 2: fresh events land, then the clock eats the old ones — batch1 is now 73h
    // old (gone, and the cursor with it), batch2 is minutes old.
    const batch2 = mock.stream.emit(7);
    mock.stream.advance(3 * 3600);

    // Chapter 3: the fallback. Forward progress AND an honest report, in that order of
    // execution and the reverse order of importance.
    const report = await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(report.ingested).toBe(7);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toEqual({
      cause: "retention",
      fromEventId: batch1.at(-1)!.event.id,
      fromOccurredAt: batch1.at(-1)!.event.event_time,
      toEventId: batch2[0].event.id,
      toOccurredAt: batch2[0].event.event_time,
    });

    // Aftermath: nothing already ingested was lost to the expiry; the books balance with
    // the aged-out rows counted as the window's normal metabolism.
    expect((await rawRows(pool)).size).toBe(16);
    const rec = (await new BusReplayConnector({ baseUrl, batchSize: 100 }).reconcile(pool)).report as BusReconcileReport;
    expect(rec).toMatchObject({ ledger: 7, raw: 16, missing: [], extra: [], agedOutRaw: 9 });

    // The durable record — and it is UNACKNOWLEDGED, which is what makes reconcile red.
    const stored = await listGaps(pool, "00000000-0000-0000-0000-000000000000", CASEBUS_SOURCE);
    expect(stored).toHaveLength(1);
    expect(stored[0].cause).toBe("retention");
    expect(stored[0].acknowledgedAt).toBeNull();
    expect(stored[0].fromEventId).toBe(batch1.at(-1)!.event.id);
    expect(stored[0].toEventId).toBe(batch2[0].event.id);
  });
});

describe("oracle 5 — stream reset mid-run: the SAME wire error, a different diagnosis", () => {
  it("reset → gap with cause 'reset' on a cursor that is seconds old, and the cursor rebinds to the new stream", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);

    const before = mock.stream.emit(11);
    expect(await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool)).toBe(11);

    // "On rare occasions, the stream of retained events can be reset if the Salesforce org
    // is moved to a new instance." Nothing aged out; the cursor is seconds old.
    mock.stream.reset();
    const after = mock.stream.emit(6);

    const report = await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(report.ingested).toBe(6);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].cause).toBe("reset"); // NOT 'retention' — age had nothing to do with it
    expect(report.gaps[0].fromEventId).toBe(before.at(-1)!.event.id);
    expect(report.gaps[0].toEventId).toBe(after[0].event.id);

    const stored = await listGaps(pool, "00000000-0000-0000-0000-000000000000", CASEBUS_SOURCE);
    expect(stored.map((g) => g.cause)).toEqual(["reset"]);

    // Everything ingested before the reset is still ours: a reset destroys the SOURCE's
    // retained window, not our record of what we already read.
    expect((await rawRows(pool)).size).toBe(17);

    // And the cursor now belongs to the new stream, so the NEXT invalidation is diagnosed
    // on its own merits rather than as a permanent second reset.
    const cur = await pool.query<{ stream_id: string }>(
      "select stream_id from ingest.cursors where source = $1",
      [CASEBUS_SOURCE],
    );
    expect(cur.rows[0].stream_id).toBe(mock.stream.streamId());
  });

  it("a reset with NOTHING retained afterwards still reports the loss, with an honestly unknown far edge", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(5);
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    mock.stream.reset(); // empty stream, new identity

    const report = await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUpWithReport(pool);
    expect(report.ingested).toBe(0);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].cause).toBe("reset");
    expect(report.gaps[0].toEventId).toBeNull();
    expect(report.gaps[0].toOccurredAt).toBeNull();
  });
});

describe("oracle 6 — opaque-id safety: arithmetic on a replay id is provably wrong", () => {
  it("the successor of a replay id, computed the way an ordinal-minded connector would, is NOT a valid cursor", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(20);

    const retained = mock.stream.retained();
    const served = new Set(retained.map((e) => e.replay_id));
    // The `evt-N` mistake, transplanted: decode, add one, re-encode.
    const arithmetic = retained.map((e) => `rpl_${(parseInt(e.replay_id.slice(4), 36) + 1).toString(36)}`);
    for (const id of arithmetic) expect(served.has(id)).toBe(false);

    // The bus rejects such a cursor outright — a connector built on arithmetic would
    // wedge or silently skip here rather than in production.
    const res = await fetch(`${baseUrl}/subscribe?replay_preset=CUSTOM&replay_id=${arithmetic[0]}&num_requested=10`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted");

    // And the connector never invents one: every cursor it persists is a replay id the
    // server actually served.
    await new BusReplayConnector({ baseUrl, batchSize: 6 }).catchUp(pool);
    const cur = await pool.query<{ last_event_id: string }>(
      "select last_event_id from ingest.cursors where source = $1",
      [CASEBUS_SOURCE],
    );
    expect(served.has(cur.rows[0].last_event_id)).toBe(true);
  });
});

describe("oracle 7 — the poison event, co-batched (standing rule)", () => {
  it("a poisoned event between healthy batchmates is quarantined alone; the window still reconciles with the poison accounted for", async () => {
    const mock = createCasebusApp({ seed: 42, poisonEmissionIndexes: [3, 4] });
    const baseUrl = listen(mock);
    mock.stream.emit(12);
    const c = new BusReplayConnector({ baseUrl, batchSize: 12 });

    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(10);
    expect(report.quarantined).toBe(2);

    // The oracle's real claim: the two poisoned events are NOT reported as missing —
    // they are preserved, named, and cross-referenced, so one bad vendor event cannot red
    // three days of reconciles.
    const rec = (await c.reconcile(pool)).report as BusReconcileReport;
    expect(rec.missing).toEqual([]);
    expect(rec.quarantined).toHaveLength(2);
    expect(rec.ledger).toBe(12);
    expect(rec.raw).toBe(10);
  });
});

describe("oracle 8 — reconcile-first detection must not file a POORER record than catchUp-first (cold review I2)", () => {
  it("a gap first observed by reconcile names the far edge by ID, exactly as a catchUp-first gap would", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);

    const aged = mock.stream.emit(9, { ageS: 70 * 3600 });
    await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(pool);
    const fresh = mock.stream.emit(7);
    mock.stream.advance(3 * 3600);

    // RECONCILE FIRST — the cron ordering nothing exercised before. `recordGap` is
    // first-writer-wins, so whichever surface gets here first fixes the record's quality
    // for the life of the gap; a reconcile-first gap used to keep to_event_id NULL
    // FOREVER even though reconcile is holding the entire retained window in memory.
    const rec = (await new BusReplayConnector({ baseUrl, batchSize: 100 }).reconcile(pool)).report as BusReconcileReport;
    expect(rec.gaps).toHaveLength(1);

    const stored = await listGaps(pool, "00000000-0000-0000-0000-000000000000", CASEBUS_SOURCE);
    expect(stored).toHaveLength(1);
    expect(stored[0].cause).toBe("retention");
    expect(stored[0].fromEventId).toBe(aged.at(-1)!.event.id);
    // The assertion this oracle exists for: the far edge is NAMED, not null.
    expect(stored[0].toEventId).toBe(fresh[0].event.id);
    expect(stored[0].toOccurredAt).toBe(fresh[0].event.event_time);
  });

  it("catchUp-first and reconcile-first produce the SAME record for the same loss — the ledger must not depend on which surface looked first", async () => {
    const build = async (p: pg.Pool, reconcileFirst: boolean) => {
      const mock = createCasebusApp({ seed: 42 });
      const baseUrl = listen(mock);
      mock.stream.emit(9, { ageS: 70 * 3600 });
      await new BusReplayConnector({ baseUrl, batchSize: 100 }).catchUp(p);
      mock.stream.emit(7);
      mock.stream.advance(3 * 3600);
      const c = new BusReplayConnector({ baseUrl, batchSize: 100 });
      if (reconcileFirst) {
        await c.reconcile(p);
        await c.catchUpWithReport(p);
      } else {
        await c.catchUpWithReport(p);
        await c.reconcile(p);
      }
      return (await listGaps(p, "00000000-0000-0000-0000-000000000000", CASEBUS_SOURCE))[0];
    };

    const catchUpFirst = await build(pool, false);
    const other = await freshTestDb();
    try {
      const reconcileFirst = await build(other.pool, true);
      // Same seed, same script ⇒ same ids; the only variable is who detected first.
      expect(reconcileFirst.cause).toBe(catchUpFirst.cause);
      expect(reconcileFirst.fromEventId).toBe(catchUpFirst.fromEventId);
      expect(reconcileFirst.fromOccurredAt).toBe(catchUpFirst.fromOccurredAt);
      expect(reconcileFirst.toEventId).toBe(catchUpFirst.toEventId);
      expect(reconcileFirst.toOccurredAt).toBe(catchUpFirst.toOccurredAt);
    } finally {
      await other.cleanup();
    }
  });
});
