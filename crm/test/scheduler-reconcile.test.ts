// Core loop / T13 pins — the scheduler and the reconcile listing.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  freshCrmDb,
  seedContact,
  seedNumber,
  seedSettings,
  startTouch,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { publishQuestionSet } from "../src/questions.js";
import { beginTouch } from "../src/touch.js";
import { startScheduler } from "../src/scheduler.js";
import { reconcile, formatReconcile } from "../src/reconcile.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import { claimDue } from "../src/claim.js";
import { payloadHash } from "../../approval/src/canonical.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, { intervalDays: 30, shortRetryDays: 3 });
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
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("T13: a failing cycle is logged, never thrown", () => {
  // mutation: drop the `.catch` entirely — `void runOnce();` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 4 passed (5)`
  //     AssertionError: expected [ Array(7) ] to deeply equal []
  //     (an `unhandledRejection` per tick, captured by the listener)
  //
  //   🚨 A NOTE ON A MUTATION THAT DID NOT DISCRIMINATE, recorded rather than quietly
  //   dropped: the first attempt was `.catch((err) => { throw err; }).catch(…)`, which
  //   stayed GREEN — the trailing catch still handles it. That is a badly-formed mutation,
  //   not a badly-formed pin, and the fix was to perform the stated mutation properly.
  //
  // An unhandled rejection out of a timer callback is a PROCESS KILL. Losing the whole
  // proposer because one cycle hit a bad row is strictly worse than losing that cycle: the
  // next tick is sixty seconds away and the claim lease makes the lost work re-claimable in
  // fifteen minutes.
  it("survives a cycle that rejects", async () => {
    const errors: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      errors.push(e);
    };
    process.on("unhandledRejection", onUnhandled);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startScheduler(async () => {
      throw new Error("bad row");
    }, 10);
    await new Promise((r) => setTimeout(r, 80));
    stop();
    logged.mockRestore();
    process.off("unhandledRejection", onUnhandled);
    expect(errors).toEqual([]);
  });
});

describe("T13: the timer never holds the process open", () => {
  // mutation: remove `timer.unref?.()` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 4 passed (5)` — the child never exits and `execFile`
  //     kills it at the 15s timeout. Without `unref` a process that starts the scheduler
  //     can never shut down cleanly.
  //
  // Run in a CHILD PROCESS on purpose: asserting `timer.hasRef()` in-process would be
  // asserting the implementation back at itself. The independent variable is "does node
  // exit".
  it("lets a process that started the scheduler exit on its own", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", join(HERE, "helpers", "scheduler-exit.ts")],
      { timeout: 15_000, cwd: join(HERE, "..") },
    );
    expect(stdout).toContain("scheduler started");
  }, 20_000);
});

