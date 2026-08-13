// Core loop / T5 pins — the touch lifecycle and the clock.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { freshCrmDb, seedContact, seedSettings, TEST_TENANT } from "./helpers/crmdb.js";
import { beginTouch, recordTouch, type Disposition } from "../src/touch.js";
import { blockFollowUp, openFollowUp } from "../src/followups.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

const SETTINGS = { defaultIntervalDays: 30, shortRetryDays: 3 };

const dueAt = async (id: string): Promise<Date> => {
  const r = await admin.query<{ next_due_at: Date }>(
    `select next_due_at from crm.contacts where id = $1`,
    [id],
  );
  return r.rows[0].next_due_at;
};
const daysFromNow = (d: Date): number =>
  Math.round((d.getTime() - Date.now()) / 86_400_000) + 0;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, SETTINGS);
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

async function callAndRecord(
  contactId: string,
  disposition: Disposition,
  proposalId?: string,
): Promise<void> {
  const t = await beginTouch(crm, {
    contactId,
    channel: "call",
    proposalId: proposalId ?? null,
  });
  await recordTouch(crm, t, { disposition }, SETTINGS);
}

describe("T5: which dispositions earn the long interval", () => {
  // mutation: use the short interval for ALL dispositions
  //           (`LONG_INTERVAL_DISPOSITIONS = new Set()`) -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  4 failed | 5 passed (9)` — every long-interval property at once:
  //     AssertionError: expected 3 to be 30   (tenant default)
  //     AssertionError: expected 3 to be 7    (per-contact override)
  //     AssertionError: expected 3 to be 30   (sibling-once, both halves)
  it("advances an answered call by exactly follow_up_interval_days", async () => {
    const ana = await seedContact(admin);
    await callAndRecord(ana, "answered");
    expect(daysFromNow(await dueAt(ana))).toBe(30);
  });

  it("honours a per-contact override over the tenant default", async () => {
    const ana = await seedContact(admin, { intervalDays: 7 });
    await callAndRecord(ana, "answered");
    expect(daysFromNow(await dueAt(ana))).toBe(7);
  });

  // mutation: treat voicemail as answered
  //           (`LONG_INTERVAL_DISPOSITIONS = new Set(["answered","voicemail"])`) -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected 30 to be 3 // Object.is equality
  //   SOURCED (LiveKit): "Voicemail systems answer the call at the SIP layer with a 200 OK."
  //   Treating that as contact means a machine that picked up buys the prospect a full
  //   interval of silence — the failure this product exists to fix, caused by us.
  it("gives voicemail the SHORT retry", async () => {
    const ana = await seedContact(admin);
    await callAndRecord(ana, "voicemail");
    expect(daysFromNow(await dueAt(ana))).toBe(3);
  });

  // mutation: treat wrong_person as a successful contact
  //           (add it to LONG_INTERVAL_DISPOSITIONS) -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected 30 to be 3 // Object.is equality
  //   The spouse answers, the lead is marked contacted, and the REAL prospect waits another
  //   full interval. Precisely the failure the product exists to fix, caused by us.
  it("gives wrong_person the SHORT retry, never the long one", async () => {
    const ana = await seedContact(admin);
    await callAndRecord(ana, "wrong_person");
    expect(daysFromNow(await dueAt(ana))).toBe(3);
  });

  it("gives every other non-answered disposition the short retry", async () => {
    for (const d of [
      "partial",
      "unknown_answer",
      "no_answer",
      "busy",
      "declined",
      "failed",
    ] as Disposition[]) {
      const c = await seedContact(admin);
      await callAndRecord(c, d);
      expect([d, daysFromNow(await dueAt(c))]).toEqual([d, 3]);
    }
  });
});

