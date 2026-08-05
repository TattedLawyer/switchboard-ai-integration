import { describe, expect, it } from "vitest";
import { generateManifest } from "@switchboard/mock-core";
import { COL, SHEET_HEADER } from "../src/seed.js";
import { createSheet, METADATA_CHAR_CAP, type EditOpType } from "../src/sheet.js";

// The manifest universe the sheet content must derive from (master seed 42 — the same
// default every other mock uses).
const manifest = generateManifest(42);
const contactNames = new Set(manifest.crm.contacts.map((c) => c.name));
const contactEmails = new Set(manifest.crm.contacts.map((c) => c.email));
const companyNames = new Set(manifest.crm.companies.map((c) => c.name));
const dealNames = new Set(manifest.crm.deals.map((d) => d.name));
const dealAmounts = new Set(manifest.crm.deals.map((d) => (d.amount_cents / 100).toFixed(2)));
const dealIds = new Set(manifest.crm.deals.map((d) => d.id));

describe("seeded sheet state", () => {
  it("same seed → byte-identical grid and metadata; different seed differs", () => {
    const a = createSheet({ seed: 7 });
    const b = createSheet({ seed: 7 });
    expect(JSON.stringify(a.values())).toBe(JSON.stringify(b.values()));
    expect(JSON.stringify(a.metadata())).toBe(JSON.stringify(b.metadata()));
    const c = createSheet({ seed: 8 });
    expect(JSON.stringify(c.values())).not.toBe(JSON.stringify(a.values()));
  });

  it("every seeded cell derives from the manifest universe (identity resolution can match; hygiene stays green)", () => {
    const grid = createSheet({ seed: 7, rowCount: 20 }).values();
    expect(grid.header).toEqual([...SHEET_HEADER]);
    expect(grid.rows.length).toBe(20);
    for (const row of grid.rows) {
      expect(contactNames.has(row[COL.clientName])).toBe(true);
      expect(contactEmails.has(row[COL.email])).toBe(true);
      expect(companyNames.has(row[COL.company])).toBe(true);
      expect(dealNames.has(row[COL.deal])).toBe(true);
      expect(dealAmounts.has(row[COL.amount])).toBe(true);
      expect(row[COL.currency]).toBe("USD");
      expect(["open", "won", "lost"]).toContain(row[COL.status]);
      expect(row[COL.closeDate]).toMatch(/^2026-07-(0[1-9]|1\d|2[0-8])$/);
      // notes are either empty or a manifest deal reference
      if (row[COL.notes] !== "") {
        const ref = /^ref (DEMO-D-\d{4})$/.exec(row[COL.notes]);
        expect(ref).not.toBeNull();
        expect(dealIds.has(ref![1])).toBe(true);
      }
    }
  });
});

