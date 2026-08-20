// Core loop / T11 pins — the call, wired to the A2 execution spine.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  freshCrmDb,
  seedContact,
  seedNumber,
  seedQuestionSet,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { payloadHash } from "../../approval/src/canonical.js";
import {
  beginExecution,
  finishExecution,
  findStuckExecutions,
} from "../../approval/src/execute.js";
import { placeCallPayloadSchema } from "../../approval/src/proposal.js";
import {
  executeCall,
  selectApprovedActions,
  CallRefused,
  type ApprovalSpine,
  type CallResult,
} from "../src/executor.js";
import { stubPlaceCall } from "../src/call-transport.js";

// The REAL A2 functions and the REAL grammar, wired in at the seam. Test code is the
// established exception to the no-cross-workspace-import rule (see
// ingest/test/helpers/golden-ledger.ts, which makes the same move for the same reason: a
// local reimplementation would make the test self-certifying).
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

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let cleanup: () => Promise<void>;
let setId: string;
let questionIds: string[];

const WINDOW = { windowStart: "00:00:00", windowEnd: "23:59:00", timezone: "Asia/Manila" };
const INTERVALS = { defaultIntervalDays: 30, shortRetryDays: 3 };
// Piece 1 (call allowlist): every number this file dials, injected exactly as the
// composition root does. Additive only - no assertion in this file changed.
const PHONE_ALLOW = ["+639171234567", "+639179999999"];

/** A `place_call` proposal in `approved`, reached the way the system reaches it. */
async function seedApprovedCall(opts: {
  contactId: string;
  phoneNumberId: string;
  displayName?: string | null;
  expiresInHours?: number;
}): Promise<string> {
  const payload = {
    contact_id: opts.contactId,
    phone_number_id: opts.phoneNumberId,
    phone_e164: "+639171234567",
    display_name: opts.displayName === undefined ? "Ana Reyes" : opts.displayName,
    opening_line: "Hi, may I speak with Ana Reyes?",
    question_set_id: setId,
    context: { source_detail: "Rotary breakfast", looking_for: "a 2BR near Alabang" },
  };
  const ins = await admin.query<{ id: string }>(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, 'place_call', $3::jsonb, 'due today', $4, now() + interval '72 hours')
     returning id`,
    [
      TEST_TENANT,
      `call-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      payloadHash(payload),
    ],
  );
  const id = ins.rows[0].id;
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
      [id, approver.rows[0].id],
    );
    await c.query(`update approval.proposals set state = 'approved' where id = $1`, [id]);
    await c.query("commit");
  } finally {
    c.release();
  }
  // Expiry is moved AFTER the decision — a decision on an already-expired ask is refused,
  // so "approved but expired" can only be built the way reality builds it.
  if (opts.expiresInHours !== undefined) {
    await admin.query(
      `update approval.proposals set expires_at = now() + make_interval(hours => $2::int)
        where id = $1`,
      [id, opts.expiresInHours],
    );
  }
  return id;
}

/** A `send_email` proposal in `approved`, reached the same way (P7's second live card). */
async function seedApprovedEmail(contactId: string): Promise<string> {
  const payload = {
    contact_id: contactId,
    to: "ana@example.com",
    subject: "Checking in",
    body: "Hi Ana — following up on the 2BR near Alabang.",
  };
  const ins = await admin.query<{ id: string }>(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, 'send_email', $3::jsonb, 'due today', $4, now() + interval '72 hours')
     returning id`,
    [
      TEST_TENANT,
      `email-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      payloadHash(payload),
    ],
  );
  const id = ins.rows[0].id;
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
      [id, approver.rows[0].id],
    );
    await c.query(`update approval.proposals set state = 'approved' where id = $1`, [id]);
    await c.query("commit");
  } finally {
    c.release();
  }
  return id;
}

const stateOf = async (id: string): Promise<string> =>
  (await admin.query<{ state: string }>(`select state from approval.proposals where id = $1`, [id]))
    .rows[0].state;

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
  await seedSettings(admin, INTERVALS);
  const qs = await seedQuestionSet(admin);
  setId = qs.setId;
  questionIds = qs.questionIds;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
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