describe("T5: two channels reset the clock ONCE", () => {
  // mutation: reset per-touch — drop the `siblingAlreadySucceeded` check -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 7 passed (9)`
  //     AssertionError: expected true to be false   (the second touch advanced too)
  //     AssertionError: expected 3 to be 30         (and a later FAILING sibling dragged
  //                                                  the successful reset back to 3 days) `channel = 'both'` produces two proposals
  //   sharing one follow_up_id; each advancing on its own puts the contact two intervals
  //   into the future for one cycle of contact — silently, and in the direction the product
  //   exists to prevent.
  it("does not advance a second time when the sibling channel also succeeds", async () => {
    const ana = await seedContact(admin, { channel: "both", email: "ana@example.com" });
    const fu = await openFollowUp(admin, ana, new Date().toISOString().slice(0, 10));
    const callProposal = "11111111-1111-1111-1111-111111111111";
    const emailProposal = "22222222-2222-2222-2222-222222222222";
    await admin.query(
      `insert into crm.follow_up_actions (follow_up_id, channel, proposal_id)
       values ($1,'call',$2), ($1,'email',$3)`,
      [fu.id, callProposal, emailProposal],
    );

    const t1 = await beginTouch(crm, {
      contactId: ana,
      channel: "call",
      proposalId: callProposal,
    });
    const first = await recordTouch(crm, t1, { disposition: "answered" }, SETTINGS);
    expect(first.advancedClock).toBe(true);
    const afterFirst = await dueAt(ana);

    const t2 = await beginTouch(crm, {
      contactId: ana,
      channel: "email",
      proposalId: emailProposal,
    });
    const second = await recordTouch(crm, t2, { disposition: "answered" }, SETTINGS);
    expect(second.advancedClock).toBe(false);
    expect((await dueAt(ana)).getTime()).toBe(afterFirst.getTime());
    expect(daysFromNow(await dueAt(ana))).toBe(30); // not 60
  });

  it("does not let a failing sibling drag a successful reset back to a short retry", async () => {
    const ana = await seedContact(admin, { channel: "both", email: "ana@example.com" });
    const fu = await openFollowUp(admin, ana, new Date().toISOString().slice(0, 10));
    const callProposal = "33333333-3333-3333-3333-333333333333";
    const emailProposal = "44444444-4444-4444-4444-444444444444";
    await admin.query(
      `insert into crm.follow_up_actions (follow_up_id, channel, proposal_id)
       values ($1,'call',$2), ($1,'email',$3)`,
      [fu.id, callProposal, emailProposal],
    );
    const t1 = await beginTouch(crm, { contactId: ana, channel: "call", proposalId: callProposal });
    await recordTouch(crm, t1, { disposition: "answered" }, SETTINGS);
    const t2 = await beginTouch(crm, {
      contactId: ana,
      channel: "email",
      proposalId: emailProposal,
    });
    await recordTouch(crm, t2, { disposition: "failed" }, SETTINGS);
    expect(daysFromNow(await dueAt(ana))).toBe(30);
  });
});

describe("T5: a blocked follow-up does not reset the clock", () => {
  // mutation: have `blockFollowUp` also write `next_due_at` (i.e. treat a block as a
  //           contact) -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected 1786584806589 to be 1786325606558 — i.e. the block moved
  //     next_due_at three days out.
  //   A block is the ABSENCE of contact. Advancing on it silences the contact for an
  //   interval because we could not act — the anti-silence record becoming a silencer,
  //   which is exactly the shape B4 caught in the index.
  it("leaves next_due_at where it was", async () => {
    const ana = await seedContact(admin, { channel: "email", email: null });
    const before = await dueAt(ana);
    await blockFollowUp(crm, ana, new Date().toISOString().slice(0, 10), "no_email_address");
    expect((await dueAt(ana)).getTime()).toBe(before.getTime());
    expect(daysFromNow(await dueAt(ana))).toBe(0);
  });
});

describe("T5: the row exists from call start, with a NULL disposition", () => {
  it("inserts pending delivery and no disposition, so answers can land during the call", async () => {
    const ana = await seedContact(admin);
    const t = await beginTouch(crm, { contactId: ana, channel: "call" });
    const r = await admin.query<{ disposition: string | null; transcript_delivery: string }>(
      `select disposition, transcript_delivery from crm.touches where id = $1`,
      [t],
    );
    expect(r.rows[0].disposition).toBeNull();
    expect(r.rows[0].transcript_delivery).toBe("pending");
    void TEST_TENANT;
  });
});

// ── Email spike / Task 2 ─────────────────────────────────────────────────────────────
describe("Email spike: 'sent' earns the long interval", () => {
  // mutation: remove `"sent"` from LONG_INTERVAL_DISPOSITIONS -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  2 failed | 9 passed (11)`
  //     AssertionError: expected 3 to be 30   (tenant default)
  //     AssertionError: expected 3 to be 7    (per-contact override)
  //   i.e. a submitted email fell back to the three-day short retry — the contact emailed
  //   today and emailed again on Friday.
  //
  // 🚨 THE ASSERTION IS ON THE INTERVAL AND THE PERSISTED DATE, not on `advancedClock`.
  // A pin asserting only `advancedClock === true` stays GREEN under that mutation — the
  // short-retry branch also advances the clock. `next_due_at` is read back from the
  // database; nothing here writes it.
  it("advances a submitted email by the long interval, persisted", async () => {
    const ana = await seedContact(admin, { channel: "email", email: "ana@example.com" });
    const t = await beginTouch(crm, { contactId: ana, channel: "email" });
    const recorded = await recordTouch(crm, t, { disposition: "sent" }, SETTINGS);

    expect(recorded.intervalDaysUsed).toBe(SETTINGS.defaultIntervalDays);
    expect(daysFromNow(await dueAt(ana))).toBe(SETTINGS.defaultIntervalDays);
  });

  it("honours a per-contact override for a submitted email too", async () => {
    const ana = await seedContact(admin, {
      channel: "email",
      email: "ana@example.com",
      intervalDays: 7,
    });
    const t = await beginTouch(crm, { contactId: ana, channel: "email" });
    const recorded = await recordTouch(crm, t, { disposition: "sent" }, SETTINGS);

    expect(recorded.intervalDaysUsed).toBe(7);
    expect(daysFromNow(await dueAt(ana))).toBe(7);
  });
});
