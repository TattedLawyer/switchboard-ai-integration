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
import {
  IDEMPOTENCY_FINGERPRINT_FIELDS,
  idempotencyFingerprint,
  payloadHash,
} from "../src/canonical.js";

const TENANT = "00000000-0000-0000-0000-000000000000";
const SECRET = "test-proposal-token-do-not-reuse";
const RATE = 6;

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
    actionRateLimit: RATE,
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

describe("A2/I-3: the fingerprint is PUBLISHED, and a changed rationale is not swallowed", () => {
  it("same key, same payload, DIFFERENT rationale -> 422, not a silent 200", async () => {
    // mutation: drop `rationale` from `idempotencyFingerprint` in `canonical.ts`
    //           -> the door answers 200 {duplicate:true}, nothing is written, and the
    //           stored rationale stays the first one. This reds. RUN ✅ 2026-08-08
    //
    // 🚨 THIS WAS THE SILENT FIRST-WRITE-WINS THE 422 BRANCH CLAIMED TO HAVE ELIMINATED,
    // surviving on the one field a human actually reads to decide. `suppress.ts` puts
    // `rationale` in the suppression key and argues at length that without it "the one that
    // would have changed her deliberation is superseded unseen" — here it was worse than
    // superseded: no row existed at all, so there was nothing for her to see and nothing
    // for an auditor to reconstruct.
    const key = `rat-${Math.random().toString(36).slice(2)}`;
    const payload = { to: "jane@client.example.com", body: "same bytes" };
    const first = await post(body({ idempotency_key: key, payload, rationale: "routine follow-up" }));
    expect(first.status).toBe(201);

    const second = await post(
      body({
        idempotency_key: key,
        payload,
        rationale: "client called; she is threatening to list elsewhere",
      }),
    );
    expect(second.status, JSON.stringify(second.json)).toBe(422);
    expect(second.json.id).toBeUndefined();
    // The response NAMES the fields, because an undeclared subset was the actual defect.
    expect(second.json.fingerprint_fields).toEqual(["action_type", "payload_hash", "rationale"]);

    const rows = await admin.query(
      `select rationale from approval.proposals where idempotency_key = $1`,
      [key],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].rationale).toBe("routine follow-up");
  });

  it("the fingerprint field list is PINNED — adding a proposal field forces a decision", async () => {
    // mutation: add a field to the fingerprint (or remove one) -> this reds.
    //           RUN ✅ 2026-08-08
    //
    // The point of pinning the list rather than the behaviour: a new field on the proposal
    // grammar must not default to "silently ignored for idempotency purposes", which is
    // how `rationale` came to be omitted. AWS's shape — publish the exemptions — is what
    // makes a partial fingerprint defensible; an implicit one is not.
    expect(IDEMPOTENCY_FINGERPRINT_FIELDS).toEqual(["action_type", "payload_hash", "rationale"]);
    // ...and every one of them really does change the fingerprint.
    const base = { action_type: "send_email", payload_hash: "h", rationale: "r" };
    expect(idempotencyFingerprint({ ...base, action_type: "other" })).not.toBe(
      idempotencyFingerprint(base),
    );
    expect(idempotencyFingerprint({ ...base, payload_hash: "h2" })).not.toBe(
      idempotencyFingerprint(base),
    );
    expect(idempotencyFingerprint({ ...base, rationale: "r2" })).not.toBe(
      idempotencyFingerprint(base),
    );
  });

  it("an identical retry — same key, same payload, same rationale — is still 200", async () => {
    // The witness. Without it, a fingerprint that never matched would green the pin above.
    const b = body();
    const first = await post(b);
    const retry = await post(b);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ id: first.json.id, duplicate: true });
  });
});

