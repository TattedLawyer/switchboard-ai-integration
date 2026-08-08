// Phase 3 / A2, T10 — the volume controls are the MEASURED ones, and the dedup asserts in
// BOTH directions.
//
// A one-directional dedup pin passes trivially by never collapsing anything, so every
// assertion here has a counterpart: identical asks MUST collapse, and near-identical ones
// MUST NOT. The second half is the one that matters — over-collapsing is the direction a
// suppression key is designed to produce, and it silently drops an ask the human needed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../src/server.js";
import { readPendingQueue } from "../src/queue.js";
import { approveCard, collapseDuplicates, rejectCard } from "../src/suppress.js";
import { ACTION_RATE_WINDOW_MINUTES } from "../src/config.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../ingest/src/cli/approval-user-add.ts", import.meta.url));
const INGEST_DIR = fileURLToPath(new URL("../../ingest", import.meta.url));
const TENANT = "00000000-0000-0000-0000-000000000000";
const SECRET = "test-proposal-token-do-not-reuse";
const CAP = 40;
const RATE = 12;

let admin: pg.Pool;
let app: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;
let base: string;
let close: () => Promise<void>;
let approver: string;

async function post(
  payload: Record<string, unknown>,
  rationale = "the same reason, every time",
  actionType = "send_email",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/internal/proposals`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      idempotency_key: `k-${Math.random().toString(36).slice(2)}`,
      action_type: actionType,
      payload,
      rationale,
    }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** N live pending rows whose `created_at` is `agoMinutes` in the past — seeded at INSERT,
 *  because `created_at` is a FROZEN column and no UPDATE can move it. */
async function seedAged(n: number, agoMinutes: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await admin.query(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
          expires_at, created_at)
       values ($1, $2, 'send_email', $3::jsonb, 'aged probe', repeat('f', 64),
               now() + interval '72 hours', now() - make_interval(mins => $4::int))`,
      [TENANT, `aged-${i}-${Math.random()}`, JSON.stringify({ i }), agoMinutes],
    );
  }
}

