// Sheet foundation / pins — the adoption pass (`crm/src/sheet-adopt.ts`).
//
// The transport is the stateful FakeSheet (helpers/fakesheet.ts): minted refs become
// durable exactly the way DOCUMENT-visibility developer metadata does on the live API,
// because the duplicate-adoption failure class lives in that seam. The pass itself runs
// on the ADMIN pool — it is owner-credentialed by design (021's grant block).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { freshCrmDb, sqlstate, TEST_TENANT } from "./helpers/crmdb.js";
import { FakeSheet, type FakeRow } from "./helpers/fakesheet.js";
import { linkSheet, runSheetAdoption, type AdoptionReport } from "../src/sheet-adopt.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.linked_sheets");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

const HEADER = ["Name", "Email", "Contact #", "Met At"];

function row(name: string, email = "", phone = "", metAt = "", ref: string | null = null): FakeRow {
  return { ref, cells: [name, email, phone, metAt] };
}

async function linkedFake(rows: FakeRow[]): Promise<{
  sheet: FakeSheet;
  run: () => Promise<AdoptionReport>;
  linkedSheetId: string;
}> {
  const spreadsheetId = `fake-${randomUUID()}`;
  const sheet = new FakeSheet(spreadsheetId, HEADER, rows);
  const { linkedSheetId } = await linkSheet(admin, TEST_TENANT, spreadsheetId, "Her list");
  const run = (): Promise<AdoptionReport> =>
    runSheetAdoption(
      { admin, transport: sheet },
      { id: linkedSheetId, tenantId: TEST_TENANT, spreadsheetId },
    );
  return { sheet, run, linkedSheetId };
}

interface ContactRow {
  id: string;
  display_name: string | null;
  email_address: string | null;
  active: boolean;
  next_due_at: Date | null;
  row_ref: string | null;
}

async function contactsOf(linkedSheetId: string): Promise<ContactRow[]> {
  const r = await admin.query<ContactRow>(
    `select id, display_name, email_address, active, next_due_at, row_ref
       from crm.contacts where linked_sheet_id = $1 order by created_at`,
    [linkedSheetId],
  );
  return r.rows;
}

async function latestRead(linkedSheetId: string): Promise<{ ok: boolean; detail: string }> {
  const r = await admin.query<{ ok: boolean; detail: string }>(
    `select ok, detail from crm.sheet_reads where linked_sheet_id = $1 order by at desc limit 1`,
    [linkedSheetId],
  );
  expect(r.rowCount).toBe(1);
  return r.rows[0];
}

describe("first import — rows become contacts, refs become durable identity", () => {
  it("mints refs, writes them back BEFORE adopting, and creates contacts due now", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([
      row("Ana Reyes", "ana@example.com", "0917 123 4567", "Rotary breakfast"),
      row("Ben Cruz", "", "0918 555 1234"),
      row("", "blank-name@example.com"), // the deliberately blank name — still a contact
    ]);
    const r = await run();
    expect(r.completed).toBe(true);
    expect(r.refsMinted).toBe(3);
    expect(r.adopted).toBe(3);
    expect(sheet.refWrites).toHaveLength(1); // one batch, before adoption
    expect(sheet.refs()).toHaveLength(3); // durable on the sheet

    const contacts = await contactsOf(linkedSheetId);
    expect(contacts).toHaveLength(3);
    for (const c of contacts) {
      expect(c.row_ref).not.toBeNull();
      expect(c.active).toBe(true);
      expect(c.next_due_at).not.toBeNull(); // due immediately — the client's stated failure
    }
    // "" → null at the boundary: the blank-name row must not become `display_name = ''`.
    const blank = contacts.find((c) => c.email_address === "blank-name@example.com");
    expect(blank?.display_name).toBeNull();
    // Phones landed with dial order preserved.
    const ana = contacts.find((c) => c.email_address === "ana@example.com");
    const phones = await admin.query(
      `select phone_e164 from crm.phone_numbers where contact_id = $1 order by ordinal`,
      [ana?.id],
    );
    expect(phones.rows).toEqual([{ phone_e164: "+639171234567" }]);

    // A second pass over the SAME sheet adopts nothing new — the refs written back in
    // pass one are the identity that stops re-import.
    const again = await run();
    expect(again.adopted).toBe(0);
    expect(again.refsMinted).toBe(0);
    expect(await contactsOf(linkedSheetId)).toHaveLength(3);
  });

  it("skips adoption for rows whose ref write-back failed — a contact without a durable ref re-imports as a duplicate on every pass", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([row("Ana", "a@example.com")]);
    sheet.failRefWrites = new Error("metadata write refused");
    const r = await run();
    expect(r.completed).toBe(true);
    expect(r.refWriteFailed).toBe(true);
    expect(r.adopted).toBe(0);
    expect(await contactsOf(linkedSheetId)).toHaveLength(0);
    // The write-back recovers; the row is adopted once, not twice.
    sheet.failRefWrites = null;
    const r2 = await run();
    expect(r2.adopted).toBe(1);
    expect(await contactsOf(linkedSheetId)).toHaveLength(1);
  });
});

