// Core loop / C1 SECOND HALF — the non-executed terminal states must close the follow-up,
// or the date-aware guard turns a lingering open row into a permanent, invisible lockout the
// next Manila day. Proven on live DBs by the gate review; this suite drives each terminal
// state through PRODUCTION CODE (never `admin.query('update … set closed_at')`) and asserts
// cycle 2 behaves correctly after the production close pass runs.
//
// The discipline is the same as C1's first half: fixtures play EXTERNAL ACTORS only — her
// rejection at the door, the vendor's outcome, the owner's settings, a proposal's
// `expires_at` (an approval-side input), and the passage of TIME. The CLOSE must come from
// the production sweep (`closeTerminatedFollowUps`), never from a fixture write to `crm.*`.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { freshCrmDb, seedSettings, TEST_TENANT } from "./helpers/crmdb.js";
import { addContact, addNumber } from "../src/intake.js";
import { publishQuestionSet } from "../src/questions.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import { executeCall, type ApprovalSpine, type CallResult } from "../src/executor.js";
import { reconcile, closeTerminatedFollowUps } from "../src/reconcile.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { decide } from "../../approval/src/decide.js";
import { sweepExpired } from "../../approval/src/expiry.js";
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

/** The A2 door, played as an external actor — persists a PENDING proposal as the real door
 *  does (owner authority), replays the same id for a repeated key. Writes only `approval.*`. */
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

