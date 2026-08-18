// Core loop / V3 — the STRUCTURAL fix for the permanent-silence class (Option B).
//
// The bug recurred three times because the follow-up row opened BEFORE we knew there was any
// work to do. When every leg resolved to nothing (a `call`/`both` contact with no phone
// number, or no active question set), the row was left OPEN, UNBLOCKED, ACTION-LESS — the
// close pass (an INNER JOIN through follow_up_actions) could never see it, and the date-aware
// guard silenced the contact the next Manila day. Option B opens the row only once ≥1 leg is
// buildable; a non-actionable contact yields a BLOCKED row (surfaced, guard-excluded,
// recoverable) or none, and can never strand.
//
// Every case is driven through PRODUCTION `runCycle`/`proposeForClaimed` with an injected
// clock and a real/throwing `postProposal` seam. NO `admin.query` writes `crm.*` lifecycle
// state.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  freshCrmDb,
  seedContact,
  seedLinkedSheet,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { FakeSheet } from "./helpers/fakesheet.js";
import { addContact, addNumber } from "../src/intake.js";
import { publishQuestionSet } from "../src/questions.js";
import { runCycle, proposeForClaimed, type DoorProposal } from "../src/proposer.js";
import { claimDue } from "../src/claim.js";
import { reconcile } from "../src/reconcile.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

const SETTINGS = { intervalDays: 30, shortRetryDays: 3 };

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

const cycle = async (contactId: string, vnow: Date) => {
  const door = fakeDoor();
  const out = await runCycle({ db: crm, postProposal: door.post, now: () => vnow }, TEST_TENANT, 10);
  return { outcome: out.find((o) => o.contactId === contactId), door };
};

const blockedReasonsFor = async (contactId: string): Promise<string[]> => {
  const r = await admin.query<{ blocked_reason: string }>(
    `select blocked_reason from crm.follow_ups
      where contact_id = $1 and blocked_reason is not null and closed_at is null`,
    [contactId],
  );
  return r.rows.map((x) => x.blocked_reason);
};

const openUnblockedCount = async (contactId: string): Promise<number> =>
  Number(
    (
      await admin.query<{ n: string }>(
        `select count(*) as n from crm.follow_ups
          where contact_id = $1 and closed_at is null and blocked_reason is null`,
        [contactId],
      )
    ).rows[0].n,
  );

const onBlocked = async (contactId: string): Promise<boolean> =>
  (await reconcile(admin)).blockedFollowUps.some((b) => b.contactId === contactId);

const T0 = () => new Date(Date.now() + 60_000);
const plusDays = (base: Date, n: number): Date => new Date(base.getTime() + n * 86_400_000);

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, SETTINGS);
  // A tenant-global active question set exists by default (so no-number tests block on the
  // NUMBER, not the set). NQ retires it explicitly.
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
  await admin.query("delete from crm.linked_sheets");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("V3 Test NP — call, no phone number: BLOCKED, never silenced, recovers", () => {
  // 🚨 THE MUTATION THAT WOULD HAVE CAUGHT THIS. Revert to Option A: open the row
  // unconditionally instead of blocking when zero legs build — `if (buildable.length === 0)`
  // -> `if (false && buildable.length === 0)`.
  // RUN ✅ 2026-08-11
  //   Observed: `Tests  6 failed | 2 passed (8)` — every case that must block reds:
  //     NP: `expected null to be 'no_phone_number'`   (Option A opens an unblocked row and
  //         records no block; day 3 the date-aware guard silences the contact for ever)
  //     NQ: `expected null to be 'no_question_set'`
  //     BB: `expected null to be 'no_phone_number'`
  //     ORPH(b): `expected null to be 'no_phone_number'` + an unblocked orphan is left
  //     NONE: `expected 1 to be +0`  (a `none` contact opens a row under Option A)
  it("blocks no_phone_number, stays surfaced across days, recovers when a number is added", async () => {
    const t0 = T0();
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Ana Reyes",
      channel: "call",
      source: "referral",
    });

    // Cycle 1: no number → zero legs → blocked, NO unblocked open row.
    const c1 = await cycle(c.id, t0);
    expect(c1.outcome?.actions).toHaveLength(0);
    expect(c1.outcome?.blockedReason).toBe("no_phone_number");
    expect(await openUnblockedCount(c.id)).toBe(0); // the whole point: no action-less open row
    expect(await blockedReasonsFor(c.id)).toContain("no_phone_number");
    expect(await onBlocked(c.id)).toBe(true);

    // Two days later (past the one-day self-heal window): still blocked, NOT a bare skip.
    const c2 = await cycle(c.id, plusDays(t0, 2));
    expect(c2.outcome?.actions).toHaveLength(0);
    expect(c2.outcome?.blockedReason).toBe("no_phone_number");
    expect(await openUnblockedCount(c.id)).toBe(0);
    expect(await onBlocked(c.id)).toBe(true);

    // She adds a number through production intake. Next cycle recovers.
    await addNumber(admin, c.id, "+639171234567");
    const c3 = await cycle(c.id, plusDays(t0, 3));
    expect(c3.outcome?.actions).toHaveLength(1); // 🚨 recovered — never silenced
  });
});

