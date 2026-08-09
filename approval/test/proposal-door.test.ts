// Phase 3 / A1 — the proposal-recording door.
//
// This is the seam the whole writer-boundary decision rests on. The agent produces a
// validated object and hands it across an authenticated door; THIS service records it.
// The agent process never acquires a write-capable credential, which is why the sentence
// the README publishes survives Phase 3 unchanged.
//
// What these tests are pinning, in order of how much the claim depends on them:
//   1. The door authenticates, fails closed without its secret, and compares in constant
//      time. An unauthenticated proposal door is a public INSERT endpoint.
//   2. The door's grammar is one row shape. A pool speaks SQL; the door speaks one row.
//      That difference IS the claim — so a proposal outside the action allowlist, or with
//      the wrong shape, is a refusal, never a coerced INSERT.
//   3. Flood control. A compromised agent host holds the bearer secret and can forge
//      well-formed proposals at volume. The terminal state of an unbounded flood is an
//      approval queue no human can triage — which DISABLES the "nothing acts without an
//      identified approver" constraint rather than merely annoying it. Cap + idempotency.
//   4. Failure is loud. A proposal that was not recorded must never look recorded.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../src/server.js";
import { PROPOSAL_ACTION_TYPES } from "../src/proposal.js";

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

/** A well-formed proposal body. Tests deform one field at a time from this. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotency_key: `k-${Math.random().toString(36).slice(2)}`,
    action_type: "send_email",
    payload: { to: "ops@example.com", subject: "renewal at risk" },
    rationale: "Invoice 3 is 41 days overdue and the account has two SLA breaches.",
    ...overrides,
  };
}

async function post(
  b: unknown,
  opts: { token?: string | null; contentType?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
  };
  const token = opts.token === undefined ? SECRET : opts.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/internal/proposals`, {
    method: "POST",
    headers,
    body: typeof b === "string" ? b : JSON.stringify(b),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  approvalPool = new pg.Pool({ connectionString: approvalUrlFrom(r.url), max: 4 });
  const app = createApprovalApp(approvalPool, {
    tenantId: TENANT,
    proposalToken: SECRET,
    pendingCap: 5,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
});

afterEach(async () => {
  // Children first: A2 added `approval.decisions` / `approval.executions`, which reference
  // proposals with no ON DELETE CASCADE — a decision is evidence, and evidence does not
  // evaporate when the row it is about is removed.
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
  vi.unstubAllEnvs();
});

afterAll(async () => {
  if (close) await close().catch(() => {});
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("A1: the proposal door records what the agent proposes", () => {
  it("records a well-formed proposal as pending and returns its id", async () => {
    const b = body();
    const res = await post(b);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.state).toBe("pending");
    expect(typeof res.json.id).toBe("string");

    const row = await admin.query(
      `select tenant_id, idempotency_key, action_type, payload, rationale, state
         from approval.proposals where id = $1`,
      [res.json.id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      tenant_id: TENANT,
      idempotency_key: b.idempotency_key,
      action_type: "send_email",
      rationale: b.rationale,
      state: "pending",
    });
    expect(row.rows[0].payload).toEqual(b.payload);
  });

  it("the tenant comes from the deployment, never from the request body", async () => {
    // SEC-C1's rule: one deployment serves one configured tenant. A caller-supplied
    // tenant would make the door a tenant selector, and the agent's bearer token would
    // become authority over every tenant on the host.
    const res = await post(body({ tenant_id: "11111111-1111-1111-1111-111111111111" }));
    expect(res.status).toBe(400);
    const rows = await admin.query("select count(*)::int as n from approval.proposals");
    expect(rows.rows[0].n).toBe(0);
  });
});

describe("A1: the door authenticates, and fails closed", () => {
  it("refuses an unauthenticated proposal with 401 and writes nothing", async () => {
    const res = await post(body(), { token: null });
    expect(res.status).toBe(401);
    const rows = await admin.query("select count(*)::int as n from approval.proposals");
    expect(rows.rows[0].n).toBe(0);
  });

  it("refuses a wrong bearer token with 401", async () => {
    expect((await post(body(), { token: "not-the-token" })).status).toBe(401);
    // Same length as the real secret: a length-only comparison would accept this.
    expect((await post(body(), { token: "x".repeat(SECRET.length) })).status).toBe(401);
  });

  it("refuses a token that is a prefix of the real one", async () => {
    expect((await post(body(), { token: SECRET.slice(0, -1) })).status).toBe(401);
  });

  it("never echoes the expected secret in a refusal", async () => {
    const res = await post(body(), { token: "wrong" });
    expect(JSON.stringify(res.json)).not.toContain(SECRET);
  });

  it("rejects before parsing the body — an unauthenticated caller cannot even reach the parser", async () => {
    const res = await post("{not json", { token: null });
    expect(res.status).toBe(401);
  });
});

describe("A1: the door's grammar is one row shape, not SQL", () => {
  it("refuses an action_type outside the allowlist, naming the allowlist", async () => {
    const res = await post(body({ action_type: "drop_database" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain("action_type");
    const rows = await admin.query("select count(*)::int as n from approval.proposals");
    expect(rows.rows[0].n).toBe(0);
  });

  it("the allowlist is non-empty and every member is accepted", async () => {
    // Vacuity guard: an empty allowlist would make the test above pass for free.
    expect(PROPOSAL_ACTION_TYPES.length).toBeGreaterThanOrEqual(1);
    for (const action of PROPOSAL_ACTION_TYPES) {
      const res = await post(body({ action_type: action }));
      expect(res.status, `${action} was refused: ${JSON.stringify(res.json)}`).toBe(201);
    }
  });

  it("refuses a missing rationale — a proposal a human cannot judge is not a proposal", async () => {
    const res = await post({ ...body(), rationale: undefined });
    expect(res.status).toBe(400);
  });

  it("refuses an empty idempotency key", async () => {
    expect((await post(body({ idempotency_key: "" }))).status).toBe(400);
  });

  it("refuses a payload that is not an object (no coercion, ever)", async () => {
    expect((await post(body({ payload: "to=a@example.com" }))).status).toBe(400);
    expect((await post(body({ payload: null }))).status).toBe(400);
  });

  it("refuses unknown fields rather than dropping them silently", async () => {
    // A silently-dropped field is a proposal the human approved and the executor never
    // saw. Strict parsing makes that a refusal at the boundary instead.
    const res = await post({ ...body(), execute_immediately: true });
    expect(res.status).toBe(400);
  });

  it("refuses a malformed JSON body with 400, not a 500", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });
});

describe("A1: flood control — the approval queue stays triageable", () => {
  it("a replayed idempotency key is a no-op returning the SAME id, not a second row", async () => {
    const b = body();
    const first = await post(b);
    expect(first.status).toBe(201);
    const second = await post(b);
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.duplicate).toBe(true);
    const rows = await admin.query("select count(*)::int as n from approval.proposals");
    expect(rows.rows[0].n).toBe(1);
  });

  it("refuses at the pending cap with a loud 429 and records nothing beyond it", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post(body())).status).toBe(201);
    }
    const over = await post(body());
    expect(over.status).toBe(429);
    // Loud: the operator has to be able to tell this from a network blip.
    expect(JSON.stringify(over.json)).toMatch(/pending/i);
    const rows = await admin.query("select count(*)::int as n from approval.proposals");
    expect(rows.rows[0].n).toBe(5);
  });

  it("the cap counts PENDING rows only — a triaged queue accepts again", async () => {
    for (let i = 0; i < 5; i++) await post(body());
    expect((await post(body())).status).toBe(429);
    // A human decides on one.
    //
    // 🚨 THIS BLOCK USED TO BE A BARE `update ... set state = 'rejected'`, AND A2 BROKE IT
    // ON PURPOSE. That one-liner is exactly the exploit the widened trigger predicate
    // closes: a proposal reaching a terminal HUMAN disposition with no attributable human
    // anywhere. It succeeded silently before migration 015 and now raises
    //   "a rejected transition requires an approval.decisions row of kind rejected,
    //    naming an approver, written in the SAME transaction"
    // — which is the guarantee working, discovered by this test rather than asserted by
    // it. So the triage is now performed the only way the database permits: a real
    // approver, a real reason, one transaction.
    //
    // (Still done as `admin`: seeding an approver is the operator CLI's privilege, not the
    // approval role's, and A0b owns the page that would drive this for real.)
    const approver = (
      await admin.query(`insert into approval.users (email) values ($1) returning id`, [
        `triage-${Math.random().toString(36).slice(2)}@example.com`,
      ])
    ).rows[0].id as string;
    const victim = (
      await admin.query(`select id from approval.proposals limit 1`)
    ).rows[0].id as string;
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, reason,
                                         renderer_version)
         values ($1, 'rejected', $2, 'triaging the queue in a test', 'test')`,
        [victim, approver],
      );
      await c.query(`update approval.proposals set state = 'rejected' where id = $1`, [victim]);
      await c.query("commit");
    } finally {
      c.release();
    }
    expect((await post(body())).status).toBe(201);
  });
});

describe("A1: failure is loud — a proposal that was not recorded never looks recorded", () => {
  it("a database failure answers 5xx, never a plausible-looking success", async () => {
    // The governing precedent is the plan's own AnthropicLlm.complete finding: swallowing
    // an error and returning template text is silently dangerous in an action path.
    const brokenPool = {
      query: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as pg.Pool;
    const app = createApprovalApp(brokenPool, {
      tenantId: TENANT,
      proposalToken: SECRET,
      pendingCap: 5,
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/internal/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(body()),
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      const j = (await res.json()) as Record<string, unknown>;
      expect(j.id, "a failed record must not return an id").toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
