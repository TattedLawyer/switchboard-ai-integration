// Phase 3 / A2, T7 — decisions are append-only, attributable, and reachable BY THE SHIPPED
// ROLE.
//
// 🚨 THE HARNESS RULE THAT MATTERS MOST HERE, and the reason this file looks awkward.
// Every approval in this suite runs as `switchboard_approval`, against a database whose
// approver was created THROUGH THE OPERATOR CLI THAT SHIPS — never through an
// owner-privileged fixture INSERT.
//
// That is not ceremony. An earlier revision of this design held three individually
// defensible statements: `approver_user_id` is a real FK, the approval role gets NO INSERT
// on `approval.users`, and seeding "is A0b's job" — where A0b is not built. At merge,
// `approval.users` would have been empty and unfillable, the decisions INSERT would raise
// 23503, and the transition to `approved` — the entire purpose of A2 — would have been
// unreachable in every real deployment. Every approval pin greened anyway, because the
// harness connected as the migration owner and seeded users itself. The canonical test-
// smell catalogue's cure for resource-dependent tests ("allocate and initialise all
// resources used") is an exact description of that mistake: we followed it and it produced
// a false pass.
//
// So: owner privilege appears in this file ONLY to create proposals (which the door does
// in production) and to run the shipped CLI. The decisions themselves go through the
// role a deployment actually uses. If the grant set cannot complete an approval, this
// suite fails.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { decide, DecisionRefused } from "../src/decide.js";
import { RENDERER_VERSION } from "../src/render.js";
import { payloadHash } from "../src/canonical.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(
  new URL("../../ingest/src/cli/approval-user-add.ts", import.meta.url),
);
const INGEST_DIR = fileURLToPath(new URL("../../ingest", import.meta.url));

const TENANT = "00000000-0000-0000-0000-000000000000";

let admin: pg.Pool;
let approvalPool: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;
let approver: string;

/** The ONLY way an approver comes into existence in this suite: the shipped operator CLI,
 *  connecting as the migration owner, exactly as a real deployment bootstraps one. */
async function addApproverViaCli(email: string): Promise<string> {
  await execFileAsync(process.execPath, ["--import", "tsx", CLI, "--email", email], {
    env: { ...process.env, DATABASE_URL: url },
    cwd: INGEST_DIR,
  });
  // Read it back through the APPROVAL role — which holds SELECT and nothing more, and is
  // how the running service would find it.
  const r = await approvalPool.query(`select id from approval.users where email = $1`, [email]);
  if (r.rowCount !== 1) throw new Error(`the CLI did not create ${email}`);
  return r.rows[0].id as string;
}

async function seedProposal(state = "pending"): Promise<string> {
  const payload = { to: "jane@client.example.com", n: Math.random() };
  const r = await admin.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
        expires_at, state)
     values ($1, $2, 'send_email', $3::jsonb, 'decide probe', $4,
             now() + interval '72 hours', $5)
     returning id`,
    [
      TENANT,
      `t7-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      payloadHash(payload),
      state,
    ],
  );
  return r.rows[0].id as string;
}

/** A pending proposal whose window has already closed. Seeded with the past expiry AT
 *  INSERT, because `expires_at` is not frozen but `created_at` is, and because this is the
 *  state a real row reaches simply by being ignored for 72 hours. */
async function seedExpiredPending(): Promise<string> {
  const payload = { to: "jane@client.example.com", n: Math.random() };
  const r = await admin.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, 'send_email', $3::jsonb, 'stale tab probe', $4, now() - interval '1 hour')
     returning id`,
    [
      TENANT,
      `t7-exp-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      payloadHash(payload),
    ],
  );
  return r.rows[0].id as string;
}

const stateOf = async (id: string): Promise<string> =>
  (await approvalPool.query(`select state from approval.proposals where id = $1`, [id])).rows[0]
    .state as string;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  url = r.url;
  cleanup = r.cleanup;
  const u = new URL(url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approvalPool = new pg.Pool({ connectionString: u.toString(), max: 6 });
  approvalPool.on("error", () => {});
  approver = await addApproverViaCli(`broker-${Math.random().toString(36).slice(2)}@example.com`);
}, 120_000);