describe("V3 Test NQ — call with number, no active question set: BLOCKED (tenant-global), recovers", () => {
  // mutation: same Option-A revert (`if (buildable.length === 0)` -> `if (false && …)`) ->
  //           red. RUN ✅ 2026-08-11 (see Test NP for the full 6-failure output)
  //     NQ line: `expected null to be 'no_question_set'`
  it("blocks no_question_set and recovers when a set is authored", async () => {
    // Retire the tenant's only set so there is no active one.
    await admin.query(`update crm.question_sets set retired_at = now() where tenant_id = $1`, [
      TEST_TENANT,
    ]);
    const t0 = T0();
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Ben Cruz",
      channel: "call",
      source: "event",
    });
    await addNumber(admin, c.id, "+639179999999");

    const c1 = await cycle(c.id, t0);
    expect(c1.outcome?.actions).toHaveLength(0);
    expect(c1.outcome?.blockedReason).toBe("no_question_set");
    expect(await openUnblockedCount(c.id)).toBe(0);
    expect(await onBlocked(c.id)).toBe(true);

    // The surface AGGREGATES no_question_set — one line, not one per contact.
    const rep = await reconcile(admin);
    const noSet = rep.blockedFollowUps.filter((b) => b.reason === "no_question_set");
    expect(noSet.length).toBeGreaterThanOrEqual(1);

    // She authors a set. Recovery on the same-day row (16 min later so the lease has expired,
    // still the same Manila day so the due date — and the row — are the same).
    await publishQuestionSet(admin, TEST_TENANT, [
      { key: "budget", prompt: "What budget range?", kind: "text" },
    ]);
    const c2 = await cycle(c.id, new Date(t0.getTime() + 16 * 60_000));
    expect(c2.outcome?.actions).toHaveLength(1);
  });
});

describe("V3 Test BB — both, both arms fail: BLOCKED; but a partial gap is NOT a silence", () => {
  // mutation: Option-A revert -> red. RUN ✅ 2026-08-11 (see Test NP output)
  //     BB line: `expected null to be 'no_phone_number'`
  it("blocks when both, no address and no number", async () => {
    const t0 = T0();
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Cora Lim",
      channel: "both",
      source: "referral",
      emailAddress: null,
    });
    const c1 = await cycle(c.id, t0);
    expect(c1.outcome?.actions).toHaveLength(0);
    // Primary reason: the call-arm gap outranks the email-arm one.
    expect(c1.outcome?.blockedReason).toBe("no_phone_number");
    expect(await openUnblockedCount(c.id)).toBe(0);
    expect(await onBlocked(c.id)).toBe(true);
  });

  it("P4a control: both WITH address, no number → email builds → ≥1 action, NOT blocked", async () => {
    // SHEET-BOUND since Part 2 / migration 022: an email leg can only build from a live
    // sheet row (a manual contact's email leg now blocks with the honest not-on-the-sheet
    // reason — proposer-sheet.test.ts P10). The P4a property under pin is unchanged: a
    // partial gap on a contact that produced ≥1 action is data-completeness, not silence.
    const t0 = T0();
    const linked = await seedLinkedSheet(admin);
    const ref = randomUUID();
    const sheet = new FakeSheet(linked.spreadsheetId, ["Name", "Email", "Contact #"], [
      { ref, cells: ["Dina Ong", "dina@example.com", ""] }, // address, no number
    ]);
    const cId = await seedContact(admin, {
      displayName: "Dina Ong",
      channel: "both",
      email: "dina@example.com",
      dueAt: t0.toISOString(),
      linkedSheetId: linked.id,
      rowRef: ref,
    });
    const door = fakeDoor();
    const out = await runCycle(
      { db: crm, postProposal: door.post, now: () => t0, sheet },
      TEST_TENANT,
      10,
    );
    const outcome = out.find((o) => o.contactId === cId);
    expect(outcome?.actions.map((a) => a.channel)).toEqual(["email"]);
    expect(outcome?.blockedReason).toBeNull();
    expect(await openUnblockedCount(cId)).toBe(1); // a normal, healthy open row
    expect(await blockedReasonsFor(cId)).toEqual([]);
  });
});

