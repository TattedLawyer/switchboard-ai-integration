// Phase 3 / A2, T5 — expiry, on `pending` AND on `approved`.
//
// WHY EXPIRY IS A CORRECTNESS CONTROL AND NOT HOUSEKEEPING. Before A2 the door 429s
// permanently once the cap is hit: `switchboard_approval` held no UPDATE, so pending rows
// could not reach a terminal state and one burst wedged the queue forever, legitimate
// proposals included. That is the C7 wedge, and expiry is what makes it self-heal. It has
// THREE enforcement points, not one, because a sweeper alone fails open during exactly the
// outage that matters:
//
//   1. the sweeper                — moves aged rows to `expired`;
//   2. the queue read query       — never renders a card for a row past its window (T6);
//   3. the DOOR's cap count       — excludes expired rows, so a dead burst does not hold
//                                   budget even if the sweeper is not running.
//
// Point 3 is the one that heals without any process being alive, which is why it is
// pinned here rather than left as an optimisation.
//
// `approved -> expired` IS DELIBERATE AND IT HAS A COST WE STATE RATHER THAN HIDE. OWASP
// puts expiry in the APPROVAL RECORD — an approval carries its own validity window, and
// execution after it refuses. But an approved row that expires is a DESTROYED HUMAN
// DECISION, and A2 ships no re-proposal path (that is A5's). Since A2 ships no executor
// either, EVERY approved row meets this timer. Harmless today because nobody can approve
// until A0b ships login; unsafe the day A0b lands without A5.
//
// EXPIRY IS MACHINE-DRIVEN AND THEREFORE CARRIES NO DECISION ROW — because nobody decided.
// That exemption is the whole content of the trigger's rule, and it is pinned below: the
// sweeper must work with zero rows in `approval.decisions`.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../src/server.js";
import { sweepExpired } from "../src/expiry.js";
import { seedInState } from "./helpers/seed.js";

const TENANT = "00000000-0000-0000-0000-000000000000";
const OTHER_TENANT = "11111111-1111-1111-1111-111111111111";
const SECRET = "test-proposal-token-do-not-reuse";
const CAP = 5;

let admin: pg.Pool;
let approvalPool: pg.Pool;
let cleanup: () => Promise<void>;
let base: string;
let close: () => Promise<void>;

function approvalUrlFrom(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  return u.toString();
}