afterEach(async () => {
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("A2/T7: the approve path completes with ONLY the shipped grants", () => {
  it("approves end-to-end as switchboard_approval, with a CLI-created approver", async () => {
    // mutation: withdraw ANY grant the approve path needs — `revoke select on
    //           approval.decisions from switchboard_approval` -> 7 of this file's 10 tests
    //           red, all with `permission denied for table decisions`. RUN ✅ 2026-08-08
    //
    // That mutation is M4 made real, and it was ALSO isolated on a throwaway database to
    // show the failure mode precisely, because "it broke" is not the interesting part:
    //
    //     INSERT (no RETURNING): INSERT 1          <- the decision row lands fine
    //     UPDATE ERROR: 42501 permission denied for table decisions
    //     CONTEXT: SQL expression "not exists ( select 1 from approval.decisions d ... )"
    //              PL/pgSQL function approval.proposals_guard() line 54 at IF
    //
    // The operator ran an UPDATE on `proposals` and got an error naming `decisions`. That
    // is because the trigger is invoker-rights — correctly, since SECURITY DEFINER is
    // forbidden here — so its lookup runs with the CALLER's privileges. SELECT on
    // `approval.decisions` is an INVISIBLE HARD PREREQUISITE of both human-driven
    // transitions, and a future least-privilege narrowing of this role to `insert` only
    // would break every approval in the deployment with that misleading message.
    // (In `decide()` itself the INSERT carries `returning id`, which needs SELECT too, so
    // the real code path fails one statement earlier than the isolated probe.)
    const id = await seedProposal();
    const res = await decide(approvalPool, {
      proposalId: id,
      kind: "approved",
      approverUserId: approver,
    });
    expect(res.state).toBe("approved");
    expect(await stateOf(id)).toBe("approved");

    const d = await approvalPool.query(
      `select kind, approver_user_id, renderer_version, reason from approval.decisions
        where proposal_id = $1`,
      [id],
    );
    expect(d.rowCount).toBe(1);
    expect(d.rows[0]).toMatchObject({
      kind: "approved",
      approver_user_id: approver,
      renderer_version: RENDERER_VERSION,
      reason: null,
    });
    // `decided_at` on the proposal is stamped — and it is a different column from the
    // decision's own; the delta between `created_at` and it IS the staleness evidence.
    const p = await approvalPool.query(
      `select decided_at, created_at from approval.proposals where id = $1`,
      [id],
    );
    expect(p.rows[0].decided_at).not.toBeNull();
  });

  it("rejects, with a reason, and the reason is stored", async () => {
    const id = await seedProposal();
    const res = await decide(approvalPool, {
      proposalId: id,
      kind: "rejected",
      approverUserId: approver,
      reason: "the price is wrong and the client has not agreed to it",
    });
    expect(res.state).toBe("rejected");
    expect(await stateOf(id)).toBe("rejected");
    const d = await approvalPool.query(
      `select reason from approval.decisions where proposal_id = $1`,
      [id],
    );
    expect(d.rows[0].reason).toMatch(/price is wrong/);
  });
});

describe("A2/I-2: a decision on an already-expired ask is REFUSED", () => {
  it("approving an expired-but-pending row is refused, and nothing is recorded", async () => {
    // mutation: remove `and expires_at > now()` from `decideOn`'s conditional UPDATE
    //           -> the approval succeeds on a dead ask and this reds. RUN ✅ 2026-08-08
    //
    // The scenario: she leaves the queue open overnight, the ask expires at 03:00, she
    // clicks Approve at 09:00 on the card still on her screen. `readPendingQueue` would not
    // have re-rendered it, but `decide()` is the exported API and takes an id from the
    // client. Before this, the decision was recorded and the row moved to `approved` with
    // an `expires_at` already past — then either swept back to `expired` (a destroyed human
    // decision, delivered to her as a SUCCESS response) or executed on a stale
    // authorisation.
    const id = await seedExpiredPending();
    await expect(
      decide(approvalPool, { proposalId: id, kind: "approved", approverUserId: approver }),
    ).rejects.toBeInstanceOf(DecisionRefused);
    await expect(
      decide(approvalPool, { proposalId: id, kind: "approved", approverUserId: approver }),
    ).rejects.toThrow(/EXPIRED/);
    expect(await stateOf(id)).toBe("pending");
    const d = await approvalPool.query(
      `select count(*)::int as n from approval.decisions where proposal_id = $1`,
      [id],
    );
    expect(d.rows[0].n, "a decision row survived a refused decision").toBe(0);
  });

  it("rejecting an expired ask is refused too — the same window, both verbs", async () => {
    const id = await seedExpiredPending();
    await expect(
      decide(approvalPool, {
        proposalId: id,
        kind: "rejected",
        approverUserId: approver,
        reason: "too late, but I still want to say no",
      }),
    ).rejects.toBeInstanceOf(DecisionRefused);
  });

  it("...while a LIVE ask still decides — the witness", async () => {
    const id = await seedProposal();
    const r = await decide(approvalPool, {
      proposalId: id,
      kind: "approved",
      approverUserId: approver,
    });
    expect(r.state).toBe("approved");
  });
});

describe("A2/T7: a rejection without a reason is refused, in BOTH places", () => {
  it("refused by the workflow", async () => {
    const id = await seedProposal();
    await expect(
      decide(approvalPool, { proposalId: id, kind: "rejected", approverUserId: approver }),
    ).rejects.toBeInstanceOf(DecisionRefused);
    await expect(
      decide(approvalPool, {
        proposalId: id,
        kind: "rejected",
        approverUserId: approver,
        reason: "   ",
      }),
    ).rejects.toBeInstanceOf(DecisionRefused);
    expect(await stateOf(id), "the proposal moved anyway").toBe("pending");
  });

  it("and refused by the DATABASE, which is the half that matters", async () => {
    // mutation: drop `decisions_rejection_needs_reason` from 015 -> this reds.
    //           RUN ✅ 2026-08-08
    //
    // The workflow check above is the friendly one. This is the one that holds when
    // somebody writes the INSERT by hand, which is the only kind of check worth publishing
    // a sentence about.
    const id = await seedProposal();
    await expect(
      approvalPool.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
         values ($1, 'rejected', $2, 'v0')`,
        [id, approver],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe('A2/T7: "Not now" is a decision, not a transition', () => {
  it("writes a dismissed row and leaves the proposal PENDING", async () => {
    const id = await seedProposal();
    const res = await decide(approvalPool, {
      proposalId: id,
      kind: "dismissed",
      approverUserId: approver,
    });
    expect(res.state).toBe("pending");
    expect(await stateOf(id)).toBe("pending");
  });

  it("refuses on a dead ask instead of reporting a state it did not read", async () => {
    // mutation: delete the live-row lookup from the `dismissed` branch of `decideOn` and
    //           return the hardcoded `state: "pending"` -> this reds. RUN ✅ 2026-08-08
    //
    // The branch used to check NOTHING and return a hardcoded literal, so "Not now" on a
    // stale card whose proposal was expired, rejected or executed was accepted, recorded
    // against that dead row, and reported to the caller as pending. Every other path in
    // that file refuses loudly when the row moved underneath it; this one lied quietly.
    const expired = await seedExpiredPending();
    await expect(
      decide(approvalPool, { proposalId: expired, kind: "dismissed", approverUserId: approver }),
    ).rejects.toBeInstanceOf(DecisionRefused);

    const decided = await seedProposal();
    await decide(approvalPool, {
      proposalId: decided,
      kind: "approved",
      approverUserId: approver,
    });
    await expect(
      decide(approvalPool, { proposalId: decided, kind: "dismissed", approverUserId: approver }),
    ).rejects.toBeInstanceOf(DecisionRefused);

    // Nothing was recorded on either dead row.
    const n = await approvalPool.query(
      `select count(*)::int as n from approval.decisions where kind = 'dismissed'`,
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("accumulates — the table is multi-row per proposal BY DESIGN", async () => {
    // Which is exactly why the trigger's predicate has to match on KIND. Without that, one
    // of these rows would satisfy the check for `approved`, and T8 pins that it does not.
    const id = await seedProposal();
    for (let i = 0; i < 3; i++) {
      await decide(approvalPool, { proposalId: id, kind: "dismissed", approverUserId: approver });
    }
    const n = await approvalPool.query(
      `select count(*)::int as n from approval.decisions where proposal_id = $1`,
      [id],
    );
    expect(n.rows[0].n).toBe(3);
    expect(await stateOf(id)).toBe("pending");
  });
});

describe("A2/T7: `approval.decisions` is APPEND-ONLY at the database", () => {
  it("the approval role gets 42501 on UPDATE and on DELETE", async () => {
    // mutation: `grant update on approval.decisions to switchboard_approval` -> the UPDATE
    //           half reds. RUN ✅ 2026-08-08
    // mutation: `grant delete on approval.decisions to switchboard_approval` -> the DELETE
    //           half reds. RUN ✅ 2026-08-08
    //
    // A2's obligation towards A3's hash chain is exactly this: decision rows are
    // append-only and therefore chainable. A3 owns the chain and the head custody.
    const id = await seedProposal();
    await decide(approvalPool, { proposalId: id, kind: "dismissed", approverUserId: approver });
    await expect(
      approvalPool.query(`update approval.decisions set kind = 'approved'`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(approvalPool.query(`delete from approval.decisions`)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("...and cannot rewrite the approver on a row it already wrote", async () => {
    const id = await seedProposal();
    await decide(approvalPool, { proposalId: id, kind: "dismissed", approverUserId: approver });
    await expect(
      approvalPool.query(`update approval.decisions set approver_user_id = $1`, [approver]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("A2/T7: the approver must be a real row, and the role cannot invent one", () => {
  it("an approver id that names nobody is refused by the foreign key", async () => {
    const id = await seedProposal();
    await expect(
      decide(approvalPool, {
        proposalId: id,
        kind: "approved",
        approverUserId: "99999999-9999-9999-9999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await stateOf(id)).toBe("pending");
  });

  it("and the approval role cannot mint one to fix that", async () => {
    await expect(
      approvalPool.query(`insert into approval.users (email) values ('invented@example.com')`),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
