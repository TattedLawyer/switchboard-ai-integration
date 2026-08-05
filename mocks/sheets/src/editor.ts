// The simulated human editor: seeded fault-plan operations applied to the grid.
// Fully deterministic — same seed + same plan + same step count → identical grid,
// journal, and (via onHumanEdit) notification stream.

import { prng } from "@switchboard/mock-core";
import { COL, SHEET_HEADER, createRowSource, editValueSource } from "./seed.js";
import type { Profile } from "@switchboard/mock-core";
import type { EditOp, EditOpType, SheetState } from "./sheet.js";

export const FAULT_PLANS = ["calm", "messy", "bulk", "hostile"] as const;
export type FaultPlanName = (typeof FAULT_PLANS)[number];

// The free-hand garbage a human types. These strings are FORMAT garbage, deliberately
// not manifest content — identity content (names/emails/companies/deals) always comes
// from the manifest universe.
export const FREEHAND_DATES = ["7/30", "July 30", "30-Jul-2026", "tomorrow"] as const;
// "ABC" is deliberately in this list and deliberately unlike the others: it is a
// PERFECTLY SHAPED currency code that is not a currency (#37). Before the ISO-4217
// allowlist, every garbage variant here was shape-invalid, so the sheets lane could not
// exercise — and could not regress — the difference between "not a code" and "not a real
// code". The empty string stays: an empty cell is ABSENT, not garbage, and must pass.
export const GARBAGE_CURRENCIES = ["usd", "US Dollars", "₱", "ABC", ""] as const;

export type HumanEdit = {
  step: number;
  op: string;
  range: string;
  /** Deterministic logical clock (base + step seconds), NOT wall clock: byte-identical
   *  replay is a mock requirement. A real onEdit trigger would stamp wall time; the
   *  connector must treat this value as opaque/derived either way. */
  occurred_at: string;
  rowsChanged: number;
};

export type Editor = {
  /** Apply one human edit step under the given plan. Calls onHumanEdit exactly once
   *  per STEP (not per row) — see trigger.ts for why that is the conservative
   *  coalescing encoding. */
  applyStep(plan: FaultPlanName): HumanEdit;
  applySteps(n: number, plan: FaultPlanName): HumanEdit[];
  steps(): number;
};

// Weighted operation mixes per fault plan. calm = routine bookkeeping only; messy adds
// every single-row garbage class; bulk leans on multi-row pastes; hostile covers the
// full vocabulary AND (see rotation below) guarantees every garbage class on a schedule.
const MIX: Record<FaultPlanName, [EditOpType, number][]> = {
  calm: [["edit_cell", 50], ["append_row", 30], ["duplicate_row", 10], ["delete_row", 10]],
  messy: [
    ["edit_cell", 25], ["append_row", 15], ["insert_row_above", 10], ["delete_row", 10],
    ["insert_blank_row", 10], ["freehand_date", 10], ["garbage_currency", 10],
    ["rename_header", 5], ["duplicate_row", 5],
  ],
  bulk: [["bulk_paste", 40], ["edit_cell", 20], ["append_row", 20], ["insert_row_above", 10], ["delete_row", 10]],
  hostile: [
    ["edit_cell", 20], ["bulk_paste", 10], ["append_row", 10], ["insert_row_above", 10],
    ["delete_row", 10], ["duplicate_row", 10], ["freehand_date", 10], ["garbage_currency", 10],
    ["insert_blank_row", 5], ["rename_header", 5],
  ],
};

// hostile guarantee: every 3rd step is drawn from this rotation instead of the weighted
// mix, so ALL four garbage classes provably appear within 12 steps of any hostile run —
// a bound by construction, not by seed luck (test obligation 3).
const HOSTILE_ROTATION: EditOpType[] = ["freehand_date", "garbage_currency", "rename_header", "insert_blank_row"];

// Human-plausible header drift per column (positions never change — only labels).
const HEADER_VARIANTS: [number, string[]][] = [
  [COL.amount, ["Amount", "Deal Value (PHP)", "Amt"]],
  [COL.status, ["Status", "Stage", "Deal Status"]],
  [COL.closeDate, ["Close Date", "Closing", "Date Closed"]],
];

// Logical clock base for occurred_at (see HumanEdit.occurred_at note).
const CLOCK_BASE_MS = Date.parse("2026-07-01T00:00:00.000Z");