async function post(): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/internal/proposals`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      idempotency_key: `k-${Math.random().toString(36).slice(2)}`,
      action_type: "send_email",
      payload: { to: "jane@client.example.com", n: Math.random() },
      rationale: "expiry probe",
    }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A row in any state, reached LEGALLY, with an expiry we choose.
 *
 *  🚨 This used to INSERT the state directly. The creation guard now refuses that — which is
 *  the guard working: a fixture that could conjure an `approved` row was testing a state the
 *  running system cannot produce. See `helpers/seed.ts`. */
async function seed(state: string, expiresInHours: number, tenant = TENANT): Promise<string> {
  return seedInState(admin, { state, expiresInHours, tenant });
}

async function stateOf(id: string): Promise<string> {
  return (await admin.query(`select state from approval.proposals where id = $1`, [id])).rows[0]
    .state as string;
}

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  approvalPool = new pg.Pool({ connectionString: approvalUrlFrom(r.url), max: 4 });
  approvalPool.on("error", () => {});
  const app = createApprovalApp(approvalPool, {
    tenantId: TENANT,
    proposalToken: SECRET,
    pendingCap: CAP,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}, 60_000);

afterEach(async () => {
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (close) await close().catch(() => {});
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("A2/T5: the C7 wedge self-heals — a dead burst does not hold budget", () => {
  it("a queue full of EXPIRED rows accepts again, with no sweeper having run", async () => {
    // mutation: remove `and expires_at > now()` from the door's cap count in `server.ts`
    //           -> the aged queue keeps 429ing forever and this reds. That is the C7 wedge,
    //           reproduced. RUN ✅ 2026-08-08
    //
    // NOTE WHAT IS DELIBERATELY ABSENT: no sweeper runs in this test. The point of putting
    // the filter in the COUNT as well as in a background process is that the healing does
    // not depend on any process being alive.
    for (let i = 0; i < CAP; i++) expect((await post()).status).toBe(201);
    expect((await post()).status, "the cap should be reached").toBe(429);

    // Age every one of them. `expires_at` is deliberately NOT a frozen column — a burst
    // that is already dead must be movable.
    await admin.query(`update approval.proposals set expires_at = now() - interval '1 hour'`);

    const after = await post();
    expect(after.status, JSON.stringify(after.json)).toBe(201);
  });

  it("but a queue full of LIVE rows still refuses — the filter is not a hole in the cap", async () => {
    // The other direction, which is what makes the pin above non-vacuous: if the count
    // simply stopped counting, this would go green too and the cap would be gone.
    for (let i = 0; i < CAP; i++) expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(429);
  });
});

describe("A2/T5: the sweeper", () => {
  it("moves aged PENDING and aged APPROVED rows to expired, and nothing else", async () => {
    // mutation: remove 'approved' from the sweeper's state list in `expiry.ts` -> the aged
    //           approved row stays approved and this reds. RUN ✅ 2026-08-08
    const agedPending = await seed("pending", -1);
    const agedApproved = await seed("approved", -1);
    const livePending = await seed("pending", 24);
    const liveApproved = await seed("approved", 24);
    // `executing` is deliberately EXEMPT: A2 builds no auto-reaper, because a timer that
    // flips a live in-flight send to failed is worse than a stuck row. A5 owns that
    // contract. An aged `executing` row must survive the sweep untouched.
    const agedExecuting = await seed("executing", -1);
    const agedTerminal = await seed("rejected", -1);

    const r = await sweepExpired(approvalPool, TENANT);
    expect(r.expired).toBe(2);

    expect(await stateOf(agedPending)).toBe("expired");
    expect(await stateOf(agedApproved)).toBe("expired");
    expect(await stateOf(livePending)).toBe("pending");
    expect(await stateOf(liveApproved)).toBe("approved");
    expect(await stateOf(agedExecuting), "A2 must not reap an in-flight send").toBe("executing");
    expect(await stateOf(agedTerminal)).toBe("rejected");
  });

  it("runs with NO decision rows — expiry is machine-driven, because nobody decided", async () => {
    // This is the exemption the trigger's rule turns on. If expiry required a decision row
    // it would either be impossible or would fabricate a decision, and `rejected` would
    // stop meaning "a human decided against it".
    await seed("pending", -1);
    await seed("approved", -1);
    // Counted BEFORE and AFTER, not from zero: seeding an `approved` row now legitimately
    // writes the decision row a real approval writes (the fixture walks the real machine),
    // so the property is "the SWEEP adds none", which is the property that was always meant.
    const before = (
      await admin.query<{ n: number }>(`select count(*)::int as n from approval.decisions`)
    ).rows[0].n;
    await sweepExpired(approvalPool, TENANT);
    const after = (
      await admin.query<{ n: number }>(`select count(*)::int as n from approval.decisions`)
    ).rows[0].n;
    expect(after, "the sweeper fabricated a decision").toBe(before);
  });

  it("runs using ONLY the grants switchboard_approval holds", async () => {
    // The sweeper above is driven through `approvalPool`, not `admin`. If the shipped
    // grant set cannot express the sweep, this suite fails rather than passing on an
    // owner-privileged fixture — which is the harness defect that let a deployment-breaking
    // FK violation through a whole revision of this design.
    const who = await approvalPool.query(`select current_user as u`);
    expect(who.rows[0].u).toBe("switchboard_approval");
  });

  it("is tenant-scoped — one deployment's sweep never touches another tenant's rows", async () => {
    const mine = await seed("pending", -1);
    const theirs = await seed("pending", -1, OTHER_TENANT);
    await sweepExpired(approvalPool, TENANT);
    expect(await stateOf(mine)).toBe("expired");
    expect(await stateOf(theirs)).toBe("pending");
  });
});

describe("A2/T5: an approval has its own validity window", () => {
  it("an aged APPROVED row cannot execute once swept — expired is terminal", async () => {
    // mutation: remove 'approved' from the sweeper's state list -> the row stays approved,
    //           `approved -> executing` succeeds, and this reds. RUN ✅ 2026-08-08
    const id = await seed("approved", -1);
    await sweepExpired(approvalPool, TENANT);
    expect(await stateOf(id)).toBe("expired");
    // Terminal means terminal, enforced by the trigger and not by the caller remembering.
    await expect(
      admin.query(`update approval.proposals set state = 'executing' where id = $1`, [id]),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("...while a LIVE approved row still can", async () => {
    // The witness. Without this the pin above passes for a queue in which nothing can ever
    // execute, which would be a very quiet way to ship a broken product.
    const id = await seed("approved", 24);
    await sweepExpired(approvalPool, TENANT);
    const r = await admin.query(
      `update approval.proposals set state = 'executing' where id = $1`,
      [id],
    );
    expect(r.rowCount).toBe(1);
  });
});
