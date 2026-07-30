import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
// The REAL mock, in-process — house cross-workspace precedent: backfill.test.ts imports
// mocks/crm the same way. The connector under test may only speak to it over HTTP
// (GET /snapshot, the combined atomic read); direct `sheets.sheet.*` calls below are the
// API/script mutation path the mock provides FOR TESTS (and never fires the trigger).
import { COL, createRowSource, createSheetsApp, type SheetsApp, type SheetsAppOptions } from "../../mocks/sheets/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { ingestEvent } from "../src/ingest-event.js";
import { SheetSnapshotConnector } from "../src/connectors/sheet-snapshot.js";
import { canonicalStringify } from "../src/connectors/sheet-canonical.js";
import type { SourceEvent } from "../src/event-schema.js";

// Task A4 — the sheet-snapshot connector. Two RED→GREEN pairs, named:
//   pair 1 "connector core":        obligations 1–8, 11, 12 (catchUp, diff, canonical
//                                   hash + header mapping, quarantine, rawBody custody)
//   pair 2 "reconcile + resilience": obligations 9, 10 (read-only reconcile, 429 backoff,
//                                   timeout discipline)
// A4.1 (review C1, amended decision 2): the supersession-counter pair at the bottom —
//   a revert to previously-seen content must LAND, with n=0 ids unsuffixed.

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let srv: Server | undefined;

// Fresh DB per test: the sheet mock is seeded, so identical seeds mint identical rowKeys
// and content — a shared DB would carry earlier tests' content-addressed event_ids and
// every later first-catchUp would silently dedupe against them.
beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  await cleanup();
});

function startSheet(opts?: Partial<SheetsAppOptions>): { sheets: SheetsApp; baseUrl: string } {
  const sheets = createSheetsApp({ seed: 7, rowCount: 6, ...opts });
  srv = sheets.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  return { sheets, baseUrl: `http://127.0.0.1:${port}` };
}

function connectorFor(baseUrl: string): SheetSnapshotConnector {
  // Small backoff numbers keep the 429 tests fast; semantics are unchanged.
  return new SheetSnapshotConnector({
    baseUrl,
    timeoutMs: 3000,
    backoff: { baseMs: 5, capMs: 50, maxAttempts: 6 },
  });
}

async function rawSheetEvents(db: pg.Pool): Promise<{ event_id: string; event_type: string; payload: Record<string, unknown>; raw_body: string | null }[]> {
  const res = await db.query(
    "select event_id, event_type, payload, raw_body from raw.raw_events where source = 'sheets' order by id",
  );
  return res.rows;
}

