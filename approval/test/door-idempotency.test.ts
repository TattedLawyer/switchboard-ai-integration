// Phase 3 / A2, T4 — the door's conflict branch. Two live defects, both silent.
//
// DEFECT 1 (V5, shipped today). `on conflict ... do nothing` plus a read of the existing
// row means SAME KEY + DIFFERENT PAYLOAD is first-write-wins, reported to the caller as
// `200 {duplicate:true}` with the ORIGINAL proposal's id. The second payload is discarded
// and the caller is told it succeeded. Fixed by comparing `payload_hash` on conflict:
// equal is still 200, DIFFERENT is 422 and no row is written. This is `payload_hash`'s ONE
// JOB — it is not a TOCTOU control and not a display binding.
//
// DEFECT 2, which A2 would otherwise CREATE (rev-7 I2). `proposals_idempotency_unique` is
// permanent and STATE-BLIND, and A2 adds expiry. So: the broker is away, the sweeper moves
// the row to `expired` at the TTL, the agent re-proposes the identical ask, the door finds
// the conflict, the hashes match, and it returns `200 {duplicate:true}` POINTING AT A DEAD
// TERMINAL ROW. Nothing is queued, no card is rendered, the caller was told it succeeded,
// and every future attempt under that key hits the same corpse. The plan's claim that "no
// proposal is ever discarded without a human seeing it once" is false on that path
// whenever the original expired unread. So the conflict branch compares STATE as well as
// hash, and a terminal row gets a DISTINGUISHABLE response.
//
// This is the purest silent failure in A2: she is never shown the ask, no error is raised
// anywhere, and the agent believes it asked. She cannot report a card she never saw.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../src/server.js";
import { payloadHash } from "../src/canonical.js";

const TENANT = "00000000-0000-0000-0000-000000000000";
const SECRET = "test-proposal-token-do-not-reuse";

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