const cards = async (): Promise<ReturnType<typeof collapseDuplicates>> =>
  collapseDuplicates(await readPendingQueue(app, TENANT));

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
  const server = createApprovalApp(app, {
    tenantId: TENANT,
    proposalToken: SECRET,
    pendingCap: CAP,
    actionRateLimit: RATE,
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  const email = `t10-${Math.random().toString(36).slice(2)}@example.com`;
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
  if (close) await close().catch(() => {});
  if (app) await app.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("A2/T10: the dedup collapses identical asks — and ONLY identical asks", () => {
  it("two byte-identical proposals render as ONE card", async () => {
    const p = { to: "jane@client.example.com", subject: "renewal", body: "shall I?" };
    await post(p);
    await post(p);
    const c = await cards();
    expect(c).toHaveLength(1);
    expect(c[0].duplicates).toHaveLength(1);
  });

  it("🚨 two DIFFERENT payloads to the SAME recipient render as TWO cards", async () => {
    // mutation: remove `payload_hash` from `suppressionKey` -> these two collapse into one
    //           card and this reds. RUN ✅ 2026-08-08
    //
    // This is the scenario that killed the previous key. Same action type, same recipient,
    // same "entity" — and the second message is the one she actually had to authorise.
    await post({ to: "jane@client.example.com", body: "your listing expires Friday" });
    await post({ to: "jane@client.example.com", body: "we are dropping the price to $400,000" });
    const c = await cards();
    expect(c, "two different outcomes were merged into one card").toHaveLength(2);
    expect(c.every((x) => x.duplicates.length === 0)).toBe(true);
  });

  it("🚨 an identical payload with a DIFFERENT rationale renders as TWO cards", async () => {
    // mutation: remove `rationale` from `suppressionKey` -> these collapse and this reds.
    //           RUN ✅ 2026-08-08
    //
    // No unapproved send results here — the payload is identical and at-most-once holds —
    // but the second reason is the one that would have changed her deliberation, and the
    // card is required to carry everything decision-relevant on its face.
    const p = { to: "jane@client.example.com", body: "call me" };
    await post(p, "routine follow-up");
    await post(p, "client called; she is threatening to list elsewhere");
    expect(await cards()).toHaveLength(2);
  });

  it("a different ACTION TYPE never collapses into another", async () => {
    // One member in the allowlist today, so this is checked at the function rather than
    // over the door — which is honest: the door would refuse an unknown action type, and a
    // pin that can only pass because the input is impossible is not a pin.
    const rows = [
      { id: "a", action_type: "send_email", payload_hash: "h", rationale: "r" },
      { id: "b", action_type: "send_sms", payload_hash: "h", rationale: "r" },
    ];
    expect(collapseDuplicates(rows as never)).toHaveLength(2);
  });
});

describe("A2/T10: NO PROPOSAL IS EVER DISCARDED WITHOUT A HUMAN SEEING IT ONCE", () => {
  it("the dedup is render-time — every posted proposal has a row", async () => {
    // mutation: move the dedup to the DOOR (refuse a proposal whose key already exists)
    //           -> the second post is discarded, the row count drops to 1, and this reds.
    //           RUN ✅ 2026-08-08
    //
    // Render-time is the whole point. A door-time dedup would silently discard an ask, and
    // "she never saw it" is a failure she cannot even report.
    const p = { to: "jane@client.example.com", body: "identical" };
    for (let i = 0; i < 4; i++) expect((await post(p)).status).toBe(201);
    const n = await app.query(`select count(*)::int as n from approval.proposals`);
    expect(n.rows[0].n, "the door discarded a proposal").toBe(4);
    // ...and they render as one card, which is the point of writing all four.
    expect(await cards()).toHaveLength(1);
  });

  it("approving a collapsed card supersedes the repeats — none is left pending", async () => {
    const p = { to: "jane@client.example.com", body: "identical" };
    for (let i = 0; i < 3; i++) await post(p);
    const c = await cards();
    expect(c).toHaveLength(1);
    const primary = c[0].primary.id;
    await approveCard(app, c[0], approver);

    const rows = await app.query<{ id: string; state: string }>(
      `select id, state from approval.proposals order by created_at, id`,
    );
    expect(rows.rows.find((r) => r.id === primary)?.state).toBe("approved");
    expect(
      rows.rows.filter((r) => r.id !== primary).map((r) => r.state),
      "a repeat was left pending behind a decided card",
    ).toEqual(["superseded", "superseded"]);
    expect(await cards(), "the queue still shows a decided card").toHaveLength(0);
  });

  it("approving a card is ATOMIC — a failure part-way leaves NOTHING decided", async () => {
    // mutation: give `approveCard` back its per-statement transactions (call `decide(pool,
    //           …)` then `transition(pool, …)` instead of `decideOn(client, …)` /
    //           `transition(client, …)` inside one `begin`)
    //           -> the primary ends up `approved` with a decision row while a repeat is
    //           still `pending`, and this reds. RUN ✅ 2026-08-08
    //
    // WHY IT MATTERS, since it fails toward the SAFE direction and is therefore easy to
    // wave away: a repeat left `pending` re-renders as a card the human ALREADY ANSWERED.
    // Approving that card produces a second, byte-identical outward action. Asking her
    // twice is the right way to fail — but a window that costs nothing to close should be
    // closed, not defended.
    const p = { to: "jane@client.example.com", body: "identical" };
    for (let i = 0; i < 3; i++) await post(p);
    const c = await cards();
    expect(c).toHaveLength(1);
    expect(c[0].duplicates).toHaveLength(2);

    // Somebody else moves one of the repeats out from under the card between render and
    // decision — the sweeper aging it out is the realistic version. The card's transition
    // for that row now finds no `pending` row and refuses.
    const victim = c[0].duplicates[1].id;
    await admin.query(`update approval.proposals set state = 'expired' where id = $1`, [victim]);

    await expect(approveCard(app, c[0], approver)).rejects.toThrow();

    // NOTHING was decided: no decision row survived, the primary is untouched, and the
    // first repeat was not superseded either.
    const d = await app.query(`select count(*)::int as n from approval.decisions`);
    expect(d.rows[0].n, "a decision row survived a failed card approval").toBe(0);
    const states = await app.query<{ id: string; state: string }>(
      `select id, state from approval.proposals order by created_at, id`,
    );
    expect(states.rows.find((r) => r.id === c[0].primary.id)?.state).toBe("pending");
    expect(states.rows.find((r) => r.id === c[0].duplicates[0].id)?.state).toBe("pending");
    expect(states.rows.find((r) => r.id === victim)?.state).toBe("expired");
  });

  it("the card approves the EARLIEST row, deterministically", async () => {
    const p = { to: "jane@client.example.com", body: "identical" };
    const first = await post(p);
    await post(p);
    const c = await cards();
    expect(c[0].primary.id).toBe(first.json.id);
  });

  it("rejecting a card rejects ALL of them, each with its own attributable decision", async () => {
    // A repeat left pending after its card was rejected would come back as a card the
    // human already answered.
    const p = { to: "jane@client.example.com", body: "identical" };
    for (let i = 0; i < 3; i++) await post(p);
    const c = await cards();
    await rejectCard(app, c[0], approver, "not this client, not this week");

    const states = await app.query<{ state: string }>(`select state from approval.proposals`);
    expect(states.rows.every((r) => r.state === "rejected")).toBe(true);
    const d = await app.query<{ n: number }>(
      `select count(*)::int as n from approval.decisions where kind = 'rejected'`,
    );
    expect(d.rows[0].n, "three rejections must be three attributable decisions").toBe(3);
  });
});

describe("A2/T10: the volume backstops, in their ranked order", () => {
  it("the per-action rate limit refuses loudly and names the action", async () => {
    // mutation: delete the rate-limit block from `server.ts` -> the burst is accepted and
    //           this reds. RUN ✅ 2026-08-08
    //
    // Ranked THIRD, below repeat-suppression and expiry. 🚨 The number is JUDGMENT with NO
    // SOURCE: SRE's "2 per 12-hour shift" is a rate DERIVED FROM HANDLING TIME, and nobody
    // has measured how long a broker spends on one of these — the METHOD transfers, the
    // number does not.
    for (let i = 0; i < RATE; i++) {
      expect((await post({ to: "a@example.com", n: i })).status, `post ${i}`).toBe(201);
    }
    const over = await post({ to: "a@example.com", n: 999 });
    expect(over.status).toBe(429);
    expect(over.json.error).toMatch(/rate limit/i);
    expect(over.json.action_type).toBe("send_email");
    expect(over.json.window_minutes).toBe(ACTION_RATE_WINDOW_MINUTES);
    // The remedy points at narrowing the action, not at raising the number.
    expect(String(over.json.remedy)).toMatch(/narrow the action/);
  });

  it("...and it is a RATE, not a cap — ageing the window lets the next one through", async () => {
    // The counterpart that keeps the pin above honest: a limit that simply refused
    // everything after N would green it too.
    for (let i = 0; i < RATE; i++) await post({ to: "a@example.com", n: i });
    expect((await post({ to: "a@example.com", n: 998 })).status).toBe(429);
    // The same rows, but OUTSIDE the window. They cannot be aged by UPDATE — `created_at`
    // is a frozen column and the trigger raises P0001 on any attempt, which is itself the
    // right answer — so they are re-seeded at their older time instead.
    await admin.query(`delete from approval.proposals`);
    await seedAged(RATE, 120);
    expect((await post({ to: "a@example.com", n: 997 })).status).toBe(201);
  });

  it("the static count is the WEAKEST control, and it counts a different quantity now", async () => {
    // It bounds what a compromised agent host can leave sitting in the queue. It is not an
    // attention budget: NO PUBLISHED SOURCE gives a number for this, and neither 100 nor
    // any other value here is derived from evidence about human attention. What protects
    // approval quality is repeat-suppression, the rate limit, and expiry.
    //
    // And it counts UNEXPIRED pending rows — a different quantity from the pre-A2 count
    // under the same numeral, which is why the comment in config.ts had to change.
    await admin.query(`delete from approval.proposals`);
    // Seeded OUTSIDE the rate window, so this test measures the cap and only the cap. A
    // fresh burst of CAP rows would trip the rate limit first and the assertion below would
    // be about the wrong control.
    await seedAged(CAP, 120);
    const res = await post({ to: "b@example.com", n: -1 });
    expect(res.status).toBe(429);
    expect(res.json.error).toMatch(/cap/i);
    // Age them all: the budget is released with no sweeper running.
    await admin.query(`update approval.proposals set expires_at = now() - interval '1 hour'`);
    expect((await post({ to: "b@example.com", n: -2 })).status).toBe(201);
  });
});
