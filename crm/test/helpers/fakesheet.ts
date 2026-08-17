// A stateful in-memory Google Sheet for the adoption-pass suites: the same contract as
// `crm/src/sheet-client.ts`'s SheetTransport, with the ONE behaviour the tests must model
// faithfully — `writeRowRefs` makes the ref durable, so the NEXT snapshot carries it, the
// way DOCUMENT-visibility developer metadata does on the live API (measured, 2026-08-17).
// A fake whose minted refs evaporate between passes would make every second pass re-mint
// and the duplicate-adoption failure class untestable.
import type { RefWrite, SheetSnapshot, SheetTransport } from "../../src/sheet-client.js";

export interface FakeRow {
  ref: string | null;
  cells: string[];
}

export class FakeSheet implements SheetTransport {
  serviceAccountEmail = "switchboard-sheets@robot.example.com";
  /** Row 0 is the header, exactly as on the wire. */
  rows: FakeRow[];
  refWrites: RefWrite[][] = [];
  /** Set to make the next read fail (network down, permission revoked, …). */
  failWith: Error | null = null;
  /** Set to make ref write-back fail while reads still succeed. */
  failRefWrites: Error | null = null;

  constructor(
    public readonly spreadsheetId: string,
    header: string[],
    dataRows: FakeRow[] = [],
  ) {
    this.rows = [{ ref: null, cells: header }, ...dataRows];
  }

  async readSnapshot(spreadsheetId: string): Promise<SheetSnapshot> {
    if (this.failWith) throw this.failWith;
    return {
      spreadsheetId,
      tabs: [
        {
          sheetId: 111,
          title: "Contacts",
          rows: this.rows.map((r, i) => ({ rowIndex: i, ref: r.ref, cells: [...r.cells] })),
        },
      ],
    };
  }

  async writeRowRefs(_spreadsheetId: string, writes: readonly RefWrite[]): Promise<void> {
    if (this.failRefWrites) throw this.failRefWrites;
    this.refWrites.push([...writes]);
    for (const w of writes) {
      const row = this.rows[w.rowIndex];
      if (row) row.ref = w.ref;
    }
  }

  /** Remove a DATA row the way a live delete behaves: the row and its ref vanish together. */
  deleteRowByRef(ref: string): FakeRow {
    const i = this.rows.findIndex((r) => r.ref === ref);
    if (i < 1) throw new Error(`no data row with ref ${ref}`);
    return this.rows.splice(i, 1)[0];
  }

  refs(): string[] {
    return this.rows.slice(1).flatMap((r) => (r.ref !== null ? [r.ref] : []));
  }
}