export function createEditor(
  sheet: SheetState,
  opts: { seed: number; profile?: Profile; onHumanEdit?: (e: HumanEdit) => void },
): Editor {
  const rand = prng(opts.seed);
  // Distinct content stream from the sheet's seed stream (offset avoids replaying the
  // exact seed rows) — still fully determined by the editor seed.
  const rowSource = createRowSource(opts.seed + 1_000_003, opts.profile);
  const editValue = editValueSource(rand, opts.profile);
  let steps = 0;
  let hostileSteps = 0;

  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const weighted = (mix: [EditOpType, number][]): EditOpType => {
    const total = mix.reduce((n, [, w]) => n + w, 0);
    let r = rand() * total;
    for (const [op, w] of mix) {
      if ((r -= w) < 0) return op;
    }
    return mix[mix.length - 1][0];
  };
  const pickRowKey = (): string => pick(sheet.metadata()).rowKey;
  const pickPosition = (): number => Math.floor(rand() * (sheet.rowCount() + 1));

  const buildOp = (kind: EditOpType): EditOp => {
    switch (kind) {
      case "edit_cell": {
        // amount/status/date are what humans touch most (brief §2); notes trail
        const r = rand();
        const rowKey = pickRowKey();
        if (r < 0.4) return { type: "edit_cell", rowKey, column: COL.amount, value: editValue.amount() };
        if (r < 0.65) return { type: "edit_cell", rowKey, column: COL.status, value: editValue.status() };
        if (r < 0.85) return { type: "edit_cell", rowKey, column: COL.closeDate, value: editValue.closeDate() };
        return { type: "edit_cell", rowKey, column: COL.notes, value: editValue.notes() };
      }
      case "append_row":
        return { type: "append_row", cells: rowSource.next() };
      case "insert_row_above":
        return { type: "insert_row_above", position: Math.floor(rand() * sheet.rowCount()), cells: rowSource.next() };
      case "delete_row":
        // keep the sheet alive: below 3 rows a "delete" impulse becomes an append
        return sheet.rowCount() < 3
          ? { type: "append_row", cells: rowSource.next() }
          : { type: "delete_row", rowKey: pickRowKey() };
      case "rename_header": {
        const [column, variants] = pick(HEADER_VARIANTS);
        const current = sheet.values().header[column];
        const options = variants.filter((v) => v !== current);
        return { type: "rename_header", column, name: pick(options) };
      }
      case "insert_blank_row":
        return { type: "insert_blank_row", position: pickPosition() };
      case "freehand_date":
        return { type: "freehand_date", rowKey: pickRowKey(), value: pick(FREEHAND_DATES) };
      case "garbage_currency":
        return { type: "garbage_currency", rowKey: pickRowKey(), value: pick(GARBAGE_CURRENCIES) };
      case "bulk_paste": {
        const n = 2 + Math.floor(rand() * 4); // 2–5 rows in one paste
        const position = Math.floor(rand() * (sheet.rowCount() + 1));
        return { type: "bulk_paste", position, rows: Array.from({ length: n }, () => rowSource.next()) };
      }
      case "duplicate_row":
        return { type: "duplicate_row", rowKey: pickRowKey() };
      // PRE-3 (#33): buildable, but deliberately NOT in any fault plan's MIX below.
      //
      // The mock can now permute columns, which is what the register's "no test can
      // exercise a reorder" needed. Putting it into the weighted mixes would be a
      // different and much larger change: every fault plan's output is seeded and dozens
      // of soak/oracle assertions are pinned against those exact sequences, so adding an
      // operation to a MIX re-rolls all of them. That is a spec change about what "a
      // messy human" does, not the small fidelity upgrade the entry asked for, and it
      // would arrive bundled with a mass re-pin that hides whatever else moved.
      //
      // So a reorder is a DELIBERATE operation a test applies (see
      // ingest/test/sheet-oracle.test.ts and mocks/sheets/test/sheet.test.ts), and this
      // arm exists so `EditOpType` stays exhaustive — the compile wall is what will make
      // the next person adding an operation read this note.
      case "move_column": {
        const width = SHEET_HEADER.length;
        const from = Math.floor(rand() * width);
        let to = Math.floor(rand() * width);
        if (to === from) to = (from + 1) % width;
        return { type: "move_column", from, to };
      }
    }
  };

  const applyStep = (plan: FaultPlanName): HumanEdit => {
    const kind =
      plan === "hostile" && hostileSteps % 3 === 0
        ? HOSTILE_ROTATION[(hostileSteps / 3) % HOSTILE_ROTATION.length]
        : weighted(MIX[plan]);
    if (plan === "hostile") hostileSteps++;
    const op = buildOp(kind);
    const applied = sheet.apply(op);
    const edit: HumanEdit = {
      step: ++steps,
      op: op.type,
      range: applied.range,
      occurred_at: new Date(CLOCK_BASE_MS + steps * 1000).toISOString(),
      rowsChanged: applied.rowsChanged,
    };
    // ONE callback per human step, even when the step changed N rows (bulk paste):
    // the conservative coalescing encoding the trigger channel relies on.
    opts.onHumanEdit?.(edit);
    return edit;
  };

  return {
    applyStep,
    applySteps: (n, plan) => Array.from({ length: n }, () => applyStep(plan)),
    steps: () => steps,
  };
}
