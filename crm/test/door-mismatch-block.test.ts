// Core loop / Family 4 — the CHANGED-RETRY poison: a crashed cycle's retry whose bytes no
// longer match what the door recorded.
//
// THE BUG (reproduced at HEAD before this suite's fix existed): the proposer POSTs to the
// A2 door and only then records the action (proposer.ts). A crash between those two steps
// leaves an OPEN, ZERO-ACTION follow-up designed to be retried with the SAME deterministic
// key. But the door pre-checks the idempotency FINGERPRINT `(action_type, payload_hash,
// rationale)` and answers BEFORE the terminal-replay branch — so if ANY detail changed
// between the original POST and the retry (an email edit syncing from the sheet, or merely
// a new touch changing the date inside `lastTouchSummary`'s rationale text), the retry is
// refused 422 FOR EVER. Expiry does not heal it (the close pass inner-joins through
// actions and cannot see a zero-action row; the fingerprint pre-check answers before the
// terminal branch, so even an `expired` row poisons the key), and the zero-action row
// freezes the due date so the key never rolls. Invisible: no blocked row, nothing in the
// digest — only reconcile's "claimed, no proposal" listing, whose docs promise a 15-minute
// self-heal that never comes.
//
// THE FIX UNDER TEST: the proposer catches the door's 422 SPECIFICALLY and blocks the
// follow-up with a surfaced, broker-readable reason. Blocked rows are excluded from
// `openZeroActionFollowUpDate` AND from the date-aware guard, so the next Manila day
// derives a fresh key and the contact heals on its own.
//
// 🚨 THE SINGLE MOST IMPORTANT DISTINCTION IN THIS SUITE: a 409 TERMINAL REPLAY MUST NOT
// BLOCK. A 409 occurs normally and healthily in the same-day window between an
// `execution_failed` outcome and the close pass running — and the close pass requires
// `blocked_reason is null`, so blocking on 409 would strand that row open-blocked forever.
// T3 pins it.
//
// Every pin drives the PRODUCTION proposer (`runCycle`) against the REAL door
// (`createApprovalApp` over HTTP), with the REAL claim/lease and an injected clock — never
// the machine clock, never a fake door.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  freshCrmDb,
  seedContact,
  seedLinkedSheet,
  seedNumber,
  seedSettings,
  startTouch,
  TEST_TENANT,
  TEST_INSTANT,
} from "./helpers/crmdb.js";
import { FakeSheet } from "./helpers/fakesheet.js";
import { publishQuestionSet } from "../src/questions.js";
import { runCycle, dueDateIn, type DoorProposal } from "../src/proposer.js";
import { DETAILS_CHANGED_REASON, type BlockedReason } from "../src/followups.js";
import { DoorReplyError } from "../src/door-reply.js";
import { closeTerminatedFollowUps, reconcile } from "../src/reconcile.js";
import { createApprovalApp } from "../../approval/src/server.js";
import { decide } from "../../approval/src/decide.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";

// N4 — COMPILE-TIME PIN: `BlockedReason` must never silently widen to `string`. Each
// plain-English member enters the union as `typeof <constant>`, and converting any one
// constant to a concatenation (`"a" + "b"` types as `string`) widens the whole union to
// accept anything, with zero compile errors anywhere else — the exact failure the union's
// own comment warns about. If that happens, `_NoWiden` resolves to `never` and the
// assignment below fails to typecheck. The VALUE form is load-bearing: an unused
// type-alias instantiation is deferred and never checked (measured 2026-08-18 — an alias
// form stayed green under the widened constant).
// mutation: in crm/src/followups.ts, split DETAILS_CHANGED_REASON into a two-part
//   concatenation ("…retried; " + "the system will…") -> typecheck red. RUN ✅ 2026-08-18
//   test/door-mismatch-block.test.ts(68,7): error TS2322: Type 'true' is not assignable
//   to type 'never'.   (tsc exit 2 over this file). NOTE: crm's workspace typecheck
//   (`tsc -p tsconfig.json --noEmit`) includes only `src`, so this copy is enforced only
//   by checks that include tests; the twin VALUE-form pin beside the union in
//   src/followups.ts is what makes the workspace typecheck fail, verified red the same
//   run: src/followups.ts(88,7): error TS2322: Type 'true' is not assignable to type
//   'never'. (exit 2). Constant restored to one literal -> both checks exit 0.
type _NoWiden = string extends BlockedReason ? never : true;
const _ok: _NoWiden = true;
void _ok;

