// Core loop / C1 — the follow-up LIFECYCLE across cycles, driven end to end through
// production code with NO forged state.
//
// 🚨 THIS IS THE TEST C1 PROVES THE OLD SUITE COULD NOT WRITE. The only multi-cycle test
// that shipped (the rotation pin) hand-wrote `closed_at` and `dial_rotation_ordinal` through
// the admin pool before each cycle — supplying exactly the transition no production code
// performed, which is how a loop that follows up each contact exactly once, ever, shipped
// green.
//
// THE LINE: a fixture may play an EXTERNAL ACTOR — her approval at the door, the vendor's
// `CallResult`, the owner's settings, and the passage of TIME — and may never write state a
// production component owes (`closed_at`, `next_due_at`, `dial_rotation_ordinal`). Read-only
// SELECT assertions are fine; admin WRITES to `crm.*` after setup are forged state.
//
// TIME is injected, because Postgres's `now()` cannot be moved by vitest fake timers
// (process-local — opened: vitest.dev/api/vi). `vnow` threads into `claimDue` and
// `recordTouch` as a SQL parameter.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  freshCrmDb,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { addContact, addNumber } from "../src/intake.js";
import { publishQuestionSet } from "../src/questions.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import { executeCall, type ApprovalSpine, type CallResult } from "../src/executor.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { placeCallPayloadSchema } from "../../approval/src/proposal.js";

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let cleanup: () => Promise<void>;

const SETTINGS = { intervalDays: 30, shortRetryDays: 3 };

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

/**
 * The A2 door, played as an external actor: it persists a PENDING proposal exactly as the
 * real door does (owner pool = the door's write authority), returns its id, and REPLAYS the
 * same id for a repeated idempotency key — 014's `unique (tenant_id, idempotency_key)`. It
 * writes only `approval.*`, never `crm.*`.
 */
