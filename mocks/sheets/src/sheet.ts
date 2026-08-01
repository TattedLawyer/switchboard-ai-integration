// Mutable grid state for the mock Sheets source.
//
// rowKey models Google's row-attached developer metadata (plan §2, documented): assigned
// at row birth, follows its row through insertions/moves, dies with the row.
// The row set of this grid is the paradigm's reconciliation truth — the A5 oracle
// compares these rows against pipeline output exactly.

import { COL, createRowSource, SHEET_HEADER } from "./seed.js";
import type { Profile } from "@switchboard/mock-core";

export type SheetRow = { rowKey: string; cells: string[] };
export type Grid = { header: string[]; rows: string[][] };
export type RowKeyMapEntry = { rowKey: string; rowIndex: number };
/** The combined atomic read: grid values AND row-attached metadata from ONE state. */
export type SheetSnapshot = Grid & { metadata: RowKeyMapEntry[] };

export type EditOp =
  | { type: "edit_cell"; rowKey: string; column: number; value: string }
  | { type: "append_row"; cells: string[] }
  | { type: "insert_row_above"; position: number; cells: string[] }
  | { type: "delete_row"; rowKey: string }
  | { type: "rename_header"; column: number; name: string }
  | { type: "insert_blank_row"; position: number }
  | { type: "freehand_date"; rowKey: string; value: string }
  | { type: "garbage_currency"; rowKey: string; value: string }
  | { type: "bulk_paste"; position: number; rows: string[][] }
  | { type: "duplicate_row"; rowKey: string };

export type EditOpType = EditOp["type"];

// TEST INSTRUMENTATION — the journal is NOT a vendor artifact. Real Google Sheets keeps
// no consumable edit log at this granularity; tests read the journal to assert what the
// simulated human did. The connector (A4) must never read it.
export type JournalEntry = {
  step: number;
  op: EditOpType;
  range: string; // A1 notation of the affected cells (header row is sheet row 1)
  rowsChanged: number;
  detail: Record<string, unknown>;
};

export type AppliedEdit = { range: string; rowsChanged: number };

export type SheetState = {
  readonly sheetId: string;
  /** Direct state mutation — the API/script-driven path. NEVER fires the trigger
   *  channel (documented: "Script executions and API requests don't cause triggers
   *  to run" — installable-triggers reference, plan §2). The trigger hook lives only
   *  on the EDITOR's human path; this module has no reference to trigger.ts at all. */
  apply(op: EditOp): AppliedEdit;
  values(): Grid;
  metadata(): RowKeyMapEntry[];
  /** values() + metadata() materialized in ONE synchronous read of the same grid
   *  state (cold review I4). Mirrors the real Sheets API capability: a single
   *  spreadsheets.get call can return grid data and developer metadata together, so
   *  an atomic combined read is vendor-faithful, not a mock convenience. Consumers
   *  that DIFF the grid must use this; the split reads cannot promise their two
   *  responses describe the same state. */
  snapshot(): SheetSnapshot;
  journal(): readonly JournalEntry[];
  rowCount(): number;
  rowByKey(rowKey: string): SheetRow | undefined;
};

// Documented: developer metadata is capped at 30,000 chars per sheet AND per spreadsheet
// (Sheets API metadata guide). Behavior AT the ceiling is one of the five
// unverified-assume-conservative behaviors (plan §2): the conservative encoding is a hard
// refusal to mint further row keys once live metadata would exceed the cap.
export const METADATA_CHAR_CAP = 30_000;

const WIDTH = SHEET_HEADER.length;
const colLetter = (i: number) => String.fromCharCode(65 + i);
// A1 sheet row number for a 0-based data index: header occupies sheet row 1.
const sheetRow = (dataIndex: number) => dataIndex + 2;
const rowRange = (dataIndex: number) => `A${sheetRow(dataIndex)}:${colLetter(WIDTH - 1)}${sheetRow(dataIndex)}`;