describe("A4 pair 1 — connector core: idempotency manufactured from content", () => {
  it("obligation 1: first catchUp ingests every data row; a second identical catchUp ingests zero — stateless idempotency by construction", async () => {
    const { baseUrl } = startSheet();
    const c = connectorFor(baseUrl);

    const first = await c.catchUp(pool);
    expect(first).toBe(6);

    const rows = await rawSheetEvents(pool);
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.event_type).toBe("sheet.row_upserted");
      const data = r.payload.data as Record<string, unknown>;
      expect(r.event_id).toBe(`sheet-${data.row_key}-${data.content_hash}`);
      // occurred_at is OUR detection clock, and the payload says so honestly.
      expect(data.occurred_at_derived).toBe(true);
    }

    const second = await c.catchUp(pool);
    expect(second).toBe(0);
    expect(await rawSheetEvents(pool)).toHaveLength(6);
  });

  it("obligation 2: one cell edit → exactly one new upsert with a new content hash; untouched rows produce nothing", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);
    const before = await rawSheetEvents(pool);

    const rk = sheets.sheet.metadata()[2].rowKey;
    const oldHash = (before.find((r) => (r.payload.data as Record<string, unknown>).row_key === rk)!
      .payload.data as Record<string, unknown>).content_hash;
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: "won" });

    expect(await c.catchUp(pool)).toBe(1);
    const after = await rawSheetEvents(pool);
    expect(after).toHaveLength(7);
    const fresh = after[after.length - 1].payload.data as Record<string, unknown>;
    expect(fresh.row_key).toBe(rk);
    expect(fresh.status).toBe("won");
    expect(fresh.content_hash).not.toBe(oldHash);
  });

  it("obligation 3 (load-bearing): insert-above shifts every position — ZERO spurious events for the shifted rows", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);
    const idsBefore = new Set((await rawSheetEvents(pool)).map((r) => r.event_id));

    // Insert at the very top: every existing row's position shifts by one. rowKey
    // stability is the paradigm — a position-keyed connector would re-emit all six.
    sheets.sheet.apply({ type: "insert_row_above", position: 0, cells: createRowSource(999).next() });

    expect(await c.catchUp(pool)).toBe(1);
    const after = await rawSheetEvents(pool);
    expect(after).toHaveLength(7);
    const newIds = after.map((r) => r.event_id).filter((id) => !idsBefore.has(id));
    expect(newIds).toHaveLength(1);
    const newRow = after.find((r) => r.event_id === newIds[0])!.payload.data as Record<string, unknown>;
    expect(newRow.row_key).toBe(sheets.sheet.metadata()[0].rowKey);
  });

  it("obligation 4: delete → one sheet.row_deleted; re-adding the same content births a new rowKey → fresh upsert id, not a duplicate", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const rk = sheets.sheet.metadata()[1].rowKey;
    const cells = sheets.sheet.rowByKey(rk)!.cells;
    const originalUpsertId = (await rawSheetEvents(pool)).find(
      (r) => (r.payload.data as Record<string, unknown>).row_key === rk,
    )!.event_id;

    sheets.sheet.apply({ type: "delete_row", rowKey: rk });
    expect(await c.catchUp(pool)).toBe(1);
    let rows = await rawSheetEvents(pool);
    const del = rows[rows.length - 1];
    expect(del.event_type).toBe("sheet.row_deleted");
    expect(del.event_id.startsWith(`sheet-${rk}-del-`)).toBe(true);
    expect((del.payload.data as Record<string, unknown>).row_key).toBe(rk);

    // Re-add byte-identical content: metadata died with the row, so this is a NEW row.
    sheets.sheet.apply({ type: "append_row", cells });
    expect(await c.catchUp(pool)).toBe(1);
    rows = await rawSheetEvents(pool);
    const readd = rows[rows.length - 1];
    expect(readd.event_type).toBe("sheet.row_upserted");
    expect(readd.event_id).not.toBe(originalUpsertId);
    expect((readd.payload.data as Record<string, unknown>).row_key).not.toBe(rk);
  });

  it("obligation 5: a human copy-paste duplicate (new rowKey, same content) is its own upsert — different rowKey ⇒ different id, same content hash", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const rk = sheets.sheet.metadata()[0].rowKey;
    const sourceEvent = (await rawSheetEvents(pool)).find(
      (r) => (r.payload.data as Record<string, unknown>).row_key === rk,
    )!;
    sheets.sheet.apply({ type: "duplicate_row", rowKey: rk });

    expect(await c.catchUp(pool)).toBe(1);
    const rows = await rawSheetEvents(pool);
    const copy = rows[rows.length - 1].payload.data as Record<string, unknown>;
    expect(copy.row_key).not.toBe(rk);
    expect(copy.content_hash).toBe((sourceEvent.payload.data as Record<string, unknown>).content_hash);
    expect(rows[rows.length - 1].event_id).not.toBe(sourceEvent.event_id);
  });

  it("obligation 6: messy rows quarantine per-row with reasons naming the field; clean rows in the same batch ingest — never batch-fatal", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);

    const [rkA, rkB] = [sheets.sheet.metadata()[0].rowKey, sheets.sheet.metadata()[1].rowKey];
    sheets.sheet.apply({ type: "garbage_currency", rowKey: rkA, value: "usd" });
    sheets.sheet.apply({ type: "edit_cell", rowKey: rkB, column: COL.amount, value: "US$ 500" });

    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(4);
    expect(report.quarantined).toBe(2);

    const rows = await rawSheetEvents(pool);
    expect(rows).toHaveLength(4);
    const rawKeys = rows.map((r) => (r.payload.data as Record<string, unknown>).row_key);
    expect(rawKeys).not.toContain(rkA);
    expect(rawKeys).not.toContain(rkB);

    const q = await pool.query(
      "select reason, payload->'data'->>'row_key' as row_key from ingest.quarantine order by id",
    );
    expect(q.rowCount).toBe(2);
    const reasonFor = (rk: string) => q.rows.find((r: { row_key: string }) => r.row_key === rk)!.reason as string;
    expect(reasonFor(rkA)).toContain("currency");
    expect(reasonFor(rkB)).toContain("amount_cents");
  });

  it("obligation 7: header renames WITHIN the alias map keep fields mapped and produce zero spurious events — the hash is over canonical fields, not raw labels", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    sheets.sheet.apply({ type: "rename_header", column: COL.amount, name: "Amt" });
    sheets.sheet.apply({ type: "rename_header", column: COL.status, name: "Stage" });
    // If the hash covered raw header labels, every row's id would rewrite here.
    expect(await c.catchUp(pool)).toBe(0);

    // The renamed columns still MAP: an amount edit still parses into amount_cents.
    const rk = sheets.sheet.metadata()[3].rowKey;
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.amount, value: "1500.00" });
    expect(await c.catchUp(pool)).toBe(1);
    const rows = await rawSheetEvents(pool);
    const fresh = rows[rows.length - 1].payload.data as Record<string, unknown>;
    expect(fresh.row_key).toBe(rk);
    expect(fresh.amount_cents).toBe(150000);
  });

  it("obligation 8a: a rename OUTSIDE the alias map degrades that field to absent — events still flow and the degradation is noted", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    sheets.sheet.apply({ type: "rename_header", column: COL.notes, name: "Scribbles" });
    const report = await c.catchUpWithReport(pool);
    expect(report.degradations.join("\n")).toContain("notes");

    // Rows that carried notes genuinely changed shape (the mapped view lost a field) and
    // re-upsert without it; rows with empty notes are untouched. Nothing quarantines.
    const rowsWithNotes = sheets.sheet.values().rows.filter((cells) => cells[COL.notes] !== "").length;
    expect(report.ingested).toBe(rowsWithNotes);
    expect(report.quarantined).toBe(0);
    const rows = await rawSheetEvents(pool);
    for (const r of rows.slice(6)) {
      expect(r.payload.data as Record<string, unknown>).not.toHaveProperty("notes");
    }

    // The pipe is still alive after the degradation: a later edit flows normally.
    // (status is a passthrough string with no contract rule; the value just has to be
    // one the seeded row cannot already hold, or the content hash would not change.)
    const rk = sheets.sheet.metadata()[0].rowKey;
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: "renegotiating" });
    expect(await c.catchUp(pool)).toBe(1);
  });

  it("obligation 8b: a KEY column renamed out of the map fails catchUp loudly, naming the headers it saw — never guess", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    sheets.sheet.apply({ type: "rename_header", column: COL.email, name: "Contact Info" });

    await expect(c.catchUp(pool)).rejects.toThrow(/email/);
    await expect(c.catchUp(pool)).rejects.toThrow(/Contact Info/);
    // Loud means NOTHING was ingested on the failed run.
    expect(await rawSheetEvents(pool)).toHaveLength(0);
  });

  it("nudge() is a coalescing early catchUp — two concurrent nudges share ONE run (single-flight); lossiness of the channel that calls it is irrelevant to correctness", async () => {
    const { baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    const [a, b] = await Promise.all([c.nudge(pool), c.nudge(pool)]);
    // Coalesced: both callers observe the SAME run's count. Two separate runs would
    // return [6, 0] — the second would find everything already ingested.
    expect(a).toBe(6);
    expect(b).toBe(6);
    expect(await rawSheetEvents(pool)).toHaveLength(6);
  });

  it("obligation 12: rawBody custody — ingested sheet events carry the connector's canonical JSON in raw.raw_events.raw_body", async () => {
    const { baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const rows = await rawSheetEvents(pool);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.raw_body).not.toBeNull();
      // The connector is the event's origin: its canonical bytes ARE the wire form, so
      // re-canonicalizing the stored payload must reproduce raw_body byte-for-byte.
      expect(r.raw_body).toBe(canonicalStringify(r.payload));
      expect(JSON.parse(r.raw_body!).event_id).toBe(r.event_id);
    }
  });
});