describe("a failed read records ok=false and changes NOTHING else", () => {
  // mutation: in `runSheetAdoption`'s read-failure path, treat absence as deletion (block
  // every bound contact and null its clock before returning) -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected [ { …(6) } ] to deeply equal [ { …(6) } ]
  //   (the before/after contact comparison: `next_due_at` had been nulled by a mere
  //   network blip, with a sheet_row_missing block stacked on top). i.e. an UNREACHABLE
  //   sheet silently paused every contact on it — absence of evidence treated as
  //   deletion, the exact failure the design forbids. Restored, green.
  it("pauses on unreachable — no blocks, no deactivations, no clock changes", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([
      row("Ana", "ana@example.com", "0917 123 4567"),
    ]);
    await run(); // established: one adopted contact
    const before = await contactsOf(linkedSheetId);

    sheet.failWith = new Error("ETIMEDOUT reading sheet");
    const r = await run();
    expect(r.completed).toBe(false);
    expect(r.code).toBe("unreachable");

    const read = await latestRead(linkedSheetId);
    expect(read.ok).toBe(false);
    expect(read.detail).toMatch(/^unreachable: /);

    // NOTHING else changed: same contacts, same activity, same clocks, no follow-ups.
    expect(await contactsOf(linkedSheetId)).toEqual(before);
    const fups = await admin.query(`select blocked_reason, closed_at from crm.follow_ups`);
    expect(fups.rows).toEqual([]);
  });

  it("names the service account when access was revoked — her action is re-sharing, not waiting", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([row("Ana", "ana@example.com")]);
    await run();
    const { SheetApiError } = await import("../src/sheet-client.js");
    sheet.failWith = new SheetApiError(403, "The caller does not have permission");
    const r = await run();
    expect(r.code).toBe("permission_revoked");
    const read = await latestRead(linkedSheetId);
    expect(read.ok).toBe(false);
    expect(read.detail).toContain(sheet.serviceAccountEmail);
    expect(read.detail).toContain("Re-share");
  });
});

describe("rebind on return — history reattaches instead of flooding back as strangers", () => {
  // mutation: disable the deactivated-email-match branch in `adoptRow` (always create) ->
  // red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected +0 to be 1 // Object.is equality   (report.rebound)
  //   i.e. Ana came back as a brand-new stranger: two contacts where one should exist,
  //   with the touch history stranded on the deactivated one. Restored, green.
  it("matches a new row's email against DEACTIVATED contacts and reactivates the SAME contact", async () => {
    // A deactivated contact with real history — the state a sheet swap leaves behind.
    const old = await admin.query<{ id: string }>(
      `insert into crm.contacts (tenant_id, display_name, email_address, channel, source,
                                 active, next_due_at, follow_up_interval_days)
       values ($1, 'Ana Reyes', 'ana@example.com', 'call', 'referral', false, null, 9)
       returning id`,
      [TEST_TENANT],
    );
    const oldId = old.rows[0].id;
    await admin.query(
      `insert into crm.touches (contact_id, channel, disposition) values ($1, 'call', 'answered')`,
      [oldId],
    );

    // Her NEW sheet lists Ana again (fresh row, no ref — a copy carries no metadata).
    const { run, linkedSheetId } = await linkedFake([
      row("Ana R.", "ana@example.com", "0917 123 4567"),
    ]);
    const r = await run();
    expect(r.rebound).toBe(1);
    expect(r.adopted).toBe(0);

    const contacts = await contactsOf(linkedSheetId);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].id).toBe(oldId); // the SAME contact — not a duplicate
    expect(contacts[0].active).toBe(true);
    expect(contacts[0].next_due_at).not.toBeNull(); // the clock restarts
    // History reattached because it never moved: the touch still belongs to this row.
    const touches = await admin.query(`select contact_id from crm.touches`);
    expect(touches.rows).toEqual([{ contact_id: oldId }]);
    // Her per-contact interval survived the swap — "keep their clocks".
    const interval = await admin.query<{ follow_up_interval_days: number }>(
      `select follow_up_interval_days from crm.contacts where id = $1`,
      [oldId],
    );
    expect(interval.rows[0].follow_up_interval_days).toBe(9);
  });
});