describe("rowKey integrity (developer-metadata semantics)", () => {
  it("insert-above shifts positions but every rowKey still maps to its original content", () => {
    const sheet = createSheet({ seed: 7, rowCount: 5 });
    const before = new Map(
      sheet.metadata().map((m) => [m.rowKey, sheet.rowByKey(m.rowKey)!.cells.join("\u0000")]),
    );
    sheet.apply({ type: "insert_row_above", position: 0, cells: sheet.values().rows[4].slice() });
    const meta = sheet.metadata();
    expect(meta.length).toBe(6);
    // previously-first row moved down one position
    const shifted = meta.find((m) => m.rowKey === [...before.keys()][0]);
    expect(shifted?.rowIndex).toBe(1);
    // every pre-existing rowKey still resolves to its original content
    for (const [key, content] of before) {
      expect(sheet.rowByKey(key)!.cells.join("\u0000")).toBe(content);
    }
  });

  it("delete kills exactly its rowKey; the others survive untouched", () => {
    const sheet = createSheet({ seed: 7, rowCount: 5 });
    const keys = sheet.metadata().map((m) => m.rowKey);
    sheet.apply({ type: "delete_row", rowKey: keys[2] });
    const after = sheet.metadata().map((m) => m.rowKey);
    expect(after).toEqual([keys[0], keys[1], keys[3], keys[4]]);
    expect(sheet.rowByKey(keys[2])).toBeUndefined();
  });

  it("duplicate row copies content but mints a NEW rowKey (metadata-across-duplication: unverified → conservative)", () => {
    const sheet = createSheet({ seed: 7, rowCount: 3 });
    const keys = sheet.metadata().map((m) => m.rowKey);
    sheet.apply({ type: "duplicate_row", rowKey: keys[1] });
    const meta = sheet.metadata();
    expect(meta.length).toBe(4);
    const dupe = meta[2]; // inserted directly below its source
    expect(dupe.rowKey).not.toBe(keys[1]);
    expect(keys).not.toContain(dupe.rowKey);
    expect(sheet.rowByKey(dupe.rowKey)!.cells).toEqual(sheet.rowByKey(keys[1])!.cells);
  });

  it("bulk paste over existing rows keeps their rowKeys; overflow rows get new ones", () => {
    const sheet = createSheet({ seed: 7, rowCount: 3 });
    const keys = sheet.metadata().map((m) => m.rowKey);
    const donor = createSheet({ seed: 9, rowCount: 4 }).values().rows;
    sheet.apply({ type: "bulk_paste", position: 1, rows: donor });
    const meta = sheet.metadata();
    expect(meta.length).toBe(5);
    // rows 1..2 were overwritten in place — same keys, new content
    expect(meta[1].rowKey).toBe(keys[1]);
    expect(meta[2].rowKey).toBe(keys[2]);
    expect(sheet.rowByKey(keys[1])!.cells).toEqual(donor[0]);
    // rows 3..4 are new births
    expect(keys).not.toContain(meta[3].rowKey);
    expect(keys).not.toContain(meta[4].rowKey);
  });
});

describe("every editor operation is observable in grid + journal", () => {
  it("applies each op type and journals it with a range", () => {
    const sheet = createSheet({ seed: 7, rowCount: 4 });
    const k = () => sheet.metadata().map((m) => m.rowKey);
    const row = sheet.values().rows[0].slice();

    sheet.apply({ type: "edit_cell", rowKey: k()[0], column: COL.status, value: "won" });
    expect(sheet.rowByKey(k()[0])!.cells[COL.status]).toBe("won");

    sheet.apply({ type: "append_row", cells: row });
    expect(sheet.rowCount()).toBe(5);

    sheet.apply({ type: "insert_row_above", position: 2, cells: row });
    expect(sheet.rowCount()).toBe(6);

    sheet.apply({ type: "delete_row", rowKey: k()[5] });
    expect(sheet.rowCount()).toBe(5);

    sheet.apply({ type: "rename_header", column: COL.amount, name: "Deal Value (PHP)" });
    expect(sheet.values().header[COL.amount]).toBe("Deal Value (PHP)");

    sheet.apply({ type: "insert_blank_row", position: 1 });
    expect(sheet.values().rows[1]).toEqual(Array(9).fill(""));

    sheet.apply({ type: "freehand_date", rowKey: k()[0], value: "7/30" });
    expect(sheet.rowByKey(k()[0])!.cells[COL.closeDate]).toBe("7/30");

    sheet.apply({ type: "garbage_currency", rowKey: k()[0], value: "₱" });
    expect(sheet.rowByKey(k()[0])!.cells[COL.currency]).toBe("₱");

    sheet.apply({ type: "bulk_paste", position: 0, rows: [row, row] });
    sheet.apply({ type: "duplicate_row", rowKey: k()[0] });

    const ops = sheet.journal().map((j) => j.op);
    const expected: EditOpType[] = [
      "edit_cell", "append_row", "insert_row_above", "delete_row", "rename_header",
      "insert_blank_row", "freehand_date", "garbage_currency", "bulk_paste", "duplicate_row",
    ];
    expect(ops).toEqual(expected);
    for (const j of sheet.journal()) {
      expect(j.range).toMatch(/^[A-I]\d+(:[A-I]?\d+)?$/);
      expect(j.step).toBeGreaterThan(0);
    }
  });

  it("journal is append-only and rowsChanged reflects the op width", () => {
    const sheet = createSheet({ seed: 7, rowCount: 3 });
    const row = sheet.values().rows[0].slice();
    sheet.apply({ type: "bulk_paste", position: 0, rows: [row, row, row] });
    sheet.apply({ type: "rename_header", column: COL.status, name: "Stage" });
    const j = sheet.journal();
    expect(j.length).toBe(2);
    expect(j[0].rowsChanged).toBe(3);
    expect(j[1].rowsChanged).toBe(0);
    expect(j.map((e) => e.step)).toEqual([1, 2]);
  });
});