const SECRET = "test-proposal-token-do-not-reuse";
const TZ = "Asia/Manila";
const SETTINGS = { intervalDays: 30, shortRetryDays: 3 };

// Same-day instants (fixed, mid-Manila-day — see TEST_INSTANT's warning): 11:00 / 11:20 /
// 11:30 Manila on day D. The 15-minute lease from t0 ends 11:15, so tRetry re-claims.
const t0 = TEST_INSTANT; // 2026-03-03T03:00Z = 11:00 Manila, day D = 2026-03-03
const tRetry = new Date(t0.getTime() + 20 * 60_000);
const tAfter = new Date(t0.getTime() + 30 * 60_000);

// Cross-midnight instants for the heal pin: 23:56 Manila day D, then 00:20 and 00:40 on
// day D+1. Asia/Manila is UTC+8 with no DST, so the arithmetic is exact; the premise (the
// dates differ) is asserted inside the pin rather than assumed.
const tPre = new Date("2026-03-03T15:56:00Z"); // 23:56 Manila, day D
const tPost = new Date("2026-03-03T16:20:00Z"); // 00:20 Manila, day D+1
const tPost2 = new Date("2026-03-03T16:40:00Z"); // 00:40 Manila, day D+1

// Next-Manila-day instants for the mixed-leg double-serve pin (T6): 11:00 and 11:20 on day
// D+1. The FIRST D+1 claim reads the cycle-2 lease (11:35 day D) and so still derives day
// D; only the SECOND reads a lease that has crossed midnight (11:15 day D+1) and derives
// the fresh date. Two claims, exactly as production would take them.
const tNextA = new Date("2026-03-04T03:00:00Z"); // 11:00 Manila, day D+1
const tNextB = new Date("2026-03-04T03:20:00Z"); // 11:20 Manila, day D+1

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let cleanup: () => Promise<void>;
let base: string;
let closeServer: () => Promise<void>;

/** The door adapter, mirroring the production daemon's contract (`crm/src/main.ts`): 200
 *  and 201 carry the id; EVERYTHING ELSE THROWS — including 409, which the daemon treats
 *  as a per-contact failure today. The throw is `DoorReplyError` so the status survives to
 *  the proposer, exactly as the daemon's adapter now throws it. */
async function doorPost(p: DoorProposal): Promise<{ id: string }> {
  const res = await fetch(`${base}/internal/proposals`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(p),
  });
  const text = await res.text();
  if (res.status !== 200 && res.status !== 201) {
    throw new DoorReplyError(res.status, `door refused ${p.action_type} (${res.status}): ${text}`);
  }
  const body = JSON.parse(text) as { id?: string };
  if (!body.id) throw new Error(`door returned ${res.status} without an id: ${text}`);
  return { id: body.id };
}

/** The MIXED-LEG crash (T5/T6): the CALL leg posts and its action records normally; the
 *  EMAIL leg posts at the door and then its local action insert dies. The durable residue
 *  is an OPEN row with ONE action (call) whose card is pending in her queue, plus an
 *  email proposal at the door with no local action row. */
