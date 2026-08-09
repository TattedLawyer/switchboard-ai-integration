// Phase 3 / A2, T8 — one winner, always; and a human disposition always names a human.
//
// TWO FAMILIES OF PIN LIVE HERE, and they fail for different reasons:
//
//   · THE STATE MACHINE. Every legal transition succeeds and every forbidden one raises,
//     attempted directly against the database rather than through our own helper — because
//     the guarantee is that the invariant holds for callers who never heard of
//     `transition.ts`, including bare psql.
//   · THE DECISION-ROW PREDICATE. `approved` and `rejected` require a decision row of the
//     MATCHING KIND, written in the SAME TRANSACTION. Each of the three ways to weaken
//     that has its own pin, because each is a different mistake:
//       – drop the kind match      -> an accumulated `dismissed` row approves a proposal
//       – drop the `rejected` half -> a bare `update ... set state='rejected'` succeeds,
//                                     which was MEASURED live: UPDATE 6, zero decision
//                                     rows, no error
//       – drop the xid8 match      -> a decision row committed at any point in the past
//                                     satisfies it forever
//
// EVERYTHING RUNS AS `switchboard_approval` unless the test is specifically about what the
// OWNER cannot do either. The approver is created by the shipped operator CLI.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { decide, DecisionRefused } from "../src/decide.js";
import { LEGAL_TRANSITIONS, transition, TransitionRefused } from "../src/transition.js";
import { seedInState } from "./helpers/seed.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../ingest/src/cli/approval-user-add.ts", import.meta.url));
const INGEST_DIR = fileURLToPath(new URL("../../ingest", import.meta.url));
const TENANT = "00000000-0000-0000-0000-000000000000";

const ALL_STATES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "superseded",
  "executing",
  "executed",
  "execution_failed",
] as const;

let admin: pg.Pool;
let app: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;
let approver: string;

/** A row in `state`, reached LEGALLY from pending — see `helpers/seed.ts`. The approver is
 *  the CLI-created one, because in THIS suite the provenance of the approver is part of the
 *  property under test. */
async function seed(state = "pending"): Promise<string> {
  return seedInState(admin, { state, approverId: approver });
}

const stateOf = async (id: string): Promise<string> =>
  (await app.query(`select state from approval.proposals where id = $1`, [id])).rows[0]
    .state as string;

/** Approve or reject the ONLY way the database permits, on one client, in one transaction. */
async function decideRaw(
  db: pg.Pool,
  id: string,
  kind: "approved" | "rejected",
  opts: { reason?: string } = {},
): Promise<void> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query(
      `insert into approval.decisions (proposal_id, kind, approver_user_id, reason,
                                       renderer_version)
       values ($1, $2, $3, $4, 'v0')`,
      [id, kind, approver, opts.reason ?? (kind === "rejected" ? "a stated reason" : null)],
    );
    await c.query(`update approval.proposals set state = $2 where id = $1`, [id, kind]);
    await c.query("commit");
  } finally {
    c.release();
  }
}

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
  const email = `t8-${Math.random().toString(36).slice(2)}@example.com`;
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

