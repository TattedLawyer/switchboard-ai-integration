// Part 2 / Piece B pins — migration `022_contact_detail_revoke.sql`.
//
// 🚨 RED BY MEASUREMENT, NOT BY ABSENCE (the 017/018/021 idiom): every grant pin asserts
// the SQLSTATE through the pool whose role would hit it in production. "A 42501 is a
// control; a comment is not" — 021's own deferred-revoke note, now cashed in.
//
// Nothing here writes to the named `switchboard` database: `freshCrmDb()` creates its own
// ephemeral database (001–022 applied) and drops it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("022: the CRM role can no longer read contact DETAILS — the sheet is the source", () => {
  // P8. mutation: delete the revoke + column re-grant from 022 (leave only the header and
  //     the switchboard_agent denial) -> NO-ERROR -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 4 passed (5)`
  //     AssertionError: expected 'NO-ERROR' to be '42501' // Object.is equality
  //   — with the statements gone, 016's table-level SELECT stands and the CRM role reads
  //   every detail column unimpeded. The revoke is the control, and this pin is what
  //   makes it non-vacuous. Restored, green.
  it("selecting email_address / source_detail / looking_for raises 42501", async () => {
    await seedContact(admin, { email: "ana@example.com" });
    expect(await sqlstate(() => crm.query(`select email_address from crm.contacts`))).toBe(
      "42501",
    );
    expect(await sqlstate(() => crm.query(`select source_detail from crm.contacts`))).toBe(
      "42501",
    );
    expect(await sqlstate(() => crm.query(`select looking_for from crm.contacts`))).toBe(
      "42501",
    );
    // `select *` expands to the full column list, so it must refuse too — the shipped
    // proposer's pre-022 loadContact shape is now unwritable, which is the point.
    expect(await sqlstate(() => crm.query(`select * from crm.contacts`))).toBe("42501");
  });

  it("still reads every column the proposer legitimately needs", async () => {
    await seedContact(admin, {});
    expect(
      await sqlstate(() =>
        crm.query(
          `select id, tenant_id, display_name, channel, source, active,
                  follow_up_interval_days, next_due_at, dial_rotation_ordinal,
                  created_at, updated_at, linked_sheet_id, row_ref
             from crm.contacts`,
        ),
      ),
    ).toBe("NO-ERROR");
    // The columns are REVOKED, not dropped: the owner still reads them (pending proposals
    // and `placeCallPayloadSchema`'s strict context grammar depend on their existence).
    expect(
      await sqlstate(() =>
        admin.query(`select email_address, source_detail, looking_for from crm.contacts`),
      ),
    ).toBe("NO-ERROR");
  });

  it("keeps phone_numbers SELECT — dial candidates resolve stored rows by E.164", async () => {
    const c = await seedContact(admin, {});
    await admin.query(
      `insert into crm.phone_numbers (contact_id, phone_e164, phone_raw, ordinal)
       values ($1, '+639171234567', '0917 123 4567', 0)`,
      [c],
    );
    expect(
      await sqlstate(() => crm.query(`select id, phone_e164, ordinal from crm.phone_numbers`)),
    ).toBe("NO-ERROR");
  });

  it("leaves 016's column-level UPDATE grants working (claim lease, rotation)", async () => {
    // "Any nontrivial UPDATE requires SELECT as well" (016's grant note): the lease writes
    // next_due_at and the rotation writes dial_rotation_ordinal, both under WHERE clauses
    // over granted columns — the revoke must not have broken either.
    const c = await seedContact(admin, {});
    expect(
      await sqlstate(() =>
        crm.query(
          `update crm.contacts set next_due_at = now(), updated_at = now() where id = $1`,
          [c],
        ),
      ),
    ).toBe("NO-ERROR");
    expect(
      await sqlstate(() =>
        crm.query(
          `update crm.contacts set dial_rotation_ordinal = dial_rotation_ordinal + 1,
                                   updated_at = now() where id = $1`,
          [c],
        ),
      ),
    ).toBe("NO-ERROR");
  });

  it("denies switchboard_agent everything on crm.contacts — named only to be denied", async () => {
    const u = new URL(dbUrl);
    u.username = "switchboard_agent";
    u.password = "switchboard_agent";
    const pg = (await import("pg")).default;
    const agent = new pg.Pool({ connectionString: u.toString(), max: 1 });
    agent.on("error", () => {});
    try {
      expect(await sqlstate(() => agent.query(`select id from crm.contacts`))).toBe("42501");
      expect(await sqlstate(() => agent.query(`select email_address from crm.contacts`))).toBe(
        "42501",
      );
    } finally {
      await agent.end().catch(() => {});
    }
  });
});