describe("A4 pair 2 — reconcile + resilience", () => {
  it("obligation 9a: after a clean catchUp, reconcile reports clean — and reconcile NEVER writes", async () => {
    const { baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const result = await c.reconcile(pool);
    expect(result.skipped).toBeUndefined();
    expect(result.integrity.ok).toBe(true);
    expect(result.report).toEqual({
      ledger: 6,
      raw: 6,
      missing: [],
      stale: [],
      extra: [],
      rawDuplicates: 0,
    });
    // Read-only is structural, not incidental: raw is untouched by the comparison.
    expect(await rawSheetEvents(pool)).toHaveLength(6);
  });

  it("obligation 9b: direct sheet mutation WITHOUT a catchUp — the report names the drifted row_keys by category", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const staleRk = sheets.sheet.metadata()[0].rowKey;
    const extraRk = sheets.sheet.metadata()[1].rowKey;
    sheets.sheet.apply({ type: "edit_cell", rowKey: staleRk, column: COL.status, value: "renegotiating" });
    sheets.sheet.apply({ type: "delete_row", rowKey: extraRk });
    sheets.sheet.apply({ type: "append_row", cells: createRowSource(4242).next() });
    const missingRk = sheets.sheet.metadata()[sheets.sheet.rowCount() - 1].rowKey;

    const result = await c.reconcile(pool);
    expect(result.integrity.ok).toBe(true);
    expect(result.report!.stale).toEqual([staleRk]);
    expect(result.report!.extra).toEqual([extraRk]);
    expect(result.report!.missing).toEqual([missingRk]);
    // Still read-only: detecting drift must not repair it (that is catchUp's job).
    expect(await rawSheetEvents(pool)).toHaveLength(6);
  });

  it("obligation 9c: a 429 storm mid-reconcile is an integrity failure with NO report — a diff against an unreadable sheet would be confident and meaningless", async () => {
    const { baseUrl } = startSheet({ read429: { seed: 11, rate: 1 } });
    const c = connectorFor(baseUrl);

    const result = await c.reconcile(pool);
    expect(result.integrity.ok).toBe(false);
    expect(result.integrity.detail).toMatch(/429/);
    expect(result.report).toBeUndefined();
  });

  it("obligation 10a: catchUp succeeds under a seeded 429 fraction — bounded truncated-exponential retries actually observed", async () => {
    // Seed chosen from the mock's documented deterministic draw-per-request stream:
    // mulberry32(7) opens 1,1,0 at rate 0.5 → the single combined /snapshot read (I4)
    // answers 429 twice, then serves. Deterministic, so "retries observed" cannot flake.
    const { baseUrl } = startSheet({ read429: { seed: 7, rate: 0.5 } });
    const c = connectorFor(baseUrl);

    expect(await c.catchUp(pool)).toBe(6);
    // The quota hits were real and the connector retried through them (bounded).
    expect(c.stats().retried429).toBe(2);
    expect(c.stats().requests).toBe(3);
  });

  it("obligation 10b: a black-holed endpoint is a bounded LOUD failure via AbortSignal.timeout — never a wedge", async () => {
    const blackHole = express();
    blackHole.get("/snapshot", () => {
      /* accept the request, answer never — the wedge shape under test */
    });
    const bhSrv: Server = blackHole.listen(0);
    const port = (bhSrv.address() as { port: number }).port;
    try {
      const c = new SheetSnapshotConnector({
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 200,
        backoff: { baseMs: 5, capMs: 50, maxAttempts: 6 },
      });
      const started = Date.now();
      await expect(c.catchUp(pool)).rejects.toThrow(/timed out after 200ms/);
      // Bounded: one timeout, no retry ladder for black holes — a stateless connector
      // loses nothing by failing the cycle and re-diffing fresh next time.
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await rawSheetEvents(pool)).toHaveLength(0);
    } finally {
      bhSrv.close();
    }
  });
});

