// Core loop / T9 pins — the proposer.
//
// The door is FAKED here, and faked FAITHFULLY: a retry of the same idempotency key returns
// the SAME id, which is the door's published behaviour. A fake that minted a new id per
// call would make the idempotency pin below pass for the wrong reason.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  freshCrmDb,
  seedContact,
  seedLinkedSheet,
  seedNumber,
  seedSettings,
  TEST_INSTANT,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { FakeSheet } from "./helpers/fakesheet.js";
import { publishQuestionSet } from "../src/questions.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import { placeCallPayloadSchema } from "../../approval/src/proposal.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

/** The A2 door, faithfully faked: same key -> same id. */
function fakeDoor() {
  const byKey = new Map<string, string>();
  const posted: DoorProposal[] = [];
  return {
    posted,
    byKey,
    post: async (p: DoorProposal): Promise<{ id: string }> => {
      posted.push(p);
      const existing = byKey.get(p.idempotency_key);
      if (existing !== undefined) return { id: existing };
      const id = randomUUID();
      byKey.set(p.idempotency_key, id);
      return { id };
    },
  };
}

const overdue = () => new Date(Date.now() - 86_400_000).toISOString();

/** A SHEET-BOUND contact whose details live on a FakeSheet row.
 *
 *  WHY THE EMAIL-LEG TESTS BELOW CHANGED (Part 2 / migration 022): the proposer now reads
 *  email/name/context LIVE from the linked sheet, and `switchboard_crm` cannot SELECT the
 *  stored detail columns at all (42501, pinned in migration-022.test.ts). A MANUAL email
 *  contact therefore blocks with the honest not-on-the-sheet reason (pinned in
 *  proposer-sheet.test.ts P10), so every pin about the email leg's CONTENT or about
 *  `no_email_address` must drive a sheet-bound contact — the only kind whose address the
 *  proposer is permitted to see. The properties pinned are unchanged.
 */
async function sheetContact(o: {
  name?: string;
  email?: string;
  phone?: string;
  channel?: "call" | "email" | "both";
  dueAt?: string;
}): Promise<{ contactId: string; ref: string; sheet: FakeSheet }> {
  const linked = await seedLinkedSheet(admin);
  const ref = randomUUID();
  const sheet = new FakeSheet(linked.spreadsheetId, ["Name", "Email", "Contact #"], [
    { ref, cells: [o.name ?? "Ana Reyes", o.email ?? "", o.phone ?? ""] },
  ]);
  const contactId = await seedContact(admin, {
    displayName: o.name ?? "Ana Reyes",
    email: o.email ?? null,
    channel: o.channel ?? "email",
    dueAt: o.dueAt ?? overdue(),
    linkedSheetId: linked.id,
    rowRef: ref,
  });
  return { contactId, ref, sheet };
}

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, { intervalDays: 30, shortRetryDays: 3 });
  await publishQuestionSet(admin, TEST_TENANT, [
    { key: "budget", prompt: "What budget range are you working with?", kind: "text" },
  ]);
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.linked_sheets");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("T9: the same follow-up proposes ONCE per channel", () => {
  // mutation: append `Date.now()` to the idempotency key -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected 'followup:e38720c3-…' to be 'followup:e38720c3-…'
  //     — same contact, same date, same channel, different key.
  //
  // A time-varying key turns ONE ask into a new card every cycle — the flood the door's
  // unique index exists to stop, arriving from the inside.
  it("returns the same proposal id when the cycle is re-run for the same due date", async () => {
    const ana = await seedContact(admin, { dueAt: overdue() });
    await seedNumber(admin, ana, "+639171234567");
    const door = fakeDoor();

    const first = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);
    expect(first[0].actions).toHaveLength(1);
    const firstId = first[0].actions[0].proposalId;

    // Make it due again immediately, and clear the open-guard the way a completed cycle
    // would: the point of this pin is the KEY, not the guard.
    await admin.query(`update crm.contacts set next_due_at = now() - interval '1 day'`);
    await admin.query(`update crm.follow_ups set closed_at = now()`);
    const second = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);
    expect(second[0].actions[0].idempotencyKey).toBe(first[0].actions[0].idempotencyKey);
    expect(second[0].actions[0].proposalId).toBe(firstId);
    expect(door.byKey.size).toBe(1);
  });
});

