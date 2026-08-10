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
  seedNumber,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
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
    const ana = await seedContact(admin, {
      channel: "both",
      email: "ana@example.com",
      dueAt: overdue(),
    });
    await seedNumber(admin, ana, "+639171234567");
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

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
    const ana = await seedContact(admin, {
      channel: "email",
      email: null,
      dueAt: overdue(),
    });
    await seedNumber(admin, ana, "+639171234567"); // a number EXISTS — and is not used
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

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
    const ana = await seedContact(admin, {
      channel: "email",
      email: null,
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const door = fakeDoor();
    await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

    await admin.query(`update crm.contacts set email_address = 'ana@example.com' where id = $1`, [
      ana,
    ]);
    await admin.query(`update crm.contacts set next_due_at = now() - interval '1 minute'`);
    const [second] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

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

describe("T9: the open-guard", () => {
  // mutation: drop the `hasOpenFollowUp` check -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     error: duplicate key value violates unique constraint "follow_ups_one_open"
  //   — 016's partial unique index catches it one layer down, which is the right place for
  //   it to be caught but not a reason to drop the application guard: the DB refusal aborts
  //   the cycle rather than skipping one contact.
  it("does not propose again for a contact mid-cycle, even with the clock moved back", async () => {
    const ana = await seedContact(admin, { dueAt: overdue() });
    await seedNumber(admin, ana, "+639171234567");
    const door = fakeDoor();
    await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);
    await admin.query(`update crm.contacts set next_due_at = now() - interval '30 days'`);

    const [second] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);
    expect(second.actions).toHaveLength(0);
    expect(second.skipped[0].reason).toMatch(/open follow-up/);
    expect(door.posted).toHaveLength(1);
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
