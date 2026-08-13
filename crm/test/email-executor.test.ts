// Email spike / Task 9 pins — `executeEmail`, on a real ephemeral database with the REAL
// A2 spine wired in at the seam and a FAKE transport that records every call.
//
// NO NETWORK. The fake `SendEmail` is the only sender here; nothing in this file can reach
// an inbox.
//
// 🚨 EVERY REFUSAL PATH ASSERTS TWO THINGS SEPARATELY: that nothing was sent, AND that
// `approval.executions` holds ZERO rows for that proposal. The second is the one that
// detects an ordering regression — a refusal must not burn the proposal's one permitted
// start. A pin asserting only "no send" stays green if someone moves `beginExecution` above
// the guards for convenience.
//
// 🚨 NO FIXTURE FORGES STATE. The proposal payload is the one the SHIPPED PROPOSER builds;
// approval goes through the real decision path; and every acceptance-relevant fact
// (`next_due_at`, `closed_at`, proposal state, execution rows) is READ BACK from the
// database, never written by the test.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  freshCrmDb,
  seedContact,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { followUpEmailPayloadSchema } from "../../approval/src/proposal.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import { closeTerminatedFollowUps } from "../src/reconcile.js";
import { hasOpenFollowUpBefore } from "../src/followups.js";
import {
  executeEmail,
  EmailRefused,
  type EmailApprovalSpine,
  type SendEmailFn,
} from "../src/executor.js";

// The REAL A2 functions and the REAL grammar, wired in at the seam.
const SPINE: EmailApprovalSpine = {
  beginExecution,
  finishExecution,
  parsePayload: (input) => {
    const r = followUpEmailPayloadSchema.safeParse(input);
    return r.success
      ? { ok: true, value: r.data }
      : { ok: false, problem: r.error.issues.map((i) => i.path.join(".")).join("; ") };
  },
};

const INTERVALS = { defaultIntervalDays: 30, shortRetryDays: 3 };
const ALLOW = ["ana@example.com"];

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

/** A `SendEmail` that records every call and never touches a socket. */
function fakeSender(
  behaviour: "ok" | "throw" = "ok",
): SendEmailFn & { calls: Array<{ to: string; subject: string; body: string }> } {
  const calls: Array<{ to: string; subject: string; body: string }> = [];
  const fn = (async (msg) => {
    calls.push(msg);
    if (behaviour === "throw") throw new Error("relay refused the connection");
    return {
      messageId: `<${randomUUID()}@relay.example.com>`,
      accepted: [msg.to],
      rejected: [],
      response: "250 2.0.0 OK",
    };
  }) as SendEmailFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, INTERVALS);
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

/** Drive the SHIPPED PROPOSER through a door that inserts the proposal for real, then
 *  approve it through the real decision path. Nothing about the payload is invented here. */
async function proposeAndApprove(
  contactId: string,
  opts: { approve?: boolean; overridePayload?: Record<string, unknown> } = {},
): Promise<string> {
  let proposalId = "";
  const door = async (p: DoorProposal): Promise<{ id: string }> => {
    const payload = opts.overridePayload ?? (p.payload as Record<string, unknown>);
    const ins = await admin.query<{ id: string }>(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
          expires_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, now() + interval '72 hours')
       returning id`,
      [
        TEST_TENANT,
        p.idempotency_key,
        p.action_type,
        JSON.stringify(payload),
        p.rationale,
        payloadHash(payload),
      ],
    );
    proposalId = ins.rows[0].id;
    return { id: proposalId };
  };
  await runCycle({ db: crm, postProposal: door }, TEST_TENANT, 10);
  expect(proposalId, "the shipped proposer must have produced a proposal").not.toBe("");

  if (opts.approve !== false) await approve(proposalId);
  return proposalId;
}

async function approve(proposalId: string): Promise<void> {
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
    await c.query(`update approval.proposals set state = 'approved' where id = $1`, [
      proposalId,
    ]);
    await c.query("commit");
  } finally {
    c.release();
  }
}

const executions = async (proposalId: string): Promise<Array<{ kind: string; vendor_reference: string | null }>> => {
  const r = await admin.query<{ kind: string; vendor_reference: string | null }>(
    `select kind, vendor_reference from approval.executions
      where proposal_id = $1 order by at`,
    [proposalId],
  );
  return r.rows;
};

const state = async (proposalId: string): Promise<string> => {
  const r = await admin.query<{ state: string }>(
    `select state from approval.proposals where id = $1`,
    [proposalId],
  );
  return r.rows[0].state;
};

const deps = (sendEmail: SendEmailFn, allowlist: readonly string[] = ALLOW) => ({
  approvalDb: admin,
  crmDb: crm,
  sendEmail,
  spine: SPINE,
  allowlist,
  intervals: INTERVALS,
});

const emailContact = () =>
  seedContact(admin, {
    channel: "email",
    email: "ana@example.com",
    displayName: "Ana Reyes",
  });

// ═══════════════════════════════════════════════════════════════════════════════════════
describe("Task 9 pin 1: the happy path", () => {
  // mutation: pass `'answered'` instead of `'sent'` -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 13 passed (14)`
  // mutation: `finishExecution({ok:true})` without the vendorReference -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 13 passed (14)`
  it("sends, records exactly two execution rows, and writes an honest email touch", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    const fake = fakeSender();

    const out = await executeEmail(deps(fake), proposalId);

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].to).toBe("ana@example.com");
    expect(await state(proposalId)).toBe("executed");

    const rows = await executions(proposalId);
    expect(rows.map((r) => r.kind)).toEqual(["started", "succeeded"]);
    expect(rows[1].vendor_reference).toBe(out.messageId);
    expect(rows[1].vendor_reference).not.toBeNull();

    const t = await admin.query<{
      channel: string;
      disposition: string;
      phone_number_id: string | null;
      question_set_id: string | null;
      transcript_delivery: string | null;
    }>(
      `select channel, disposition, phone_number_id, question_set_id, transcript_delivery
         from crm.touches where proposal_id = $1`,
      [proposalId],
    );
    expect(t.rowCount).toBe(1);
    expect(t.rows[0]).toEqual({
      channel: "email",
      disposition: "sent",
      phone_number_id: null,
      question_set_id: null,
      transcript_delivery: null,
    });
  });

  // 🚨 THE CARD↔ENVELOPE IDENTITY. What the fake was handed must be byte-for-byte what the
  // approved payload holds and what `payload_hash` covers. This is the property a
  // normalising transform anywhere on the send path would dissolve silently.
  it("hands the transport exactly the bytes that were approved and hashed", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    const fake = fakeSender();
    await executeEmail(deps(fake), proposalId);

    const p = await admin.query<{ payload: Record<string, string>; payload_hash: string }>(
      `select payload, payload_hash from approval.proposals where id = $1`,
      [proposalId],
    );
    const stored = p.rows[0].payload;
    expect(fake.calls[0].to).toBe(stored.to);
    expect(fake.calls[0].subject).toBe(stored.subject);
    expect(fake.calls[0].body).toBe(stored.body);
    // And the stored payload still hashes to what was recorded at proposal time.
    expect(payloadHash(stored)).toBe(p.rows[0].payload_hash);
  });
});