// Cold review I4 — the two-GET race is structurally unreachable with the in-process
// single-threaded mock, so the fix is pinned STRUCTURALLY instead: the connector takes
// exactly one combined snapshot request per cycle (values + metadata from one grid
// state), and the old /values + /metadata pairing path is gone from its diff surface.
// With one read there is no intra-snapshot window in which a count-preserving mutation
// could pair rowKey X with row Y's content and land fabricated states in raw.
describe("cold review I4 — atomic snapshot: one combined read per cycle", () => {
  it("catchUp and reconcile each issue exactly ONE request — GET /snapshot — and never consult /values or /metadata for diffing", async () => {
    const sheets = createSheetsApp({ seed: 7, rowCount: 6 });
    // Request journal wrapped AROUND the real mock: the pin must see every path the
    // connector touches, including any it is no longer supposed to touch.
    const journal: string[] = [];
    const wrapper = express();
    wrapper.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
      journal.push(req.path);
      next();
    });
    wrapper.use(sheets.app);
    srv = wrapper.listen(0);
    const port = (srv.address() as { port: number }).port;
    const c = connectorFor(`http://127.0.0.1:${port}`);

    expect(await c.catchUp(pool)).toBe(6);
    expect(journal).toEqual(["/snapshot"]);
    expect(c.stats().requests).toBe(1);

    const rec = await c.reconcile(pool);
    expect(rec.integrity.ok).toBe(true);
    expect(journal).toEqual(["/snapshot", "/snapshot"]);
    expect(journal).not.toContain("/values");
    expect(journal).not.toContain("/metadata");
  });
});