export function createSheet(opts: { seed: number; rowCount?: number; profile?: Profile }): SheetState {
  const { seed, rowCount = 12, profile } = opts;
  const header: string[] = [...SHEET_HEADER];
  const rows: SheetRow[] = [];
  const journal: JournalEntry[] = [];
  let step = 0;
  let keyCounter = 0;
  let liveMetadataChars = 0;

  const mintKey = (): string => {
    const key = `rk-${String(++keyCounter).padStart(4, "0")}`;
    // Conservative ceiling behavior (see METADATA_CHAR_CAP note above): refuse the mint.
    if (liveMetadataChars + key.length > METADATA_CHAR_CAP) {
      keyCounter--; // the refused key was never born
      throw new Error(
        `developer metadata cap exceeded: ${liveMetadataChars} + ${key.length} chars > ${METADATA_CHAR_CAP} per sheet`,
      );
    }
    liveMetadataChars += key.length;
    return key;
  };
  const birth = (cells: string[]): SheetRow => ({ rowKey: mintKey(), cells: [...cells] });
  const indexOfKey = (rowKey: string) => rows.findIndex((r) => r.rowKey === rowKey);
  const mustFind = (rowKey: string): number => {
    const i = indexOfKey(rowKey);
    if (i === -1) throw new Error(`unknown rowKey: ${rowKey}`);
    return i;
  };

  // seed rows are row BIRTHS, not edits: the journal records only mutations
  const source = createRowSource(seed, profile);
  for (let i = 0; i < rowCount; i++) rows.push(birth(source.next()));

  const record = (op: EditOpType, range: string, rowsChanged: number, detail: Record<string, unknown>): AppliedEdit => {
    journal.push({ step: ++step, op, range, rowsChanged, detail });
    return { range, rowsChanged };
  };

  const setCell = (op: EditOpType, rowKey: string, column: number, value: string): AppliedEdit => {
    const i = mustFind(rowKey);
    const from = rows[i].cells[column];
    rows[i].cells[column] = value;
    return record(op, `${colLetter(column)}${sheetRow(i)}`, 1, { rowKey, column, from, to: value });
  };

  const apply = (op: EditOp): AppliedEdit => {
    switch (op.type) {
      case "edit_cell":
        return setCell("edit_cell", op.rowKey, op.column, op.value);
      case "freehand_date":
        return setCell("freehand_date", op.rowKey, COL.closeDate, op.value);
      case "garbage_currency":
        return setCell("garbage_currency", op.rowKey, COL.currency, op.value);
      case "append_row": {
        const row = birth(op.cells);
        rows.push(row);
        return record("append_row", rowRange(rows.length - 1), 1, { rowKey: row.rowKey });
      }
      case "insert_row_above": {
        const row = birth(op.cells);
        rows.splice(op.position, 0, row);
        return record("insert_row_above", rowRange(op.position), 1, { rowKey: row.rowKey, position: op.position });
      }
      case "insert_blank_row": {
        const row = birth(Array(WIDTH).fill(""));
        rows.splice(op.position, 0, row);
        return record("insert_blank_row", rowRange(op.position), 1, { rowKey: row.rowKey, position: op.position });
      }
      case "delete_row": {
        const i = mustFind(op.rowKey);
        const [dead] = rows.splice(i, 1);
        liveMetadataChars -= dead.rowKey.length; // metadata dies with its row (documented)
        return record("delete_row", rowRange(i), 1, { rowKey: op.rowKey });
      }
      case "rename_header": {
        const from = header[op.column];
        header[op.column] = op.name;
        return record("rename_header", `${colLetter(op.column)}1`, 0, { column: op.column, from, to: op.name });
      }
      case "duplicate_row": {
        const i = mustFind(op.rowKey);
        // Metadata across duplication is unverified (plan §2) → conservative: the copy
        // is a NEW row birth with a fresh key, never an inherited one.
        const copy = birth(rows[i].cells);
        rows.splice(i + 1, 0, copy);
        return record("duplicate_row", rowRange(i + 1), 1, { sourceRowKey: op.rowKey, rowKey: copy.rowKey });
      }
      case "bulk_paste": {
        // Paste over existing rows edits their VALUES in place (row-attached metadata
        // survives a paste — the row itself was never deleted); rows pasted past the
        // current bottom are new births.
        const born: string[] = [];
        for (let k = 0; k < op.rows.length; k++) {
          const target = op.position + k;
          if (target < rows.length) rows[target].cells = [...op.rows[k]];
          else {
            const row = birth(op.rows[k]);
            rows.push(row);
            born.push(row.rowKey);
          }
        }
        const last = op.position + op.rows.length - 1;
        const range = `A${sheetRow(op.position)}:${colLetter(WIDTH - 1)}${sheetRow(last)}`;
        return record("bulk_paste", range, op.rows.length, { position: op.position, born });
      }
    }
  };

  return {
    sheetId: `demo-sheet-${seed}`,
    apply,
    values: () => ({ header: [...header], rows: rows.map((r) => [...r.cells]) }),
    metadata: () => rows.map((r, i) => ({ rowKey: r.rowKey, rowIndex: i })),
    snapshot: () => ({
      header: [...header],
      rows: rows.map((r) => [...r.cells]),
      metadata: rows.map((r, i) => ({ rowKey: r.rowKey, rowIndex: i })),
    }),
    journal: () => journal,
    rowCount: () => rows.length,
    rowByKey: (rowKey) => {
      const i = indexOfKey(rowKey);
      return i === -1 ? undefined : { rowKey: rows[i].rowKey, cells: [...rows[i].cells] };
    },
  };
}
