// Core loop / Family 3 — the CROSS-MIDNIGHT orphan heal: freeze the idempotency key by
// reading back `crm.follow_ups.due_date`.
//
// The defect (root-cause-fix-research.md): the door key `followup:{contact}:{dueDate}:{ch}`
// derives `dueDate` from `claimedDueAt`, which on a RETRY is the lease-advanced
// `next_due_at`. A cycle that crashes after `openFollowUp` but before/at the door POST at
// 23:56 Manila leaves a zero-action orphan at day D while the lease value is past midnight
// — so the retry derives day D+1, the date-aware guard counts the day-D orphan
// (`due_date < $2`) and SUPPRESSES the contact FOR EVER. Same Manila day this self-heals
// (`no-silence.test.ts` ORPH); across midnight it never did, until this fix.
//
// The fix is a READ-BACK, not new storage: before deriving the key, adopt the `due_date` of
// the contact's open, unblocked, ZERO-ACTION follow-up row (the orphan discriminator) so the
// retry re-derives the identical key and the door dedups. No migration, no new grant.
//
// 🚨 REVIEW I-1 (BINDING, family3-fix-plan-review.md): in this OPEN-FIRST ordering,
// reverting the fix causes SILENCE, never a double call. The guard suppresses the
// cross-midnight retry BEFORE any POST, so under the revert mutation `byKey.size` stays 1
// and `next_due_at` is never dragged to tomorrow — those assertions are true in both fixed
// and mutated code and are kept only as belt-and-suspenders. THE discriminating assertion in
// every pin is the HEAL: orphan adopted → same key → door replays → action recorded →
// follow-up closes. Do NOT re-aim any pin at `byKey.size === 2`; that pin can never red.
//
// Every pin drives PRODUCTION `claimDue`/`runCycle`/`proposeForClaimed` with an injected
// clock crossing a real Manila midnight and the real 15-minute lease. NO fixture writes
// `crm.*` lifecycle state (`next_due_at` after creation, `closed_at`, proposal state);
// constructing the pre-crash inputs (a contact due at 23:56, a crash at the door seam) is
// input construction, exactly like the shipped ORPH test.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { freshCrmDb, seedContact, seedNumber, seedSettings, TEST_TENANT } from "./helpers/crmdb.js";
import { publishQuestionSet } from "../src/questions.js";
import { runCycle, dueDateIn, type DoorProposal } from "../src/proposer.js";
import {
  openFollowUp,
  blockFollowUp,
  openZeroActionFollowUpDate,
} from "../src/followups.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

const SETTINGS = { intervalDays: 30, shortRetryDays: 3 };
const TZ = "Asia/Manila";

/** The next Manila midnight at least `marginMs` in the future. Asia/Manila is UTC+8 with no
 *  DST, so the arithmetic is exact — and the premise (the two cycles land on DIFFERENT
 *  Manila dates) is asserted inside each pin rather than assumed. */
function nextManilaMidnight(after: Date, marginMs = 2 * 3600_000): Date {
  const MANILA_OFFSET_MS = 8 * 3600_000;
  const DAY_MS = 86_400_000;
  const local = after.getTime() + marginMs + MANILA_OFFSET_MS;
  return new Date(Math.ceil(local / DAY_MS) * DAY_MS - MANILA_OFFSET_MS);
}

/** tPre = 23:56 Manila on day D (the pre-midnight cycle); tPost = 00:20 Manila on day D+1
 *  (after the 15-minute lease from tPre, which ends 00:11). */
function crossMidnightClock(): { tPre: Date; tPost: Date } {
  const mid = nextManilaMidnight(new Date());
  return { tPre: new Date(mid.getTime() - 4 * 60_000), tPost: new Date(mid.getTime() + 20 * 60_000) };
}

/** The A2 door as the shipped fake models it: 201-fresh mints an id, a replayed key returns
 *  the SAME id (`no-silence.test.ts` discipline). */
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

/** Captures the DoorProposal then crashes — the crash-between-open-and-POST external actor.
 *  `openFollowUp` has already committed the row, so the crash leaves the zero-action orphan
 *  the whole family is about, with `next_due_at` still at the REAL lease value. */
function capturingCrashDoor() {
  const posted: DoorProposal[] = [];
  return {
    posted,
    post: async (p: DoorProposal): Promise<{ id: string }> => {
      posted.push(p);
      throw new Error("killed at the door, after openFollowUp");
    },
  };
}

const followUpRows = async (
  contactId: string,
): Promise<Array<{ id: string; due_date: string; blocked_reason: string | null; closed_at: Date | null }>> =>
  (
    await admin.query<{ id: string; due_date: string; blocked_reason: string | null; closed_at: Date | null }>(
      `select id, due_date::text as due_date, blocked_reason, closed_at
         from crm.follow_ups where contact_id = $1 order by due_date`,
      [contactId],
    )
  ).rows;