// A4.1 — review adjudication A (Critical C1), binding decision 2 AMENDED: when the diff
// says a row CHANGED and the content-addressed id already exists in raw for that
// (rowKey, contentHash), the id gains `-r<n>` where n = the count of prior ingested
// events for that pair, derived STATELESSLY from raw at diff time. n=0 stays UNSUFFIXED,
// so every pre-A4.1 id (and every pair-1 test) is untouched.
describe("A4.1 — supersession counter: a human's undo must land", () => {
  const dataOf = (r: { payload: Record<string, unknown> }) => r.payload.data as Record<string, unknown>;
  const eventsForRow = async (db: pg.Pool, rk: string) =>
    (await rawSheetEvents(db)).filter((r) => dataOf(r).row_key === rk);

  it("F1a (the test the fix exists for): A→B→A — the revert LANDS as a third event with -r1, raw latest-state = A, reconcile CLEAN", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const rk = sheets.sheet.metadata()[0].rowKey;
    const statusA = sheets.sheet.rowByKey(rk)!.cells[COL.status];
    const hashA = dataOf((await eventsForRow(pool, rk))[0]).content_hash as string;

    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: "renegotiating" }); // → B
    expect(await c.catchUp(pool)).toBe(1);
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: statusA }); // undo → A

    // Pre-A4.1 this was 0 forever: the manufactured id collided with history, the door
    // said duplicate, and the pipeline served B while the sheet said A.
    expect(await c.catchUp(pool)).toBe(1);

    const rkEvents = await eventsForRow(pool, rk);
    expect(rkEvents).toHaveLength(3);
    const revert = rkEvents[2];
    expect(revert.event_id).toBe(`sheet-${rk}-${hashA}-r1`);
    expect(dataOf(revert).content_hash).toBe(hashA); // payload hash stays canonical — only the id is salted
    expect(dataOf(revert).status).toBe(statusA); // raw latest-state = A again

    // The oracle can converge: reconcile is clean, not permanently `stale`.
    const rec = await c.reconcile(pool);
    expect(rec.integrity.ok).toBe(true);
    expect(rec.report!.stale).toEqual([]);
    expect(rec.report!.missing).toEqual([]);
    expect(rec.report!.extra).toEqual([]);
  });

  it("F1b: idempotency survives — the counter fires only on diff-change; an unchanged sheet still catches up to zero, with no runaway -r suffixes", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const rk = sheets.sheet.metadata()[1].rowKey;
    const statusA = sheets.sheet.rowByKey(rk)!.cells[COL.status];
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: "renegotiating" });
    expect(await c.catchUp(pool)).toBe(1);
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: statusA });
    expect(await c.catchUp(pool)).toBe(1); // the revert lands ...

    // ... and then the sheet is unchanged: a counter keyed on id-existence instead of
    // diff-change would mint -r2, -r3, ... here, one per cycle. It must not.
    expect(await c.catchUp(pool)).toBe(0);
    expect(await c.catchUp(pool)).toBe(0);
    expect(await eventsForRow(pool, rk)).toHaveLength(3);
  });

  it("F1c: A→B→A→B→A soak — every swing lands with an incrementing n, reconcile clean after each catchUp", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const rk = sheets.sheet.metadata()[2].rowKey;
    const statusA = sheets.sheet.rowByKey(rk)!.cells[COL.status];
    const statusB = "renegotiating";
    const hashA = dataOf((await eventsForRow(pool, rk))[0]).content_hash as string;

    const swing = async (value: string) => {
      sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value });
      expect(await c.catchUp(pool)).toBe(1);
      const rec = await c.reconcile(pool);
      expect(rec.report!.stale).toEqual([]);
      expect(rec.report!.missing).toEqual([]);
      expect(rec.report!.extra).toEqual([]);
    };
    await swing(statusB); // B, first sighting → bare id
    await swing(statusA); // A again → -r1
    await swing(statusB); // B again → -r1
    await swing(statusA); // A a third time → -r2

    const ids = (await eventsForRow(pool, rk)).map((r) => r.event_id);
    expect(ids).toHaveLength(5);
    const hashB = dataOf((await eventsForRow(pool, rk))[1]).content_hash as string;
    expect(ids[1]).toBe(`sheet-${rk}-${hashB}`);
    expect(ids[2]).toBe(`sheet-${rk}-${hashA}-r1`);
    expect(ids[3]).toBe(`sheet-${rk}-${hashB}-r1`);
    expect(ids[4]).toBe(`sheet-${rk}-${hashA}-r2`);
  });

  it("F1d: crash-window self-healing — a cycle that died right after writing the -r1 event costs nothing: next catchUp emits zero, and the counter keeps counting on top of the orphan", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = connectorFor(baseUrl);
    await c.catchUp(pool);

    const rk = sheets.sheet.metadata()[3].rowKey;
    const statusA = sheets.sheet.rowByKey(rk)!.cells[COL.status];
    const first = (await eventsForRow(pool, rk))[0];
    const hashA = dataOf(first).content_hash as string;

    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: "renegotiating" }); // → B
    expect(await c.catchUp(pool)).toBe(1);
    const hashB = dataOf((await eventsForRow(pool, rk))[1]).content_hash as string;

    // Revert the sheet to A, then simulate the interrupted cycle: the -r1 upsert reached
    // raw and the process died before anything else. (Hand-ingesting exactly what that
    // cycle would have written IS the crash state — raw is the only state there is.)
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: statusA });
    const orphan = {
      ...(first.payload as SourceEvent),
      event_id: `sheet-${rk}-${hashA}-r1`,
      occurred_at: new Date().toISOString(),
    };
    expect(await ingestEvent(pool, "sheets", orphan, { rawBody: canonicalStringify(orphan) })).toBe("inserted");

    // Self-healing: raw latest already equals the sheet — nothing new for that row.
    expect(await c.catchUp(pool)).toBe(0);
    expect(await eventsForRow(pool, rk)).toHaveLength(3);

    // And the mechanism still counts THROUGH the orphan: the next swing back to B is a
    // second sighting of B, so it must land as -r1 (pre-A4.1: duplicate, lost forever).
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: "renegotiating" });
    expect(await c.catchUp(pool)).toBe(1);
    const ids = (await eventsForRow(pool, rk)).map((r) => r.event_id);
    expect(ids[3]).toBe(`sheet-${rk}-${hashB}-r1`);
  });
});