describe("T11: a vendor death mid-call keeps what the prospect already said", () => {
  // mutation: wrap the call in one transaction and roll the answers back on failure —
  //           i.e. `catch { await crmDb.query("delete from crm.answers …") }`, or run the
  //           whole call inside `begin`/`rollback` -> red. RUN ✅ 2026-08-09
  //   Observed, BOTH variants run:
  //     (a) `delete from crm.answers` in the catch, plus finishExecution(ok:false):
  //         `Tests  1 failed | 5 passed (6)`
  //         AssertionError: expected 'execution_failed' to be 'executing'
  //         🚨 Worth reading exactly: THE ANSWERS SURVIVED THIS VARIANT ANYWAY, because
  //         `crm.answers` has no DELETE grant — the delete was refused. What red was the
  //         STATE. The privilege posture is doing real work here, not the code.
  //     (b) the whole call wrapped in one transaction, rolled back on failure:
  //         `Tests  1 failed | 5 passed (6)`
  //         AssertionError: expected [] to deeply equal [ 'around 5, maybe 6' ]
  //         — which is the loss the pin is actually about, and the variant a privilege
  //         boundary cannot stop.
  //
  // What she said before the line dropped is TRUE, and it is the only record of it. And
  // `crm.answers` has no DELETE grant at all, so the rollback variant cannot even be
  // written the obvious way — see the second assertion.
  it("leaves the proposal executing and the partial answers present", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const proposalId = await seedApprovedCall({ contactId: ana, phoneNumberId: num });

    await expect(
      executeCall(
        {
          approvalDb: approval,
          crmDb: crm,
        spine: SPINE,
          spine: SPINE,
          window: WINDOW,
          intervals: INTERVALS,
          phoneAllowlist: PHONE_ALLOW,
          placeCall: async (ctx) => {
            await ctx.answer(questionIds[0], "around 5, maybe 6");
            await ctx.reached(1);
            throw new Error("vendor session died");
          },
        },
        proposalId,
      ),
    ).rejects.toThrow(/vendor session died/);

    // 015 documents `executing` as having no timer-driven exit and no reaper, deliberately:
    // a timer that flips a live in-flight send to `failed` is WORSE than a stuck row.
    expect(await stateOf(proposalId)).toBe("executing");
    const answers = await admin.query<{ value: string }>(
      `select value from crm.answers order by at`,
    );
    expect(answers.rows.map((r) => r.value)).toEqual(["around 5, maybe 6"]);
    const touch = await admin.query<{ disposition: string | null; reached_ordinal: number | null }>(
      `select disposition, reached_ordinal from crm.touches`,
    );
    expect(touch.rows[0].disposition).toBeNull(); // the call never ended
    expect(touch.rows[0].reached_ordinal).toBe(1);

    // P2 (T15): the wedge is VISIBLE. `executing` has no reaper and no timer-driven exit
    // by design, so reconcile's stuck-execution report is the ONLY surface that will ever
    // mention this proposal — it must list it, or the no-rollback stance is unauditable.
    //
    // mutations, both RUN ✅ 2026-08-18:
    //   (a) `finishExecution({ok:false})` in `executeCall`'s catch (tidy the wedge away):
    //       `Tests  1 failed | 8 passed (9)`
    //       AssertionError: expected 'execution_failed' to be 'executing'
    //       — caught by the STATE assertion above before this one is reached.
    //   (b) `findStuckExecutions` reads `s.kind = 'succeeded'` (the report goes blind while
    //       the state stays `executing` — the variant only THIS assertion can catch):
    //       `Tests  1 failed | 8 passed (9)`
    //       AssertionError: expected [] to deeply equal [ Array(1) ]
    const stuck = await findStuckExecutions(approval, 0);
    expect(stuck.map((s) => s.proposalId)).toEqual([proposalId]);
  });
});

