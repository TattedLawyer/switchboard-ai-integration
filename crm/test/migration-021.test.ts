// Sheet foundation / pins — migration `021_linked_sheets.sql`.
//
// 🚨 RED BY MEASUREMENT, NOT BY ABSENCE (the 017/018 idiom): each schema pin asserts the
// SQLSTATE the constraint produces, through the pool whose role would hit it in
// production. Grant pins go through the `crm` pool because `switchboard_crm` is the role
// whose surface 021 deliberately does NOT widen.
//
// Nothing here writes to the named `switchboard` database: `freshCrmDb()` creates its own
// ephemeral database and drops it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { freshCrmDb, seedContact, sqlstate, TEST_TENANT } from "./helpers/crmdb.js";

let admin: pg.Pool;
let crm: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  dbUrl = db.url;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.linked_sheets");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

async function seedSheet(spreadsheetId = `sheet-${randomUUID()}`): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into crm.linked_sheets (tenant_id, spreadsheet_id, label)
     values ($1, $2, 'Her master list') returning id`,
    [TEST_TENANT, spreadsheetId],
  );
  return r.rows[0].id;
}

describe("021: linked_sheets identity", () => {
  // mutation: delete `constraint linked_sheets_one_per_sheet unique (tenant_id,
  // spreadsheet_id)` from 021 -> red. RUN ✅ 2026-08-17
  //   Observed (migration-021 + sheet-link together): `Tests  1 failed | 11 passed (12)`
  //     AssertionError: expected 'NO-ERROR' to be '23505' // Object.is equality
  //   i.e. the same sheet could be linked twice, and every row would import twice — once
  //   per linked_sheets row, because the contact identity tuple differs. Restored, green.
  it("refuses the same spreadsheet linked twice for a tenant — 23505, not a second import", async () => {
    await seedSheet("sheet-dup");
    // Unlinked or not, the identity row is unique: mark the first unlinked and the
    // constraint must STILL refuse — relinking reactivates the same row instead.
    await admin.query(`update crm.linked_sheets set unlinked_at = now()`);
    const code = await sqlstate(() =>
      admin.query(
        `insert into crm.linked_sheets (tenant_id, spreadsheet_id) values ($1, 'sheet-dup')`,
        [TEST_TENANT],
      ),
    );
    expect(code).toBe("23505");
  });

  it("allows only ONE active sheet per tenant — swap is unlink-then-link, by owner decision", async () => {
    await seedSheet("sheet-a");
    const code = await sqlstate(() => seedSheet("sheet-b"));
    expect(code).toBe("23505");
    // After unlinking the first, a second becomes linkable.
    await admin.query(`update crm.linked_sheets set unlinked_at = now()`);
    const code2 = await sqlstate(() => seedSheet("sheet-b"));
    expect(code2).toBe("NO-ERROR");
  });
});

describe("021: contact ↔ row binding", () => {
  it("refuses two contacts on one sheet row — the partial unique on (linked_sheet_id, row_ref)", async () => {
    const sheetId = await seedSheet();
    await admin.query(
      `insert into crm.contacts (tenant_id, display_name, channel, source, linked_sheet_id, row_ref)
       values ($1, 'Ana', 'call', 'manual', $2, 'ref-1')`,
      [TEST_TENANT, sheetId],
    );
    const code = await sqlstate(() =>
      admin.query(
        `insert into crm.contacts (tenant_id, display_name, channel, source, linked_sheet_id, row_ref)
         values ($1, 'Impostor', 'call', 'manual', $2, 'ref-1')`,
        [TEST_TENANT, sheetId],
      ),
    );
    expect(code).toBe("23505");
  });

  it("keeps manual contacts free of the constraint — many (null, null) rows coexist", async () => {
    await seedContact(admin, { displayName: "Manual 1" });
    await seedContact(admin, { displayName: "Manual 2" });
    const r = await admin.query<{ n: string }>(
      `select count(*) as n from crm.contacts where linked_sheet_id is null and row_ref is null`,
    );
    expect(Number(r.rows[0].n)).toBe(2);
  });

  it("makes a half-bound contact unrepresentable — identity is the PAIR", async () => {
    const sheetId = await seedSheet();
    const refOnly = await sqlstate(() =>
      admin.query(
        `insert into crm.contacts (tenant_id, channel, source, row_ref)
         values ($1, 'call', 'manual', 'orphan-ref')`,
        [TEST_TENANT],
      ),
    );
    const sheetOnly = await sqlstate(() =>
      admin.query(
        `insert into crm.contacts (tenant_id, channel, source, linked_sheet_id)
         values ($1, 'call', 'manual', $2)`,
        [TEST_TENANT, sheetId],
      ),
    );
    expect(refOnly).toBe("23514");
    expect(sheetOnly).toBe("23514");
  });
});

describe("021: grants — adoption is OWNER territory; the CRM role reads health only", () => {
  it("lets switchboard_crm SELECT the two health tables (the digest's need) and nothing more", async () => {
    const sheetId = await seedSheet();
    await admin.query(
      `insert into crm.sheet_reads (tenant_id, linked_sheet_id, ok, detail)
       values ($1, $2, true, 'ok: adopted 0')`,
      [TEST_TENANT, sheetId],
    );
    expect(await sqlstate(() => crm.query(`select * from crm.linked_sheets`))).toBe("NO-ERROR");
    expect(await sqlstate(() => crm.query(`select * from crm.sheet_reads`))).toBe("NO-ERROR");
    // The writes belong to the owner-run adoption pass alone. 42501 is the control.
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into crm.linked_sheets (tenant_id, spreadsheet_id) values ($1, 'rogue')`,
          [TEST_TENANT],
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into crm.sheet_reads (tenant_id, linked_sheet_id, ok) values ($1, $2, true)`,
          [TEST_TENANT, sheetId],
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(() => crm.query(`update crm.linked_sheets set unlinked_at = now()`)),
    ).toBe("42501");
    // Nor may the CRM role bind contacts to rows: `linked_sheet_id`/`row_ref` are not in
    // 016's column-level UPDATE grant, and 021 does not add them.
    expect(
      await sqlstate(() => crm.query(`update crm.contacts set row_ref = 'hijack'`)),
    ).toBe("42501");
  });

  it("denies switchboard_agent everything, in the named-only-to-be-denied idiom", async () => {
    const u = new URL(dbUrl);
    u.username = "switchboard_agent";
    u.password = "switchboard_agent";
    const pg = (await import("pg")).default;
    const agent = new pg.Pool({ connectionString: u.toString(), max: 1 });
    agent.on("error", () => {});
    try {
      expect(await sqlstate(() => agent.query(`select * from crm.linked_sheets`))).toBe("42501");
      expect(await sqlstate(() => agent.query(`select * from crm.sheet_reads`))).toBe("42501");
    } finally {
      await agent.end().catch(() => {});
    }
  });
});