async function post(b: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/internal/proposals`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(b),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  idempotency_key: `k-${Math.random().toString(36).slice(2)}`,
  action_type: "send_email",
  payload: { to: "jane@client.example.com", subject: "renewal at risk" },
  rationale: "Invoice 3 is 41 days overdue.",
  ...over,
});

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  approvalPool = new pg.Pool({ connectionString: approvalUrlFrom(r.url), max: 4 });
  approvalPool.on("error", () => {});
  const app = createApprovalApp(approvalPool, {
    tenantId: TENANT,
    proposalToken: SECRET,
    pendingCap: 50,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}, 60_000);

afterEach(async () => {
  // Children first: `approval.decisions` and `approval.executions` reference proposals and
  // there is no ON DELETE CASCADE — deliberately, because a decision is evidence and
  // evidence does not evaporate when the thing it is about is removed.
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (close) await close().catch(() => {});
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("A2/T4: the door records the hash and the expiry", () => {
  it("stores the canonical payload hash and a 72-hour expiry", async () => {
    const b = body();
    const res = await post(b);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const row = await admin.query(
      `select payload_hash, expires_at, created_at from approval.proposals where id = $1`,
      [res.json.id],
    );
    expect(row.rows[0].payload_hash).toBe(payloadHash(b.payload as Record<string, unknown>));
    const ttlMs =
      new Date(row.rows[0].expires_at as string).getTime() -
      new Date(row.rows[0].created_at as string).getTime();
    expect(ttlMs).toBe(72 * 60 * 60 * 1000);
  });

  it("hashes what was STORED, not merely what was sent — key order is irrelevant", async () => {
    // The two bodies differ only in key order, so they are the same ask and must produce
    // the same hash. This is the door end of T1's equivalence.
    const a = await post(body({ payload: { b: 1, a: { d: 4, c: 3 } } }));
    const c = await post(body({ payload: { a: { c: 3, d: 4 }, b: 1 } }));
    const hashes = await admin.query(
      `select payload_hash from approval.proposals where id = any($1::uuid[])`,
      [[a.json.id, c.json.id]],
    );
    expect(new Set(hashes.rows.map((r) => r.payload_hash)).size).toBe(1);
  });
});

describe("A2/T4: same key, DIFFERENT payload is 422 — never a silent first-write-wins", () => {
  it("refuses loudly and writes nothing", async () => {
    // mutation: delete the `payload_hash` comparison from the conflict branch of
    //           `server.ts` -> the door silently returns 200 with the ORIGINAL id and this
    //           reds. RUN ✅ 2026-08-08
    const key = `collide-${Math.random().toString(36).slice(2)}`;
    const first = await post(body({ idempotency_key: key, payload: { to: "a@example.com" } }));
    expect(first.status).toBe(201);

    const second = await post(
      body({ idempotency_key: key, payload: { to: "attacker@example.com" } }),
    );
    expect(second.status, JSON.stringify(second.json)).toBe(422);
    // Names the collision, and carries NO id — a caller must not be able to mistake this
    // for a recorded proposal.
    expect(String(second.json.error)).toMatch(/idempotenc/i);
    expect(second.json.id).toBeUndefined();

    const rows = await admin.query(
      `select payload from approval.proposals where idempotency_key = $1`,
      [key],
    );
    expect(rows.rowCount, "a second row was written").toBe(1);
    expect(rows.rows[0].payload).toEqual({ to: "a@example.com" });
  });

  it("but an identical retry of a LIVE row is still an idempotent 200", async () => {
    // The whole point of the key: a caller that retried after a timeout must not be able
    // to tell its retry from its first attempt.
    const b = body();
    const first = await post(b);
    const retry = await post(b);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ id: first.json.id, duplicate: true, state: "pending" });
    expect(retry.json.terminal).toBeUndefined();
  });
});

describe("A2/T4: same key, same payload, but the existing row is TERMINAL", () => {
  for (const state of ["expired", "rejected", "superseded", "executed", "execution_failed"]) {
    it(`is DISTINGUISHABLE from a live duplicate when the row is '${state}'`, async () => {
      // mutation: delete the state check from the conflict branch of `server.ts` -> the
      //           door answers `200 {duplicate:true}` pointing at a dead row and this reds.
      //           RUN ✅ 2026-08-08
      const b = body();
      const first = await post(b);
      expect(first.status).toBe(201);
      // Aged out by the machine — no decision row, because nobody decided. `rejected` is
      // reached the only way the trigger permits, via a real same-transaction decision.
      if (state === "rejected") {
        const u = (
          await admin.query(`insert into approval.users (email) values ($1) returning id`, [
            `t4-${Math.random().toString(36).slice(2)}@example.com`,
          ])
        ).rows[0].id as string;
        const c = await admin.connect();
        try {
          await c.query("begin");
          await c.query(
            `insert into approval.decisions (proposal_id, kind, approver_user_id, reason,
                                             renderer_version)
             values ($1, 'rejected', $2, 'not now, and not later', 'v0')`,
            [first.json.id, u],
          );
          await c.query(`update approval.proposals set state = 'rejected' where id = $1`, [
            first.json.id,
          ]);
          await c.query("commit");
        } finally {
          c.release();
        }
      } else if (state === "executed" || state === "execution_failed") {
        // Reached through the legal path: pending -> approved -> executing -> terminal.
        const u = (
          await admin.query(`insert into approval.users (email) values ($1) returning id`, [
            `t4-${Math.random().toString(36).slice(2)}@example.com`,
          ])
        ).rows[0].id as string;
        const c = await admin.connect();
        try {
          await c.query("begin");
          await c.query(
            `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
             values ($1, 'approved', $2, 'v0')`,
            [first.json.id, u],
          );
          await c.query(`update approval.proposals set state = 'approved' where id = $1`, [
            first.json.id,
          ]);
          await c.query("commit");
        } finally {
          c.release();
        }
        await admin.query(`update approval.proposals set state = 'executing' where id = $1`, [
          first.json.id,
        ]);
        await admin.query(`update approval.proposals set state = $2 where id = $1`, [
          first.json.id,
          state,
        ]);
      } else {
        await admin.query(`update approval.proposals set state = $2 where id = $1`, [
          first.json.id,
          state,
        ]);
      }

      const again = await post(b);
      expect(
        again.status === 409 || again.json.terminal === true,
        `a dead ${state} row answered as a live duplicate: ${again.status} ${JSON.stringify(again.json)}`,
      ).toBe(true);
      expect(again.json.state).toBe(state);
      // And nothing new was written — the key is permanent and state-blind at the database,
      // which is exactly why the DOOR has to say so.
      const rows = await admin.query(
        `select count(*)::int as n from approval.proposals where idempotency_key = $1`,
        [b.idempotency_key],
      );
      expect(rows.rows[0].n).toBe(1);
    });
  }
});