describe("T9: channel='both' is TWO proposals sharing one follow_up", () => {
  // mutation: emit ONE composite proposal for `both` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected [ 'call' ] to deeply equal [ 'call', 'email' ]
  //
  // §5.3, dispositive: `executions_one_start` admits exactly ONE started execution per
  // proposal, so a composite call+email proposal would need two — which means relaxing the
  // at-most-once guarantee (never) or inventing a sub-action layer beneath proposals, i.e.
  // a SECOND APPROVAL SPINE. The product agrees: the channels have different execution-time
  // gates, partial failure is representable, and divergent decisions are a feature.
  it("emits a call and an email under one follow_up_id", async () => {
    // Sheet-bound since Part 2: the email leg's address is readable only from the sheet.
    const { contactId: ana, sheet } = await sheetContact({
      channel: "both",
      email: "ana@example.com",
      phone: "0917 123 4567",
    });
    await seedNumber(admin, ana, "+639171234567");
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);

    expect(outcome.actions.map((a) => a.channel).sort()).toEqual(["call", "email"]);
    expect(new Set(outcome.actions.map((a) => a.followUpId)).size).toBe(1);
    expect(new Set(outcome.actions.map((a) => a.proposalId)).size).toBe(2);
    expect(door.posted.map((p) => p.action_type).sort()).toEqual(["place_call", "send_email"]);
  });
});

describe("T9: email preferred, no address on file", () => {
  // mutation: fall back to calling when the address is missing -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 8 passed (10)` —
  //     AssertionError: expected null to be 'no_email_address'   (nothing recorded)
  //     AssertionError: expected [] to deeply equal [ 'email' ]  (and the recovery pin
  //                     collapses too, because there was never a block to recover from)
  //
  // Overriding her stated preference at the moment we have LEAST information is the worst
  // available outcome. The block is recorded and surfaced; the clock is untouched, so the
  // moment she types the address the next cycle proceeds.
  it("records a blocked follow-up, emits nothing, and never calls", async () => {
    // Sheet-bound since Part 2: `no_email_address` is a statement about HER SHEET ROW —
    // the only address the proposer can see — so the pin drives a row with no email cell.
    // (The manual-contact variant now blocks with the honest not-on-the-sheet reason,
    // pinned in proposer-sheet.test.ts P10.)
    const { contactId: ana, sheet } = await sheetContact({
      channel: "email",
      email: "",
      phone: "0917 123 4567",
    });
    await seedNumber(admin, ana, "+639171234567"); // a number EXISTS — and is not used
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);

    expect(outcome.blockedReason).toBe("no_email_address");
    expect(outcome.actions).toHaveLength(0);
    expect(door.posted).toHaveLength(0);
    const r = await admin.query<{ blocked_reason: string | null }>(
      `select blocked_reason from crm.follow_ups where contact_id = $1`,
      [ana],
    );
    expect(r.rows[0].blocked_reason).toBe("no_email_address");
  });

  // The B-B recovery, end to end through the proposer.
  it("recovers on the next cycle once she adds the address, on the SAME row", async () => {
    // Both cycles must land on the SAME due-date for this to be the recovery path rather
    // than an ordinary next-day row — so "a minute ago", not "yesterday".
    const { contactId: ana, sheet } = await sheetContact({
      channel: "email",
      email: "",
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const door = fakeDoor();
    await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);

    // She types the address INTO THE SHEET (Part 2: the master list is hers). No adoption
    // pass runs between the cycles — the proposer reads the address live, while the
    // stored column stays empty and, post-022, unreadable.
    sheet.rows[1].cells[1] = "ana@example.com";
    await admin.query(`update crm.contacts set next_due_at = now() - interval '1 minute'`);
    const [second] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);

    expect(second.blockedReason).toBeNull();
    expect(second.actions.map((a) => a.channel)).toEqual(["email"]);
    const rows = await admin.query<{ n: string }>(
      `select count(*) as n from crm.follow_ups where contact_id = $1`,
      [ana],
    );
    expect(rows.rows[0].n).toBe("1"); // ONE row — the recovery is an UPDATE, not an insert
  });
});

