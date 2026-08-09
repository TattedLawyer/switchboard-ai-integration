// Phase 3 / A2, T9 — at-most-once execution, decided by the database.
//
// The property: two executors racing one approved proposal produce ONE `started` row, and
// the loser learns it lost from a `23505` rather than from an application-level check that
// can be raced. Plus the state A2 deliberately does not resolve — a `started` row with no
// terminal sibling — made detectable BY AGE and handed to A5.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { decide } from "../src/decide.js";
import {
  beginExecution,
  ExecutionRefused,
  findStuckExecutions,
  finishExecution,
} from "../src/execute.js";
import { sweepExpired } from "../src/expiry.js";
import { payloadHash } from "../src/canonical.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../ingest/src/cli/approval-user-add.ts", import.meta.url));
const INGEST_DIR = fileURLToPath(new URL("../../ingest", import.meta.url));
const APPROVAL_DIR = fileURLToPath(new URL("..", import.meta.url));
const STUCK_CLI = fileURLToPath(new URL("../src/cli/stuck-executions.ts", import.meta.url));

function roleUrl(adminUrl: string, role: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = role;
  return u.toString();
}
const TENANT = "00000000-0000-0000-0000-000000000000";

let admin: pg.Pool;
let app: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;
let approver: string;

async function seedApproved(
  opts: { expiresInHours?: number; expireAfterApproval?: boolean } = {},
): Promise<string> {
  const payload = { to: "jane@client.example.com", n: Math.random() };
  const r = await admin.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, 'send_email', $3::jsonb, 'execute probe', $4,
             now() + make_interval(hours => $5::int))
     returning id`,
    [
      TENANT,
      `t9-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      payloadHash(payload),
      opts.expiresInHours ?? 72,
    ],
  );
  const id = r.rows[0].id as string;
  await decide(app, { proposalId: id, kind: "approved", approverUserId: approver });
  if (opts.expireAfterApproval) {
    // Approve while LIVE, then let the window close — which is what actually happens: the
    // human decides inside the window and the executor arrives after it. It cannot be
    // seeded the other way round any more, because `decide()` now refuses an expired ask
    // (I-2), and that ordering constraint is itself evidence the two fixes compose.
    // `expires_at` is deliberately not a frozen column: time has to be able to pass.
    await admin.query(
      `update approval.proposals set expires_at = now() - interval '1 hour' where id = $1`,
      [id],
    );
  }
  return id;
}

