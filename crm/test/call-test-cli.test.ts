// Piece 3 pins (A6/A7) — `seedCallTest`, the one-command path to the first real phone
// call. The logic under test lives in `crm/src/call-test.ts`; `scripts/crm-call-test.ts`
// is the thin composition-root wrapper that wires the REAL approval functions in (the
// same split as `executeCall` + `scripts/executor-loop.ts`, and for the same reason:
// `crm/src` may not import `approval/src`, and script code is outside every tsconfig).
//
// The REAL A2 functions are wired at the seam here (the established test-code exception),
// so what is pinned is the same behaviour the wrapper composes.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { freshCrmDb, TEST_TENANT, seedSettings, seedQuestionSet } from "./helpers/crmdb.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { decide } from "../../approval/src/decide.js";
import { PROPOSAL_TTL_HOURS } from "../../approval/src/config.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { placeCallPayloadSchema } from "../../approval/src/proposal.js";
import { seedCallTest, type CallTestSpine } from "../src/call-test.js";
import { executeCall, selectApprovedActions, type ApprovalSpine } from "../src/executor.js";
import { isWithinWindow } from "../src/gates.js";

const NUMBER = "+639171112222";
const ALLOW = [NUMBER];

/** The REAL spine, exactly as scripts/crm-call-test.ts wires it. */
const SPINE: CallTestSpine = {
  payloadHash,
  parsePayload: (input) => {
    const r = placeCallPayloadSchema.safeParse(input);
    return r.success
      ? { ok: true, value: r.data }
      : { ok: false, problem: r.error.issues.map((i) => i.path.join(".")).join("; ") };
  },
  decide: (pool, req) => decide(pool, req),
  proposalTtlHours: PROPOSAL_TTL_HOURS,
};

/** A spine that must never be reached — for the refusal pins. */
const UNREACHABLE_SPINE: CallTestSpine = {
  payloadHash: () => {
    throw new Error("payloadHash reached on a refusal path");
  },
  parsePayload: () => {
    throw new Error("parsePayload reached on a refusal path");
  },
  decide: async () => {
    throw new Error("decide reached on a refusal path");
  },
  proposalTtlHours: PROPOSAL_TTL_HOURS,
};

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.questions");
  await admin.query("delete from crm.question_sets");
  await admin.query("delete from crm.outreach_settings");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("A6: the CLI refuses before it touches anything", () => {
  // A pool that refuses to be queried at all — so a green here PROVES the refusal
  // happened before any database work, not merely that it happened.
  const untouchablePool = {
    query: async (text: string) => {
      throw new Error(`the database was touched on a refusal path: ${text}`);
    },
  } as unknown as pg.Pool;

  // mutation (A6, allowlist): delete the `checkCallable` block from seedCallTest -> red,
  //   and the failure message itself proves the ordering (the pool trap fired).
  //   RUN ✅ 2026-08-19 — observed:
  //     Tests  2 failed | 7 passed (9)
  //     AssertionError: expected [Function] to throw error including '+639998887777'
  //     but got 'the database was touched on a refusal…'
  it("refuses a number not on SWITCHBOARD_PHONE_ALLOWLIST, naming the number", async () => {
    await expect(
      seedCallTest(untouchablePool, UNREACHABLE_SPINE, {
        tenantId: TEST_TENANT,
        phone: "+639998887777",
        phoneAllowlist: ALLOW,
      }),
    ).rejects.toThrow("+639998887777");
  });

  it("refuses everything when the allowlist is empty (fail-closed)", async () => {
    await expect(
      seedCallTest(untouchablePool, UNREACHABLE_SPINE, {
        tenantId: TEST_TENANT,
        phone: NUMBER,
        phoneAllowlist: [],
      }),
    ).rejects.toThrow(/SWITCHBOARD_PHONE_ALLOWLIST/);
  });

  it("refuses a phone number it cannot read, with an actionable message", async () => {
    await expect(
      seedCallTest(untouchablePool, UNREACHABLE_SPINE, {
        tenantId: TEST_TENANT,
        phone: "not-a-number",
        phoneAllowlist: ALLOW,
      }),
    ).rejects.toThrow(/could not read/);
  });

  // mutation (A6, db name): delete the current_database() guard -> red, and the failure
  //   message proves a write would have happened.
  //   RUN ✅ 2026-08-19 — observed:
  //     Tests  1 failed | 8 passed (9)
  //     AssertionError: expected [Function] to throw error matching /switchboard/ but got
  //     'wrote on the forbidden database: sele…'
  it("refuses to run against a database named `switchboard` BEFORE any write", async () => {
    const switchboardPool = {
      query: async (text: string) => {
        if (/current_database/.test(text)) return { rows: [{ d: "switchboard" }], rowCount: 1 };
        throw new Error(`wrote on the forbidden database: ${text}`);
      },
    } as unknown as pg.Pool;

    await expect(
      seedCallTest(switchboardPool, UNREACHABLE_SPINE, {
        tenantId: TEST_TENANT,
        phone: NUMBER,
        phoneAllowlist: ALLOW,
      }),
    ).rejects.toThrow(/switchboard/);
  });
});