describe("A2/I-4: a replay is answered, not rate-limited", () => {
  it("a byte-identical retry of an already-recorded ask is answered even AT the limit", async () => {
    // mutation: delete the replay short-circuit block from `server.ts` (the
    //           `if (replay.rowCount === 1)` branch before the cap/rate counters)
    //           -> the retry gets 429 and this reds. RUN ✅ 2026-08-08
    //
    // 🚨 THIS IS A DELIBERATE DEPARTURE FROM THE ONLY PUBLISHED PRECEDENT, and the source
    // comment says so: Stripe documents "rate limiters run before the API's idempotency
    // layer" in terms, and the IETF draft is silent. We depart because our 429 was returned
    // for an ask that was ALREADY RECORDED AND QUEUED — which is not what RFC 6585 §4
    // describes — and because Stripe's client-side remedy for a 4xx ("always generate a new
    // idempotency key") would produce a second card for the same ask, the exact duplicate
    // `suppress.ts` exists to prevent.
    //
    // The failure it closes: the agent posts its Nth send of the hour, the response is lost
    // to a socket timeout, it retries as the idempotency contract exists to make safe, and
    // gets a 429 — so it cannot learn whether the ask was recorded, which is the one
    // question the key was introduced to answer.
    const b = body({ payload: { to: "first@example.com" } });
    const first = await post(b);
    expect(first.status).toBe(201);
    // Fill the per-action budget with DISTINCT asks.
    for (let i = 0; i < RATE - 1; i++) {
      expect((await post(body({ payload: { to: `f${i}@example.com` } }))).status).toBe(201);
    }
    expect(
      (await post(body({ payload: { to: "over@example.com" } }))).status,
      "the limit must actually be reached, or this test proves nothing",
    ).toBe(429);

    const retry = await post(b);
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect(retry.json).toMatchObject({ id: first.json.id, duplicate: true });
  });

  it("...but a NEW key at the limit STILL 429s — the exemption is not a bypass", async () => {
    // mutation: widen the short-circuit to answer without comparing the fingerprint, or to
    //           run before the key lookup -> a new ask slips through and this reds.
    //           RUN ✅ 2026-08-08
    for (let i = 0; i < RATE; i++) {
      expect((await post(body({ payload: { to: `n${i}@example.com` } }))).status).toBe(201);
    }
    const fresh = await post(body({ payload: { to: "brand-new@example.com" } }));
    expect(fresh.status, "a NEW ask was admitted past the rate limit").toBe(429);
  });

  it("...and a MISMATCHED fingerprint AT THE LIMIT still 422s — it is NOT counted, deliberately", async () => {
    // mutation: move `respondToMismatch(...)` in `server.ts` to AFTER the cap and rate
    //           counts (i.e. let a mismatch "fall through" and be counted)
    //           -> the mismatch below returns 429 instead of 422 and this reds.
    //           RUN ✅ 2026-08-09
    //
    // 🚨 THIS PIN USED TO BE VACUOUS WITH RESPECT TO ITS OWN TITLE — the seventh such on
    // this project and the first introduced by a fix wave. It said "at the limit" and
    // posted twice, never reaching the limit, so it asserted nothing about the property it
    // named. Its sibling above carried the "the limit must actually be reached" guard; this
    // one did not. The budget is now genuinely filled and the fill is asserted before the
    // mismatch is sent.
    //
    // 🚨 AND THE BEHAVIOUR IT PINS IS THE OPPOSITE OF WHAT THE OLD TITLE CLAIMED. Three
    // published sentences said a mismatch "is still counted"; measured, it never was
    // ([422,422,422,422,422] after the limiter had started refusing). The DECISION was to
    // keep the exemption and correct the sentences, because an application-level counter
    // cannot bound request volume — only row creation — so counting mismatches would turn
    // unbounded 422s into unbounded 429s while TRIPLING the query cost of each refusal and
    // letting a client-side payload bug consume the budget that protects the human's
    // queue. JUDGMENT; the residual is disclosed in KNOWN-ISSUES.
    const key = `mm-${Math.random().toString(36).slice(2)}`;
    expect(
      (await post(body({ idempotency_key: key, payload: { to: "original@example.com" } }))).status,
    ).toBe(201);

    // Fill the rest of the budget with DISTINCT asks, then prove the limiter is actually
    // refusing — without this guard the assertions below prove nothing.
    for (let i = 0; i < RATE - 1; i++) {
      expect((await post(body({ payload: { to: `fill${i}@example.com` } }))).status).toBe(201);
    }
    expect(
      (await post(body({ payload: { to: "fresh@example.com" } }))).status,
      "the limit must actually be reached, or this test proves nothing",
    ).toBe(429);

    // Now the property: a mismatch on an existing key is answered 422, not 429, and stays
    // 422 however many times it is sent.
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(
        (await post(body({ idempotency_key: key, payload: { to: `mismatch${i}@example.com` } })))
          .status,
      );
    }
    expect(seen, "a mismatch was metered by the rate limiter").toEqual([422, 422, 422, 422]);

    // ...and none of it wrote anything. That is the reason the exemption is defensible:
    // the counters exist to bound ROW CREATION, and this path creates no rows.
    const rows = await admin.query<{ n: number }>(
      `select count(*)::int as n from approval.proposals where idempotency_key = $1`,
      [key],
    );
    expect(rows.rows[0].n).toBe(1);
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