describe("T11: an outcome with no `started` row is REFUSED", () => {
  // mutation: drop the rowcount check in `finishExecution` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 5 passed (6)`
  //     AssertionError: promise resolved "undefined" instead of rejecting
  //   — i.e. it succeeds, and the proposal reaches a terminal state with an empty log.
  //
  // Mirrors execute.ts:145-160. Without it the transaction still commits the state move,
  // producing a proposal marked `executed` with an EMPTY EXECUTION LOG — the audit trail
  // saying an action happened with no record of it happening.
  it("refuses, and moves nothing", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const proposalId = await seedApprovedCall({ contactId: ana, phoneNumberId: num });
    // Reached `executing` OUTSIDE beginExecution — the state the forgery defect made
    // possible, and the reason the rowcount check exists.
    await admin.query(
      `update approval.proposals set state = 'executing' where id = $1 and state = 'approved'`,
      [proposalId],
    );
    await expect(
      finishExecution(approval, proposalId, { ok: true }),
    ).rejects.toThrow(/no 'started' execution row/);
    expect(await stateOf(proposalId)).toBe("executing");
  });
});

describe("T11: an expired approval cannot start a call", () => {
  // mutation: remove `and expires_at > now()` from `beginExecution`'s UPDATE predicate
  //           -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 5 passed (6)`
  //     AssertionError: promise resolved "{ …(5) }" instead of rejecting
  //   — the call is PLACED on an authorisation that expired an hour earlier.
  //
  // The obligation is on the VERIFIER AT THE MOMENT OF USE (RFC 7519 §4.1.4, RFC 9068 §4,
  // RFC 6749 §10.5), and it lives in the UPDATE predicate so it is a COMPARE-AND-SET: the
  // check and the use cannot be separated by any interleaving. A read-then-act would
  // reintroduce the window it closes, and a sweeper alone fails open during exactly the
  // outage that matters.
  it("refuses before the phone rings, and no touch is created", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const proposalId = await seedApprovedCall({
      contactId: ana,
      phoneNumberId: num,
      expiresInHours: -1,
    });
    let vendorCalled = false;
    await expect(
      executeCall(
        {
          approvalDb: approval,
          crmDb: crm,
        spine: SPINE,
          spine: SPINE,
          window: WINDOW,
          intervals: INTERVALS,
          phoneAllowlist: PHONE_ALLOW,
          placeCall: async () => {
            vendorCalled = true;
            return { transport: { sipStatus: 200, amdResult: "human" }, conversation: null };
          },
        },
        proposalId,
      ),
    ).rejects.toThrow(/EXPIRED/);
    expect(vendorCalled).toBe(false);
    expect(await stateOf(proposalId)).toBe("approved");
    const touches = await admin.query(`select 1 from crm.touches`);
    expect(touches.rowCount).toBe(0);
  });
});

