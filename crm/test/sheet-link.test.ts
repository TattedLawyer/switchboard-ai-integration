// Sheet foundation / pins — link, relink and unlink (`crm/src/sheet-adopt.ts`).
//
// The two pins here guard the two ways a sheet lifecycle can silently corrupt the loop:
// a relink that mints a FRESH identity row (every contact re-imports as a duplicate), and
// an unlink that leaves BLOCKED follow-ups open (the digest lists them forever — no
// shipped writer can close a blocked row of a deactivated contact).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { freshCrmDb, TEST_TENANT } from "./helpers/crmdb.js";
import { FakeSheet, type FakeRow } from "./helpers/fakesheet.js";
import { linkSheet, unlinkSheet, runSheetAdoption } from "../src/sheet-adopt.js";
import { reconcile } from "../src/reconcile.js";

let admin: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.linked_sheets");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

const HEADER = ["Name", "Email", "Contact #"];
const row = (name: string, email = "", phone = ""): FakeRow => ({
  ref: null,
  cells: [name, email, phone],
});

async function establish(rows: FakeRow[]): Promise<{ sheet: FakeSheet; linkedSheetId: string }> {
  const sheet = new FakeSheet(`fake-${randomUUID()}`, HEADER, rows);
  const { linkedSheetId } = await linkSheet(admin, TEST_TENANT, sheet.spreadsheetId);
  await runSheetAdoption(
    { admin, transport: sheet },
    { id: linkedSheetId, tenantId: TEST_TENANT, spreadsheetId: sheet.spreadsheetId },
  );
  return { sheet, linkedSheetId };
}