function failOnEmailActionInsert(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return async (text: unknown, params?: unknown): Promise<unknown> => {
          if (
            typeof text === "string" &&
            text.includes("insert into crm.follow_up_actions") &&
            Array.isArray(params) &&
            params[1] === "email"
          ) {
            throw new Error("killed after the email door POST, before its local action write");
          }
          return (target.query as (t: unknown, p?: unknown) => Promise<unknown>)(text, params);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

// The sheet vocabulary from proposer-sheet.test.ts, kept byte-compatible: a `both` contact
// whose email lives on the LIVE sheet (post-022 the email leg only builds for a
// sheet-bound contact, so the mixed-leg scenario requires one).
const SHEET_HEADER = ["Name", "Email", "Contact #", "Met At", "Looking For"];

/** A sheet-bound `both` contact: linked sheet + FakeSheet row + the adopted stored number
 *  the payload grammar needs. Returns the transport to inject into `runCycle`. */
async function sheetBothContact(o: {
  dueAt: string;
  email: string;
  phoneCell: string;
  storedE164: string;
}): Promise<{ contactId: string; sheet: FakeSheet }> {
  const linked = await seedLinkedSheet(admin);
  const ref = randomUUID();
  const sheet = new FakeSheet(linked.spreadsheetId, SHEET_HEADER, [
    { ref, cells: ["Ana Reyes", o.email, o.phoneCell, "", ""] },
  ]);
  const contactId = await seedContact(admin, {
    displayName: "Ana Reyes",
    channel: "both",
    dueAt: o.dueAt,
    linkedSheetId: linked.id,
    rowRef: ref,
  });
  await seedNumber(admin, contactId, o.storedE164);
  return { contactId, sheet };
}

const pendingPlaceCallCount = async (): Promise<number> =>
  Number(
    (
      await admin.query<{ n: string }>(
        `select count(*) as n from approval.proposals
          where tenant_id = $1 and action_type = 'place_call' and state = 'pending'`,
        [TEST_TENANT],
      )
    ).rows[0].n,
  );

/** The crash between proposer.ts's door POST and its `follow_up_actions` insert — the door
 *  has recorded the proposal, the local action write dies (family3's fault-injection seam:
 *  everything else is the real `switchboard_crm` pool). */
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
): Promise<
  Array<{ id: string; due_date: string; blocked_reason: string | null; closed_at: Date | null }>
> =>
  (
    await admin.query<{
      id: string;
      due_date: string;
      blocked_reason: string | null;
      closed_at: Date | null;
    }>(
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

const proposalCount = async (): Promise<number> =>
  Number(
    (
      await admin.query<{ n: string }>(
        `select count(*) as n from approval.proposals where tenant_id = $1`,
        [TEST_TENANT],
      )
    ).rows[0].n,
  );

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

  const app = createApprovalApp(approval, {
    tenantId: TEST_TENANT,
    proposalToken: SECRET,
    pendingCap: 50,
    actionRateLimit: 50,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closeServer = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.linked_sheets");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (closeServer) await closeServer();
  if (approval) await approval.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("Family 4 / T1 — changed-detail retry of a crashed-post-door orphan BLOCKS, surfaced", () => {
  // mutation: neuter the fix — in proposer.ts's catch, change the condition
  //   `err instanceof DoorReplyError && err.status === 422` to `false` (the pre-fix
  //   behaviour: every door refusal propagates) -> red. RUN ✅ 2026-08-18
  //   DoorReplyError: door refused place_call (422): {"error":"idempotency key reused with
  //   a DIFFERENT ask","detail":"this key already names a proposal whose fingerprint
  //   differs from the one just sent. Nothing was recorded. …"}
  //     ❯ Object.doorPost [as postProposal] test/door-mismatch-block.test.ts:89:11
  //     ❯ proposeForClaimed src/proposer.ts:262:16
  //     ❯ runCycle src/proposer.ts:120:14
  //   Tests  2 failed | 2 passed (4) — T2 reds with it. restored -> 4 passed.
  //
  // mutation (N3 — the mixed-leg fix must not have widened into never-block): make the
  //   422 catch ALWAYS skip — change `if (actions.length > 0) {` to `if (true) {` -> red.
  //   RUN ✅ 2026-08-18
  //   AssertionError: expected null to be 'an earlier follow-up attempt was inte…'
  //   - Expected: "an earlier follow-up attempt was interrupted, and this contact's
  //     details changed before it could be retried; the system will try again on its own
  //     using the contact's current details — nothing for you to do"
  //   + Received: null
  //     ❯ test/door-mismatch-block.test.ts:335:35  expect(outcome.blockedReason).toBe(…)
  //   Tests  2 failed | 4 passed (6) — this pin and T2 red together (the zero-action
  //   orphan silently skips forever again — the pre-953866a poison); T5/T6 stayed green.
  //   restored -> 6 passed.
  it("the retry is refused 422 by the real door and the contact becomes BLOCKED, not silent", async () => {
    const c = await seedContact(admin, { dueAt: t0.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    // Cycle N: the REAL door records the proposal ("never contacted" rationale); the local
    // action insert is killed. The durable residue is the zero-action orphan at day D.
    await expect(
      runCycle(
        { db: failOnActionInsert(crm), postProposal: doorPost, now: () => t0 },
        TEST_TENANT,
        10,
      ),
    ).rejects.toThrow("before the local action write");
    expect(await actionRows(c)).toHaveLength(0);
    expect(await proposalCount()).toBe(1);

    // A detail changes before the retry — a touch is recorded, which changes the
    // `lastTouchSummary` date inside the rationale text. The retry's bytes now differ.
    await startTouch(crm, c);

    // Cycle N+1, same Manila day: the frozen key replays, the door refuses 422 — and the
    // proposer must SURFACE that as a block instead of throwing forever.
    const [outcome] = await runCycle(
      { db: crm, postProposal: doorPost, now: () => tRetry },
      TEST_TENANT,
      10,
    );
    expect(outcome.blockedReason).toBe(DETAILS_CHANGED_REASON);
    expect(outcome.actions).toHaveLength(0);
    expect(outcome.skipped.map((s) => s.reason)).toContain(DETAILS_CHANGED_REASON);

    const rows = await followUpRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked_reason).toBe(DETAILS_CHANGED_REASON);
    expect(rows[0].closed_at).toBeNull();

    // VISIBLE: the reconcile surface lists it — the bug's whole point was invisibility.
    const report = await reconcile(admin, { digestDueLocalTime: "23:59" });
    expect(report.blockedFollowUps.map((b) => b.followUpId)).toContain(rows[0].id);
    expect(
      report.blockedFollowUps.find((b) => b.followUpId === rows[0].id)!.reason,
    ).toBe(DETAILS_CHANGED_REASON);

    // The reason is HER text, not ours: plain English, no wire jargon.
    expect(DETAILS_CHANGED_REASON).not.toMatch(/422|fingerprint|idempoten|http|payload/i);

    // Nothing new was written at the door (the 422 records nothing).
    expect(await proposalCount()).toBe(1);
  });
});

describe("Family 4 / T2 — the blocked contact HEALS on the next Manila day (fresh key)", () => {
  // mutation: remove the blocked-row exclusion the heal depends on — delete the line
  //   `and f.blocked_reason is null` from openZeroActionFollowUpDate
  //   (crm/src/followups.ts) -> red. RUN ✅ 2026-08-18
  //   AssertionError: expected [] to have a length of 1 but got +0
  //     ❯ test/door-mismatch-block.test.ts:311:28  expect(healed.actions).toHaveLength(1)
  //   Tests  1 failed | 3 passed (4). The blocked day-D row's date is adopted again, the
  //   frozen key replays, the door refuses 422 again, and the contact re-blocks instead of
  //   healing. restored -> 4 passed.
  it("next-day cycle derives a fresh key, proposes normally, and the block stays surfaced", async () => {
    // The premise, asserted rather than assumed: tPre and tPost are different Manila days.
    expect(dueDateIn(tPost, TZ)).not.toBe(dueDateIn(tPre, TZ));
    const frozen = dueDateIn(tPre, TZ);

    const c = await seedContact(admin, { dueAt: tPre.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    // Cycle N at 23:56 day D: door writes the proposal, the local action insert dies.
    await expect(
      runCycle(
        { db: failOnActionInsert(crm), postProposal: doorPost, now: () => tPre },
        TEST_TENANT,
        10,
      ),
    ).rejects.toThrow("before the local action write");

    // A detail changes overnight (the reconciler appends a bounce touch, the sheet syncs an
    // edit — any of them). The frozen key's bytes no longer match.
    await startTouch(crm, c);

    // Cycle N+1 at 00:20 day D+1: the orphan's day-D date is adopted (zero-action,
    // unblocked), the frozen key replays, the door refuses 422 → BLOCKED, not silent.
    const [blocked] = await runCycle(
      { db: crm, postProposal: doorPost, now: () => tPost },
      TEST_TENANT,
      10,
    );
    expect(blocked.blockedReason).toBe(DETAILS_CHANGED_REASON);
    expect(blocked.dueDate).toBe(frozen);

    // Cycle N+2 at 00:40 day D+1: the blocked row is EXCLUDED from adoption and from the
    // date-aware guard, so the lease value (00:35, day D+1) derives a FRESH key and the
    // contact proposes normally. This is the heal.
    const [healed] = await runCycle(
      { db: crm, postProposal: doorPost, now: () => tPost2 },
      TEST_TENANT,
      10,
    );
    expect(healed.actions).toHaveLength(1);
    expect(healed.blockedReason).toBeNull();
    expect(healed.dueDate).toBe(dueDateIn(tPost, TZ)); // day D+1 — the key rolled
    expect(healed.actions[0].idempotencyKey).toBe(
      `followup:${c}:${dueDateIn(tPost, TZ)}:call`,
    );

    // Two rows now: the day-D block (still open, still SURFACED — honesty over tidiness)
    // and the healthy day-D+1 row carrying the new action.
    const rows = await followUpRows(c);
    expect(rows).toHaveLength(2);
    expect(rows[0].due_date).toBe(frozen);
    expect(rows[0].blocked_reason).toBe(DETAILS_CHANGED_REASON);
    expect(rows[1].blocked_reason).toBeNull();
    const acts = await actionRows(c);
    expect(acts).toHaveLength(1);
    expect(acts[0].follow_up_id).toBe(rows[1].id);
  });
});

describe("Family 4 / T3 — 🚨 a 409 terminal replay does NOT block (the healthy same-day window)", () => {
  // mutation: widen the catch to the sibling status — in proposer.ts change
  //   `err.status === 422` to `(err.status === 422 || err.status === 409)` -> red.
  //   RUN ✅ 2026-08-18
  //   AssertionError: promise resolved "[ { …(5) } ]" instead of rejecting
  //   + Received: [ { "actions": [], "blockedReason": "an earlier follow-up attempt was
  //     interrupted, and this contact's details changed before it could be retried; …",
  //     "dueDate": "2026-03-03", … } ]
  //     ❯ test/door-mismatch-block.test.ts:376:6  await expect(runCycle(…)).rejects…
  //   Tests  1 failed | 3 passed (4). The 409 was converted into a block — wearing a reason
  //   that is now a LIE (nothing changed), on a row the close pass below can no longer see
  //   (`blocked_reason is null` is in its predicate): the strand. restored -> 4 passed.
  it("execution_failed + close pass not yet run: the retry 409s, the row stays open and UNBLOCKED, and the close pass then heals it", async () => {
    const c = await seedContact(admin, { dueAt: t0.toISOString() });
    await seedNumber(admin, c, "+639171234567");

    // A NORMAL cycle: proposal recorded, action linked.
    const [first] = await runCycle(
      { db: crm, postProposal: doorPost, now: () => t0 },
      TEST_TENANT,
      10,
    );
    expect(first.actions).toHaveLength(1);
    const pA = first.actions[0].proposalId;

    // Her approval, then the vendor fails — `execution_failed`, a TERMINAL state. The close
    // pass has NOT run yet: this is the ordinary same-day window in which the door answers
    // 409 to the deterministic key.
    const approver = (
      await admin.query<{ id: string }>(
        `insert into approval.users (email) values ($1) returning id`,
        [`broker-${randomUUID()}@example.com`],
      )
    ).rows[0].id;
    await decide(approval, { proposalId: pA, kind: "approved", approverUserId: approver });
    await beginExecution(approval, pA);
    await finishExecution(approval, pA, { ok: false, error: "vendor rejected the call" });
    expect(
      (await admin.query(`select state from approval.proposals where id = $1`, [pA])).rows[0]
        .state,
    ).toBe("execution_failed");

    // The retry inside the window: same key, same bytes, terminal row → 409. The daemon
    // adapter throws it (per-contact skip today) — and the proposer MUST NOT convert it
    // into a block: the close pass below requires `blocked_reason is null`.
    await expect(
      runCycle({ db: crm, postProposal: doorPost, now: () => tRetry }, TEST_TENANT, 10),
    ).rejects.toMatchObject({ name: "DoorReplyError", status: 409 });

    const rows = await followUpRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].closed_at).toBeNull(); // still open —
    expect(rows[0].blocked_reason).toBeNull(); // — and NOT blocked
    expect(await actionRows(c)).toHaveLength(1); // the original action, untouched

    // The window closes the way it is designed to: the close pass sees the terminal action
    // (it CAN, because blocked_reason stayed null), closes the row, and re-proposes
    // tomorrow. Blocking on 409 would have made this row invisible to it forever.
    const closed = await closeTerminatedFollowUps(admin, tAfter);
    expect(closed).toHaveLength(1);
    expect(closed[0].reason).toBe("expired_or_failed");
    expect((await followUpRows(c))[0].closed_at).not.toBeNull();
  });
});

describe("Family 4 / T4 — the UNCHANGED retry still replays (200) and completes", () => {
  // mutation: break key determinism — in proposer.ts's idempotencyKey, append a
  //   time-varying suffix: `…:${channel}` -> `…:${channel}:${Date.now()}` -> red.
  //   RUN ✅ 2026-08-18
  //   TypeError: Cannot read properties of undefined (reading 'id')
  //     ❯ test/door-mismatch-block.test.ts:422:15  (the pA lookup under the deterministic
  //       key — the door holds NO row under it any more; the rolled key minted a stray)
  //   Tests  4 failed (4) — every pin in this suite depends on the key being deterministic,
  //   so all four red together. restored -> 4 passed.
  it("nothing changed: the frozen key replays against the same proposal and the action links it", async () => {
    const c = await seedContact(admin, { dueAt: t0.toISOString() });
    await seedNumber(admin, c, "+639171234567");
    const frozen = dueDateIn(t0, TZ);

    // Cycle N: door records the proposal, the local action write dies.
    await expect(
      runCycle(
        { db: failOnActionInsert(crm), postProposal: doorPost, now: () => t0 },
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

    // Cycle N+1, NOTHING changed: byte-identical replay → 200, the SAME proposal id, the
    // action row finally links it. This is the self-heal the design promises today, and the
    // 422 fix must not have narrowed it.
    const [outcome] = await runCycle(
      { db: crm, postProposal: doorPost, now: () => tRetry },
      TEST_TENANT,
      10,
    );
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0].proposalId).toBe(pA);
    expect(outcome.blockedReason).toBeNull();

    const acts = await actionRows(c);
    expect(acts).toHaveLength(1);
    expect(acts[0].proposal_id).toBe(pA);
    expect(await proposalCount()).toBe(1); // no twin was minted
    const rows = await followUpRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked_reason).toBeNull();
  });
});

describe("Family 4 / T5 — MIXED LEG (N1): a sibling already posted, so the 422 leg SKIPS and the row is NOT blocked", () => {
  // THE DEFECT THIS PINS (proved at 953866a): for a `both` contact whose call leg posted
  // (action recorded) before the email leg crashed post-door, the changed retry's email
  // 422 blocked the WHOLE row — a row already carrying a live call card PENDING IN HER
  // QUEUE. Blocked rows are invisible to `hasOpenFollowUpBefore`, so the next day
  // re-proposed BOTH legs (a second pending call card — T6), and invisible to the close
  // pass (`blocked_reason is null`), so a rejection of the live card stranded the row
  // open for ever. The fix: block on 422 ONLY when no leg has posted this cycle.
  //
  // mutation: restore the unconditional block — in proposer.ts's 422 catch, delete the
  //   `if (actions.length > 0) { skipped.push(…); continue; }` branch -> red.
  //   RUN ✅ 2026-08-18
  //   AssertionError: expected 'an earlier follow-up attempt was inte…' to be null
  //   + Received: "an earlier follow-up attempt was interrupted, and this contact's
  //     details changed before it could be retried; the system will try again on its own
  //     using the contact's current details — nothing for you to do"
  //     ❯ test/door-mismatch-block.test.ts:590:35  expect(outcome.blockedReason).toBeNull()
  //   Tests  2 failed | 4 passed (6) — T6 reds with it (two pending call cards; its
  //   record below). The row carrying her LIVE pending call card was declared blocked.
  //   restored -> 6 passed.
  it("call posted + email 422: no block, the email leg is reported skipped, the call action survives", async () => {
    const { contactId: c, sheet } = await sheetBothContact({
      dueAt: t0.toISOString(),
      email: "ana@old.example.com",
      phoneCell: "0917 123 4567",
      storedE164: "+639171234567",
    });
    const dayD = dueDateIn(t0, TZ);

    // Cycle N: the call leg posts AND records its action; the email leg posts at the real
    // door, then its local action insert dies. Residue: an open row with ONE live call
    // card pending in her queue, plus an email proposal at the door with no action row.
    await expect(
      runCycle(
        { db: failOnEmailActionInsert(crm), postProposal: doorPost, now: () => t0, sheet },
        TEST_TENANT,
        10,
      ),
    ).rejects.toThrow("before its local action write");
    const acts1 = await actionRows(c);
    expect(acts1).toHaveLength(1);
    expect(acts1[0].channel).toBe("call");
    const pCall = acts1[0].proposal_id;
    expect(await proposalCount()).toBe(2); // call + email, both recorded at the door

    // Her sheet edit before the retry: the email address changes, so the email leg's bytes
    // no longer match the frozen key's fingerprint. The call leg's bytes are unchanged.
    sheet.rows[1].cells[1] = "ana@new.example.com";

    // Cycle N+1, same Manila day: the call leg replays 200 (same proposal id), the email
    // leg is refused 422 — and the row must NOT be blocked: it carries a LIVE pending card.
    const [outcome] = await runCycle(
      { db: crm, postProposal: doorPost, now: () => tRetry, sheet },
      TEST_TENANT,
      10,
    );
    expect(outcome.blockedReason).toBeNull();
    expect(outcome.actions).toHaveLength(1);
    expect(outcome.actions[0].channel).toBe("call");
    expect(outcome.actions[0].proposalId).toBe(pCall); // replay, never a twin
    const emailSkips = outcome.skipped.filter((s) => s.channel === "email");
    expect(emailSkips).toHaveLength(1);
    expect(emailSkips[0].reason).toMatch(/interrupted/i);
    // The same standard as every surfaced sentence: plain English, no wire jargon.
    expect(emailSkips[0].reason).not.toMatch(/422|fingerprint|idempoten|http|payload/i);

    // The row: open, UNBLOCKED, still carrying the posted call action — so the close pass
    // (`blocked_reason is null`) can see it when the live card reaches a terminal state.
    const rows = await followUpRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].due_date).toBe(dayD);
    expect(rows[0].blocked_reason).toBeNull();
    expect(rows[0].closed_at).toBeNull();
    const acts2 = await actionRows(c);
    expect(acts2).toHaveLength(1);
    expect(acts2[0].proposal_id).toBe(pCall);

    // Her queue: exactly ONE pending call card, and nothing new minted at the door.
    expect(await pendingPlaceCallCount()).toBe(1);
    expect(await proposalCount()).toBe(2);
  });
});

describe("Family 4 / T6 — MIXED LEG (N2): the next day does NOT serve a second call card", () => {
  // Continues T5 to day D+1, through BOTH claims production would take. Under the
  // unconditional block the second D+1 claim derives a fresh date, the blocked day-D row
  // is invisible to the date-aware guard, and the contact ends the day with TWO pending
  // place_call cards (`…:2026-03-03:call` and `…:2026-03-04:call`) — the double-serve.
  // With the fix, the day-D row stays open+unblocked+actioned and suppresses D+1 cleanly.
  //
  // mutation: restore the unconditional block (delete the `actions.length > 0` branch)
  //   -> red: two pending place_call cards. RUN ✅ 2026-08-18
  //   AssertionError: expected 2 to be 1 // Object.is equality
  //   - 1
  //   + 2
  //     ❯ test/door-mismatch-block.test.ts:658:43  expect(await pendingPlaceCallCount()).toBe(1)
  //   Tests  2 failed | 4 passed (6) — the blocked day-D row was invisible to the guard,
  //   the second D+1 claim minted `followup:…:2026-03-04:call` next to the still-pending
  //   `followup:…:2026-03-03:call`: she would be asked to approve calling the same
  //   contact twice. restored -> 6 passed.
  it("day D+1 suppresses via the open actioned row — never two pending place_call cards", async () => {
    const { contactId: c, sheet } = await sheetBothContact({
      dueAt: t0.toISOString(),
      email: "ana@old.example.com",
      phoneCell: "0917 123 4567",
      storedE164: "+639171234567",
    });

    // Cycle N (11:00 day D): call posted + recorded, email posted, its action write dies.
    await expect(
      runCycle(
        { db: failOnEmailActionInsert(crm), postProposal: doorPost, now: () => t0, sheet },
        TEST_TENANT,
        10,
      ),
    ).rejects.toThrow("before its local action write");
    const pCall = (await actionRows(c))[0].proposal_id;

    // The sheet edit, then the same-day retry (11:20 day D): call replays, email 422s.
    sheet.rows[1].cells[1] = "ana@new.example.com";
    await runCycle({ db: crm, postProposal: doorPost, now: () => tRetry, sheet }, TEST_TENANT, 10);

    // Day D+1, claim 1 (11:00): the cycle-2 lease still derives day D — same frozen key,
    // call replays, email 422s again. Claim 2 (11:20): the lease has rolled to day D+1.
    await runCycle({ db: crm, postProposal: doorPost, now: () => tNextA, sheet }, TEST_TENANT, 10);
    const cycles = await runCycle(
      { db: crm, postProposal: doorPost, now: () => tNextB, sheet },
      TEST_TENANT,
      10,
    );

    // THE PIN: one pending call card for this contact — never two.
    expect(await pendingPlaceCallCount()).toBe(1);
    // The fresh-date key was never minted at the door…
    const d1Key = `followup:${c}:${dueDateIn(tNextA, TZ)}:call`;
    const d1 = await admin.query(
      `select id from approval.proposals where tenant_id = $1 and idempotency_key = $2`,
      [TEST_TENANT, d1Key],
    );
    expect(d1.rowCount).toBe(0);
    // …because the D+1-dated claim was suppressed by the open, unblocked, ACTIONED day-D
    // row (hasOpenFollowUpBefore), not re-proposed.
    expect(cycles).toHaveLength(1);
    expect(cycles[0].actions).toHaveLength(0);
    expect(cycles[0].blockedReason).toBeNull();
    expect(cycles[0].skipped.map((s) => s.reason)).toContain(
      "an open follow-up from an earlier due date exists",
    );

    // One open, unblocked row carrying the one call action — the close pass can see it.
    const rows = await followUpRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked_reason).toBeNull();
    expect(rows[0].closed_at).toBeNull();
    const acts = await actionRows(c);
    expect(acts).toHaveLength(1);
    expect(acts[0].proposal_id).toBe(pCall);
  });
});
