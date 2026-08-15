// Bounce reconciliation / pins — migration `018_bounced_disposition.sql`.
//
// 🚨 RED BY MEASUREMENT, NOT BY ABSENCE. Before 018 exists, the first pin measures `23514`
// (check violation) rather than "module not found" — the exact idiom of the 017 pins one
// file over. Every write below goes through the `crm` pool — `switchboard_crm`, the role
// the bounce reconciler actually connects as — because a pin that widens a CHECK while the
// executing role lacks the privilege to write the new value is a pin over a universe the
// shipped code cannot reach.
//
// Nothing here writes to the named `switchboard` database: `freshCrmDb()` creates its own
// ephemeral database and drops it.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { freshCrmDb, seedContact, sqlstate } from "./helpers/crmdb.js";

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
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

/** An email touch inserted through the CRM role, in the shipped shape (no phone, no
 *  question set). Returns the touch id. */
async function emailTouch(contactId: string): Promise<string> {
  const r = await crm.query<{ id: string }>(
    `insert into crm.touches (contact_id, channel) values ($1, 'email') returning id`,
    [contactId],
  );
  return r.rows[0].id;
}

describe("018: 'bounced' is a representable disposition", () => {
  // mutation: delete the `'bounced'` literal from 018's rebuilt CHECK -> red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 2 passed (3)`
  //     AssertionError: expected '23514' to be 'NO-ERROR'
  //   i.e. `switchboard_crm` could not record the refusal at all — the exact state this
  //   task exists to end, measured rather than assumed. (The same output is the pin's
  //   pre-018 RED, observed 2026-08-15 before the migration file existed.)
  it("lets switchboard_crm record an asynchronous refusal as 'bounced'", async () => {
    const contactId = await seedContact(admin, { channel: "email", email: "ana@example.com" });
    const touchId = await emailTouch(contactId);

    const code = await sqlstate(() =>
      crm.query(`update crm.touches set disposition = 'bounced' where id = $1`, [touchId]),
    );
    expect(code).toBe("NO-ERROR");

    // Read back — the value is actually stored, not merely accepted.
    const r = await crm.query<{ disposition: string }>(
      `select disposition from crm.touches where id = $1`,
      [touchId],
    );
    expect(r.rows[0].disposition).toBe("bounced");
  });

  // mutation: replace the CHECK with `check (disposition is not null or true)` -> red.
  //           RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 2 passed (3)`
  //     AssertionError: expected 'NO-ERROR' to be '23514'
  //   i.e. the constraint had been DROPPED rather than widened, and `'delivered'` — the one
  //   word this repo may never write — became storable.
  it("still refuses a disposition that is not a member of the list", async () => {
    const contactId = await seedContact(admin, { channel: "email", email: "ana@example.com" });
    const touchId = await emailTouch(contactId);

    const code = await sqlstate(() =>
      crm.query(`update crm.touches set disposition = 'delivered' where id = $1`, [touchId]),
    );
    expect(code).toBe("23514");
  });

  // The CHECK was WIDENED BY EXACTLY ONE MEMBER, not rebuilt loosely. Each of 017's ten
  // members must still be writable.
  it("keeps all ten prior dispositions writable", async () => {
    const contactId = await seedContact(admin, { channel: "call" });
    for (const d of [
      "answered",
      "partial",
      "wrong_person",
      "voicemail",
      "unknown_answer",
      "no_answer",
      "busy",
      "declined",
      "failed",
      "sent",
    ]) {
      const r = await crm.query<{ id: string }>(
        `insert into crm.touches (contact_id, channel, transcript_delivery)
         values ($1, 'call', 'pending') returning id`,
        [contactId],
      );
      const code = await sqlstate(() =>
        crm.query(`update crm.touches set disposition = $2 where id = $1`, [r.rows[0].id, d]),
      );
      expect(code, `disposition ${d}`).toBe("NO-ERROR");
    }
  });
});