describe("missing rows — blocked and surfaced, never deactivated", () => {
  // mutation: replace the block+pause with `update crm.contacts set active = false` (the
  // deferred deactivation the owner explicitly declined) -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  2 failed | 11 passed (13)`
  //     AssertionError: expected false to be true // Object.is equality  (contact.active)
  //     AssertionError: expected +0 to be 1       (the recovery pin: r.recovered)
  //   i.e. the contact vanished from every surface instead of appearing on one, and a
  //   restored row could no longer bring anyone back. Restored, green.
  it("blocks with sheet_row_missing, pauses the clock, keeps the contact active", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([
      row("Ana", "ana@example.com", "0917 123 4567"),
      row("Ben", "ben@example.com", "0918 555 1234"),
    ]);
    await run();
    const [ana] = await contactsOf(linkedSheetId);
    sheet.deleteRowByRef(ana.row_ref as string);

    const r = await run();
    expect(r.blocked).toBe(1);

    const c = (await contactsOf(linkedSheetId)).find((x) => x.id === ana.id);
    expect(c?.active).toBe(true); // NOT deactivated — owner decision
    expect(c?.next_due_at).toBeNull(); // paused, or the proposer's upsert steamrolls the block
    const fup = await admin.query(
      `select blocked_reason from crm.follow_ups where contact_id = $1 and closed_at is null`,
      [ana.id],
    );
    expect(fup.rows).toEqual([{ blocked_reason: "sheet_row_missing" }]);

    // A second pass over the same outage does not stack a second block or re-count it.
    const r2 = await run();
    expect(r2.blocked).toBe(0);
  });

  it("recovers when the ref returns: the block closes and the clock restarts", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([
      row("Ana", "ana@example.com", "0917 123 4567"),
      row("Ben", "ben@example.com", "0918 555 1234"),
    ]);
    await run();
    const [ana] = await contactsOf(linkedSheetId);
    const removed = sheet.deleteRowByRef(ana.row_ref as string);
    await run();

    sheet.rows.push(removed); // she restores the row — same ref travels back with it
    const r = await run();
    expect(r.recovered).toBe(1);
    const c = (await contactsOf(linkedSheetId)).find((x) => x.id === ana.id);
    expect(c?.next_due_at).not.toBeNull();
    const open = await admin.query(
      `select 1 from crm.follow_ups where contact_id = $1 and closed_at is null`,
      [ana.id],
    );
    expect(open.rows).toEqual([]);
  });
});

describe("the circuit breaker — both arms halt BEFORE any write", () => {
  // mutation: disable the count-arm `if` in `runSheetAdoption` -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected true to be false // Object.is equality  (r.completed)
  //   i.e. the pass the breaker should have halted ran to completion and imported the
  //   flood. Restored, green.
  it("halts when one pass would create or block more than the threshold", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([
      row("Ana", "ana@example.com", "0917 123 4567"),
      row("Ben", "ben@example.com", "0918 555 1234"),
    ]);
    await run(); // established — the breaker never arms on a first import

    // Four new rows against a maxChanges of 3: halt, change nothing.
    for (const n of ["N1", "N2", "N3", "N4"]) sheet.rows.push(row(n, `${n}@example.com`));
    const r = await runSheetAdoption(
      { admin, transport: sheet, thresholds: { maxChanges: 3 } },
      { id: linkedSheetId, tenantId: TEST_TENANT, spreadsheetId: sheet.spreadsheetId },
    );
    expect(r.completed).toBe(false);
    expect(r.code).toBe("breaker_count");
    expect(await contactsOf(linkedSheetId)).toHaveLength(2); // nothing imported
    const read = await latestRead(linkedSheetId);
    expect(read.ok).toBe(false);
    expect(read.detail).toMatch(/^breaker_count: /);
  });

  // mutation: disable the drift-arm `if` in `runSheetAdoption` -> red. RUN ✅ 2026-08-17
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected true to be false // Object.is equality  (r.completed)
  //   i.e. with only the count arm standing, the scrambled pass ran to completion — every
  //   ref present, none new, ZERO planned changes, so the count arm saw nothing while
  //   every row bound one person's name to another's number. That blindness is why the
  //   drift arm exists. Restored, green.
  it("halts on a PARTIAL-RANGE SORT: values scrambled under unchanged refs, no ref moved, no ref missing", async () => {
    const people = ["Ana", "Ben", "Cara", "Dan", "Ely", "Fe"];
    const { sheet, run, linkedSheetId } = await linkedFake(
      people.map((n) => row(n, `${n.toLowerCase()}@example.com`, "0917 123 4567")),
    );
    await run();
    const before = await contactsOf(linkedSheetId);
    expect(before).toHaveLength(6);

    // The one-click mistake: she selects the NAME+EMAIL columns and sorts them alone.
    // Values rotate one row down; refs (metadata) stay exactly where they were.
    const dataRows = sheet.rows.slice(1);
    const rotatedCells = dataRows.map((_, i) => dataRows[(i + 1) % dataRows.length].cells);
    dataRows.forEach((r2, i) => {
      r2.cells = [...rotatedCells[i]];
    });

    const r = await run();
    expect(r.completed).toBe(false);
    expect(r.code).toBe("breaker_drift");
    // The count arm saw NOTHING to do — every ref present, none new — so without the
    // drift arm this pass would have completed and bound names to the wrong numbers.
    expect(r.adopted + r.blocked + r.refsMinted).toBe(0);
    const read = await latestRead(linkedSheetId);
    expect(read.ok).toBe(false);
    expect(read.detail).toMatch(/^breaker_drift: /);
    expect(read.detail).toContain("PARTIAL-RANGE SORT");
    // Stored state untouched: every name still beside its own email.
    expect(await contactsOf(linkedSheetId)).toEqual(before);
  });

  it("re-baselines accepted drift so gradual legitimate edits never accumulate into a halt", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([
      row("Ana", "ana@example.com", "0917 123 4567"),
      row("Ben", "ben@example.com", "0918 555 1234"),
      row("Cara", "cara@example.com"),
      row("Dan", "dan@example.com"),
      row("Ely", "ely@example.com"),
    ]);
    await run();
    // One legitimate edit: 1 of 5 = 20%, at the default threshold, passes and re-baselines.
    sheet.rows[1].cells[0] = "Ana Reyes-Santos";
    const r = await run();
    expect(r.completed).toBe(true);
    expect(r.synced).toBe(1);
    const renamed = (await contactsOf(linkedSheetId)).find(
      (c) => c.email_address === "ana@example.com",
    );
    expect(renamed?.display_name).toBe("Ana Reyes-Santos");
    // The same edit does not count as drift again next pass.
    const r2 = await run();
    expect(r2.completed).toBe(true);
    expect(r2.synced).toBe(0);
  });
});