describe("bounded metadata (documented 30,000-char cap; ceiling behavior unverified → conservative refusal)", () => {
  it("refuses to mint row keys past the cap", () => {
    const sheet = createSheet({ seed: 7, rowCount: 1 });
    const row = sheet.values().rows[0].slice();
    expect(() => {
      // rk-NNNN keys are ≥7 chars: the cap must trip before 5,000 appends
      for (let i = 0; i < 5_000; i++) sheet.apply({ type: "append_row", cells: row });
    }).toThrowError(/metadata/i);
    // accounting is over LIVE keys: chars ≈ cap, never past it
    const liveChars = sheet.metadata().reduce((n, m) => n + m.rowKey.length, 0);
    expect(liveChars).toBeLessThanOrEqual(METADATA_CHAR_CAP);
    expect(liveChars).toBeGreaterThan(METADATA_CHAR_CAP - 20);
  });
});

// ── PRE-3 / #33 — the mock can permute column POSITIONS, not just header labels ────────
//
// The register says "column reorder is UNPROVEN against a real sheet", and the triage
// found the supporting sentence ("no test can exercise a reorder") false as stated: it is
// a property of the mock we wrote — `seed.ts` says "Header renames change the header TEXT
// only", `editor.ts` says "positions never change — only labels" — not a property of
// reality, where a human drags a column and everything moves.
//
// This does NOT retire the entry: proving the connector against our own mock is a weaker
// oracle than a real spreadsheet, and the headline claim stays true. It converts
// "expected-safe by construction" into "expected-safe by construction AND exercised".
describe("PRE-3 #33 — move_column permutes a column and its cells together", () => {
  it("moves the header label and every row's cell as one unit", () => {
    const sheet = createSheet({ seed: 11, rowCount: 4 });
    const before = sheet.values();
    const label = before.header[COL.currency];
    const cellsBefore = before.rows.map((r) => r[COL.currency]);

    sheet.apply({ type: "move_column", from: COL.currency, to: 0 });

    const after = sheet.values();
    expect(after.header[0]).toBe(label);
    expect(after.rows.map((r) => r[0])).toEqual(cellsBefore);
    // Nothing was lost or duplicated: same width, same multiset of labels.
    expect(after.header).toHaveLength(before.header.length);
    expect([...after.header].sort()).toEqual([...before.header].sort());
    // Every row keeps its full content, only reordered.
    after.rows.forEach((row, i) => {
      expect([...row].sort()).toEqual([...before.rows[i]].sort());
    });
  });

  it("preserves row identity — a reorder is a COLUMN operation and must not touch row keys", () => {
    const sheet = createSheet({ seed: 12, rowCount: 5 });
    const keysBefore = sheet.metadata().map((m) => m.rowKey);
    sheet.apply({ type: "move_column", from: COL.notes, to: COL.clientName });
    expect(sheet.metadata().map((m) => m.rowKey)).toEqual(keysBefore);
  });

  it("journals the move with both positions and the column's label", () => {
    const sheet = createSheet({ seed: 13, rowCount: 3 });
    sheet.apply({ type: "move_column", from: COL.amount, to: COL.status });
    const entry = sheet.journal().at(-1)!;
    expect(entry.op).toBe("move_column");
    expect(entry.detail).toMatchObject({ from: COL.amount, to: COL.status, column: "Amount" });
    expect(entry.rowsChanged).toBe(3);
  });

  it("refuses an out-of-range move rather than silently corrupting the grid", () => {
    const sheet = createSheet({ seed: 14, rowCount: 2 });
    expect(() => sheet.apply({ type: "move_column", from: 0, to: 99 })).toThrow(/move_column out of range/);
    expect(() => sheet.apply({ type: "move_column", from: -1, to: 0 })).toThrow(/move_column out of range/);
  });
});
