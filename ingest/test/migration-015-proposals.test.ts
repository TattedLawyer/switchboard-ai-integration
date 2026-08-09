// Phase 3 / A2, T2 — migration 015 part 1: the lifecycle columns on `approval.proposals`.
//
// WHY THE INDEX ASSERTION IS ON `indexdef` AND NOT ON EXISTENCE. Rev 4 of the plan reissued
// 014's index NAME with a different column list under `if not exists`. PostgreSQL's own
// CREATE INDEX page: "there is no guarantee that the existing index is anything like the
// one that would have been created" — the existence check is on the RELATION NAME only,
// not columns, method, predicate or uniqueness. Measured on PG 16: `NOTICE: relation
// "proposals_pending_by_tenant" already exists, skipping`, CREATE INDEX reported as
// success, `expires_at` never added. The pin that said "the index demonstrably created"
// was satisfied by 014's index. So 015 uses a DISTINCT name, an explicit DROP of the old
// one, and NO `if not exists` — a future collision is a deploy-time error rather than a
// skipped statement — and this test asserts on the DEFINITION plus the ABSENCE of the old
// name. Same discipline as `migration-013.test.ts:82-98`.
//
// WHY THE THREE-STEP COLUMN ADD IS EXERCISED AGAINST A SEEDED TABLE. `alter table ... add
// column ... not null` WITHOUT a default fails on a non-empty table, and A2 cannot verify
// whether `approval.proposals` holds rows in any real deployment (plan §6 #1) — exactly the
// condition under which this matters. 015 is implicitly transactional (V19), so it would
// abort atomically and the fix would be a second migration under pressure. The final block
// below therefore builds a scratch database at migration 014, seeds a legacy row, and only
// then applies 015 — the one arrangement in which the backfill is load-bearing. A test that
// only ever runs 015 against an empty table cannot tell.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshTestDb } from "./helpers/testdb.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

const TENANT = "00000000-0000-0000-0000-000000000000";

/** The eight states §3.4 names. `dismissed` is deliberately absent: it is a DECISION
 *  without a state transition (§3.7), and it lives in `approval.decisions.kind`. */
const EIGHT_STATES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "superseded",
  "executing",
  "executed",
  "execution_failed",
] as const;

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const r = await freshTestDb();
  pool = r.pool;
  cleanup = r.cleanup;
}, 60_000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