describe("per-row isolation — one malformed row never aborts the pass", () => {
  it("adopts every good row and reports the bad one", async () => {
    const dupRef = randomUUID();
    const { run, linkedSheetId } = await linkedFake([
      row("Ana", "ana@example.com", "", "", dupRef),
      row("Impostor", "imp@example.com", "", "", dupRef), // collides on the identity tuple
      row("Cara", "cara@example.com"),
    ]);
    const r = await run();
    expect(r.completed).toBe(true);
    expect(r.rowErrors).toHaveLength(1);
    expect(r.adopted).toBe(2); // Ana and Cara made it
    expect(await contactsOf(linkedSheetId)).toHaveLength(2);
    const read = await latestRead(linkedSheetId);
    expect(read.ok).toBe(true);
    expect(read.detail).toContain("row_errors 1");
  });
});

describe("relink of the SAME sheet — matched refs reactivate in place", () => {
  it("reactivates deactivated ref-matched contacts without creating anything", async () => {
    const { sheet, run, linkedSheetId } = await linkedFake([
      row("Ana", "ana@example.com", "0917 123 4567"),
    ]);
    await run();
    const [ana] = await contactsOf(linkedSheetId);
    // Unlink-shaped state: deactivated, clock killed, identity intact.
    await admin.query(
      `update crm.linked_sheets set unlinked_at = now() where id = $1`,
      [linkedSheetId],
    );
    await admin.query(
      `update crm.contacts set active = false, next_due_at = null where id = $1`,
      [ana.id],
    );
    const relink = await linkSheet(admin, TEST_TENANT, sheet.spreadsheetId);
    expect(relink.relinked).toBe(true);
    expect(relink.linkedSheetId).toBe(linkedSheetId);

    const r = await run();
    expect(r.reactivated).toBe(1);
    expect(r.adopted).toBe(0);
    const after = await contactsOf(linkedSheetId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(ana.id);
    expect(after[0].active).toBe(true);
    expect(after[0].next_due_at).not.toBeNull();
  });
});

describe("grants — the pass is owner-only in fact, not in prose", () => {
  it("switchboard_crm cannot perform the adoption writes", async () => {
    const { linkedSheetId } = await linkedFake([]);
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into crm.contacts (tenant_id, channel, source, linked_sheet_id, row_ref)
           values ($1, 'call', 'manual', $2, 'r1')`,
          [TEST_TENANT, linkedSheetId],
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into crm.sheet_reads (tenant_id, linked_sheet_id, ok) values ($1, $2, false)`,
          [TEST_TENANT, linkedSheetId],
        ),
      ),
    ).toBe("42501");
  });
});