describe("relink reactivates the SAME linked_sheets row", () => {
  // mutation: make `linkSheet`'s relink branch mint a FRESH row (append a uuid suffix to
  // `spreadsheet_id` and insert instead of updating) -> red. RUN ✅ 2026-08-17
  //   Observed (sheet-link + sheet-adopt together): `Tests  2 failed | 16 passed (18)`
  //     AssertionError: expected '16d10d38-…' to be '110c20b6-…' // Object.is equality
  //     (and sheet-adopt's same-sheet reactivation pin red on its contact id the same way)
  //   i.e. the relink minted a fresh identity row, every contact's `(linked_sheet_id,
  //   row_ref)` tuple went stale, and adoption re-imported the sheet as duplicates with
  //   the history orphaned on the deactivated originals. Restored, green.
  it("unlink → relink returns the same row id, and adoption reactivates rather than re-imports", async () => {
    const { sheet, linkedSheetId } = await establish([
      row("Ana", "ana@example.com", "0917 123 4567"),
      row("Ben", "ben@example.com", "0918 555 1234"),
    ]);
    const before = await admin.query<{ id: string }>(
      `select id from crm.contacts where linked_sheet_id = $1 order by created_at`,
      [linkedSheetId],
    );
    expect(before.rowCount).toBe(2);

    await unlinkSheet(admin, TEST_TENANT);
    const relink = await linkSheet(admin, TEST_TENANT, sheet.spreadsheetId);
    expect(relink.relinked).toBe(true);
    expect(relink.linkedSheetId).toBe(linkedSheetId); // the SAME identity row

    await runSheetAdoption(
      { admin, transport: sheet },
      { id: relink.linkedSheetId, tenantId: TEST_TENANT, spreadsheetId: sheet.spreadsheetId },
    );
    const after = await admin.query<{ id: string; active: boolean }>(
      `select id, active from crm.contacts order by created_at`,
    );
    // TWO contacts, the SAME two, both active again — not four.
    expect(after.rows.map((r) => r.id).sort()).toEqual(before.rows.map((r) => r.id).sort());
    expect(after.rows.every((r) => r.active)).toBe(true);
  });

  it("linking a SECOND sheet while one is active refuses — swap is unlink-then-link", async () => {
    await establish([row("Ana")]);
    await expect(linkSheet(admin, TEST_TENANT, "another-sheet")).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describe("unlink kills the clocks and closes EVERY open follow-up — blocked ones included", () => {
  // mutation: add `and f.blocked_reason is null` to `unlinkSheet`'s close statement (the
  // exact predicate `closeTerminatedFollowUps` uses) -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 4 passed (5)`
  //     AssertionError: expected 1 to be 2 // Object.is equality  (r.followUpsClosed)
  //   i.e. only Ben's plain open row closed; Ana's BLOCKED row survived the unlink — and
  //   because blocked rows have no `follow_up_actions` and `closeTerminatedFollowUps`
  //   requires `blocked_reason is null`, NO shipped writer could ever close it: it would
  //   sit in the digest and the reconcile listing forever. The permanent-noise class,
  //   guarded against a fourth recurrence. Restored, green.
  it("closes open and BLOCKED follow-ups in the same transaction, deactivates, kills clocks", async () => {
    const { sheet, linkedSheetId } = await establish([
      row("Ana", "ana@example.com", "0917 123 4567"),
      row("Ben", "ben@example.com", "0918 555 1234"),
    ]);
    const contacts = await admin.query<{ id: string; row_ref: string }>(
      `select id, row_ref from crm.contacts where linked_sheet_id = $1 order by created_at`,
      [linkedSheetId],
    );
    const [ana, ben] = contacts.rows;

    // Ana: BLOCKED follow-up (her row went missing). Ben: plain open follow-up.
    sheet.deleteRowByRef(ana.row_ref);
    await runSheetAdoption(
      { admin, transport: sheet },
      { id: linkedSheetId, tenantId: TEST_TENANT, spreadsheetId: sheet.spreadsheetId },
    );
    await admin.query(
      `insert into crm.follow_ups (contact_id, due_date) values ($1, current_date)`,
      [ben.id],
    );

    const r = await unlinkSheet(admin, TEST_TENANT);
    expect(r.linkedSheetId).toBe(linkedSheetId);
    expect(r.contactsDeactivated).toBe(2);
    expect(r.followUpsClosed).toBe(2); // Ben's open row AND Ana's blocked row

    const openLeft = await admin.query(
      `select blocked_reason, contact_id from crm.follow_ups where closed_at is null`,
    );
    expect(openLeft.rows).toEqual([]);

    const state = await admin.query<{ active: boolean; next_due_at: Date | null }>(
      `select active, next_due_at from crm.contacts where linked_sheet_id = $1`,
      [linkedSheetId],
    );
    for (const c of state.rows) {
      expect(c.active).toBe(false);
      expect(c.next_due_at).toBeNull(); // unlinking kills the clocks
    }

    // The operator surfaces agree: nothing blocked survives into the listings.
    const report = await reconcile(admin);
    expect(report.blockedFollowUps).toEqual([]);

    // And the linked_sheets row itself SURVIVES (unlink never deletes).
    const rowLeft = await admin.query(
      `select unlinked_at from crm.linked_sheets where id = $1`,
      [linkedSheetId],
    );
    expect(rowLeft.rowCount).toBe(1);
    expect(rowLeft.rows[0].unlinked_at).not.toBeNull();
  });

  it("leaves manual contacts untouched", async () => {
    await establish([row("Ana", "ana@example.com")]);
    const manual = await admin.query<{ id: string }>(
      `insert into crm.contacts (tenant_id, display_name, channel, source, next_due_at)
       values ($1, 'Walk-in', 'call', 'manual', now()) returning id`,
      [TEST_TENANT],
    );
    await unlinkSheet(admin, TEST_TENANT);
    const m = await admin.query<{ active: boolean; next_due_at: Date | null }>(
      `select active, next_due_at from crm.contacts where id = $1`,
      [manual.rows[0].id],
    );
    expect(m.rows[0].active).toBe(true);
    expect(m.rows[0].next_due_at).not.toBeNull();
  });

  it("refuses to unlink when nothing is linked", async () => {
    await expect(unlinkSheet(admin, TEST_TENANT)).rejects.toThrow(/no linked sheet/);
  });
});
