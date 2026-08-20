// Call allowlist pins, EXECUTOR half (A1/A3/A4) — `executeCall` on a real ephemeral
// database with the REAL A2 spine wired in at the seam, mirroring email-executor.test.ts.
//
// NO NETWORK. The fake `PlaceCall` is the only vendor here; nothing in this file can ring
// a phone.
//
// 🚨 EVERY REFUSAL PATH ASSERTS TWO THINGS SEPARATELY: that the vendor was never invoked,
// AND that `approval.executions` holds ZERO rows for that proposal. The second is the one
// that detects an ordering regression — a refusal must not burn the proposal's one
// permitted start. A pin asserting only "no dial" stays green if someone moves
// `beginExecution` above the guard for convenience.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import {
  freshCrmDb,
  seedContact,
  seedNumber,
  seedQuestionSet,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { placeCallPayloadSchema } from "../../approval/src/proposal.js";
import { executeCall, CallRefused, type ApprovalSpine } from "../src/executor.js";

// The REAL A2 functions and the REAL grammar, wired in at the seam (the established
// test-code exception to the cross-workspace import ban).
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

const WINDOW = { windowStart: "00:00:00", windowEnd: "23:59:00", timezone: "Asia/Manila" };
const INTERVALS = { defaultIntervalDays: 30, shortRetryDays: 3 };
/** The number every proposal in this file is approved to dial. */
const APPROVED_NUMBER = "+639171234567";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;
let setId: string;

async function seedApprovedCall(): Promise<string> {
  const contactId = await seedContact(admin);
  const phoneNumberId = await seedNumber(admin, contactId, APPROVED_NUMBER);
  const payload = {
    contact_id: contactId,
    phone_number_id: phoneNumberId,
    phone_e164: APPROVED_NUMBER,
    display_name: "Ana Reyes",
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
      `allow-${Math.random().toString(36).slice(2)}`,
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

const executionRows = async (proposalId: string): Promise<number> => {
  const r = await admin.query(`select 1 from approval.executions where proposal_id = $1`, [
    proposalId,
  ]);
  return r.rowCount ?? 0;
};

const state = async (proposalId: string): Promise<string> => {
  const r = await admin.query<{ state: string }>(
    `select state from approval.proposals where id = $1`,
    [proposalId],
  );
  return r.rows[0].state;
};

/** Deps with a recording vendor that answers as a human and says nothing. */
function deps(phoneAllowlist: readonly string[]) {
  const dialed: string[] = [];
  return {
    dialed,
    deps: {
      approvalDb: admin,
      crmDb: crm,
      spine: SPINE,
      window: WINDOW,
      intervals: INTERVALS,
      phoneAllowlist,
      placeCall: async (ctx: { payload: { phone_e164: string } }) => {
        dialed.push(ctx.payload.phone_e164);
        return {
          transport: { sipStatus: 200 as const, amdResult: "human" as const },
          conversation: null,
        };
      },
    },
  };
}

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin);
  ({ setId } = await seedQuestionSet(admin));
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
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("A1: the empty allowlist refuses EVERY call, BEFORE beginExecution", () => {
  // mutation (A1): delete the `checkCallable` block from `executeCall` -> every refusal
  //   pin in this file red (the vendor is reached, executions are burned).
  //   RUN ✅ 2026-08-19 — observed:
  //     Tests  4 failed | 1 passed (5)
  //     AssertionError: promise resolved "{ …(5) }" instead of rejecting
  //     × refuses with zero approval.executions rows, the vendor untouched, the approval intact
  //     × a number not on the list is refused, the refusal names the number, nothing burns
  //     × a near-neighbour on the list does not permit the approved number
  //     × a country prefix on the list permits nothing
  it("refuses with zero approval.executions rows, the vendor untouched, the approval intact", async () => {
    const proposalId = await seedApprovedCall();
    const d = deps([]);

    await expect(executeCall(d.deps, proposalId)).rejects.toThrow(CallRefused);
    await expect(executeCall(d.deps, proposalId)).rejects.toThrow(
      /SWITCHBOARD_PHONE_ALLOWLIST/,
    );

    expect(d.dialed).toEqual([]);
    // The load-bearing half: the refusal happened BEFORE `beginExecution`, so the
    // proposal's one permitted start was not burned and no touch was recorded.
    expect(await executionRows(proposalId)).toBe(0);
    expect(await state(proposalId)).toBe("approved");
    const touches = await admin.query(`select 1 from crm.touches`);
    expect(touches.rowCount).toBe(0);
  });
});

describe("A3: allowlisted proceeds; unlisted is refused BY NAME", () => {
  it("an allowlisted number is dialled and the call executes end to end", async () => {
    const proposalId = await seedApprovedCall();
    const d = deps([APPROVED_NUMBER]);

    const out = await executeCall(d.deps, proposalId);

    expect(d.dialed).toEqual([APPROVED_NUMBER]);
    expect(out.proposalId).toBe(proposalId);
    expect(await state(proposalId)).toBe("executed");
  });

  it("a number not on the list is refused, the refusal names the number, nothing burns", async () => {
    const proposalId = await seedApprovedCall();
    const d = deps(["+639998887777"]);

    await expect(executeCall(d.deps, proposalId)).rejects.toThrow(APPROVED_NUMBER);

    expect(d.dialed).toEqual([]);
    expect(await executionRows(proposalId)).toBe(0);
    expect(await state(proposalId)).toBe("approved");
  });
});

describe("A4: no prefix, no wildcard, no country-level allow — executor half", () => {
  it("a near-neighbour on the list does not permit the approved number", async () => {
    const proposalId = await seedApprovedCall(); // dials +639171234567
    const d = deps(["+639171234568"]);

    await expect(executeCall(d.deps, proposalId)).rejects.toThrow(CallRefused);
    expect(d.dialed).toEqual([]);
    expect(await executionRows(proposalId)).toBe(0);
  });

  it("a country prefix on the list permits nothing", async () => {
    const proposalId = await seedApprovedCall();
    const d = deps(["+63"]);

    await expect(executeCall(d.deps, proposalId)).rejects.toThrow(CallRefused);
    expect(d.dialed).toEqual([]);
    expect(await executionRows(proposalId)).toBe(0);
  });
});