describe("V3 Test ORPH — crash orphan is transient for actionable, impossible for non-actionable", () => {
  // mutation: Option-A revert -> the non-actionable crash leaves an unblocked orphan that
  //           strands -> red. RUN ✅ 2026-08-11 (see Test NP output)
  //     ORPH(b) line: `expected null to be 'no_phone_number'` — under Option A the crashing
  //     door is never reached (all legs fail), so an unblocked action-less row is left and
  //     nothing is blocked: the exact permanent strand.
  it("(a) actionable contact self-heals the same-date orphan through production", async () => {
    const t0 = T0();
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Elmo Rey",
      channel: "call",
      source: "referral",
    });
    await addNumber(admin, c.id, "+639171112222");
    // The door throws AFTER openFollowUp inserts the row (an external seam failure).
    const crashing = async (): Promise<{ id: string }> => {
      throw new Error("killed between open and POST");
    };
    await expect(
      runCycle({ db: crm, postProposal: crashing, now: () => t0 }, TEST_TENANT, 10),
    ).rejects.toThrow();
    expect(await openUnblockedCount(c.id)).toBe(1); // an actionable orphan exists

    // Same Manila day, working door: the same row resumes and gets its action.
    const t0b = new Date(t0.getTime() + 16 * 60_000);
    const c2 = await cycle(c.id, t0b);
    expect(c2.outcome?.actions).toHaveLength(1);
    expect(await openUnblockedCount(c.id)).toBe(1); // same row, now actioned
  });

  it("(b) non-actionable contact NEVER opens an unblocked row, even under a crashing door", async () => {
    const t0 = T0();
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Fely Uy",
      channel: "call",
      source: "referral",
    });
    // No number → zero legs → blocked BEFORE any open, so the crashing door is never reached.
    const crashing = async (): Promise<{ id: string }> => {
      throw new Error("must not be called");
    };
    const out = await runCycle({ db: crm, postProposal: crashing, now: () => t0 }, TEST_TENANT, 10);
    expect(out.find((o) => o.contactId === c.id)?.blockedReason).toBe("no_phone_number");
    expect(await openUnblockedCount(c.id)).toBe(0); // 🚨 never any unblocked row to strand
  });
});

describe("V3 Test NONE — a `none` contact yields no row and no block", () => {
  it("returns cleanly with nothing opened or blocked", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Gus Tan",
      channel: "none",
      source: "manual",
    });
    // `none` is never claimed by claimDue; call proposeForClaimed directly to prove the
    // defensive return.
    const out = await proposeForClaimed(
      { db: crm, postProposal: async () => ({ id: randomUUID() }), now: () => T0() },
      TEST_TENANT,
      { id: c.id, claimedDueAt: T0() },
    );
    expect(out.actions).toHaveLength(0);
    expect(out.blockedReason).toBeNull();
    expect(await openUnblockedCount(c.id)).toBe(0);
    expect(await blockedReasonsFor(c.id)).toEqual([]);
  });

  it("claimDue never returns a `none` contact anyway", async () => {
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      channel: "none",
      source: "manual",
    });
    const claimed = await claimDue(crm, TEST_TENANT, 10, new Date(Date.now() + 60_000));
    expect(claimed.map((x) => x.id)).not.toContain(c.id);
  });
});

describe("V3 Test SUPERSEDE — exactly one CRM card per (contact, due_date, channel)", () => {
  // This is the invariant that makes excluding — or including — `superseded` safe: a CRM
  // follow-up action can never actually BE superseded, because the proposer emits one
  // deterministic-keyed card per (contact, due_date, channel) and the door replays it. If
  // that ever broke, `approveCard` could collapse a duplicate and leave a `superseded` CRM
  // action (Critical-1 all over again).
  //
  // mutation: append `Date.now()` to `idempotencyKey` (`proposer.ts`) — two distinct cards
  //           become constructible -> red. RUN ✅ 2026-08-11
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected 2 to be 1  (the door now holds two distinct card ids for
  //     the same contact/due-date/channel — the collapsible duplicate that makes a
  //     superseded CRM action possible)
  it("proposing the same follow-up twice yields ONE card id, one action row", async () => {
    const t0 = T0();
    const c = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Hana Sy",
      channel: "call",
      source: "referral",
    });
    await addNumber(admin, c.id, "+639173334444");

    // One shared door across both cycles, so a replayed key returns the SAME id.
    const door = fakeDoor();
    const run = (vnow: Date) =>
      runCycle({ db: crm, postProposal: door.post, now: () => vnow }, TEST_TENANT, 10);

    await run(t0);
    // 16 min later, same Manila day → same due date → the deterministic key replays.
    await run(new Date(t0.getTime() + 16 * 60_000));

    expect(door.byKey.size).toBe(1); // ONE card ever constructed — the invariant
    const actions = await admin.query<{ n: string }>(
      `select count(*) as n from crm.follow_up_actions fa
         join crm.follow_ups f on f.id = fa.follow_up_id where f.contact_id = $1`,
      [c.id],
    );
    expect(actions.rows[0].n).toBe("1"); // one action row (unique per channel)
  });
});