describe("T9: a missing name must never cost her a follow-up", () => {
  // mutation: block the call when `display_name is null` (rev 3's rejected `no_contact_name`
  //           path) -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected [] to have a length of 1 but got +0
  //     — the call is silently not proposed, i.e. a missing field costs her the follow-up.
  //
  // Owner, rev 4: "nope if the number has no name just introduce yourself as an associate
  // of the end user." My blocking proposal was REJECTED. Label the uncertainty; do not
  // withhold the call.
  it("still proposes a call, from her nameless line, flagged identity-unverified", async () => {
    const nameless = await seedContact(admin, { displayName: null, dueAt: overdue() });
    await seedNumber(admin, nameless, "+639179999999");
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0].identityUnverified).toBe(true);
    const payload = door.posted[0].payload;
    expect(payload.display_name).toBeNull();
    expect(payload.opening_line).toBe(
      "Hi, I'm an associate of Marisol Cruz at Alabang Realty — do you have a moment?",
    );
    // …and it is a payload the door would actually accept.
    expect(placeCallPayloadSchema.safeParse(payload).success).toBe(true);
    expect(door.posted[0].rationale).toMatch(/identity-unverified/);
  });

  // mutation: always render from `opening_line_no_name` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected true to be false   (a named contact flagged
  //                     identity-unverified, and her name never spoken)
  it("uses her NAMED line, substituted, for a contact who has a name", async () => {
    const ana = await seedContact(admin, { displayName: "Ana Reyes", dueAt: overdue() });
    await seedNumber(admin, ana, "+639171234567");
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

    expect(outcome.actions[0].identityUnverified).toBe(false);
    const payload = door.posted[0].payload as Record<string, unknown>;
    expect(payload.opening_line).toContain("Ana Reyes");
    expect(payload.opening_line).not.toContain("{name}");
  });
});