describe("T11: the happy path, end to end on the fake vendor", () => {
  it("records answers, finishes the execution, and resets the clock", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const proposalId = await seedApprovedCall({ contactId: ana, phoneNumberId: num });

    const answered: CallResult = {
      transport: { sipStatus: 200, amdResult: "human" },
      conversation: "identity_confirmed_complete",
    };
    const r = await executeCall(
      {
        approvalDb: approval,
        crmDb: crm,
        spine: SPINE,
        window: WINDOW,
        intervals: INTERVALS,
        phoneAllowlist: PHONE_ALLOW,
        placeCall: async (ctx) => {
          expect(ctx.prompts.map((p) => p.questionKey)).toEqual(["budget", "timeline"]);
          for (const [i, p] of ctx.prompts.entries()) {
            await ctx.answer(p.id, `answer to ${p.questionKey}`);
            await ctx.reached(i + 1);
          }
          return answered;
        },
      },
      proposalId,
    );

    expect(r.disposition).toBe("answered");
    expect(r.advancedClock).toBe(true);
    expect(await stateOf(proposalId)).toBe("executed");
    const answers = await admin.query(`select 1 from crm.answers`);
    expect(answers.rowCount).toBe(2);
    const due = await admin.query<{ next_due_at: Date }>(
      `select next_due_at from crm.contacts where id = $1`,
      [ana],
    );
    expect(Math.round((due.rows[0].next_due_at.getTime() - Date.now()) / 86_400_000)).toBe(30);
  });

  it("labels a nameless call's touch, and stores its answers", async () => {
    const nameless = await seedContact(admin, { displayName: null });
    const num = await seedNumber(admin, nameless, "+639179999999");
    const proposalId = await seedApprovedCall({
      contactId: nameless,
      phoneNumberId: num,
      displayName: null,
    });
    const r = await executeCall(
      {
        approvalDb: approval,
        crmDb: crm,
        spine: SPINE,
        window: WINDOW,
        intervals: INTERVALS,
        phoneAllowlist: PHONE_ALLOW,
        placeCall: async (ctx) => {
          await ctx.answer(ctx.prompts[0].id, "two bedrooms");
          await ctx.reached(1);
          return {
            transport: { sipStatus: 200, amdResult: "human" },
            conversation: "identity_not_asked_cut_off",
          };
        },
      },
      proposalId,
    );
    expect(r.identityUnverified).toBe(true);
    expect(r.disposition).toBe("partial");
    const t = await admin.query<{ identity_unverified: boolean; n: string }>(
      `select identity_unverified,
              (select count(*) from crm.answers a where a.touch_id = t.id) as n
         from crm.touches t`,
    );
    expect(t.rows[0].identity_unverified).toBe(true);
    expect(t.rows[0].n).toBe("1");
  });

  // mutation: move the gate to AFTER `beginExecution` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 5 passed (6)`
  //     AssertionError: expected 'executing' to be 'approved'
  //   — an out-of-hours refusal consumes the proposal's ONE permitted start, and 015 gives
  //   `executing` no timer-driven exit, so the card is wedged forever for the crime of
  //   being picked up at 22:00.
  it("refuses outside the outreach window without burning the one permitted start", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const proposalId = await seedApprovedCall({ contactId: ana, phoneNumberId: num });
    await expect(
      executeCall(
        {
          approvalDb: approval,
          crmDb: crm,
        spine: SPINE,
          spine: SPINE,
          // A window that cannot contain "now" in any timezone this test could run in.
          window: { windowStart: "03:00:00", windowEnd: "03:01:00", timezone: "Asia/Manila" },
          intervals: INTERVALS,
          phoneAllowlist: PHONE_ALLOW,
          now: () => new Date("2026-08-11T14:00:00Z"), // 22:00 Manila
          placeCall: async () => {
            throw new Error("the vendor must never be reached");
          },
        },
        proposalId,
      ),
    ).rejects.toBeInstanceOf(CallRefused);
    expect(await stateOf(proposalId)).toBe("approved");
    const started = await admin.query(`select 1 from approval.executions`);
    expect(started.rowCount).toBe(0);
  });
});

