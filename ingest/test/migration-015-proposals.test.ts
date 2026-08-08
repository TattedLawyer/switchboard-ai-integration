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

async function insertProposal(
  state: string,
  extra: { payload_hash?: string } = {},
): Promise<void> {
  await pool.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, state,
        payload_hash, expires_at)
     values ($1, $2, 'send_email', '{}'::jsonb, 'probe', $3, $4, now() + interval '72 hours')`,
    [
      TENANT,
      `t2-${state}-${Math.random().toString(36).slice(2)}`,
      state,
      extra.payload_hash ?? "0".repeat(64),
    ],
  );
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

  it("accepts all EIGHT states and rejects a ninth", async () => {
    // mutation: delete the widened CHECK from 015 -> the eight-state loop reds.
    //           RUN ✅ 2026-08-08
    // mutation: delete `drop constraint proposals_state_check` from 015 -> because 015
    //           reuses the NAME, this is a loud duplicate-constraint error and the whole
    //           suite fails. RUN ✅ 2026-08-08.
    //           And the plan's own M1 mechanism, run separately to confirm it is real:
    //           delete the drop AND rename the new constraint -> the two CHECKs are
    //           CONJOINED, five of the eight states become unusable, and the loop reds on
    //           `expired` with 23514 naming `proposals_state_check`. RUN ✅ 2026-08-08.
    //           Reusing the name is therefore strictly the safer of the two spellings.
    for (const state of EIGHT_STATES) {
      await expect(insertProposal(state), `state '${state}' was refused`).resolves.not.toThrow();
    }
    await expect(insertProposal("dismissed")).rejects.toMatchObject({ code: "23514" });
    await expect(insertProposal("held")).rejects.toMatchObject({ code: "23514" });
  });

  it("forbids approving a legacy row — we cannot attest a payload we never hashed", async () => {
    // mutation: delete the `proposals_legacy_never_approved` constraint from 015 -> red.
    //           RUN ✅ 2026-08-08
    await expect(
      insertProposal("approved", { payload_hash: "legacy:unhashable" }),
    ).rejects.toMatchObject({ code: "23514" });
    // ...and it may still sit pending, be rejected, or age out. The constraint forbids one
    // outcome, not the row's existence — a legacy row must remain disposable.
    await expect(
      insertProposal("pending", { payload_hash: "legacy:unhashable" }),
    ).resolves.not.toThrow();
    await expect(
      insertProposal("expired", { payload_hash: "legacy:unhashable" }),
    ).resolves.not.toThrow();
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

  it("and that backfilled row can never be approved", async () => {
    await expect(
      scratch.query(`update approval.proposals set state = 'approved' where id = $1`, [legacyId]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
