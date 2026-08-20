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
import { executeCall, type ApprovalSpine, type CallResult } from "../src/executor.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { decide } from "../../approval/src/decide.js";
import { placeCallPayloadSchema } from "../../approval/src/proposal.js";

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let cleanup: () => Promise<void>;

const SPINE: ApprovalSpine = {
  beginExecution,
  finishExecution,
  parsePayload: (input) => {
    const r = placeCallPayloadSchema.safeParse(input);
    return r.success
      ? { ok: true, value: r.data }
      : { ok: false, problem: r.error.issues.map((i) => i.path.join(".")).join("; ") };
  },
};

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

/** The A2 door played as a REAL external actor: it persists a pending `approval.proposals`
 *  row (owner authority, exactly as the door does) and replays the stored id for a repeated
 *  key. Pin 2 needs the real proposal so `decide`/`executeCall` can drive it terminal. */
function realisticDoor() {
  const posted: DoorProposal[] = [];
  const post = async (p: DoorProposal): Promise<{ id: string }> => {
    posted.push(p);
    const ins = await admin.query<{ id: string }>(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, now() + interval '72 hours')
       on conflict (tenant_id, idempotency_key) do nothing
       returning id`,
      [TEST_TENANT, p.idempotency_key, p.action_type, JSON.stringify(p.payload), p.rationale,
        payloadHash(p.payload)],
    );
    if (ins.rowCount === 1) return { id: ins.rows[0].id };
    const existing = await admin.query<{ id: string }>(
      `select id from approval.proposals where tenant_id = $1 and idempotency_key = $2`,
      [TEST_TENANT, p.idempotency_key],
    );
    return { id: existing.rows[0].id };
  };
  return { posted, post };
}

/** The OTHER half of the non-atomicity the proposer's header discloses: the door POST
 *  SUCCEEDS and the local `follow_up_actions` write dies. A fault-injection seam at the db
 *  boundary, the mirror of the throwing `postProposal` seam. Reads/writes are otherwise the
 *  real `switchboard_crm` pool — nothing is stubbed out. */
function failOnActionInsert(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return async (text: unknown, params?: unknown): Promise<unknown> => {
          if (typeof text === "string" && text.includes("insert into crm.follow_up_actions")) {
            throw new Error("killed after the door POST, before the local action write");
          }
          return (target.query as (t: unknown, p?: unknown) => Promise<unknown>)(text, params);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
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
  const u = new URL(db.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approval = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approval.on("error", () => {});
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
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (approval) await approval.end().catch(() => {});
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

describe("Family 3 / Pin 4 — LEGACY-ORPHAN heal (the row that predates the fix)", () => {
  // The orphan a PRE-DEPLOY crash left behind: a zero-action day-D row on disk, the contact's
  // next_due_at already at the day-D+1 lease value. Nothing in this fixture writes lifecycle
  // state — the row is opened through production `openFollowUp` and `next_due_at` is set at
  // contact CREATION (seedContact's `dueAt`), which is input construction, not forgery.
  //
  // 🚨 I-1: the discriminating assertion is the HEAL — the SAME follow-up row resumed, an
  // action recorded against it, the contact not silenced. Reverting the fix does NOT mint a
  // twin; the guard suppresses the cycle outright.
  //
  // mutation: `const dueDate = adopted ?? claimedDate;` -> `const dueDate = claimedDate;`
  //   -> red. RUN ✅ 2026-08-12
  //   AssertionError: expected [] to have a length of 1 but got +0
  //     ❯ test/family3.test.ts:257  expect(outcome.actions).toHaveLength(1)
  //   restored -> 7 passed.
  it("resumes the same row and records an action instead of silencing the contact", async () => {
    const { tPre, tPost } = crossMidnightClock();
    expect(dueDateIn(tPost, TZ)).not.toBe(dueDateIn(tPre, TZ));
    const frozen = dueDateIn(tPre, TZ);

    // The pre-deploy orphan: contact due at the surviving 15-minute lease value (00:11 on
    // day D+1), plus the day-D zero-action row the crashed cycle committed.
    const lease = new Date(tPre.getTime() + 15 * 60_000);
    const c = await seedContact(admin, { dueAt: lease.toISOString() });
    await seedNumber(admin, c, "+639171234567");
    const legacy = await openFollowUp(crm, c, frozen);
    expect(await openZeroActionFollowUpDate(crm, c)).toBe(frozen);

    // One cross-midnight cycle at 00:20 on day D+1.
    const door = fakeDoor();
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, now: () => tPost },
      TEST_TENANT,
      10,
    );

    // THE HEAL — reds under the revert mutation (the guard returns actions: []).
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0].followUpId).toBe(legacy.id); // the SAME row, resumed
    expect(outcome.dueDate).toBe(frozen); // the frozen date, not the rolled one
    expect(outcome.skipped).toHaveLength(0);

    const acts = await actionRows(c);
    expect(acts).toHaveLength(1);
    expect(acts[0].follow_up_id).toBe(legacy.id);

    // Belt-and-suspenders only (true in BOTH fixed and mutated code — never the red signal):
    expect(await followUpRows(c)).toHaveLength(1);
    expect(door.byKey.size).toBe(1);
  });
});

describe("Family 3 / Pin 2 — CLOSE LINKAGE across midnight (door wrote, local write died)", () => {
  // The other half of the disclosed non-atomicity: the door POST SUCCEEDS (a real pending
  // `approval.proposals` row, p_A, under the day-D key) and the local `follow_up_actions`
  // insert dies. The durable residue is a zero-action day-D orphan whose proposal already
  // exists at the door.
  //
  // 🚨 REVIEW M-1 + I-1 (BINDING): this pin carries NO "called-at-most-once / double-call"
  // framing. A second call is structurally impossible in this open-first ordering — under the
  // revert mutation the guard suppresses cycle N+1 before any POST, so no p_B is ever minted.
  // The single discriminating property is the HEAL AND ITS LINKAGE: cycle N+1 adopts the
  // frozen date, replays the same key, the door returns p_A's id, the action row links p_A,
  // and executing p_A therefore CLOSES the follow-up and sets the real interval clock. Under
  // the mutation there is no action row at all, so p_A can never close anything and
  // `closed_at` stays null for ever.
  //
  // mutation: `const dueDate = adopted ?? claimedDate;` -> `const dueDate = claimedDate;`
  //   -> red. RUN ✅ 2026-08-12
  //   AssertionError: expected [] to have a length of 1 but got +0
  //     ❯ test/family3.test.ts:403  expect(outcome.actions).toHaveLength(1)
  //   restored -> 8 passed.
  it("the healed cycle links p_A, so the executed call closes the row and sets the clock", async () => {
    const { tPre, tPost } = crossMidnightClock();
    expect(dueDateIn(tPost, TZ)).not.toBe(dueDateIn(tPre, TZ));
    const frozen = dueDateIn(tPre, TZ);

    const c = await seedContact(admin, { dueAt: tPre.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    // Cycle N at 23:56: the door WRITES p_A; the local action insert is killed.
    const door = realisticDoor();
    await expect(
      runCycle(
        { db: failOnActionInsert(crm), postProposal: door.post, now: () => tPre },
        TEST_TENANT,
        10,
      ),
    ).rejects.toThrow("before the local action write");
    const pA = (
      await admin.query<{ id: string }>(
        `select id from approval.proposals where tenant_id = $1 and idempotency_key = $2`,
        [TEST_TENANT, `followup:${c}:${frozen}:call`],
      )
    ).rows[0].id;
    expect(await actionRows(c)).toHaveLength(0); // the zero-action orphan, proposal already live
    expect(await openZeroActionFollowUpDate(crm, c)).toBe(frozen);

    // Cycle N+1 at 00:20 on day D+1, same door.
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, now: () => tPost },
      TEST_TENANT,
      10,
    );

    // THE HEAL AND ITS LINKAGE — reds under the revert mutation (actions: [], nothing linked).
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0].proposalId).toBe(pA); // the SAME proposal, replayed, not a twin
    const acts = await actionRows(c);
    expect(acts).toHaveLength(1);
    expect(acts[0].proposal_id).toBe(pA);

    // Her approval, then the production executed path — which is what closes the row.
    const approver = (
      await admin.query<{ id: string }>(
        `insert into approval.users (email) values ($1) returning id`,
        [`broker-${randomUUID()}@example.com`],
      )
    ).rows[0].id;
    await decide(approval, { proposalId: pA, kind: "approved", approverUserId: approver });
    const answered: CallResult = {
      transport: { sipStatus: 200, amdResult: "human" },
      conversation: "identity_confirmed_complete",
    };
    await executeCall(
      {
        approvalDb: approval,
        crmDb: crm,
        spine: SPINE,
        window: { windowStart: "00:00:00", windowEnd: "23:59:00", timezone: TZ },
        intervals: { defaultIntervalDays: SETTINGS.intervalDays, shortRetryDays: SETTINGS.shortRetryDays },
        // Piece 1 (call allowlist): the number this file dials, injected exactly as the
        // composition root does. Additive only — no assertion in this file changed.
        phoneAllowlist: ["+639171234567"],
        now: () => tPost,
        placeCall: async (ctx) => {
          for (const [i, p] of ctx.prompts.entries()) await ctx.answer(p.id, `a${i}`);
          return answered;
        },
      },
      pA,
    );

    // Closed THROUGH the executed proposal, and the clock is `recordTouch`'s interval — never
    // the close-pass's start-of-tomorrow re-propose value.
    const rows = await followUpRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].closed_at).not.toBeNull();
    const nextDue = (
      await admin.query<{ next_due_at: Date | null }>(
        `select next_due_at from crm.contacts where id = $1`,
        [c],
      )
    ).rows[0].next_due_at;
    expect(nextDue).not.toBeNull();
    expect(nextDue!.getTime() - tPost.getTime()).toBeGreaterThan(20 * 86_400_000);

    // Belt-and-suspenders only (true under BOTH the fix and the mutation — never the red):
    const proposals = await admin.query<{ n: string }>(
      `select count(*) as n from approval.proposals where tenant_id = $1`,
      [TEST_TENANT],
    );
    expect(Number(proposals.rows[0].n)).toBe(1);
  });
});

describe("Family 3 / Pin 3 — ZERO-ACTION vs IN-FLIGHT discrimination (two-sided)", () => {
  // The NOT EXISTS filter is the whole safety of the fix. Both sides are pinned, each with
  // its own mutation ON THE PREDICATE (`followups.ts`), not on the adoption line — Pin 1/2/4
  // already cover reverting adoption. Widening the predicate re-serves a live card; inverting
  // it strands the orphan. Neither failure is a double call.

  // mutation: drop the zero-action filter — delete the `and not exists (...)` clause from
  //           openZeroActionFollowUpDate (crm/src/followups.ts:172-173) -> red. RUN ✅ 2026-08-12
  //   AssertionError: expected [ { channel: 'call', …(5) } ] to have a length of +0 but got 1
  //     ❯ test/family3.test.ts:501  expect(outcome.actions).toHaveLength(0)
  //   The in-flight row's date is adopted, the guard falls through, and the card she is
  //   still holding is re-served. restored -> 10 passed.
  it("an IN-FLIGHT (has-action) earlier row stays suppressed across midnight", async () => {
    const { tPre, tPost } = crossMidnightClock();
    expect(dueDateIn(tPost, TZ)).not.toBe(dueDateIn(tPre, TZ));

    const c = await seedContact(admin, { dueAt: tPre.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    // Cycle N: a NORMAL, complete cycle at 23:56 — the row is open WITH its call action, a
    // live card awaiting her decision.
    const door = fakeDoor();
    const [first] = await runCycle(
      { db: crm, postProposal: door.post, now: () => tPre },
      TEST_TENANT,
      10,
    );
    expect(first.actions).toHaveLength(1);
    // (the predicate itself is unit-pinned in the Task 1 block; asserting it here too would
    // short-circuit the widening mutation before it could reach the BEHAVIOUR below, which is
    // what this pin is actually for.)

    // Cycle N+1 across midnight: the guard must still suppress it.
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, now: () => tPost },
      TEST_TENANT,
      10,
    );
    expect(outcome.actions).toHaveLength(0); // ← the red under the widening mutation
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.skipped[0].reason).toMatch(/earlier due date/);
    expect(await actionRows(c)).toHaveLength(1); // no second action row
    expect(door.byKey.size).toBe(1);
  });

  // mutation: invert the filter to require an action — `not exists` -> `exists`
  //           (crm/src/followups.ts:172) -> red. RUN ✅ 2026-08-12
  //   AssertionError: expected [] to have a length of 1 but got +0
  //     ❯ test/family3.test.ts:534  expect(outcome.actions).toHaveLength(1)
  //   The orphan is never adopted, so hasOpenFollowUpBefore(day D+1) suppresses it for ever
  //   — the permanent silence this family exists to kill. restored -> 10 passed.
  it("the reciprocal: a ZERO-ACTION orphan IS adopted and healed", async () => {
    const { tPre, tPost } = crossMidnightClock();
    const frozen = dueDateIn(tPre, TZ);

    const c = await seedContact(admin, { dueAt: tPre.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    const crash = capturingCrashDoor();
    await expect(
      runCycle({ db: crm, postProposal: crash.post, now: () => tPre }, TEST_TENANT, 10),
    ).rejects.toThrow("killed at the door");
    // (predicate unit-pinned in the Task 1 block — asserting it here would short-circuit the
    // inverting mutation before it reached the BEHAVIOUR this pin exists to guard.)

    const door = fakeDoor();
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, now: () => tPost },
      TEST_TENANT,
      10,
    );
    expect(outcome.actions).toHaveLength(1); // ← the red under the inverting mutation
    expect(outcome.dueDate).toBe(frozen);
    expect(await actionRows(c)).toHaveLength(1);
  });
});

describe("Family 3 / Pin 5 — PAYLOAD + RATIONALE byte-stability across midnight", () => {
  // Defensive: the frozen key only dedups if the door ACCEPTS the replay, and the door
  // compares the payload fingerprint (422 on mismatch). Nothing in the proposal may vary
  // with the wall clock. Today it does not — the call payload carries no date, and the
  // rationale's only date is the LAST-TOUCH date, unchanged when nothing executed between
  // the cycles. This pin stops a future edit from quietly breaking that.
  //
  // 🚨 REVIEW M-2 (BINDING): compare the captured DoorProposal.payload and .rationale
  // directly (the proposer emits a payload; the DOOR computes the hash), and the mutation
  // must inject a `now()`/AGE-derived token. Injecting the dueDate would NOT red — the fix
  // freezes the dueDate — so a reviewer must not "repair" this pin by switching mutations.
  //
  // mutation: append a now()-derived token to the call rationale in buildCallProposal
  //           (crm/src/proposer.ts): `+ ` · clock ${Date.now()}`` -> red. RUN ✅ 2026-08-12
  //   AssertionError: expected '…(entry 1 of 1). · clock 1786561709122' to be
  //                   '…(entry 1 of 1). · clock 1786561709130' // Object.is equality
  //     ❯ test/family3.test.ts:578  expect(second.rationale).toBe(first.rationale)
  //   restored -> 11 passed.
  //
  // 🚨 MEASURED LIMIT OF THIS PIN, recorded because it was RUN and did NOT red rather than
  // reasoned about. The first mutation attempted was the plan's DAY-granularity age token,
  // `` · clock ${dueDateIn(new Date(), settings.timezone)}``: it PASSED. Both cycles execute
  // milliseconds apart in REAL time — only the INJECTED clock crosses midnight — so a token
  // derived from the real wall clock at day granularity is identical in both. This pin
  // therefore catches (a) fine-grained wall-clock tokens and (b) anything derived from the
  // cycle's own injected clock, but NOT a real-clock day/age token. Widening it would need
  // `deps.now` threaded into buildCallProposal, which is a production change, not a pin. Do
  // not "repair" this pin with a dueDate token either: the fix FREEZES dueDate, so that can
  // never red (review M-2).
  it("the two cycles emit an identical payload and rationale", async () => {
    const { tPre, tPost } = crossMidnightClock();
    expect(dueDateIn(tPost, TZ)).not.toBe(dueDateIn(tPre, TZ));

    const c = await seedContact(admin, { dueAt: tPre.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    const crash = capturingCrashDoor();
    await expect(
      runCycle({ db: crm, postProposal: crash.post, now: () => tPre }, TEST_TENANT, 10),
    ).rejects.toThrow("killed at the door");

    const door = fakeDoor();
    await runCycle({ db: crm, postProposal: door.post, now: () => tPost }, TEST_TENANT, 10);

    const first = crash.posted[0];
    const second = door.posted[0];
    expect(second).toBeDefined();
    expect(second.rationale).toBe(first.rationale);
    expect(second.payload).toEqual(first.payload); // deep, per M-2
    expect(second.action_type).toBe(first.action_type);
    expect(second.idempotency_key).toBe(first.idempotency_key);
  });
});