describe("T9: the date-aware open-guard (C1 fix)", () => {
  // 🚨 REWRITTEN FOR C1. The previous test moved `next_due_at` back 30 days by an admin
  // write and asserted the contact was STILL skipped — which is exactly the C1 bug it should
  // have caught: a date-independent guard that silences the contact for ever after the first
  // open row. Moving `next_due_at` backwards is also forged system-owed state (review I2).
  //
  // The corrected guard skips only on an open row from an EARLIER due date; a same-date
  // re-claim RESUMES. Both are driven here through production code with an injected clock —
  // no admin write to `crm.*`, no `next_due_at` forged. `now()` in `claimDue` is the injected
  // `vnow`, because Postgres's clock cannot be moved by vitest fake timers.
  //
  // mutation: revert the guard to date-independent — `hasOpenFollowUpBefore`'s WHERE back to
  //           `contact_id = $1 and closed_at is null and blocked_reason is null` with
  //           `[contactId]` -> red. RUN ✅ 2026-08-10
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected [] to have a length of 1 but got +0
  //   — the same-date orphan is SKIPPED instead of resumed, which is the date-independent
  //   lifetime-lock C1 is. (A first, sloppy attempt dropped only the clause and left the
  //   `$2` bind, reddening on "bind message supplies 2 parameters" — a wrong-reason red;
  //   the mutation above is the honest full revert.)
  // 🚨 SEEDED FROM `TEST_INSTANT` (11:00 Manila), NEVER THE MACHINE CLOCK. Seeded from
  // `new Date()`, this fixture silently stopped constructing the scenario it names for the
  // last ~16 minutes of every Manila day: cycle 1's 15-minute lease crossed Manila midnight,
  // cycle 2's due date became D+1 (an EARLIER open row), and production's SKIP was then
  // CORRECT for the scenario actually built — the test red for its own defect, daily.
  // `claimDue` is fully parameterized (predicate and lease both bind `$4`), so a fixed
  // instant plus the injected `vnow` is sufficient; no database-side clock is involved.
  // fixture fix RUN ✅ 2026-08-16, red reconstructed at shifted clock 15:50Z (Manila 23:50):
  //   Observed (pre-fix, filtered run): `Tests  1 failed | 9 skipped (10)`
  //     AssertionError: expected [] to have a length of 1 but got +0   (at c2, the resume)
  //   Post-fix, same shifted clock, whole file: `Tests  11 passed (11)`.
  // guard mutation RE-RUN ✅ 2026-08-16 against the fixed fixture (filtered run):
  //   Observed: `Tests  1 failed | 10 skipped (11)`
  //     AssertionError: expected [] to have a length of 1 but got +0
  it("resumes a same-date orphan but skips an in-flight earlier cycle", async () => {
    let vnow = new Date(TEST_INSTANT.getTime() + 60_000);
    const now = (): Date => vnow;
    const deps = { db: crm, postProposal: undefined as never, now };

    const ana = await seedContact(admin, { dueAt: TEST_INSTANT.toISOString() });
    await seedNumber(admin, ana, "+639171234567");
    const door = fakeDoor();

    // Cycle 1 (day 0): opens the row for D0 and proposes. Left in-flight — NOT executed —
    // so the row stays open and the lease anchors next_due_at at ~D0.
    const c1 = await runCycle({ ...deps, postProposal: door.post }, TEST_TENANT, 10);
    expect(c1[0].actions).toHaveLength(1);
    const d0Key = c1[0].actions[0].idempotencyKey;

    // Day 1: the lease has expired, the card is still pending. The re-claim's pre-update due
    // date is still D0 (the lease value), so this cycle's due date is D0 — SAME date. The
    // guard falls through and the orphan/in-flight row RESUMES: the door replays the same id,
    // one follow-up row, one proposal.
    vnow = new Date(vnow.getTime() + 24 * 3600_000);
    const c2 = await runCycle({ ...deps, postProposal: door.post }, TEST_TENANT, 10);
    expect(c2[0].actions).toHaveLength(1);
    expect(c2[0].actions[0].idempotencyKey).toBe(d0Key); // same date, same key — a replay
    expect(door.byKey.size).toBe(1);
    const rows1 = await admin.query<{ n: string }>(
      `select count(*) as n from crm.follow_ups where contact_id = $1`,
      [ana],
    );
    expect(rows1.rows[0].n).toBe("1");

    // Day 2: the card is STILL pending. Now the re-claim's pre-update due date is D1 (cycle
    // 2's lease), so this cycle's due date is D1 while the open row is at D0 — an EARLIER
    // in-flight cycle. The guard skips: no second card while one is genuinely pending.
    vnow = new Date(vnow.getTime() + 24 * 3600_000);
    const c3 = await runCycle({ ...deps, postProposal: door.post }, TEST_TENANT, 10);
    expect(c3[0].actions).toHaveLength(0);
    expect(c3[0].skipped[0].reason).toMatch(/earlier due date/);
  });
});

describe("T9: the rationale renders the last touch in HER timezone", () => {
  // mutation: render `occurred_at` via its UTC date (the pre-fix
  //           `toISOString`-prefix form) -> red. RUN ✅ 2026-08-16
  //   Observed: `Tests  1 failed | 10 passed (11)`
  //     AssertionError: expected 'Ana Reyes is due: last contacted 2026-0…' to contain
  //                     'last contacted 2026-08-10'   (it said 2026-08-09 — the previous
  //                     Manila day, permanently, on the field the human reads to decide)
  //
  // The touch instant is 17:30Z = 01:30 Manila NEXT day. Every bounce the reconciler
  // appends overnight and every off-window execution lands in that 00:00–08:00 Manila band.
  it("shows the Manila date for a touch that occurred 00:00-08:00 Manila", async () => {
    const ana = await seedContact(admin, { dueAt: overdue() });
    await seedNumber(admin, ana, "+639171234567");
    await admin.query(
      `insert into crm.touches (contact_id, channel, transcript_delivery, disposition, occurred_at)
       values ($1, 'call', 'sent', 'no_answer', '2026-08-09T17:30:00Z')`,
      [ana],
    );
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

    expect(outcome.actions).toHaveLength(1);
    expect(door.posted[0].rationale).toContain("last contacted 2026-08-10");
  });
});

