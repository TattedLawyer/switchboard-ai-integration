// Mutable grid state for the mock Sheets source.
//
// rowKey models Google's row-attached developer metadata (plan §2, documented): assigned
// at row birth, follows its row through insertions/moves, dies with the row.
// The row set of this grid is the paradigm's reconciliation truth — the A5 oracle
// compares these rows against pipeline output exactly.

export type SheetRow = { rowKey: string; cells: string[] };
export type Grid = { header: string[]; rows: string[][] };
export type RowKeyMapEntry = { rowKey: string; rowIndex: number };

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
   *  to run" — installable-triggers reference, plan §2). */
  apply(op: EditOp): AppliedEdit;
  values(): Grid;
  metadata(): RowKeyMapEntry[];
  journal(): readonly JournalEntry[];
  rowCount(): number;
  rowByKey(rowKey: string): SheetRow | undefined;
};

// Documented: developer metadata is capped at 30,000 chars per sheet AND per spreadsheet
// (Sheets API metadata guide). Behavior AT the ceiling is one of the five
// unverified-assume-conservative behaviors (plan §2): the conservative encoding is a hard
// refusal to mint further row keys once live metadata would exceed the cap.
export const METADATA_CHAR_CAP = 30_000;

export function createSheet(_opts: { seed: number; rowCount?: number }): SheetState {
  throw new Error("not implemented (RED)");
}