const stateOf = async (id: string): Promise<string> =>
  (await app.query(`select state from approval.proposals where id = $1`, [id])).rows[0]
    .state as string;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  url = r.url;
  cleanup = r.cleanup;
  const u = new URL(url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  app = new pg.Pool({ connectionString: u.toString(), max: 8 });
  app.on("error", () => {});
  const email = `t9-${Math.random().toString(36).slice(2)}@example.com`;
  await execFileAsync(process.execPath, ["--import", "tsx", CLI, "--email", email], {
    env: { ...process.env, DATABASE_URL: url },
    cwd: INGEST_DIR,
  });
  approver = (await app.query(`select id from approval.users where email = $1`, [email])).rows[0]
    .id as string;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (app) await app.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("A2/T9: at-most-once is decided by the database, not by application code", () => {
  it("concurrent starts produce ONE winner, and the loser sees 23505", async () => {
    // 🚨 FINDING — THIS PIN IS **NOT** SENSITIVE TO DROPPING THE INDEX, AND THE PLAN SAYS
    // IT IS. Plan §4/T9 predicts: "the partial unique index is dropped -> concurrent start
    // produces two rows and the pin reds". RUN, and it does NOT: with
    // `executions_one_start` dropped this test STAYS GREEN and only the sibling test below
    // reds. Recorded rather than adjusted, because tuning a stubborn pin until it greens
    // is how this project shipped five tests that passed while the property they named was
    // false — and the honest inverse is not to claim a sensitivity that was measured
    // absent.
    //
    // WHY it stays green, which is the useful part: with the index gone, both callers
    // insert their `started` row (nothing stops them), then both attempt the CONDITIONAL
    // UPDATE `where state = 'approved'` inside the same transaction. One wins; the loser's
    // update returns rowcount 0, it rolls back, AND ITS `started` ROW GOES WITH IT. So
    // exactly one row survives even without the index.
    //
    // 🚨 THE INDEX IS REDUNDANT HERE, NOT INERT — AND THE DIFFERENCE MATTERS ENOUGH THAT AN
    // EARLIER DRAFT OF THIS COMMENT GOT IT WRONG. Measured on the UNMUTATED system, with
    // two racers doing exactly what `beginExecution` does:
    //
    //     A: LOST -> 23505 duplicate key value violates unique constraint
    //                "executions_one_start"
    //     B: WON  (update rowcount 1)
    //
    // The index fires FIRST, at INSERT, before either UPDATE runs. So as shipped it IS the
    // decisive mechanism in the concurrent race. The pin is insensitive to removing it
    // only because a SECOND mechanism covers the same property once it is gone — which is
    // defence in depth working, not a misattributed guarantee.
    //
    // Two consequences worth stating so nobody draws the wrong lesson:
    //   · the plan's "at-most-once lives in Postgres" attribution is CORRECT. Both
    //     mechanisms are in Postgres; nothing moved into application code. Only the
    //     SENSITIVITY PREDICTION is false.
    //   · 🚨 this is NOT licence to drop the index. It is the ONLY mechanism covering the
    //     sequential case below — a retry after a completed or crashed send — which is
    //     the case that actually reds.
    //
    // The assertion is therefore deliberately permissive about WHICH loud failure the loser
    // gets — 23505 or a refused transition — and strict about the thing that must never
    // happen: two `started` rows.
    const id = await seedApproved();
    const results = await Promise.allSettled([beginExecution(app, id), beginExecution(app, id)]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);

    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    // Either the unique index refused it (23505) or it lost the conditional UPDATE — both
    // are correct outcomes, and both are LOUD. What must never happen is two started rows.
    const err = lost.reason as { code?: string };
    expect(
      err.code === "23505" || lost.reason instanceof ExecutionRefused,
      `the loser failed for an unexpected reason: ${String(lost.reason)}`,
    ).toBe(true);

    const started = await app.query(
      `select count(*)::int as n from approval.executions
        where proposal_id = $1 and kind = 'started'`,
      [id],
    );
    expect(started.rows[0].n, "two executors both started the same send").toBe(1);
    expect(await stateOf(id)).toBe("executing");
  });

  it("a SECOND start after a completed one is still refused — the index is permanent", async () => {
    // mutation: drop `executions_one_start` from 015 -> THIS is the pin that reds, with
    //           `ExecutionRefused` instead of the expected 23505. RUN ✅ 2026-08-08.
    //           It is the only demonstrated sensitivity the index has in this suite.
    const id = await seedApproved();
    await beginExecution(app, id);
    await finishExecution(app, id, { ok: true, vendorReference: "vendor-1" });
    expect(await stateOf(id)).toBe("executed");
    await expect(beginExecution(app, id)).rejects.toMatchObject({ code: "23505" });
  });

  it("propagates the proposal's own idempotency key to the vendor interface", async () => {
    // The key the human's ask was recorded under is the key the send goes out with, so a
    // retry at the vendor is the same logical send. 🚨 Whether the provider HONOURS it is a
    // C5 acceptance criterion, never an A2 assumption.
    const id = await seedApproved();
    const key = (
      await app.query(`select idempotency_key from approval.proposals where id = $1`, [id])
    ).rows[0].idempotency_key as string;
    const started = await beginExecution(app, id);
    expect(started.idempotencyKey).toBe(key);
    const row = await app.query(
      `select idempotency_key from approval.executions where proposal_id = $1`,
      [id],
    );
    expect(row.rows[0].idempotency_key).toBe(key);
  });
});

describe("A2/T9: an approval has to still be valid when it executes", () => {
  it("an APPROVED-but-expired row cannot be started — NO sweeper involved", async () => {
    // mutation: remove `and expires_at > now()` from `beginExecution`'s conditional UPDATE
    //           -> this reds (the send starts on a stale authorisation). RUN ✅ 2026-08-08
    //
    // 🚨 THIS PIN USED TO BE VACUOUS AND IT IS THE SIXTH SUCH ON THIS PROJECT. It called
    // `sweepExpired` first and asserted the row was `expired` BEFORE calling
    // `beginExecution` — so it only re-tested the sibling assertion below, and deleting the
    // expiry concept from `beginExecution` entirely (which is what the code actually did)
    // left it green. The sweeper call is gone: the row here is `approved` with an
    // `expires_at` in the past, which is the exact state the property is about.
    //
    // The failure it now covers: broker approves a send Friday 17:00; the executor is down
    // for the weekend; Monday the sweeper is also down, or misconfigured, or restarting;
    // A5 comes up first and sends an email on a 72-hour-stale authorisation.
    const id = await seedApproved({ expireAfterApproval: true });
    expect(await stateOf(id), "the fixture must be APPROVED, not swept").toBe("approved");
    await expect(beginExecution(app, id)).rejects.toBeInstanceOf(ExecutionRefused);
    await expect(beginExecution(app, id)).rejects.toThrow(/EXPIRED/);
    const n = await app.query(
      `select count(*)::int as n from approval.executions where proposal_id = $1`,
      [id],
    );
    expect(n.rows[0].n, "a started row was written for an expired approval").toBe(0);
    expect(await stateOf(id), "the row moved despite the refusal").toBe("approved");
  });

  it("a row already swept to `expired` cannot be started either — a DIFFERENT property", async () => {
    // Kept as its own test now that the one above no longer sweeps. These are two distinct
    // properties: "the state machine forbids expired -> executing" and "an approval that is
    // still `approved` but past its window is refused at the point of use". Only the second
    // survives a dead sweeper, and only the second was missing.
    const id = await seedApproved({ expireAfterApproval: true });
    await sweepExpired(app, TENANT);
    expect(await stateOf(id)).toBe("expired");
    await expect(beginExecution(app, id)).rejects.toBeInstanceOf(ExecutionRefused);
  });

  it("...while a LIVE approval still starts — the witness", async () => {
    const id = await seedApproved({ expiresInHours: 24 });
    const started = await beginExecution(app, id);
    expect(started.executionId).toBeTruthy();
    expect(await stateOf(id)).toBe("executing");
  });

  it("a pending proposal cannot be started — approval is not optional", async () => {
    const payload = { to: "a@example.com" };
    const r = await admin.query(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
       values ($1, $2, 'send_email', $3::jsonb, 'unapproved', $4, now() + interval '72 hours')
       returning id`,
      [TENANT, `t9-unapproved-${Math.random()}`, JSON.stringify(payload), payloadHash(payload)],
    );
    await expect(beginExecution(app, r.rows[0].id as string)).rejects.toBeInstanceOf(
      ExecutionRefused,
    );
  });
});

describe("A2/T9: the crash-mid-send state is DETECTABLE, and deliberately not adjudicated", () => {
  it("a started row with no terminal sibling is queryable BY AGE", async () => {
    // mutation: drop the `and s.at <= now() - ...` age clause from `findStuckExecutions`
    //           -> a send that started one second ago is reported as stuck, and the
    //           "young sends are not stuck" assertion reds. RUN ✅ 2026-08-08
    const stuck = await seedApproved();
    const fresh = await seedApproved();
    const done = await seedApproved();
    await beginExecution(app, stuck);
    await beginExecution(app, fresh);
    await beginExecution(app, done);
    await finishExecution(app, done, { ok: true });

    // Age the stuck one. `approval.executions.at` on the `started` row IS the start time.
    await admin.query(
      `update approval.executions set at = now() - interval '30 minutes'
        where proposal_id = $1 and kind = 'started'`,
      [stuck],
    );

    const found = await findStuckExecutions(app, 300);
    expect(found.map((f) => f.proposalId)).toEqual([stuck]);
    expect(found[0].ageSeconds).toBeGreaterThan(1500);
    // The witness in the other direction: a fresh send is NOT stuck, and a finished one is
    // never stuck no matter how old. Without these the age query could return everything
    // and still pass.
    expect(found.map((f) => f.proposalId)).not.toContain(fresh);
    expect(found.map((f) => f.proposalId)).not.toContain(done);
  });

  it("🚨 A2 builds NO reaper — the row stays `executing` and nothing moves it", async () => {
    // This is a DELIBERATE non-feature and it is pinned as one, so that a future change
    // that quietly adds a timer has to delete a test that says why it must not.
    //
    // A timer that flips a live in-flight send to `failed` is worse than a stuck row: the
    // human authorised ONE send, and a mistaken `failed` invites a second. Only a live
    // executor knows, and "A5 decides" cannot deliver if A5 is the process that died. So
    // A5 owns the reaper CONTRACT, with knowledge of the vendor's semantics that A2 lacks.
    const id = await seedApproved();
    await beginExecution(app, id);
    await admin.query(
      `update approval.executions set at = now() - interval '7 days' where proposal_id = $1`,
      [id],
    );
    await sweepExpired(app, TENANT);
    await admin.query(`update approval.proposals set expires_at = now() - interval '7 days'`);
    await sweepExpired(app, TENANT);
    expect(await stateOf(id), "something reaped an in-flight send").toBe("executing");
    // ...and it is not a cap wedge: `executing` sits outside the pending count.
    const pending = await app.query(
      `select count(*)::int as n from approval.proposals
        where tenant_id = $1 and state = 'pending' and expires_at > now()`,
      [TENANT],
    );
    expect(pending.rows[0].n).toBe(0);
  });
});

describe("A2/M-3: a terminal state always has an execution row behind it", () => {
  it("finishExecution refuses when no `started` row exists", async () => {
    // mutation: drop the `logged.rowCount !== 1` check from `finishExecution`
    //           -> the proposal is marked `executed` with an EMPTY execution log and this
    //           reds. RUN ✅ 2026-08-08
    //
    // The terminal execution row is written by an insert-SELECT, which inserts ZERO rows
    // when there is no start — a silent no-op — while the state UPDATE only required
    // `state = 'executing'`. The transaction then committed an action claimed with no
    // evidence of it happening.
    const id = await seedApproved();
    // Reach `executing` WITHOUT going through beginExecution, which is the only way this
    // is reachable — and was reachable in practice while a forged INSERT could mint an
    // `approved` row.
    await admin.query(`update approval.proposals set state = 'executing' where id = $1`, [id]);
    await expect(finishExecution(app, id, { ok: true })).rejects.toBeInstanceOf(ExecutionRefused);
    expect(await stateOf(id), "a terminal state was committed with no execution row").toBe(
      "executing",
    );
    const n = await app.query(
      `select count(*)::int as n from approval.executions where proposal_id = $1`,
      [id],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("...and the normal path still finishes — the witness", async () => {
    const id = await seedApproved();
    await beginExecution(app, id);
    await finishExecution(app, id, { ok: true, vendorReference: "vendor-ok" });
    expect(await stateOf(id)).toBe("executed");
  });
});

describe("A2/M-2: the stuck-execution mitigation is an OPERATOR SURFACE, not just an export", () => {
  it("ships as a CLI that lists in-flight sends and refuses to adjudicate them", async () => {
    // KNOWN-ISSUES names `findStuckExecutions` as the mitigation for the permanently
    // non-terminal `executing` class. It was reachable only from a test — so the published
    // mitigation was not something an operator could run. This pins that it is.
    const id = await seedApproved();
    await beginExecution(app, id);
    await admin.query(
      `update approval.executions set at = now() - interval '2 hours' where proposal_id = $1`,
      [id],
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", STUCK_CLI, "--minutes", "30"],
      {
        env: {
          ...process.env,
          APPROVAL_DATABASE_URL: roleUrl(url, "switchboard_approval"),
        },
        cwd: APPROVAL_DIR,
      },
    );
    expect(stdout).toContain(id);
    // It must say what it is NOT: a verdict. Re-sending on a guess is the failure that
    // costs the human a second unauthorised send.
    expect(stdout).toMatch(/DIAGNOSIS, NOT A VERDICT/);
    expect(stdout).toMatch(/idempotency key/);
  }, 60_000);

  it("reports nothing when every send is young or finished", async () => {
    const done = await seedApproved();
    await beginExecution(app, done);
    await finishExecution(app, done, { ok: true });
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", STUCK_CLI, "--minutes", "30"],
      {
        env: {
          ...process.env,
          APPROVAL_DATABASE_URL: roleUrl(url, "switchboard_approval"),
        },
        cwd: APPROVAL_DIR,
      },
    );
    expect(stdout).toMatch(/no execution has been in flight/);
  }, 60_000);
});

describe("A2/T9: the guard is TypeScript — this schema has exactly one SQL function", () => {
  it("015 created no callable SQL function beyond the trigger function", async () => {
    // mutation: add `create function approval.begin_execution() ...` to 015 -> the function
    //           list stops being exactly ['proposals_guard'] and this reds — with the
    //           new function's `proacl` NULL, i.e. PUBLIC-executable. RUN ✅ 2026-08-08
    //
    // 🚨 IF THIS EVER REDS, THE FIX IS THE REVOKE OR THE FUNCTION — NEVER THE PIN. Do not
    // narrow it to "no user-callable function", do not exclude trigger functions, do not
    // add an allowlist. The two schema-wide "belts" that were supposed to make new
    // functions safe were both measured INERT on PG 16; there is no belt.
    const fns = await admin.query<{ proname: string; proacl: string | null }>(
      `select p.proname, p.proacl::text as proacl from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'approval' order by p.proname`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual(["proposals_guard"]);
    expect(fns.rows[0].proacl).not.toBeNull();
  });
});
