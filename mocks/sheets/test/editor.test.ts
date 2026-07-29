import { describe, expect, it } from "vitest";
import { generateManifest } from "@switchboard/mock-core";
import { COL } from "../src/seed.js";
import { createSheet } from "../src/sheet.js";
import {
  createEditor, FAULT_PLANS, FREEHAND_DATES, GARBAGE_CURRENCIES,
  type FaultPlanName, type HumanEdit,
} from "../src/editor.js";

const manifest = generateManifest(42);
const contactEmails = new Set(manifest.crm.contacts.map((c) => c.email));

function run(seed: number, plan: FaultPlanName, steps: number) {
  const sheet = createSheet({ seed });
  const edits: HumanEdit[] = [];
  const editor = createEditor(sheet, { seed, onHumanEdit: (e) => edits.push(e) });
  editor.applySteps(steps, plan);
  return { sheet, editor, edits };
}

describe("simulated human determinism", () => {
  it("same seed + plan + steps → byte-identical grid, journal, and edit stream", () => {
    for (const plan of FAULT_PLANS) {
      const a = run(7, plan, 30);
      const b = run(7, plan, 30);
      expect(JSON.stringify(a.sheet.values())).toBe(JSON.stringify(b.sheet.values()));
      expect(JSON.stringify(a.sheet.journal())).toBe(JSON.stringify(b.sheet.journal()));
      expect(JSON.stringify(a.edits)).toBe(JSON.stringify(b.edits));
    }
  });

  it("different seeds diverge under the same plan", () => {
    const a = run(7, "messy", 30);
    const b = run(8, "messy", 30);
    expect(JSON.stringify(a.sheet.journal())).not.toBe(JSON.stringify(b.sheet.journal()));
  });

  it("occurred_at is a deterministic logical clock, strictly increasing", () => {
    const { edits } = run(7, "calm", 10);
    const times = edits.map((e) => Date.parse(e.occurred_at));
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    expect(JSON.stringify(run(7, "calm", 10).edits.map((e) => e.occurred_at)))
      .toBe(JSON.stringify(edits.map((e) => e.occurred_at)));
  });

  it("emits exactly one human-edit event per step (the per-step grain the trigger consumes)", () => {
    const { edits, editor } = run(7, "bulk", 25);
    expect(edits.length).toBe(25);
    expect(editor.steps()).toBe(25);
  });
});

describe("fault-plan effects", () => {
  it("hostile produces every garbage class within a bounded step count (12 steps)", () => {
    const { sheet } = run(7, "hostile", 12);
    const ops = new Set(sheet.journal().map((j) => j.op));
    expect(ops.has("freehand_date")).toBe(true);
    expect(ops.has("garbage_currency")).toBe(true);
    expect(ops.has("rename_header")).toBe(true);
    expect(ops.has("insert_blank_row")).toBe(true);
    // and the bound holds for other seeds too — the rotation guarantees it, not luck
    for (const seed of [1, 99, 2026]) {
      const r = run(seed, "hostile", 12);
      const o = new Set(r.sheet.journal().map((j) => j.op));
      expect(o.has("freehand_date") && o.has("garbage_currency") && o.has("rename_header") && o.has("insert_blank_row")).toBe(true);
    }
  });

  it("a long hostile run exercises the full operation vocabulary", () => {
    const { sheet } = run(7, "hostile", 120);
    const ops = new Set(sheet.journal().map((j) => j.op));
    for (const op of [
      "edit_cell", "append_row", "insert_row_above", "delete_row", "rename_header",
      "insert_blank_row", "freehand_date", "garbage_currency", "bulk_paste", "duplicate_row",
    ]) expect(ops.has(op as never), `missing op ${op}`).toBe(true);
  });

  it("garbage values come from the documented free-hand sets and land in the grid", () => {
    const { sheet } = run(7, "hostile", 40);
    const rows = sheet.values().rows;
    const dates = rows.map((r) => r[COL.closeDate]);
    const currencies = rows.map((r) => r[COL.currency]);
    expect(dates.some((d) => (FREEHAND_DATES as readonly string[]).includes(d))).toBe(true);
    expect(currencies.some((c) => (GARBAGE_CURRENCIES as readonly string[]).includes(c))).toBe(true);
    for (const d of dates) {
      expect([...FREEHAND_DATES, ""].includes(d) || /^2026-07-\d{2}$/.test(d)).toBe(true);
    }
  });

  it("bulk plan actually pastes in bulk: some steps change multiple rows", () => {
    const { sheet } = run(7, "bulk", 30);
    const bulk = sheet.journal().filter((j) => j.op === "bulk_paste");
    expect(bulk.length).toBeGreaterThan(0);
    expect(bulk.some((j) => j.rowsChanged >= 2)).toBe(true);
  });

  it("calm plan stays calm: no garbage classes, no header renames", () => {
    const { sheet } = run(7, "calm", 60);
    const ops = new Set(sheet.journal().map((j) => j.op));
    expect(ops.has("freehand_date")).toBe(false);
    expect(ops.has("garbage_currency")).toBe(false);
    expect(ops.has("rename_header")).toBe(false);
  });

  it("identity content stays manifest-derived even after a hostile run", () => {
    const { sheet } = run(7, "hostile", 80);
    for (const row of sheet.values().rows) {
      // blank rows are legal; any non-empty email must belong to the manifest universe
      if (row[COL.email] !== "") expect(contactEmails.has(row[COL.email])).toBe(true);
    }
  });
});