describe("A7: the seeded proposal is genuinely approved and genuinely executable", () => {
  // mutation (A7): delete `spine.decide` AND the state read-back from seedCallTest ->
  //   red (the proposal stays 'pending' and the executor would never see it).
  //   RUN ✅ 2026-08-19 — observed:
  //     Tests  1 failed | 8 passed (9)
  //     AssertionError: expected { state: 'pending', …(1) } to deeply equal
  //     { state: 'approved', …(1) }
  it("seeds everything, approves through the real decision path, and the executor's own selectApprovedActions sees it", async () => {
    const seeded = await seedCallTest(admin, SPINE, {
      tenantId: TEST_TENANT,
      phone: NUMBER,
      phoneAllowlist: ALLOW,
    });

    expect(seeded.phoneE164).toBe(NUMBER);

    // Approved for real: state read back, decision row present and attributed.
    const p = await admin.query<{ state: string; action_type: string }>(
      `select state, action_type from approval.proposals where id = $1`,
      [seeded.proposalId],
    );
    expect(p.rows[0]).toEqual({ state: "approved", action_type: "place_call" });
    const d = await admin.query<{ kind: string; approver_user_id: string }>(
      `select kind, approver_user_id from approval.decisions where proposal_id = $1`,
      [seeded.proposalId],
    );
    expect(d.rows).toEqual([{ kind: "approved", approver_user_id: seeded.approverUserId }]);

    // Selectable by the EXECUTOR'S OWN per-tick selection — the daemon would pick it up.
    const approved = await selectApprovedActions(admin, TEST_TENANT);
    expect(approved).toContainEqual({ id: seeded.proposalId, action_type: "place_call" });

    // The window it seeded is OPEN NOW, so the gate will not refuse it.
    const s = await admin.query<{ window_start: string; window_end: string; timezone: string }>(
      `select window_start, window_end, timezone from crm.outreach_settings where tenant_id = $1`,
      [TEST_TENANT],
    );
    expect(
      isWithinWindow(new Date(), {
        windowStart: s.rows[0].window_start,
        windowEnd: s.rows[0].window_end,
        timezone: s.rows[0].timezone,
      }),
    ).toBe(true);

    // And the whole thing EXECUTES through the real executor with a fake vendor — the
    // exact path the daemon runs, phone allowlist included.
    const CALL_SPINE: ApprovalSpine = {
      beginExecution,
      finishExecution,
      parsePayload: SPINE.parsePayload as ApprovalSpine["parsePayload"],
    };
    const dialed: string[] = [];
    const out = await executeCall(
      {
        approvalDb: admin,
        crmDb: crm,
        spine: CALL_SPINE,
        window: {
          windowStart: s.rows[0].window_start,
          windowEnd: s.rows[0].window_end,
          timezone: s.rows[0].timezone,
        },
        intervals: { defaultIntervalDays: 30, shortRetryDays: 3 },
        phoneAllowlist: ALLOW,
        placeCall: async (ctx) => {
          dialed.push(ctx.payload.phone_e164);
          expect(ctx.payload.opening_line).toBe(seeded.openingLine);
          return { transport: { sipStatus: 200, amdResult: "human" }, conversation: null };
        },
      },
      seeded.proposalId,
    );
    expect(dialed).toEqual([NUMBER]);
    expect(out.proposalId).toBe(seeded.proposalId);
  });

  it("reuses HER current question set instead of retiring it", async () => {
    const existing = await seedQuestionSet(admin);
    const seeded = await seedCallTest(admin, SPINE, {
      tenantId: TEST_TENANT,
      phone: NUMBER,
      phoneAllowlist: ALLOW,
    });

    expect(seeded.questionSetId).toBe(existing.setId);
    expect(seeded.questionSetCreated).toBe(false);
    const sets = await admin.query(`select 1 from crm.question_sets`);
    expect(sets.rowCount).toBe(1);
  });

  it("publishes a minimal set (2–3 questions) only when she has none", async () => {
    const seeded = await seedCallTest(admin, SPINE, {
      tenantId: TEST_TENANT,
      phone: NUMBER,
      phoneAllowlist: ALLOW,
    });

    expect(seeded.questionSetCreated).toBe(true);
    expect(seeded.questionPrompts.length).toBeGreaterThanOrEqual(2);
    expect(seeded.questionPrompts.length).toBeLessThanOrEqual(3);
  });

  it("opens a CLOSED window and says so, preserving her other settings", async () => {
    const fixedNow = new Date("2026-03-03T03:00:00Z"); // 11:00 Asia/Manila
    await seedSettings(admin, {
      windowStart: "03:00",
      windowEnd: "03:01",
      openingLine: "Magandang umaga, this is {name}'s reminder line.",
    });

    const seeded = await seedCallTest(admin, SPINE, {
      tenantId: TEST_TENANT,
      phone: NUMBER,
      phoneAllowlist: ALLOW,
      now: () => fixedNow,
    });

    expect(seeded.windowAdjusted).toBe(true);
    const s = await admin.query<{ window_start: string; window_end: string; opening_line: string }>(
      `select window_start, window_end, opening_line from crm.outreach_settings
        where tenant_id = $1`,
      [TEST_TENANT],
    );
    expect(
      isWithinWindow(fixedNow, {
        windowStart: s.rows[0].window_start,
        windowEnd: s.rows[0].window_end,
        timezone: "Asia/Manila",
      }),
    ).toBe(true);
    // Her opening line is untouched — only the window moved, and the result says so.
    expect(s.rows[0].opening_line).toBe("Magandang umaga, this is {name}'s reminder line.");
    expect(seeded.openingLine).toContain("Call Test");
  });

  it("leaves an already-open window alone", async () => {
    const fixedNow = new Date("2026-03-03T03:00:00Z"); // 11:00 Asia/Manila
    await seedSettings(admin, { windowStart: "09:00", windowEnd: "18:00" });

    const seeded = await seedCallTest(admin, SPINE, {
      tenantId: TEST_TENANT,
      phone: NUMBER,
      phoneAllowlist: ALLOW,
      now: () => fixedNow,
    });

    expect(seeded.windowAdjusted).toBe(false);
    const s = await admin.query<{ window_start: string }>(
      `select window_start from crm.outreach_settings where tenant_id = $1`,
      [TEST_TENANT],
    );
    expect(s.rows[0].window_start).toBe("09:00:00");
  });
});