describe("T15: raw transport signals reach the touch through disposition.ts", () => {
  // These three pin the EXECUTOR's use of `resolveDisposition` — `disposition.test.ts`
  // already pins `mapTransport` at the unit level, but nothing until now pinned that a
  // vendor's raw signals actually arrive at the TOUCH ROW uninterpreted. The vendor
  // reports; `disposition.ts` decides; the executor records. (See the contract header in
  // `src/call-transport.ts`.)

  // P3. mutation: make `mapTransport` treat 200+machine as a conversation (the vendor's
  //     200 OK taken at face value) -> red: the voicemail trap documented at
  //     disposition.ts:33-42 reopens and a machine pick-up buys the prospect a full
  //     follow-up interval of silence. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected 'unknown_answer' to be 'voicemail'
  it("records 200 + AMD machine as voicemail, never answered", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const proposalId = await seedApprovedCall({ contactId: ana, phoneNumberId: num });

    const r = await executeCall(
      {
        approvalDb: approval,
        crmDb: crm,
        spine: SPINE,
        window: WINDOW,
        intervals: INTERVALS,
        phoneAllowlist: PHONE_ALLOW,
        placeCall: async () => ({
          transport: { sipStatus: 200, amdResult: "machine" },
          conversation: null,
          messageLeft: true,
        }),
      },
      proposalId,
    );

    expect(r.disposition).toBe("voicemail");
    expect(await stateOf(proposalId)).toBe("executed");
    const t = await admin.query<{ disposition: string | null }>(
      `select disposition from crm.touches`,
    );
    expect(t.rows[0].disposition).toBe("voicemail");
  });

  // P4. mutation: default the 200-with-no-AMD branch to `answered` -> red: ignorance
  //     laundered into a successful contact. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected 'answered' to be 'unknown_answer'
  it("records 200 with no AMD verdict as unknown_answer — ignorance is not contact", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const proposalId = await seedApprovedCall({ contactId: ana, phoneNumberId: num });

    const r = await executeCall(
      {
        approvalDb: approval,
        crmDb: crm,
        spine: SPINE,
        window: WINDOW,
        intervals: INTERVALS,
        phoneAllowlist: PHONE_ALLOW,
        placeCall: async () => ({
          transport: { sipStatus: 200 },
          conversation: null,
        }),
      },
      proposalId,
    );

    expect(r.disposition).toBe("unknown_answer");
    expect(r.disposition).not.toBe("answered");
    const t = await admin.query<{ disposition: string | null }>(
      `select disposition from crm.touches`,
    );
    expect(t.rows[0].disposition).toBe("unknown_answer");
  });

  // P5. mutation: stop carrying `payload.display_name === null` into `recordTouch`'s
  //     `identityUnverified` -> red: the final update silently CLEARS the flag the call
  //     start wrote, and a nameless touch claims a verified identity. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected false to be true  (the touch row's identity_unverified)
  //
  // The existing nameless pin above covers a HUMAN-answered nameless call, where the
  // conversation outcome itself carries the flag. This one uses the REAL `stubPlaceCall`
  // (no answer, no conversation, `identityUnverified: false` from `resolveDisposition`),
  // so the flag can ONLY survive through the payload-derived carry — namelessness is a
  // property of the CALL, not of how it ended.
  it("labels a nameless call identity_unverified even when nobody answered", async () => {
    const nameless = await seedContact(admin, { displayName: null });
    const num = await seedNumber(admin, nameless, "+639179999999");
    const proposalId = await seedApprovedCall({
      contactId: nameless,
      phoneNumberId: num,
      displayName: null,
    });

    const r = await executeCall(
      {
        approvalDb: approval,
        crmDb: crm,
        spine: SPINE,
        window: WINDOW,
        intervals: INTERVALS,
        phoneAllowlist: PHONE_ALLOW,
        placeCall: stubPlaceCall,
      },
      proposalId,
    );

    expect(r.disposition).toBe("no_answer");
    expect(r.identityUnverified).toBe(true);
    const t = await admin.query<{ identity_unverified: boolean; disposition: string | null }>(
      `select identity_unverified, disposition from crm.touches`,
    );
    expect(t.rows[0].identity_unverified).toBe(true);
    expect(t.rows[0].disposition).toBe("no_answer");
  });
});

describe("T15: what the loop selects to execute", () => {
  // P7. The daemon's selection, pinned HERE in typed code rather than in the script: the
  // loop sits outside every tsconfig (its header says so, and a real bug shipped there),
  // so the query lives in `selectApprovedActions` (src/executor.ts) where the compiler and
  // this pin can both see it, and the loop only runs it and branches on the string.
  //
  // mutations, each -> red, ALL RUN ✅ 2026-08-18:
  //   (a) drop `and expires_at > now()`   — the anti-poison filter: an approved-but-expired
  //       row is otherwise selected every tick forever and refused every time.
  //       Observed: `Tests  1 failed | 9 passed (10)` — the expired place_call appears as a
  //       third row: `expected [ { …(2) }, { …(2) }, { …(2) } ] to deeply equal [ … ]`
  //   (b) narrow to `action_type = 'send_email'` — the defect this pin exists to end:
  //       approved call cards executed by NOTHING.
  //       Observed: `Tests  1 failed | 9 passed (10)` — the place_call row vanishes:
  //       `expected [ { …(2) } ] to deeply equal [ { …(2) }, { …(2) } ]`
  //   (c) `order by created_at desc`      — approved cards must run oldest-first.
  //       Observed: `Tests  1 failed | 9 passed (10)` — same two rows, reversed.
  it("returns live send_email and place_call cards in created_at,id order, never expired ones", async () => {
    const ana = await seedContact(admin);
    const num = await seedNumber(admin, ana, "+639171234567");
    const callId = await seedApprovedCall({ contactId: ana, phoneNumberId: num });
    const emailId = await seedApprovedEmail(ana);
    const expiredId = await seedApprovedCall({
      contactId: ana,
      phoneNumberId: num,
      expiresInHours: -1,
    });

    const rows = await selectApprovedActions(approval, TEST_TENANT);

    expect(rows).toEqual([
      { id: callId, action_type: "place_call" },
      { id: emailId, action_type: "send_email" },
    ]);
    expect(rows.map((r) => r.id)).not.toContain(expiredId);
  });
});
