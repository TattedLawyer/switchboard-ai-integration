// Phase 3 / A2, T6 — the queue read model.
//
// The second of expiry's three enforcement points: a row past its window is NEVER
// rendered, whether or not the sweeper has caught up with it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { readPendingQueue } from "../src/queue.js";
import { payloadHash } from "../src/canonical.js";

const TENANT = "00000000-0000-0000-0000-000000000000";
const OTHER = "11111111-1111-1111-1111-111111111111";

let admin: pg.Pool;
let approvalPool: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
  const u = new URL(r.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approvalPool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approvalPool.on("error", () => {});
}, 60_000);

afterEach(async () => {
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (approvalPool) await approvalPool.end().catch(() => {});
  if (cleanup) await cleanup();
});

async function seed(opts: {
  state?: string;
  hours?: number;
  tenant?: string;
  createdAgoMin?: number;
  payload?: Record<string, unknown>;
}): Promise<string> {
  const payload = opts.payload ?? { to: "a@example.com", n: Math.random() };
  const r = await admin.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
        expires_at, state, created_at)
     values ($1, $2, 'send_email', $3::jsonb, 'seeded', $4,
             now() + make_interval(hours => $5::int), $6,
             now() - make_interval(mins => $7::int))
     returning id`,
    [
      opts.tenant ?? TENANT,
      `q-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      payloadHash(payload),
      opts.hours ?? 24,
      opts.state ?? "pending",
      opts.createdAgoMin ?? 0,
    ],
  );
  return r.rows[0].id as string;
}

describe("A2/T6: the queue read model", () => {
  it("shows LIVE pending rows and hides expired ones, with no sweeper running", async () => {
    // mutation: remove `and expires_at > now()` from `readPendingQueue` -> the aged row is
    //           rendered and this reds. RUN ✅ 2026-08-08
    const live = await seed({ hours: 24 });
    await seed({ hours: -1 }); // aged out, sweeper has NOT run
    const rows = await readPendingQueue(approvalPool, TENANT);
    expect(rows.map((r) => r.id)).toEqual([live]);
  });

  it("shows only PENDING — nothing decided, executing or terminal", async () => {
    const pending = await seed({});
    for (const s of ["approved", "rejected", "expired", "superseded", "executing", "executed"]) {
      await seed({ state: s });
    }
    const rows = await readPendingQueue(approvalPool, TENANT);
    expect(rows.map((r) => r.id)).toEqual([pending]);
  });

  it("orders by created_at then id — the tiebreak is not decoration", async () => {
    // mutation: drop `, id` from the ORDER BY -> same-tick inserts tie and the order is
    //           whatever the plan happens to produce. RUN ✅ 2026-08-08 (see the note in
    //           `queue.ts`: `created_at` defaults to `now()`, which is TRANSACTION START,
    //           so same-transaction inserts tie EXACTLY and the `supersedes` graph that
    //           duplicate-collapse builds would be nondeterministic. A3's audit reads it.)
    const older = await seed({ createdAgoMin: 10 });
    const newer = await seed({ createdAgoMin: 1 });
    const rows = await readPendingQueue(approvalPool, TENANT);
    expect(rows.map((r) => r.id)).toEqual([older, newer]);

    // The tie case, made real: three rows inserted in ONE transaction share `created_at`
    // to the microsecond, so only the id tiebreak makes the order stable.
    await admin.query("delete from approval.proposals");
    const c = await admin.connect();
    const tied: string[] = [];
    try {
      await c.query("begin");
      for (let i = 0; i < 3; i++) {
        const p = { i };
        const r = await c.query(
          `insert into approval.proposals
             (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
              expires_at)
           values ($1, $2, 'send_email', $3::jsonb, 'tied', $4, now() + interval '24 hours')
           returning id`,
          [TENANT, `tie-${i}-${Math.random()}`, JSON.stringify(p), payloadHash(p)],
        );
        tied.push(r.rows[0].id as string);
      }
      await c.query("commit");
    } finally {
      c.release();
    }
    const stamps = await admin.query(
      `select count(distinct created_at)::int as n from approval.proposals`,
    );
    expect(stamps.rows[0].n, "the tie fixture did not actually tie").toBe(1);
    const a = (await readPendingQueue(approvalPool, TENANT)).map((r) => r.id);
    const b = (await readPendingQueue(approvalPool, TENANT)).map((r) => r.id);
    expect(a).toEqual(b);
    expect(a).toEqual([...tied].sort());
  });

  it("is tenant-scoped", async () => {
    const mine = await seed({});
    await seed({ tenant: OTHER });
    expect((await readPendingQueue(approvalPool, TENANT)).map((r) => r.id)).toEqual([mine]);
  });

  it("reads with ONLY the grants switchboard_approval holds", async () => {
    const who = await approvalPool.query(`select current_user as u`);
    expect(who.rows[0].u).toBe("switchboard_approval");
    await seed({});
    expect((await readPendingQueue(approvalPool, TENANT)).length).toBe(1);
  });
});