const actionRows = async (
  contactId: string,
): Promise<Array<{ follow_up_id: string; channel: string; proposal_id: string }>> =>
  (
    await admin.query<{ follow_up_id: string; channel: string; proposal_id: string }>(
      `select fa.follow_up_id, fa.channel, fa.proposal_id
         from crm.follow_up_actions fa
         join crm.follow_ups f on f.id = fa.follow_up_id
        where f.contact_id = $1`,
      [contactId],
    )
  ).rows;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, SETTINGS);
  await publishQuestionSet(admin, TEST_TENANT, [
    { key: "budget", prompt: "What budget range?", kind: "text" },
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

describe("Family 3 / Task 1 — openZeroActionFollowUpDate discriminates the orphan", () => {
  it("returns the due_date of an open, unblocked, zero-action row", async () => {
    const c = await seedContact(admin);
    await openFollowUp(crm, c, "2026-08-10");
    expect(await openZeroActionFollowUpDate(crm, c)).toBe("2026-08-10");
  });

  it("returns null once the row has an action (in-flight, guard's business)", async () => {
    const c = await seedContact(admin);
    const f = await openFollowUp(crm, c, "2026-08-10");
    await crm.query(
      `insert into crm.follow_up_actions (follow_up_id, channel, proposal_id)
       values ($1, 'call', $2) on conflict (follow_up_id, channel) do nothing`,
      [f.id, randomUUID()],
    );
    expect(await openZeroActionFollowUpDate(crm, c)).toBeNull();
  });

  it("returns null when the contact has no open row", async () => {
    const c = await seedContact(admin);
    expect(await openZeroActionFollowUpDate(crm, c)).toBeNull();
  });

  it("returns null when the only row is blocked (surfaced state, never adopted)", async () => {
    const c = await seedContact(admin);
    await blockFollowUp(crm, c, "2026-08-10", "no_phone_number");
    expect(await openZeroActionFollowUpDate(crm, c)).toBeNull();
  });

  it("picks the orphan when a blocked row coexists (one_open covers only unblocked rows)", async () => {
    const c = await seedContact(admin);
    await blockFollowUp(crm, c, "2026-08-09", "no_phone_number");
    await openFollowUp(crm, c, "2026-08-10");
    expect(await openZeroActionFollowUpDate(crm, c)).toBe("2026-08-10");
  });
});

describe("Family 3 / Pin 1 — KEY-STABILITY across Manila midnight (the direct root pin)", () => {
  // mutation: revert the adoption — `const dueDate = adopted ?? claimedDate;` ->
  //           `const dueDate = claimedDate;` (proposer.ts).
  // 🚨 I-1: under this mutation the failure mode is SILENCE, not a rolled key. Cycle N+1
  // derives day D+1, the date-aware guard counts the day-D orphan (`due_date < $2`) and
  // returns BEFORE openFollowUp or any POST — so no second key is ever POSTed. The red is
  // the ABSENT second POST (`expected +0 to be 1`), never `byKey.size === 2`, which is
  // structurally impossible open-first and must not become this pin's target.
  //
  // mutation: `const dueDate = adopted ?? claimedDate;` -> `const dueDate = claimedDate;`
  //   -> red. RUN ✅ 2026-08-12
  //   AssertionError: expected [] to have a length of 1 but got +0
  //     ❯ test/family3.test.ts:215  expect(door.posted).toHaveLength(1)
  //   restored -> 6 passed.
  it("the cross-midnight retry POSTs again, and the key is byte-identical", async () => {
    const { tPre, tPost } = crossMidnightClock();
    // The premise, asserted rather than assumed: the two cycles are on DIFFERENT Manila days.
    expect(dueDateIn(tPost, TZ)).not.toBe(dueDateIn(tPre, TZ));

    const c = await seedContact(admin, { dueAt: tPre.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    // Cycle N at 23:56 Manila: the REAL claim writes the lease (tPre + 15min = 00:11 D+1),
    // openFollowUp commits the day-D row, the door crashes after capturing the ask.
    const crash = capturingCrashDoor();
    await expect(
      runCycle({ db: crm, postProposal: crash.post, now: () => tPre }, TEST_TENANT, 10),
    ).rejects.toThrow("killed at the door");
    expect(crash.posted).toHaveLength(1);
    expect(crash.posted[0].idempotency_key).toBe(`followup:${c}:${dueDateIn(tPre, TZ)}:call`);
    const orphan = await followUpRows(c);
    expect(orphan).toHaveLength(1);
    expect(orphan[0].blocked_reason).toBeNull();
    expect(orphan[0].closed_at).toBeNull(); // the zero-action orphan, at day D

    // Cycle N+1 at 00:20 Manila, day D+1 (the lease has expired), working door.
    const door = fakeDoor();
    await runCycle({ db: crm, postProposal: door.post, now: () => tPost }, TEST_TENANT, 10);
    expect(door.posted).toHaveLength(1); // ← reds under the mutation: suppressed, no POST at all
    expect(door.posted[0].idempotency_key).toBe(crash.posted[0].idempotency_key); // byte-identical
  });
});