describe("A2/T8: the full transition matrix, attempted against the DATABASE directly", () => {
  // 8 states x 8 targets, minus the no-ops. Written as an exhaustive loop rather than a
  // hand-picked list, so a state added later without a rule is caught by omission rather
  // than by somebody remembering to add a case.
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      if (from === to) continue;
      const legal = (LEGAL_TRANSITIONS[from] ?? []).includes(to);
      const human = to === "approved" || to === "rejected";

      it(`${from} -> ${to} is ${legal ? "LEGAL" : "REFUSED"}`, async () => {
        const id = await seed(from);
        if (legal && human) {
          // Legal, but only WITH a decision row — that half is pinned separately below.
          await decideRaw(app, id, to as "approved" | "rejected");
          expect(await stateOf(id)).toBe(to);
          return;
        }
        if (legal) {
          await transition(app, { id, from, to });
          expect(await stateOf(id)).toBe(to);
          return;
        }
        // Forbidden. The trigger raises P0001 regardless of who asks — this runs as the
        // app role, and the OWNER cannot do it either (asserted below).
        await expect(
          app.query(`update approval.proposals set state = $2 where id = $1`, [id, to]),
          `${from} -> ${to} was permitted`,
        ).rejects.toMatchObject({ code: "P0001" });
        expect(await stateOf(id)).toBe(from);
      });
    }
  }

  it("the OWNER cannot make a forbidden transition either — ownership is not a bypass", async () => {
    // mutation: `drop trigger proposals_guard on approval.proposals` -> every REFUSED case
    //           above, and this, red. RUN ✅ 2026-08-08
    const id = await seed("executed");
    await expect(
      admin.query(`update approval.proposals set state = 'pending' where id = $1`, [id]),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("names the four transitions that would break the product, one by one", async () => {
    // Spelled out separately from the matrix because each has its own reason, and a
    // reviewer should not have to derive them from a table.
    //   approved -> pending      an approval that can be un-made is not evidence
    //   executing -> approved    that is the retry loop that double-sends
    //   rejected -> pending      terminal means terminal; a re-proposal is a NEW row
    //   executed -> executing    likewise, and it is the same double-send by another name
    for (const [from, to] of [
      ["approved", "pending"],
      ["executing", "approved"],
      ["rejected", "pending"],
      ["executed", "executing"],
    ] as const) {
      const id = await seed(from);
      await expect(
        app.query(`update approval.proposals set state = $2 where id = $1`, [id, to]),
        `${from} -> ${to}`,
      ).rejects.toMatchObject({ code: "P0001" });
    }
  });
});

describe("A2/T8: one winner, always", () => {
  it("two approvers race one pending row — one wins, the loser gets UPDATE 0 and refuses", async () => {
    // mutation: drop `and state = 'pending'` from the conditional UPDATE in `decide.ts`
    //           -> BOTH writers succeed, two decision rows attach to one proposal, and
    //           this reds. RUN ✅ 2026-08-08
    const id = await seed();
    const results = await Promise.allSettled([
      decide(app, { proposalId: id, kind: "approved", approverUserId: approver }),
      decide(app, {
        proposalId: id,
        kind: "rejected",
        approverUserId: approver,
        reason: "I disagree with my colleague",
      }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(DecisionRefused);
    // The loser recorded NOTHING — its decision row rolled back with its update.
    const d = await app.query(
      `select count(*)::int as n from approval.decisions where proposal_id = $1`,
      [id],
    );
    expect(d.rows[0].n, "the loser left a decision row behind").toBe(1);
  });

  it("a machine transition loses the same way, loudly", async () => {
    const id = await seed();
    await transition(app, { id, from: "pending", to: "expired" });
    await expect(transition(app, { id, from: "pending", to: "superseded" })).rejects.toBeInstanceOf(
      TransitionRefused,
    );
  });
});

describe("A2/T8: a human disposition always names a human, in the same transaction", () => {
  it("a bare `pending -> rejected` with NO decision row RAISES", async () => {
    // mutation: narrow the trigger's predicate from `new.state in ('approved','rejected')`
    //           to `new.state = 'approved'` -> this succeeds silently and the pin reds.
    //           RUN ✅ 2026-08-08
    //
    // 🚨 THIS IS THE HALF WITH A MEASURED LIVE EXPLOIT. With the predicate scoped to
    // `approved`, `update approval.proposals set state='rejected' where state='pending'`
    // returned UPDATE 6, wrote zero decision rows, and raised nothing — while the same
    // trigger correctly refused `rejected -> pending`. A rejection is a human decision; if
    // the database does not require the human, the word is not evidence of one. It is also
    // why the emergency manual drain targets `expired`, not `rejected`.
    const id = await seed();
    await expect(
      app.query(`update approval.proposals set state = 'rejected' where id = $1`, [id]),
    ).rejects.toMatchObject({ code: "P0001" });
    expect(await stateOf(id)).toBe("pending");
  });

  it("a bare `pending -> approved` with NO decision row RAISES", async () => {
    const id = await seed();
    await expect(
      app.query(`update approval.proposals set state = 'approved' where id = $1`, [id]),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("...and the bulk form raises too — a WHERE-clause slip cannot terminate the queue", async () => {
    // The RUNBOOK's old emergency remedy, exactly as it was published. It used to work.
    for (let i = 0; i < 4; i++) await seed();
    await expect(
      app.query(`update approval.proposals set state = 'rejected' where state = 'pending'`),
    ).rejects.toMatchObject({ code: "P0001" });
    const n = await app.query(
      `select count(*)::int as n from approval.proposals where state = 'pending'`,
    );
    expect(n.rows[0].n).toBe(4);
  });

  it("but the MACHINE transitions are exempt, and must be", async () => {
    // The witness for the exemption. If this reds, expiry and amendment are impossible and
    // the queue can never drain — which is a worse failure than the one the rule prevents.
    const a = await seed();
    const b = await seed();
    await transition(app, { id: a, from: "pending", to: "expired" });
    await transition(app, { id: b, from: "pending", to: "superseded" });
    const d = await app.query(`select count(*)::int as n from approval.decisions`);
    expect(d.rows[0].n, "a machine transition fabricated a decision").toBe(0);
  });

  it("the emergency drain to `expired` still works — nobody decided, so nothing is fabricated", async () => {
    // This is the corrected RUNBOOK remedy: `expired`, not `rejected`. An operator draining
    // a wedged queue is not DECIDING anything, and recording their bulk action as a
    // rejection would put a decision in the audit trail that never happened.
    for (let i = 0; i < 4; i++) await seed();
    const r = await admin.query(
      `update approval.proposals set state = 'expired' where state = 'pending'`,
    );
    expect(r.rowCount).toBe(4);
  });
});

describe("A2/T8: MATCHING KIND, and SAME TRANSACTION", () => {
  it("an accumulated `dismissed` row does NOT satisfy the check for `approved`", async () => {
    // mutation: drop `and d.kind = new.state` from the trigger's lookup -> the dismissed
    //           row satisfies it and this reds. RUN ✅ 2026-08-08
    //
    // `approval.decisions` is multi-row per proposal by design — every "Not now" adds one
    // — so without the kind match, a proposal the broker repeatedly declined to act on
    // could be approved by anything that could run the UPDATE.
    const id = await seed();
    await decide(app, { proposalId: id, kind: "dismissed", approverUserId: approver });
    const c = await app.connect();
    try {
      await c.query("begin");
      await c.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
         values ($1, 'dismissed', $2, 'v0')`,
        [id, approver],
      );
      await expect(
        c.query(`update approval.proposals set state = 'approved' where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await c.query("rollback").catch(() => {});
      c.release();
    }
    expect(await stateOf(id)).toBe("pending");
  });

  it("a matching-kind row from a PRIOR COMMITTED transaction does NOT satisfy it", async () => {
    // mutation: drop `and d.xact_id = pg_current_xact_id()` from the trigger's lookup ->
    //           the committed row satisfies it forever and this reds. RUN ✅ 2026-08-08
    //
    // Without the discriminator the predicate degrades to "a matching-kind row exists",
    // which is a materially weaker sentence than the one this design publishes: any old
    // decision row, from any time, would authorise a transition made now by anything.
    const id = await seed();
    // A real, committed `approved`-kind row — written in its own transaction.
    await admin.query(
      `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
       values ($1, 'approved', $2, 'v0')`,
      [id, approver],
    );
    await expect(
      app.query(`update approval.proposals set state = 'approved' where id = $1`, [id]),
    ).rejects.toMatchObject({ code: "P0001" });
    expect(await stateOf(id)).toBe("pending");
  });

  it("...and the SAME row inside the SAME transaction DOES — the witness", async () => {
    // Without this the two pins above would be satisfied by a predicate that never lets
    // anything through, which would be a very thorough way to ship a queue nobody can
    // approve from.
    const id = await seed();
    await decideRaw(app, id, "approved");
    expect(await stateOf(id)).toBe("approved");
  });

  it("uses xid8 on both sides — the epoch-safe comparison, not xmin", async () => {
    // `xmin` is a 32-bit `xid` and WRAPS; `txid_current()` is a 64-bit epoch'd bigint.
    // Comparing them is correct only within one epoch and silently wrong afterwards — a
    // failure that appears only on a long-lived database and looks like nothing.
    const t = await admin.query(
      `select pg_typeof(pg_current_xact_id())::text as cur,
              pg_typeof(txid_current())::text        as legacy`,
    );
    expect(t.rows[0].cur).toBe("xid8");
    expect(t.rows[0].legacy).toBe("bigint");
    const col = await admin.query(
      `select udt_name from information_schema.columns
        where table_schema = 'approval' and table_name = 'decisions' and column_name = 'xact_id'`,
    );
    expect(col.rows[0].udt_name).toBe("xid8");
  });
});
