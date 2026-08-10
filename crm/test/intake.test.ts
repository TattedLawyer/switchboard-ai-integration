// Core loop / T3 pins — capture.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { freshCrmDb, seedSettings, TEST_TENANT } from "./helpers/crmdb.js";
import { addContact, addNumber, isAddNumberError } from "../src/intake.js";
import { resolveIntervalDays } from "../src/due.js";

let admin: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  cleanup = db.cleanup;
  await seedSettings(admin, { intervalDays: 30, shortRetryDays: 3 });
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("T3: the same line in two formats is ONE number", () => {
  // mutation: key the existence check on `phone_raw` instead of `phone_e164`
  //           (`where contact_id = $1 and phone_raw = $3`) -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     error: duplicate key value violates unique constraint
  //            "phone_numbers_one_per_contact"   (at src/intake.ts:121, the INSERT)
  //   Worth reading carefully, because the red is BETTER than the one predicted: keyed on
  //   `phone_raw` the application's dedupe misses, reaches the INSERT, and 016's
  //   `unique (contact_id, phone_e164)` refuses it. The app check is belt-and-braces over
  //   the constraint, not the only thing standing between her and two rows for one line —
  //   which would have the rotation dial the same household twice in two cycles.
  it("stores one row and preserves the FIRST phone_raw she typed", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Ana Reyes",
      channel: "call",
      source: "referral",
    });
    const first = await addNumber(admin, c.id, "0917-123-4567");
    const second = await addNumber(admin, c.id, "+63 917 123 4567");
    expect(isAddNumberError(first)).toBe(false);
    expect(isAddNumberError(second)).toBe(false);
    if (isAddNumberError(first) || isAddNumberError(second)) return;

    const rows = await admin.query<{ phone_raw: string; phone_e164: string }>(
      `select phone_raw, phone_e164 from crm.phone_numbers where contact_id = $1`,
      [c.id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].phone_e164).toBe("+639171234567");
    expect(rows.rows[0].phone_raw).toBe("0917-123-4567");
    expect(second.alreadyPresent).toBe(true);
    expect(second.phoneRaw).toBe("0917-123-4567");
    expect(second.id).toBe(first.id);
  });

  it("orders numbers by the order she entered them", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      channel: "call",
      source: "event",
    });
    const a = await addNumber(admin, c.id, "0917-123-4567", { label: "mobile" });
    const b = await addNumber(admin, c.id, "(02) 8123 4567", { label: "office" });
    if (isAddNumberError(a) || isAddNumberError(b)) throw new Error("unexpected refusal");
    expect(a.ordinal).toBe(0);
    expect(b.ordinal).toBe(1);
  });

  it("refuses an unreadable number rather than storing one nobody can dial", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      channel: "call",
      source: "manual",
    });
    const r = await addNumber(admin, c.id, "call me at the office");
    expect(isAddNumberError(r)).toBe(true);
  });
});

describe("T3: a missing field must never cost her a lead", () => {
  // mutation: reject at intake — `if (channel === "email" && !emailAddress) throw` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     Error: a contact preferring email must have an address
  //   Rejecting LOSES THE LEAD, which is the failure being fixed. The missing address
  //   surfaces later as a blocked follow-up she can see and fix (§5.4).
  it("accepts channel='email' with no address on file", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Ana Reyes",
      channel: "email",
      source: "referral",
      emailAddress: null,
    });
    const row = await admin.query<{ channel: string; email_address: string | null }>(
      `select channel, email_address from crm.contacts where id = $1`,
      [c.id],
    );
    expect(row.rows[0].channel).toBe("email");
    expect(row.rows[0].email_address).toBeNull();
  });

  it("accepts a contact with no display_name at all", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: null,
      channel: "call",
      source: "referral",
    });
    const row = await admin.query<{ display_name: string | null }>(
      `select display_name from crm.contacts where id = $1`,
      [c.id],
    );
    expect(row.rows[0].display_name).toBeNull();
  });

  it("makes a newly captured lead due immediately", async () => {
    const before = Date.now();
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      channel: "call",
      source: "event",
    });
    expect(c.nextDueAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(c.nextDueAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

describe("T3: a NULL interval means HERS, resolved at due-computation time", () => {
  // mutation: backfill the tenant default into the column at insert —
  //           `input.followUpIntervalDays ?? tenantDefault` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected 30 to be null
  //   and, had the column assertion been softened, the SECOND half of this test is the one
  //   that matters: with 30 frozen into the row, changing her default to 45 leaves this
  //   contact on 30 forever. A setting that appears to work and does not.
  it("leaves the column NULL and follows a later change to her default", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      channel: "call",
      source: "referral",
    });
    const row = await admin.query<{ follow_up_interval_days: number | null }>(
      `select follow_up_interval_days from crm.contacts where id = $1`,
      [c.id],
    );
    expect(row.rows[0].follow_up_interval_days).toBeNull();

    // Today's setting.
    expect(
      resolveIntervalDays({
        contactIntervalDays: row.rows[0].follow_up_interval_days,
        tenantDefaultDays: 30,
      }),
    ).toBe(30);

    // She changes it. The contact captured BEFORE the change follows it.
    await admin.query(
      `update crm.outreach_settings set default_interval_days = 45 where tenant_id = $1`,
      [TEST_TENANT],
    );
    const s = await admin.query<{ default_interval_days: number }>(
      `select default_interval_days from crm.outreach_settings where tenant_id = $1`,
      [TEST_TENANT],
    );
    expect(
      resolveIntervalDays({
        contactIntervalDays: row.rows[0].follow_up_interval_days,
        tenantDefaultDays: s.rows[0].default_interval_days,
      }),
    ).toBe(45);
    await admin.query(
      `update crm.outreach_settings set default_interval_days = 30 where tenant_id = $1`,
      [TEST_TENANT],
    );
  });

  it("honours a per-contact override when she sets one", () => {
    expect(resolveIntervalDays({ contactIntervalDays: 7, tenantDefaultDays: 30 })).toBe(7);
  });
});