/** A PENDING proposal. The only kind that can be created — see the creation guard. */
async function insertPending(
  extra: { payload_hash?: string; state?: string } = {},
): Promise<string> {
  const r = await pool.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, state,
        payload_hash, expires_at)
     values ($1, $2, 'send_email', '{}'::jsonb, 'probe', $3, $4, now() + interval '72 hours')
     returning id`,
    [
      TENANT,
      `t2-${Math.random().toString(36).slice(2)}`,
      extra.state ?? "pending",
      extra.payload_hash ?? "0".repeat(64),
    ],
  );
  return r.rows[0].id as string;
}

/** Reach `state` the way the system reaches it: a decision row for the human-driven
 *  transitions, a plain conditional UPDATE for the machine-driven ones. */
async function walkToState(state: string): Promise<string> {
  const ins = await pool.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, 'send_email', '{}'::jsonb, 'walk', repeat('a', 64),
             now() + interval '72 hours')
     returning id`,
    [TENANT, `t2-walk-${Math.random().toString(36).slice(2)}`],
  );
  const id = ins.rows[0].id as string;
  if (state === "pending") return id;

  const decide = async (kind: "approved" | "rejected"): Promise<void> => {
    const approver = (
      await pool.query(`insert into approval.users (email) values ($1) returning id`, [
        `walk-${Math.random().toString(36).slice(2)}@example.com`,
      ])
    ).rows[0].id as string;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, reason,
                                         renderer_version)
         values ($1, $2, $3, $4, 'walk')`,
        [id, kind, approver, kind === "rejected" ? "walked rejection" : null],
      );
      await c.query(`update approval.proposals set state = $2 where id = $1`, [id, kind]);
      await c.query("commit");
    } finally {
      c.release();
    }
  };
  const move = async (from: string, to: string): Promise<void> => {
    const r = await pool.query(
      `update approval.proposals set state = $3 where id = $1 and state = $2`,
      [id, from, to],
    );
    if (r.rowCount !== 1) throw new Error(`walk: ${from} -> ${to} failed`);
  };

  if (state === "approved") await decide("approved");
  else if (state === "rejected") await decide("rejected");
  else if (state === "expired") await move("pending", "expired");
  else if (state === "superseded") await move("pending", "superseded");
  else {
    await decide("approved");
    await move("approved", "executing");
    if (state !== "executing") await move("executing", state);
  }
  return id;
}

describe("A2/T2: migration 015 widens the proposal lifecycle", () => {
  it("carries every lifecycle column the plan names, with the nullability the plan states", async () => {
    const cols = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema = 'approval' and table_name = 'proposals'
        order by column_name`,
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
    // NOT NULL, because every proposal must carry one: the hash decides whether a retried
    // call is the same call, and the expiry is what stops a burst wedging the queue.
    expect(byName.get("payload_hash")).toMatchObject({ is_nullable: "NO" });
    expect(byName.get("expires_at")).toMatchObject({
      is_nullable: "NO",
      data_type: "timestamp with time zone",
    });
    expect(byName.get("authored_by")).toMatchObject({ is_nullable: "NO" });
    // NULLABLE, because each is absent on the ordinary path: nothing supersedes a first
    // proposal, an agent-authored one has no human author, and an undecided one has no
    // decision time.
    expect(byName.get("supersedes")).toMatchObject({ is_nullable: "YES" });
    expect(byName.get("authored_by_user_id")).toMatchObject({ is_nullable: "YES" });
    expect(byName.get("decided_at")).toMatchObject({ is_nullable: "YES" });
  });

  it("declares exactly EIGHT states, and every one of them is legally REACHABLE", async () => {
    // mutation: delete the widened CHECK from 015 -> the definition assertion reds.
    //           RUN ✅ 2026-08-08
    // mutation: delete `drop constraint proposals_state_check` -> duplicate-name error and
    //           the whole suite fails; and with the new constraint renamed instead, the two
    //           CHECKs conjoin and the reachability walk reds on `expired`. RUN ✅ 2026-08-08
    //
    // 🚨 THIS TEST WAS REWRITTEN WHEN THE CREATION GUARD LANDED, AND THE REWRITE IS THE
    // POINT. It used to INSERT each state directly — `insert ... values (..., 'approved')`
    // — which is exactly the forgery the trigger now refuses. A test that could conjure an
    // `approved` row was asserting something about a state the running system cannot
    // produce, and that habit is part of why an INSERT-side hole survived seven reviews.
    // So the eight states are now checked TWO ways, neither of which forges anything:
    //   · the CHECK's DEFINITION, read from the catalog — the declared set;
    //   · a legal WALK to each state through real transitions — the reachable set.
    // A state that is declared but unreachable, or reachable but undeclared, reds.
    const def = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'proposals_state_check'
          and conrelid = 'approval.proposals'::regclass`,
    );
    expect(def.rowCount, "015 did not install the widened state CHECK").toBe(1);
    for (const state of EIGHT_STATES) {
      expect(def.rows[0].def, `'${state}' is not in the declared set`).toContain(`'${state}'`);
    }
    // `dismissed` is deliberately NOT a state: it is a DECISION without a transition, and
    // it lives in `approval.decisions.kind`.
    expect(def.rows[0].def).not.toContain("'dismissed'");
    expect(def.rows[0].def).not.toContain("'held'");

    for (const state of EIGHT_STATES) {
      const id = await walkToState(state);
      const got = await pool.query(`select state from approval.proposals where id = $1`, [id]);
      expect(got.rows[0].state, `'${state}' is declared but not reachable`).toBe(state);
    }
  });

  it("refuses a ninth state, at the guard first and the CHECK behind it", async () => {
    // Two layers, and the order matters for what the error says. The creation guard runs
    // BEFORE the constraint, so an insert naming an unknown state raises P0001 ("born
    // undecided") rather than 23514 — the CHECK is the second line, not the first. Asserting
    // that it throws AND that the declared set excludes the value covers both without
    // pretending a single SQLSTATE is the whole story.
    await expect(insertPending({ state: "dismissed" })).rejects.toMatchObject({ code: "P0001" });
    await expect(insertPending({ state: "held" })).rejects.toMatchObject({ code: "P0001" });
  });

  it("forbids approving a legacy row — we cannot attest a payload we never hashed", async () => {
    // mutation: delete the `proposals_legacy_never_approved` constraint from 015 -> red.
    //           RUN ✅ 2026-08-08
    //
    // Approached the legal way — a real approver and a real same-transaction decision row —
    // so the trigger's predicate is SATISFIED and the ONLY thing refusing this is the legacy
    // CHECK. (Previously this INSERTed `state='approved'` directly, which the creation guard
    // now refuses first, and the pin would have passed for the wrong reason.)
    const id = await insertPending({ payload_hash: "legacy:unhashable" });
    const approver = (
      await pool.query(`insert into approval.users (email) values ($1) returning id`, [
        `legacy-${Math.random().toString(36).slice(2)}@example.com`,
      ])
    ).rows[0].id as string;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
         values ($1, 'approved', $2, 'v0')`,
        [id, approver],
      );
      await expect(
        c.query(`update approval.proposals set state = 'approved' where id = $1`, [id]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await c.query("rollback").catch(() => {});
      c.release();
    }
    // ...and it may still be rejected or age out. The constraint forbids one OUTCOME, not
    // the row's existence — a legacy row must stay disposable.
    const r = await pool.query(
      `update approval.proposals set state = 'expired' where id = $1 and state = 'pending'`,
      [id],
    );
    expect(r.rowCount).toBe(1);
  });

  it("replaces 014's one-column index with the expiry-aware one, BY DEFINITION not by existence", async () => {
    // mutation: remove `expires_at` from the new index's column list -> this reds.
    //           RUN ✅ 2026-08-08
    // mutation: remove `drop index if exists approval.proposals_pending_by_tenant` from 015
    //           -> ONLY the absence clause reds (the new index carries a DISTINCT name, so
    //           both coexist and `indexdef` still contains `expires_at`). RUN ✅ 2026-08-08
    const defs = await pool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'approval' and tablename = 'proposals'`,
    );
    const names = defs.rows.map((r) => r.indexname);

    expect(
      names,
      "014's one-column index survived — the cap count may still choose its plan, so the " +
        "new index's presence proves nothing about what runs",
    ).not.toContain("proposals_pending_by_tenant");

    const row = defs.rows.find((r) => r.indexname === "proposals_pending_by_tenant_expiry");
    expect(row, "the expiry-aware index was not created").toBeDefined();
    // Strip the index NAME before asserting on the definition: the name contains
    // `expiry`, and an assertion over the whole `indexdef` would be satisfiable by the
    // name alone. This is the fifth-incident stripper from migration-013.test.ts:97.
    const def = row!.indexdef;
    const columns = def.slice(def.indexOf("USING "));
    expect(columns, `could not isolate the column list from: ${def}`).toMatch(/^USING \w+ \(/);
    expect(columns).not.toContain("proposals_pending_by_tenant_expiry"); // the stripper works
    expect(columns).toContain("tenant_id");
    expect(columns).toContain("expires_at");
    expect(columns).toContain("WHERE (state = 'pending'");
  });

  it("keeps the predicate CONSTANT — `expires_at > now()` is not creatable in an index", async () => {
    // "functions in index predicate must be marked IMMUTABLE" (42P17). Verified rather
    // than assumed, because two revisions of the plan proposed exactly this predicate.
    await expect(
      pool.query(
        `create index t2_probe_nonimmutable on approval.proposals (tenant_id)
          where state = 'pending' and expires_at > now()`,
      ),
    ).rejects.toMatchObject({ code: "42P17" });
  });
});

describe("A2/T2: the three-step column add survives a NON-EMPTY table", () => {
  // The one arrangement in which the backfill is load-bearing: migrations 001..014, a
  // seeded legacy row, and only then 015.
  let scratch: pg.Pool;
  let dropScratch: () => Promise<void>;
  let legacyId: string;

  beforeAll(async () => {
    const originalUrl = process.env.DATABASE_URL;
    if (!originalUrl) throw new Error("DATABASE_URL is required");
    const dbName = `switchboard_t2_legacy_${Date.now()}_${Math.random().toString(36).slice(7)}`;
    const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`create database "${dbName}"`);
    } finally {
      await adminPool.end();
    }
    scratch = new pg.Pool({
      connectionString: originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`),
    });
    scratch.on("error", () => {});
    dropScratch = async (): Promise<void> => {
      await scratch.end().catch(() => {});
      const p = new pg.Pool({ connectionString: adminUrl });
      p.on("error", () => {});
      try {
        await p.query(`drop database if exists "${dbName}" with (force)`);
      } finally {
        await p.end();
      }
    };

    const files = readdirSync(MIGRATIONS_DIR).sort();
    for (const f of files) {
      if (f >= "015") break; // stop at 014: this is the pre-A2 world
      await scratch.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    const ins = await scratch.query(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, created_at)
       values ($1, 'legacy-row', 'send_email', '{"to":"a@example.com"}'::jsonb, 'from before A2',
               now() - interval '10 days')
       returning id`,
      [TENANT],
    );
    legacyId = ins.rows[0].id as string;

    // 015 against the non-empty table. If the backfill step is missing this THROWS, and
    // it throws atomically (V19) — which is the failure mode the three-step exists to
    // prevent, and which no empty-table run can reproduce.
    // mutation: delete the `update ... set payload_hash = 'legacy:unhashable'` backfill
    //           from 015 -> this beforeAll throws and the SUITE fails:
    //           `column "payload_hash" of relation "proposals" contains null values`.
    //           RUN ✅ 2026-08-08
    // mutation: delete the `update ... set expires_at = created_at + ...` backfill
    //           -> same shape: `column "expires_at" ... contains null values`.
    //           RUN ✅ 2026-08-08
    await scratch.query(readFileSync(join(MIGRATIONS_DIR, "015_approval_lifecycle.sql"), "utf8"));
  }, 120_000);

  afterAll(async () => {
    if (dropScratch) await dropScratch();
  });

  it("backfills the legacy row rather than failing the migration", async () => {
    const r = await scratch.query(
      `select payload_hash, expires_at, created_at, state, authored_by
         from approval.proposals where id = $1`,
      [legacyId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].payload_hash).toBe("legacy:unhashable");
    expect(r.rows[0].authored_by).toBe("agent");
    // created_at + TTL, which for a ten-day-old row is already in the past — so a legacy
    // row is correctly ALREADY EXPIRED rather than granted a fresh 72 hours it never had.
    expect(new Date(r.rows[0].expires_at as string).getTime()).toBeLessThan(Date.now());
  });

  it("and that backfilled row can never be approved — even by a fully legitimate approval", async () => {
    // mutation: delete the `proposals_legacy_never_approved` constraint from 015 -> red.
    //           RUN ✅ 2026-08-08
    //
    // The decision row is written FOR REAL, in the same transaction, naming a real
    // approver — so the trigger's own predicate is SATISFIED and the ONLY thing left
    // refusing this update is the legacy CHECK. Without that setup the trigger would
    // refuse first and this pin would be vacuous: it would stay green with the constraint
    // deleted, which is precisely the shape this plan was rejected for four times.
    const u = (
      await scratch.query(`insert into approval.users (email) values ($1) returning id`, [
        `legacy-probe-${Math.random().toString(36).slice(2)}@example.com`,
      ])
    ).rows[0].id as string;
    const c = await scratch.connect();
    try {
      await c.query("begin");
      await c.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
         values ($1, 'approved', $2, 'v0')`,
        [legacyId, u],
      );
      await expect(
        c.query(`update approval.proposals set state = 'approved' where id = $1`, [legacyId]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await c.query("rollback").catch(() => {});
      c.release();
    }
  });
});