describe("T9: the dial rotation", () => {
  // mutation: always pick ordinal 0 -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected [ '+639171111111', …(3) ] to deeply equal
  //                     [ '+639171111111', …(3) ]  — the same line four cycles running.
  //
  // The list rotates ACROSS cycles, never within one (§5.1): an approved proposal names ONE
  // number in an immutable payload, so dialling the second mid-execution would place a call
  // the human never approved — and three calls in ninety seconds to three lines of one
  // household burns the referral goodwill that is her entire lead source.
  it("advances through the numbers by ordinal across cycles", async () => {
    const ana = await seedContact(admin, { dueAt: overdue() });
    await seedNumber(admin, ana, "+639171111111", 0);
    await seedNumber(admin, ana, "+639172222222", 1);
    await seedNumber(admin, ana, "+639173333333", 2);
    const door = fakeDoor();

    const picks: string[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      await admin.query(`update crm.contacts set next_due_at = now() - interval '1 day'`);
      await admin.query(`update crm.follow_ups set closed_at = now()`);
      const [o] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);
      picks.push(o.actions[0].phoneE164 as string);
      await admin.query(
        `update crm.contacts set dial_rotation_ordinal = dial_rotation_ordinal + 1`,
      );
    }
    expect(picks).toEqual([
      "+639171111111",
      "+639172222222",
      "+639173333333",
      "+639171111111", // modulo, back to the top
    ]);
  });

  // 🚨 M5. mutation: use the stored ordinal directly as an array index —
  //           `numbers[rotation]` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 8 passed (10)`
  //     TypeError: Cannot read properties of undefined (reading 'phone_e164')   (twice)
  //   — a hard crash in the proposer, i.e. the whole cycle dies for every contact, not just
  //   the one whose number she deleted.
  //
  // She deletes a number and the stored rotation index is suddenly past the end. An index
  // straight into the array crashes (or, with a different shape, skips the whole list).
  it("survives a number being deleted mid-rotation", async () => {
    const ana = await seedContact(admin, { dueAt: overdue() });
    await seedNumber(admin, ana, "+639171111111", 0);
    const second = await seedNumber(admin, ana, "+639172222222", 1);
    await seedNumber(admin, ana, "+639173333333", 2);
    await admin.query(`update crm.contacts set dial_rotation_ordinal = 2 where id = $1`, [ana]);
    // She removes one.
    await admin.query(`delete from crm.phone_numbers where id = $1`, [second]);

    const door = fakeDoor();
    const [o] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);
    expect(o.actions).toHaveLength(1);
    expect(o.actions[0].phoneE164).toBe("+639171111111"); // 2 % 2 = 0
  });
});

describe("T9: the rationale says why THIS contact is due", () => {
  // mutation: emit a constant rationale -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     AssertionError: expected 'Follow up with this contact.…' to contain 'Ana Reyes'
  //
  // "An instruction wearing a proposal's clothes" (proposal.ts:38-39). A human cannot judge
  // an ask that does not say what it is.
  it("names the last touch, the interval, and which number", async () => {
    const ana = await seedContact(admin, {
      displayName: "Ana Reyes",
      intervalDays: 21,
      dueAt: overdue(),
    });
    await seedNumber(admin, ana, "+639171111111", 0);
    await seedNumber(admin, ana, "+639172222222", 1);
    const door = fakeDoor();
    await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

    const r = door.posted[0].rationale;
    expect(r).toContain("Ana Reyes");
    expect(r).toContain("never contacted");
    expect(r).toContain("21 days");
    expect(r).toContain("+639171111111");
    expect(r).toContain("1 of 2");
  });
});
