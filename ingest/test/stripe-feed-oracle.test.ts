import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type pg from "pg";
import { createStripeFeedApp, type StripeFeedApp } from "../../mocks/stripefeed/src/index.js";
import { freshTestDb, type TestDbResult } from "./helpers/testdb.js";
import { StripeFeedConnector } from "../src/connectors/stripe-feed.js";
import type { StripeFeedReconcileReport } from "../src/connectors/stripe-feed.js";

// Task B pair 3 — the oracle: connector vs the REAL mock, seeded, in-process.
//
// The ledger-equivalent for this paradigm is the mock's full retained event set (the
// feed IS the interface — no ledger file, no push channel). Every oracle below compares
// against that truth: full drain exactness, idempotent re-drain, shuffled-page
// invariance, crash-resume, the retention-expiry gap with correct bounds, and 429
// resilience. Cross-workspace src import is the established test-code convention
// (backfill.test.ts precedent; the no-cross-import rule protects src only).

let db: TestDbResult;
let pool: pg.Pool;
let srv: Server | undefined;
let extraDbs: TestDbResult[];
let extraSrvs: Server[];

beforeEach(async () => {
  db = await freshTestDb();
  pool = db.pool;
  extraDbs = [];
  extraSrvs = [];
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  for (const s of extraSrvs) s.close();
  await db.cleanup();
  for (const d of extraDbs) await d.cleanup();
});

