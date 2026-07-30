import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
// The REAL mock, in-process — house cross-workspace precedent: backfill.test.ts imports
// mocks/crm the same way. The connector under test may only speak to it over HTTP
// (/values, /metadata); direct `sheets.sheet.*` calls below are the API/script mutation
// path the mock provides FOR TESTS (and deliberately never fires the trigger channel).
import { COL, createRowSource, createSheetsApp, type SheetsApp, type SheetsAppOptions } from "../../mocks/sheets/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { SheetSnapshotConnector } from "../src/connectors/sheet-snapshot.js";
import { canonicalStringify } from "../src/connectors/sheet-canonical.js";

// Task A4 — the sheet-snapshot connector. Two RED→GREEN pairs, named:
//   pair 1 "connector core":        obligations 1–8, 11, 12 (catchUp, diff, canonical
//                                   hash + header mapping, quarantine, rawBody custody)
//   pair 2 "reconcile + resilience": obligations 9, 10 (read-only reconcile, 429 backoff,
//                                   timeout discipline)

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
    const rk = sheets.sheet.metadata()[0].rowKey;
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value: "lost" });
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