describe("T13: a crash between the claim and the proposal loses the cycle, not the lead", () => {
  // 🚨 FINDING, REPORTED RATHER THAN PAPERED OVER (Minor 1 — observation corrected). The
  // plan's stated mutation — "move the claim after the proposal" — did NOT red *against this
  // pin as first written*, because this implementation protects the property TWICE: the
  // crash happens after `openFollowUp`, so on restart the open-guard refuses the contact
  // before the claim is ever consulted. §4 forbids adjusting a stubborn pin to make it pass,
  // so the mutation is recorded as non-discriminating and a SECOND, directly sensitive
  // assertion (`claimDue()` returns nothing inside the lease, line ~152) was added instead.
  // That second assertion DOES red under its own mutation below — a later reader re-running
  // "move the claim after the proposal" now hits that assertion and sees a failure, which is
  // why the wording is "against the pin as first written" rather than "did not red".
  //
  // mutation (the discriminating one): make the claim read without holding — replace the
  //           lease write with `set next_due_at = c.next_due_at` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 4 skipped (5)`
  //     AssertionError: expected [ { …(2) } ] to have a length of +0 but got 1
  //   i.e. with no lease held, a restart inside the lease window RE-CLAIMS the contact.
  //   (A first attempt at this mutation — dropping the lease expression outright — left the
  //   statement with an unused bind parameter and reddened on a Postgres error instead of on
  //   the property. Recorded because a mutation that reds for the wrong reason proves
  //   nothing; the shipped one keeps the parameter and multiplies the interval by zero.)
  //
  // The claim's whole job is to stop a second proposer for the length of one cycle. Claimed
  // first, a crash costs FIFTEEN MINUTES. Claimed last, the restart re-selects the same
  // contact and proposes again — and the deterministic key cannot save it, because the key
  // is built from the date THE CLAIM RETURNED.
  it("produces ZERO further proposals on restart inside the lease", async () => {
    const ana = await seedContact(admin, {
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await seedNumber(admin, ana, "+639171234567");

    const posted: DoorProposal[] = [];
    const crashingDoor = async (p: DoorProposal): Promise<{ id: string }> => {
      posted.push(p);
      throw new Error("process killed between claim and proposal");
    };
    await expect(runCycle({ db: crm, postProposal: crashingDoor }, TEST_TENANT, 10)).rejects.toThrow();
    expect(posted).toHaveLength(1);

    // 🚨 THE CLAIM ITSELF, asserted directly. A restart inside the lease claims NOTHING —
    // this is the assertion the plan's stated mutation ("move the claim after the proposal")
    // cannot isolate in this implementation, because T9's open-guard already refuses the
    // second pass. See the FINDING recorded above.
    expect(await claimDue(crm, TEST_TENANT, 10)).toHaveLength(0);

    // Restart, inside the lease.
    const afterRestart: DoorProposal[] = [];
    const ok = async (p: DoorProposal): Promise<{ id: string }> => {
      afterRestart.push(p);
      return { id: randomUUID() };
    };
    await runCycle({ db: crm, postProposal: ok }, TEST_TENANT, 10);
    expect(afterRestart).toHaveLength(0);
  });
});

describe("T13: reconcile lists exactly the four things", () => {
  // mutation: drop ANY ONE of the four queries -> red. RUN ✅ 2026-08-09, ALL FOUR RUN:
  //     claimedWithNoProposal   -> expected [] to include 'e237b6aa-…'
  //     blockedFollowUps        -> expected [] to deeply equal [ Array(1) ]
  //     transcriptsStuckPending -> expected [] to deeply equal [ Array(1) ]
  //     executingWithNoOutcome  -> expected [] to deeply equal [ Array(1) ]
  //
  // 🚨 "Shared numbers across contacts" is DELIBERATELY ABSENT — §5.2 deleted it, because a
  // listing whose only available response is "do nothing" is a trap, not information.
  it("finds a claimed-with-no-proposal contact, a blocked follow-up, a stuck transcript, and a wedged execution", async () => {
    // 1. Claimed, no proposal: leased, and nothing written since.
    const stranded = await seedContact(admin, { displayName: "Stranded Sam" });
    await admin.query(
      `update crm.contacts set next_due_at = now() + interval '10 minutes' where id = $1`,
      [stranded],
    );

    // 2. Blocked follow-up.
    const blocked = await seedContact(admin, { channel: "email", email: null });
    await admin.query(
      `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
       values ($1, current_date, 'no_email_address')`,
      [blocked],
    );

    // 3. A touch stuck at `pending` — the crash between summarising and sending.
    const called = await seedContact(admin);
    const touch = await startTouch(crm, called);
    await admin.query(
      `update crm.touches set occurred_at = now() - interval '2 hours' where id = $1`,
      [touch],
    );

    // 4. An `executing` proposal with a `started` row and no terminal one.
    const payload = { to: "x@y.z" };
    const prop = await admin.query<{ id: string }>(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
       values ($1, $2, 'send_email', $3::jsonb, 'wedged', $4, now() + interval '72 hours')
       returning id`,
      [TEST_TENANT, `wedged-${randomUUID()}`, JSON.stringify(payload), payloadHash(payload)],
    );
    const approver = await admin.query<{ id: string }>(
      `insert into approval.users (email) values ($1) returning id`,
      [`op-${randomUUID()}@example.com`],
    );
    // The decision row and the state move in ONE transaction — 015's guard requires it,
    // and a fixture that could reach `approved` any other way would be building a state the
    // running system cannot produce.
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
         values ($1, 'approved', $2, 'seed')`,
        [prop.rows[0].id, approver.rows[0].id],
      );
      await c.query(`update approval.proposals set state = 'approved' where id = $1`, [
        prop.rows[0].id,
      ]);
      await c.query("commit");
    } finally {
      c.release();
    }
    await admin.query(
      `insert into approval.executions (proposal_id, kind, idempotency_key, at)
       values ($1, 'started', 'k', now() - interval '2 hours')`,
      [prop.rows[0].id],
    );
    await admin.query(`update approval.proposals set state = 'executing' where id = $1`, [
      prop.rows[0].id,
    ]);

    const r = await reconcile(admin);
    expect(r.claimedWithNoProposal.map((c) => c.contactId)).toContain(stranded);
    expect(r.blockedFollowUps.map((b) => b.contactId)).toEqual([blocked]);
    expect(r.transcriptsStuckPending.map((t) => t.touchId)).toEqual([touch]);
    expect(r.executingWithNoOutcome.map((e) => e.proposalId)).toEqual([prop.rows[0].id]);

    await admin.query(`delete from approval.users where id = $1`, [approver.rows[0].id]).catch(
      () => {},
    );
  });

  it("does not list a shared number across contacts", async () => {
    // §5.2, made mechanical: two contacts on one household line produce NOTHING here.
    const a = await seedContact(admin, { displayName: "Ana Reyes", dueAt: null });
    const b = await seedContact(admin, { displayName: "Ben Reyes", dueAt: null });
    await seedNumber(admin, a, "+639171234567");
    await seedNumber(admin, b, "+639171234567");
    const r = await reconcile(admin);
    // FIVE listings now (the close pass added `passedOnLeads`). Shared numbers remain absent
    // — §5.2's trap has an available response of only "do nothing"; the passed-on listing's
    // available response is an ACTION (revisit), which is why it is information, not a trap.
    expect(Object.keys(r).sort()).toEqual([
      "blockedFollowUps",
      "claimedWithNoProposal",
      "executingWithNoOutcome",
      "passedOnLeads",
      "transcriptsStuckPending",
    ]);
    expect(JSON.stringify(r)).not.toContain("+639171234567");
  });
});

// ── Email spike / Task 4 ─────────────────────────────────────────────────────────────
describe("Email spike: reconcile stays silent about email touches", () => {
  // mutation: revert Task 3's ternary in `beginTouch` to the `'pending'` literal -> red.
  //           RUN ✅ 2026-08-12
  //   Observed: `Tests  1 failed | 5 passed (6)`
  //     AssertionError: expected [ …(2) ] to not include
  //                     '672ed9cf-6bbb-4c33-bc3c-2a609c04d111'
  //   i.e. the email touch appeared in the stuck-transcript list beside the call touch.
  //
  // This pin lands AFTER Task 3, so it is green on arrival and its red is never observed in
  // sequence. That is exactly why the revert-mutation below was RUN rather than reasoned: a
  // pin whose red was never observed is not a pin.
  //
  // What it protects: an email has no transcript, so an email touch listed as a stuck
  // transcript is a permanent false entry in a report that tells the operator, in those
  // words, that something "CANNOT be recovered". A report that cries wolf on every email is
  // a report she stops reading, and it is the only place real transcript loss ever surfaces.
  it("does not list an email touch as a stuck transcript", async () => {
    const ana = await seedContact(admin, { channel: "email", email: "ana@example.com" });
    const emailTouch = await beginTouch(crm, { contactId: ana, channel: "email" });
    // A CALL touch of the same age, as the positive control: the report is working.
    const callTouch = await beginTouch(crm, { contactId: ana, channel: "call" });
    await admin.query(
      `update crm.touches set occurred_at = now() - interval '2 hours' where id = any($1)`,
      [[emailTouch, callTouch]],
    );

    const report = await reconcile(admin, { pendingGraceMinutes: 30 });
    const ids = report.transcriptsStuckPending.map((t) => t.touchId);
    expect(ids).not.toContain(emailTouch);
    expect(ids).toContain(callTouch); // vacuity guard: the report DID run and DOES fire

    const text = formatReconcile(report);
    expect(text).not.toContain(emailTouch);
    expect(text).toContain(callTouch);
  });
});