function listen(app: StripeFeedApp, extra = false): string {
  const server = app.app.listen(0);
  if (extra) extraSrvs.push(server);
  else srv = server;
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function rawEvents(p: pg.Pool): Promise<Map<string, { event_type: string; occurred_at: string; data: unknown }>> {
  const res = await p.query(
    `select event_id, event_type, payload->>'occurred_at' as occurred_at, payload->'data' as data
       from raw.raw_events where source = 'stripefeed'`,
  );
  return new Map(
    res.rows.map((r) => [r.event_id, { event_type: r.event_type, occurred_at: r.occurred_at, data: r.data }]),
  );
}

describe("oracle 1 — full drain ⇄ retained set, exactly (the ledger-equivalent comparison)", () => {
  it("drains everything the feed retains, byte-faithful at the payload level, and a re-drain ingests ZERO", async () => {
    const mock = createStripeFeedApp({ seed: 42 });
    mock.feed.emit(57); // deliberately not a multiple of the page size
    const c = new StripeFeedConnector({ baseUrl: listen(mock), pageLimit: 10 });

    const first = await c.catchUpWithReport(pool);
    expect(first.ingested).toBe(57);
    expect(first.quarantined).toBe(0);
    expect(first.gaps).toEqual([]);

    const raw = await rawEvents(pool);
    const retained = mock.feed.retained();
    expect(raw.size).toBe(retained.length);
    for (const e of retained) {
      const row = raw.get(e.id);
      expect(row, `retained event ${e.id} must be in raw`).toBeDefined();
      expect(row!.event_type).toBe(e.type);
      expect(row!.occurred_at).toBe(new Date(e.created * 1000).toISOString());
      expect(row!.data).toEqual(e.data.object);
    }

    // Idempotent re-drain: the second pass may re-serve pages but must land nothing new.
    const second = await c.catchUpWithReport(pool);
    expect(second.ingested).toBe(0);
    expect((await rawEvents(pool)).size).toBe(57);

    // And reconcile agrees the books balance.
    const rec = await c.reconcile(pool);
    expect(rec.integrity.ok).toBe(true);
    const report = rec.report as StripeFeedReconcileReport;
    expect(report).toMatchObject({ ledger: 57, raw: 57, missing: [], extra: [], rawDuplicates: 0, agedOutRaw: 0, gaps: [] });
  });
});

describe("oracle 2 — shuffled-page invariance (ordering is undocumented; the connector must not care)", () => {
  it("reaches the IDENTICAL final raw state with the shuffle flag on and off", async () => {
    const dbB = await freshTestDb();
    extraDbs.push(dbB);

    const plain = createStripeFeedApp({ seed: 42 });
    const shuffled = createStripeFeedApp({ seed: 42, shuffle: { seed: 1337 } });
    plain.feed.emit(83);
    shuffled.feed.emit(83);

    const cPlain = new StripeFeedConnector({ baseUrl: listen(plain), pageLimit: 7 });
    const cShuffled = new StripeFeedConnector({ baseUrl: listen(shuffled, true), pageLimit: 7 });

    expect(await cPlain.catchUp(pool)).toBe(83);
    // The shuffled drain may re-serve pages (order-blind cursor + same-second ties);
    // what is INVARIANT is the final state, not the request trace.
    const shuffledReport = await cShuffled.catchUpWithReport(dbB.pool);
    expect(shuffledReport.ingested).toBe(83);
    expect(shuffledReport.quarantined).toBe(0);

    const a = await rawEvents(pool);
    const b = await rawEvents(dbB.pool);
    expect(b.size).toBe(a.size);
    for (const [id, row] of a) expect(b.get(id)).toEqual(row);
  });
});

describe("oracle 3 — mid-drain crash resume", () => {
  it("a drain cut off mid-way leaves the cursor at the last processed page; the resumed run completes with no loss and no double-ingest", async () => {
    const mock = createStripeFeedApp({ seed: 42 });
    mock.feed.emit(40);
    const c = new StripeFeedConnector({ baseUrl: listen(mock), pageLimit: 6 });

    // The crash: the round budget expires mid-drain — loud by design, state consistent.
    await expect(c.catchUp(pool, { maxRounds: 3 })).rejects.toThrow(/maxRounds/);
    const partial = (await rawEvents(pool)).size;
    expect(partial).toBe(18); // 3 full pages of 6
    const cur = await pool.query("select last_event_id from ingest.cursors where source = 'stripefeed'");
    expect(cur.rows[0].last_event_id).toBeTruthy();

    // Resume: a FRESH connector instance (new process semantics) finishes the job.
    const resumed = new StripeFeedConnector({ baseUrl: listen(mock, true), pageLimit: 6 });
    const report = await resumed.catchUpWithReport(pool);
    expect(report.ingested).toBe(40 - partial);
    expect((await rawEvents(pool)).size).toBe(40);
  });
});

describe("oracle 4 — retention expiry mid-catchUp: the honest, bounded loss report", () => {
  it("aged-out cursor → gap with correct bounds, forward progress, and both reconcile surfaces tell the story", async () => {
    const mock = createStripeFeedApp({ seed: 42 });
    const baseUrl = listen(mock);

    // Chapter 1: history the connector ingests while it is still retrievable. 26 days
    // old — inside BOTH the feed's 30-day window and the ingest door's occurred_at gate.
    const batch1 = mock.feed.emit(8, { ageS: 26 * 86_400 });
    const c1 = new StripeFeedConnector({ baseUrl, pageLimit: 10 });
    expect(await c1.catchUp(pool)).toBe(8);

    // Chapter 2: fresh events land, then the clock eats the old ones — batch1 is now 31
    // days old (gone; and with it the cursor), batch2 is 5 days old (retained).
    const batch2 = mock.feed.emit(6);
    mock.feed.advance(5 * 86_400);

    // A reconcile that runs BEFORE any fallback sees the still-live gap condition:
    // the persisted cursor names an event the feed no longer serves.
    const preFallback = (await new StripeFeedConnector({ baseUrl, pageLimit: 10 }).reconcile(pool))
      .report as StripeFeedReconcileReport;
    expect(preFallback.gaps).toHaveLength(1);
    expect(preFallback.gaps[0].cause).toBe("retention");

    // Chapter 3: the fallback itself. The cursor event is the max-(created, id) of
    // batch1 (one emission second → id tiebreak); the gap's near edge is its stored
    // occurred_at, the far edge is batch2's created — the earliest event still
    // retained. Everything between is PERMANENTLY unreachable, and said so.
    const c2 = new StripeFeedConnector({ baseUrl, pageLimit: 10 });
    const report = await c2.catchUpWithReport(pool);
    expect(report.ingested).toBe(6); // forward progress: all of batch2
    expect(report.gaps).toHaveLength(1);
    const expectedCursor = [...batch1].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id)).at(-1)!;
    expect(report.gaps[0]).toEqual({
      fromEventId: expectedCursor.id,
      fromOccurredAt: new Date(expectedCursor.created * 1000).toISOString(),
      toOccurredAt: new Date(batch2[0].created * 1000).toISOString(),
      cause: "retention",
    });

    // Aftermath: raw holds both batches (nothing ingested was lost to the expiry);
    // the cursor moved into batch2; reconcile balances the books with the aged-out
    // rows counted as the paradigm's normal metabolism, not flagged as anomalies.
    expect((await rawEvents(pool)).size).toBe(14);
    const rec = (await c2.reconcile(pool)).report as StripeFeedReconcileReport;
    expect(rec).toMatchObject({ ledger: 6, raw: 14, missing: [], extra: [], agedOutRaw: 8 });
    expect(rec.gaps).toHaveLength(1); // instance memory carries the catchUp-time gap
  });
});

describe("oracle 5 — 429 resilience against the seeded fault stream", () => {
  it("drains to exactness through injected rate limiting", async () => {
    const mock = createStripeFeedApp({ seed: 42, read429: { seed: 11, rate: 0.3 } });
    mock.feed.emit(40);
    const c = new StripeFeedConnector({
      baseUrl: listen(mock),
      pageLimit: 5,
      backoff: { baseMs: 5, capMs: 25, maxAttempts: 8 },
    });
    expect(await c.catchUp(pool)).toBe(40);
    const raw = await rawEvents(pool);
    expect([...raw.keys()].sort()).toEqual(mock.feed.retained().map((e) => e.id).sort());
  });
});