async function anApprover(): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ($1) returning id`,
    [`broker-${Math.random().toString(36).slice(2)}@example.com`],
  );
  return r.rows[0].id;
}

/** Approve a pending proposal as the human would (approval role, via the real `decide`). */
async function approve(proposalId: string): Promise<void> {
  await decide(approval, { proposalId, kind: "approved", approverUserId: await anApprover() });
}

async function contactAndCycle1(
  channel: "call" | "email",
  vnow: Date,
): Promise<{ contactId: string; proposalId: string; door: ReturnType<typeof realisticDoor> }> {
  const contact = await addContact(admin, {
    tenantId: TEST_TENANT,
    displayName: "Ana Reyes",
    channel,
    source: "referral",
    emailAddress: channel === "email" ? "ana@example.com" : null,
  });
  if (channel === "call") await addNumber(admin, contact.id, "+639171234567");
  const door = realisticDoor();
  const cycle = await runCycle({ db: crm, postProposal: door.post, now: () => vnow }, TEST_TENANT, 10);
  const out = cycle.find((o) => o.contactId === contact.id);
  expect(out?.actions).toHaveLength(1);
  return { contactId: contact.id, proposalId: out!.actions[0].proposalId, door };
}

const isOpen = async (contactId: string): Promise<boolean> =>
  Number(
    (
      await admin.query<{ n: string }>(
        `select count(*) as n from crm.follow_ups where contact_id = $1 and closed_at is null`,
        [contactId],
      )
    ).rows[0].n,
  ) > 0;

const cycle2Actions = async (contactId: string, vnow: Date): Promise<number> => {
  const door = realisticDoor();
  const c = await runCycle({ db: crm, postProposal: door.post, now: () => vnow }, TEST_TENANT, 10);
  return c.find((o) => o.contactId === contactId)?.actions.length ?? 0;
};

const onPassedOn = async (contactId: string): Promise<boolean> =>
  (await reconcile(admin)).passedOnLeads.some((p) => p.contactId === contactId);

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

const T0 = () => new Date(Date.now() + 60_000);
const plusDays = (base: Date, n: number): Date => new Date(base.getTime() + n * 86_400_000);

describe("Test R — a rejected card STOPS AND SURFACES, and never locks the contact out", () => {
  // 🚨 THE MUTATION THAT WOULD HAVE CAUGHT THIS DEFECT.
  // mutation: remove the rejected-state handling from the close pass — drop `'rejected'`
  //           from the sweep's `in (...)` so the row never closes -> red. RUN ✅ 2026-08-10
  //   Observed: `Tests  1 failed | 5 passed (6)`
  //     AssertionError: expected [] to deeply equal [ 'rejected' ]  — the row is never
  //     closed, so the contact is NOT on the passed-on surface and (next Manila day) the
  //     date-aware guard silences it: C1 verbatim, one terminal state over.
  //
  // Everything is production: intake, the door, the human's rejection via `decide`, the
  // owner close pass, and 31 days of time.
  it("closes the row, stops the contact, lists it as passed-on, and does NOT re-serve", async () => {
    const t0 = T0();
    const { contactId, proposalId } = await contactAndCycle1("call", t0);

    // The human rejects — the single most ordinary action in an approve/reject system.
    await decide(approval, {
      proposalId,
      kind: "rejected",
      reason: "bad timing",
      approverUserId: await anApprover(),
    });
    // The hole: nothing has closed the row yet.
    expect(await isOpen(contactId)).toBe(true);

    // The production close pass.
    const closed = await closeTerminatedFollowUps(admin, t0);
    expect(closed.map((c) => c.reason)).toEqual(["rejected"]);
    expect(await isOpen(contactId)).toBe(false);

    // STOP AND SURFACE: on the passed-on list, `next_due_at` NULL, reason carried.
    expect(await onPassedOn(contactId)).toBe(true);
    const rep = await reconcile(admin);
    expect(rep.passedOnLeads.find((p) => p.contactId === contactId)?.reason).toBe("bad timing");

    // Next day: NOT re-served (she said no), and NOT locked out — still visible, revisitable.
    expect(await cycle2Actions(contactId, plusDays(t0, 1))).toBe(0);
    expect(await onPassedOn(contactId)).toBe(true);
  });
});

describe("Test E — an expired card RE-PROPOSES the next day", () => {
  // mutation: drop `'expired'` from the sweep's `in (...)` -> red. RUN ✅ 2026-08-10
  //   Observed: `Tests  2 failed | 4 passed (6)` (Test E and Test M share the mechanism):
  //     AssertionError: expected [] to deeply equal [ 'expired_or_failed' ]
  //     AssertionError: expected true to be false   (the row stays open, contact locked out)
  it("closes the row and proposes again", async () => {
    const t0 = T0();
    const { contactId, proposalId } = await contactAndCycle1("call", t0);

    // Age the card (an approval-side input, not forged CRM state) and run production expiry.
    await admin.query(`update approval.proposals set expires_at = now() - interval '1 hour' where id = $1`, [
      proposalId,
    ]);
    const swept = await sweepExpired(approval, TEST_TENANT);
    expect(swept.expired).toBe(1);
    expect(await isOpen(contactId)).toBe(true); // the hole

    const closed = await closeTerminatedFollowUps(admin, t0);
    expect(closed.map((c) => c.reason)).toEqual(["expired_or_failed"]);
    expect(await isOpen(contactId)).toBe(false);

    // Re-proposed the next day; not stopped, not on the passed-on list.
    expect(await onPassedOn(contactId)).toBe(false);
    expect(await cycle2Actions(contactId, plusDays(t0, 1))).toBe(1);
  });
});

describe("Test M — an email-only contact with no executor is not silenced", () => {
  // The proposer POSTs a real `send_email` card; there is NO email executor (Wave 2). The
  // card ages to `expired` and the close pass handles it via the expiry path — the lifecycle
  // hole closes WITHOUT building the executor.
  // mutation: drop `'expired'` from the sweep -> red. RUN below (same mechanism as E).
  it("ages to expired, closes, and proposes again", async () => {
    const t0 = T0();
    const { contactId, proposalId } = await contactAndCycle1("email", t0);
    // Confirm it really is an email card with no executor consuming it.
    const at = await admin.query<{ action_type: string }>(
      `select action_type from approval.proposals where id = $1`,
      [proposalId],
    );
    expect(at.rows[0].action_type).toBe("send_email");

    await admin.query(`update approval.proposals set expires_at = now() - interval '1 hour' where id = $1`, [
      proposalId,
    ]);
    await sweepExpired(approval, TEST_TENANT);
    expect(await isOpen(contactId)).toBe(true); // the hole

    await closeTerminatedFollowUps(admin, t0);
    expect(await isOpen(contactId)).toBe(false);
    expect(await cycle2Actions(contactId, plusDays(t0, 1))).toBe(1);
  });
});

describe("Test F — an execution_failed card RE-PROPOSES the next day", () => {
  // `execution_failed` is set by the real spine function `finishExecution(ok:false)` — the
  // exact function `executeCall` calls when a call fails. Approve, claim the execution slot
  // through the real `beginExecution`, then report failure through the real `finishExecution`
  // (the vendor-reported-failure outcome). No touch, no close — the row stays open.
  // mutation: drop `'execution_failed'` from the sweep's `in (...)` -> red. RUN ✅ 2026-08-10
  //   Observed: `Tests  1 failed | 5 passed (6)`
  //     AssertionError: expected [] to deeply equal [ 'expired_or_failed' ]
  it("closes the row and proposes again", async () => {
    const t0 = T0();
    const { contactId, proposalId } = await contactAndCycle1("call", t0);
    await approve(proposalId);
    await beginExecution(approval, proposalId);
    await finishExecution(approval, proposalId, { ok: false, error: "vendor reported failure" });
    const st = await admin.query<{ state: string }>(
      `select state from approval.proposals where id = $1`,
      [proposalId],
    );
    expect(st.rows[0].state).toBe("execution_failed");
    expect(await isOpen(contactId)).toBe(true); // the hole

    const closed = await closeTerminatedFollowUps(admin, t0);
    expect(closed.map((c) => c.reason)).toEqual(["expired_or_failed"]);
    expect(await cycle2Actions(contactId, plusDays(t0, 1))).toBe(1);
  });
});

describe("Test SUPERSEDE (defense-in-depth) — a superseded action closes, not strands", () => {
  // A CRM action can never actually be superseded today (one deterministic-keyed card per
  // (contact,due_date,channel); the invariant is pinned in no-silence.test.ts). But if a
  // future path ever broke that, a `superseded` proposal must CLOSE its follow-up, not leave
  // it open to silence the contact — "fix the class, not the instance."
  //
  // mutation: drop `'superseded'` from the sweep's `in (...)` -> red. RUN ✅ 2026-08-11
  //   Observed: `Tests  1 failed | 6 passed (7)`
  //     AssertionError: expected [] to include '<contactId>' — the superseded action is not
  //     swept, so its follow-up stays open and would silence the contact.
  it("the close pass sweeps a superseded proposal", async () => {
    const t0 = T0();
    const { contactId, proposalId } = await contactAndCycle1("call", t0);
    // Transition the (pending) proposal to superseded — a legal 015 transition, no decision
    // row required — simulating approveCard collapsing a duplicate on the approval side.
    await admin.query(
      `update approval.proposals set state = 'superseded' where id = $1 and state = 'pending'`,
      [proposalId],
    );
    const st = await admin.query<{ state: string }>(
      `select state from approval.proposals where id = $1`,
      [proposalId],
    );
    expect(st.rows[0].state).toBe("superseded");
    expect(await isOpen(contactId)).toBe(true); // the hole, if superseded were excluded

    const closed = await closeTerminatedFollowUps(admin, t0);
    expect(closed.map((c) => c.contactId)).toContain(contactId);
    expect(await isOpen(contactId)).toBe(false);
  });
});

describe("the close pass leaves LIVE work alone", () => {
  it("does not close a pending or approved follow-up (still live)", async () => {
    const t0 = T0();
    const { contactId, proposalId } = await contactAndCycle1("call", t0);
    // pending
    await closeTerminatedFollowUps(admin, t0);
    expect(await isOpen(contactId)).toBe(true);
    // approved
    await approve(proposalId);
    await closeTerminatedFollowUps(admin, t0);
    expect(await isOpen(contactId)).toBe(true);
  });
});

// Also confirm the fake vendor `answered` executed path is not swept (the executed leg
// already closed the row; sweeping it would be double-handling). Uses executeCall directly.
describe("the close pass does not touch an executed cycle", () => {
  it("leaves an answered/closed row alone and does not re-open it", async () => {
    const t0 = T0();
    const { contactId, proposalId } = await contactAndCycle1("call", t0);
    await approve(proposalId);
    const answered: CallResult = {
      transport: { sipStatus: 200, amdResult: "human" },
      conversation: "identity_confirmed_complete",
    };
    await executeCall(
      {
        approvalDb: approval,
        crmDb: crm,
        spine: SPINE,
        window: { windowStart: "00:00:00", windowEnd: "23:59:00", timezone: "Asia/Manila" },
        intervals: { defaultIntervalDays: 30, shortRetryDays: 3 },
        now: () => t0,
        placeCall: async (ctx) => {
          for (const [i, p] of ctx.prompts.entries()) await ctx.answer(p.id, `a${i}`);
          return answered;
        },
      },
      proposalId,
    );
    const before = await admin.query<{ closed_at: Date | null }>(
      `select closed_at from crm.follow_ups where contact_id = $1`,
      [contactId],
    );
    expect(before.rows[0].closed_at).not.toBeNull();
    const closed = await closeTerminatedFollowUps(admin, t0);
    expect(closed.map((c) => c.contactId)).not.toContain(contactId);
  });
});