function realisticDoor() {
  const post = async (p: DoorProposal): Promise<{ id: string }> => {
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
  return { post };
}

/** The human approving — an input the system never produces for itself, so simulating it is
 *  not forging. Decision row + state move in one transaction, as 015 requires. */
async function approveAtDoor(proposalId: string): Promise<void> {
  const approver = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ($1) returning id`,
    [`broker-${Math.random().toString(36).slice(2)}@example.com`],
  );
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query(
      `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
       values ($1, 'approved', $2, 'seed')`,
      [proposalId, approver.rows[0].id],
    );
    await c.query(`update approval.proposals set state = 'approved' where id = $1`, [proposalId]);
    await c.query("commit");
  } finally {
    c.release();
  }
}

/** Drive one whole cycle for one contact through production: propose → approve → execute
 *  with a fake vendor result. `now` is virtual time. Returns the closed follow-up's due_date. */
async function driveCycle(
  contactId: string,
  vnow: Date,
  result: CallResult,
): Promise<{ proposalId: string }> {
  const door = realisticDoor();
  const cycle = await runCycle({ db: crm, postProposal: door.post, now: () => vnow }, TEST_TENANT, 10);
  const outcome = cycle.find((o) => o.contactId === contactId);
  if (!outcome || outcome.actions.length !== 1) {
    throw new Error(`expected exactly one action for ${contactId}, got ${JSON.stringify(outcome)}`);
  }
  const proposalId = outcome.actions[0].proposalId;
  await approveAtDoor(proposalId);
  await executeCall(
    {
      approvalDb: approval,
      crmDb: crm,
      spine: SPINE,
      window: { windowStart: "00:00:00", windowEnd: "23:59:00", timezone: "Asia/Manila" },
      intervals: { defaultIntervalDays: SETTINGS.intervalDays, shortRetryDays: SETTINGS.shortRetryDays },
      now: () => vnow,
      placeCall: async (ctx) => {
        for (const [i, prompt] of ctx.prompts.entries()) {
          await ctx.answer(prompt.id, `answer ${i}`);
          await ctx.reached(i + 1);
        }
        return result;
      },
    },
    proposalId,
  );
  return { proposalId };
}

const ANSWERED: CallResult = {
  transport: { sipStatus: 200, amdResult: "human" },
  conversation: "identity_confirmed_complete",
};
const NO_ANSWER: CallResult = {
  transport: { sipStatus: 408 },
  conversation: null,
};

const daysFromNow = (d: Date, base: Date): number =>
  Math.round((d.getTime() - base.getTime()) / 86_400_000);

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

describe("C1: the loop follows up MORE THAN ONCE", () => {
  // 🚨 THE PIN THAT WOULD HAVE CAUGHT C1.
  // mutation: delete the close from `recordTouch` — remove the
  //           `if (proposalId !== null) await closeFollowUpForProposal(client, …)` block
  //           -> red. RUN ✅ 2026-08-10 (re-run after wiring the shared helper)
  //   Observed: `Tests  1 failed | 2 skipped (3)` (targeted), `expected null not to be null`
  //     — cycle 1's row stays OPEN; the full-file run also reds the no_answer cycle 2 with
  //     `expected [] to have a length of 1 but got +0` (the contact silenced for ever).
  //   That is C1 verbatim: one follow-up per contact, per lifetime.
  //
  // Every write here is production. The only fixture inputs are her settings, the contact,
  // her approval at the door, the vendor's `answered`, and the passage of 31 virtual days.
  // Nothing writes `closed_at` or `next_due_at` by hand.
  it("closes cycle 1's row on `answered`, then proposes a NEW row 31 days later", async () => {
    const T0 = new Date(Date.now() + 60_000);
    // Setup, external actors only. intake sets next_due_at = now() (due at ~T0).
    const contact = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Ana Reyes",
      channel: "call",
      source: "referral",
    });
    await addNumber(admin, contact.id, "+639171234567");

    // Cycle 1 — the whole thing, through production.
    await driveCycle(contact.id, T0, ANSWERED);

    // Read-only assertions on cycle 1's terminal state.
    const c1row = await admin.query<{ due_date: string; closed_at: Date | null }>(
      `select due_date::text as due_date, closed_at from crm.follow_ups where contact_id = $1`,
      [contact.id],
    );
    expect(c1row.rowCount).toBe(1);
    expect(c1row.rows[0].closed_at).not.toBeNull(); // 🚨 the close C1 never performed
    const due = await admin.query<{ next_due_at: Date }>(
      `select next_due_at from crm.contacts where id = $1`,
      [contact.id],
    );
    expect(daysFromNow(due.rows[0].next_due_at, T0)).toBe(30);

    // Time passes — an input, not system-owed state.
    const T31 = new Date(T0.getTime() + 31 * 86_400_000);

    // Cycle 2 — the assertion the old suite could not make.
    const door = realisticDoor();
    const c2 = await runCycle({ db: crm, postProposal: door.post, now: () => T31 }, TEST_TENANT, 10);
    const out = c2.find((o) => o.contactId === contact.id);
    expect(out?.actions).toHaveLength(1); // 🚨 proposes again — the loop lives
    const rows = await admin.query<{ due_date: string; closed_at: Date | null }>(
      `select due_date::text as due_date, closed_at from crm.follow_ups
        where contact_id = $1 order by due_date`,
      [contact.id],
    );
    expect(rows.rowCount).toBe(2); // a NEW row, not the old one reopened
    expect(rows.rows[0].closed_at).not.toBeNull(); // cycle 1's row untouched
    expect(rows.rows[1].closed_at).toBeNull(); // cycle 2's row open
    expect(rows.rows[0].due_date).not.toBe(rows.rows[1].due_date); // distinct due dates
  });

  it("retries on `no_answer` as a NEW row at the short-retry date", async () => {
    const T0 = new Date(Date.now() + 60_000);
    const contact = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Ben Cruz",
      channel: "call",
      source: "event",
    });
    await addNumber(admin, contact.id, "+639179999999");

    await driveCycle(contact.id, T0, NO_ANSWER);
    const due = await admin.query<{ next_due_at: Date }>(
      `select next_due_at from crm.contacts where id = $1`,
      [contact.id],
    );
    expect(daysFromNow(due.rows[0].next_due_at, T0)).toBe(3); // short retry

    const T4 = new Date(T0.getTime() + 4 * 86_400_000);
    const door = realisticDoor();
    const c2 = await runCycle({ db: crm, postProposal: door.post, now: () => T4 }, TEST_TENANT, 10);
    expect(c2.find((o) => o.contactId === contact.id)?.actions).toHaveLength(1);
    const rows = await admin.query<{ n: string }>(
      `select count(*) as n from crm.follow_ups where contact_id = $1`,
      [contact.id],
    );
    expect(rows.rows[0].n).toBe("2");
  });
});

describe("C1 second hole: a crash between openFollowUp and the door POST self-heals", () => {
  // The orphan: the follow-up row is inserted, then the door POST throws before any
  // `follow_up_actions` row exists. The plan's ":325 self-heals in 15 minutes" was FALSE for
  // this window — reconcile item 1's `not exists` is defeated by the very row the crash left.
  // The date-aware guard makes the next SAME-DATE cycle resume it through pure production
  // code. (The guard mutation that reds this is pinned in proposer.test.ts.)
  it("resumes the actionless open row on the next cycle and proposes", async () => {
    const T0 = new Date(Date.now() + 60_000);
    const contact = await addContact(admin, {
      tenantId: TEST_TENANT,
      displayName: "Cora Lim",
      channel: "call",
      source: "referral",
    });
    await addNumber(admin, contact.id, "+639178888888");

    // The crash: the door throws AFTER openFollowUp has inserted the row.
    const crashingDoor = async (): Promise<{ id: string }> => {
      throw new Error("process killed between openFollowUp and the door POST");
    };
    await expect(
      runCycle({ db: crm, postProposal: crashingDoor, now: () => T0 }, TEST_TENANT, 10),
    ).rejects.toThrow();

    // The orphan is real: an open row with zero actions.
    const orphan = await admin.query<{ n: string; actions: string }>(
      `select count(*) as n,
              (select count(*) from crm.follow_up_actions fa
                join crm.follow_ups f on f.id = fa.follow_up_id where f.contact_id = $1) as actions
         from crm.follow_ups where contact_id = $1 and closed_at is null`,
      [contact.id],
    );
    expect(orphan.rows[0].n).toBe("1");
    expect(orphan.rows[0].actions).toBe("0");

    // 16 minutes later (same Manila day → same due date), the working door resumes it.
    const T16 = new Date(T0.getTime() + 16 * 60_000);
    const door = realisticDoor();
    const c2 = await runCycle({ db: crm, postProposal: door.post, now: () => T16 }, TEST_TENANT, 10);
    expect(c2.find((o) => o.contactId === contact.id)?.actions).toHaveLength(1);
    const rows = await admin.query<{ n: string; actions: string }>(
      `select count(*) as n,
              (select count(*) from crm.follow_up_actions fa
                join crm.follow_ups f on f.id = fa.follow_up_id where f.contact_id = $1) as actions
         from crm.follow_ups where contact_id = $1`,
      [contact.id],
    );
    expect(rows.rows[0].n).toBe("1"); // the SAME row resumed, not a second one
    expect(rows.rows[0].actions).toBe("1"); // now it has its action
  });
});