describe("Task 9 pin 2: a second run refuses and sends nothing", () => {
  it("does not send twice, and adds no execution rows", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    await executeEmail(deps(fakeSender()), proposalId);
    expect((await executions(proposalId)).length).toBe(2);

    const second = fakeSender();
    await expect(executeEmail(deps(second), proposalId)).rejects.toThrow();
    expect(second.calls.length).toBe(0);
    expect((await executions(proposalId)).length).toBe(2);
  });
});

describe("Task 9 pin 3: every refusal is BEFORE beginExecution", () => {
  // 🚨 THE ZERO-ROWS HALF IS THE ASSERTION THAT MATTERS, and it is asserted separately from
  // the no-send half.
  // mutation: move `beginExecution` above the guards -> red. RUN ✅ 2026-08-12
  //   Observed: `Tests  6 failed | 8 passed (14)` — the wrong-action_type, safeParse,
  //   off-allowlist, empty-allowlist, placeholder and CRLF cases all burned the proposal's
  //   one permitted start. (The expiry and unapproved cases stay green under it, correctly:
  //   `beginExecution` is where they refuse either way.)

  it("refuses a proposal of the wrong action_type", async () => {
    const ana = await seedContact(admin, { channel: "call" });
    const ins = await admin.query<{ id: string }>(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
       values ($1, $2, 'place_call', $3::jsonb, 'r', $4, now() + interval '72 hours')
       returning id`,
      [TEST_TENANT, `k-${randomUUID()}`, JSON.stringify({ contact_id: ana }), payloadHash({ contact_id: ana })],
    );
    const proposalId = ins.rows[0].id;
    await approve(proposalId);

    const fake = fakeSender();
    await expect(executeEmail(deps(fake), proposalId)).rejects.toThrow(EmailRefused);
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });

  it("refuses a payload that fails safeParse", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana, {
      overridePayload: { contact_id: ana, to: "ana", subject: "s", body: "b" },
    });
    const fake = fakeSender();
    await expect(executeEmail(deps(fake), proposalId)).rejects.toThrow(EmailRefused);
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });

  it("refuses an off-allowlist recipient", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    const fake = fakeSender();
    await expect(
      executeEmail(deps(fake, ["someone-else@example.com"]), proposalId),
    ).rejects.toThrow(EmailRefused);
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });

  it("refuses everything when the allowlist is empty (fail-closed)", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    const fake = fakeSender();
    await expect(executeEmail(deps(fake, []), proposalId)).rejects.toThrow(EmailRefused);
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });

  it("refuses a placeholder left in the body", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana, {
      overridePayload: {
        contact_id: ana,
        to: "ana@example.com",
        subject: "Following up",
        body: "Hi {{name}} — still looking?",
      },
    });
    const fake = fakeSender();
    await expect(executeEmail(deps(fake), proposalId)).rejects.toThrow(EmailRefused);
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });

  it("refuses a CRLF subject (the hidden-Bcc vector)", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana, {
      overridePayload: {
        contact_id: ana,
        to: "ana@example.com",
        subject: "Following up\r\nBcc: stranger@example.com",
        body: "Hi Ana",
      },
    });
    const fake = fakeSender();
    await expect(executeEmail(deps(fake), proposalId)).rejects.toThrow(EmailRefused);
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });

  // 🚨 THE EXPIRY REFUSAL FIRES INSIDE `beginExecution` — which inserts the `started` row
  // and then ROLLS BACK on the failed compare-and-set. Zero rows is therefore still the
  // correct assertion, and this pin is what proves it rather than assuming it.
  it("refuses an expired approval and still leaves zero execution rows", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    await admin.query(
      `update approval.proposals set expires_at = now() - interval '1 hour' where id = $1`,
      [proposalId],
    );
    const fake = fakeSender();
    await expect(executeEmail(deps(fake), proposalId)).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });

  it("refuses an unapproved proposal and still leaves zero execution rows", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana, { approve: false });
    const fake = fakeSender();
    await expect(executeEmail(deps(fake), proposalId)).rejects.toThrow();
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
  });
});

describe("Task 9 pin 4: the clock and the follow-up close", () => {
  // mutation: skip the follow-up close (`recordTouch`'s `closeFollowUpForProposal`) -> red.
  //           RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 13 passed (14)`
  it("advances next_due_at by the LONG interval and closes the follow-up, both read back", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    await executeEmail(deps(fakeSender()), proposalId);

    const c = await admin.query<{ next_due_at: Date }>(
      `select next_due_at from crm.contacts where id = $1`,
      [ana],
    );
    const days = Math.round((c.rows[0].next_due_at.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(INTERVALS.defaultIntervalDays); // 30, not the 3-day short retry

    const fu = await admin.query<{ closed_at: Date | null }>(
      `select f.closed_at from crm.follow_ups f
         join crm.follow_up_actions a on a.follow_up_id = f.id
        where a.proposal_id = $1`,
      [proposalId],
    );
    expect(fu.rowCount).toBe(1);
    expect(fu.rows[0].closed_at).not.toBeNull();
  });
});

describe("Task 9 pin 5: a transport failure is terminal", () => {
  it("records execution_failed, does not retry, and never claims 'sent'", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    const fake = fakeSender("throw");

    await expect(executeEmail(deps(fake), proposalId)).rejects.toThrow(/relay refused/);

    expect(fake.calls.length).toBe(1); // attempted ONCE. No retry.
    expect(await state(proposalId)).toBe("execution_failed");
    expect((await executions(proposalId)).map((r) => r.kind)).toEqual(["started", "failed"]);

    const t = await admin.query<{ disposition: string | null }>(
      `select disposition from crm.touches where proposal_id = $1`,
      [proposalId],
    );
    expect(t.rowCount).toBe(1);
    expect(t.rows[0].disposition).toBeNull(); // it does NOT claim 'sent'
  });
});

describe("Task 9 pin 6: a failed send is RECOVERABLE, and the recovery is pinned", () => {
  // 🚨 THE SPIKE CREATES NO NEW SILENCE CLASS — BUT IT MAKES AN EXISTING ONE REACHABLE FOR
  // THE FIRST TIME. `placeCall` has no implementations, so no execution has ever failed in
  // this repo; SMTP failures are routine. After a failed send `recordTouch` never ran, so
  // the follow-up row is still OPEN and `next_due_at` is unchanged — and from the next
  // Manila midnight `hasOpenFollowUpBefore` silences the contact.
  //
  // mutation: remove `'execution_failed'` from `closeTerminatedFollowUps`' state list ->
  //           red. RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 13 passed (14)`
  //     AssertionError: expected null not to be null
  //   i.e. the follow-up stayed open after the failed send, and the contact would have gone
  //   silent from the next Manila midnight.
  it("closeTerminatedFollowUps closes the row and makes the contact proposable again", async () => {
    const ana = await emailContact();
    const proposalId = await proposeAndApprove(ana);
    await expect(executeEmail(deps(fakeSender("throw")), proposalId)).rejects.toThrow();

    // Before reconcile: the row is open, and that is the silencing condition.
    const before = await admin.query<{ closed_at: Date | null; due_date: string }>(
      `select f.closed_at, f.due_date::text as due_date from crm.follow_ups f
         join crm.follow_up_actions a on a.follow_up_id = f.id
        where a.proposal_id = $1`,
      [proposalId],
    );
    expect(before.rows[0].closed_at).toBeNull();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await hasOpenFollowUpBefore(crm, ana, tomorrow)).toBe(true);

    await closeTerminatedFollowUps(admin);

    // Read back — nothing here was written by the test.
    const after = await admin.query<{ closed_at: Date | null }>(
      `select f.closed_at from crm.follow_ups f
         join crm.follow_up_actions a on a.follow_up_id = f.id
        where a.proposal_id = $1`,
      [proposalId],
    );
    expect(after.rows[0].closed_at).not.toBeNull();
    expect(await hasOpenFollowUpBefore(crm, ana, tomorrow)).toBe(false);
  });
});
