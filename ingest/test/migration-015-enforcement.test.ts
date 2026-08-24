// Phase 3 / A2, T3 — migration 015 part 2: the tables, the grants, and the invariant that
// has no bypass path.
//
// THE ONE SENTENCE THIS FILE DEFENDS: no proposal can reach `approved` or `rejected`
// without an `approval.decisions` row of the matching kind, naming an approver, written in
// the SAME transaction. Everything below is either that sentence or the privilege
// arrangement that makes it unbypassable.
//
// WHY THE PAYLOAD-IMMUTABILITY PIN IS SPLIT IN TWO, WHICH IS THE SUBTLEST THING HERE.
// Rev 3 of the plan had ONE pin — `update ... set payload` throws — and it stayed green
// with the trigger dropped, because the column grant refused the statement first. Rev 4
// split it so each half reds for a different removal. Rev 7 then measured that the split
// alone is not enough: widening the column grant to TABLE-level does not stop the
// statement throwing, because the TRIGGER absorbs it and the error becomes
// `P0001 frozen column is immutable`. A bare `rejects.toThrow()` therefore survives the
// exact mutation the privilege half exists to catch. So:
//
//   (i)  as the OWNER (table-level UPDATE) -> the TRIGGER raises, SQLSTATE P0001
//   (ii) as the APP ROLE (column grants)   -> PRIVILEGE refuses, SQLSTATE 42501
//
// and both assert the SQLSTATE, never merely "it threw". Both mutations are run below and
// recorded beside the assertions.
//
// WHY `proacl` IS PINNED AT ALL, AND WHY IT MUST NEVER BE RELAXED TO GREEN. Two revisions
// of the plan credited a "belt" that covers future functions. Both were measured inert:
// `REVOKE ... ON ALL FUNCTIONS IN SCHEMA` is a one-shot loop over EXISTING objects, and
// `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` stores no
// `pg_default_acl` row at all on PG 16 — a later function keeps `proacl` NULL and an
// unprivileged role executes it fine. There is NO belt. The explicit
// `revoke execute on function approval.proposals_guard() from public`, issued immediately
// after the `create function`, IS the entire control, and this pin is the only thing
// watching it. If it reds, the privilege is real and the mechanism is wrong: fix the
// revoke. Do NOT narrow the pin to "no user-callable function", do not exclude trigger
// functions, do not add an allowlist.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshTestDb } from "./helpers/testdb.js";
import { cliEnv } from "./helpers/child-env.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli/approval-user-add.ts", import.meta.url));
const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));

const TENANT = "00000000-0000-0000-0000-000000000000";

let admin: pg.Pool; // the migration OWNER — holds table-level UPDATE
let approval: pg.Pool; // `switchboard_approval` — the shipped runtime role
let url: string;
let cleanup: () => Promise<void>;

function roleUrl(adminUrl: string, role: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = role;
  return u.toString();
}

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  url = r.url;
  cleanup = r.cleanup;
  approval = new pg.Pool({ connectionString: roleUrl(url, "switchboard_approval"), max: 4 });
  approval.on("error", () => {});
}, 60_000);

afterAll(async () => {
  if (approval) await approval.end().catch(() => {});
  if (cleanup) await cleanup();
});

/** A pending proposal, inserted as the owner. */
async function seedProposal(): Promise<string> {
  const r = await admin.query(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, 'send_email', '{"to":"a@example.com"}'::jsonb, 'probe',
             repeat('a', 64), now() + interval '72 hours')
     returning id`,
    [TENANT, `t3-${Math.random().toString(36).slice(2)}`],
  );
  return r.rows[0].id as string;
}

describe("A2/T3: the three new tables carry the shape the plan specifies", () => {
  it("approval.users is the STRICT SUBSET — id, email, created_at, disabled_at, nothing else", async () => {
    // Nothing else, deliberately: no role column, no password, no tenant column, so A0b's
    // work is purely ADDITIVE. `approver-identity.md:140-144` makes a role or permissions
    // column a STOP-and-report, and the cheapest way to honour that is to pin the column
    // list rather than to remember.
    const cols = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'approval' and table_name = 'users' order by column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "created_at",
      "disabled_at",
      "email",
      "id",
    ]);
  });

  it("the email index is UNIQUE on lower(email) — and is storage hygiene only", async () => {
    // `citext` is rejected because no migration issues `create extension` (V21).
    // 🚨 THIS INDEX MUST NEVER BECOME A COMPARISON PREDICATE. `lower()` is NOT
    // identity-preserving for mailboxes — U+212A KELVIN SIGN lower-cases to `k`, U+0130
    // collides with `i` — and RFC 5321 §2.3.11 makes the local part case-sensitive and the
    // mailbox owner's business. A2 performs no email comparison anywhere; resolving an
    // address to a user is A0b's concern, and A0b inherits this warning.
    const defs = await admin.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'approval' and tablename = 'users'`,
    );
    const joined = defs.rows.map((r) => r.indexdef).join("\n");
    expect(joined).toMatch(/CREATE UNIQUE INDEX .* ON approval\.users USING btree \(lower\(email\)\)/);
    // The hazard, demonstrated rather than described — so nobody promotes the index into a
    // security predicate later on the strength of "it is unique, so it must be identity".
    await admin.query(`insert into approval.users (email) values ('K@example.com')`);
    await expect(
      admin.query(`insert into approval.users (email) values ('K@example.com')`),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("approval.decisions carries all eight columns, with xact_id typed xid8", async () => {
    const cols = await admin.query<{ column_name: string; data_type: string; udt_name: string }>(
      `select column_name, data_type, udt_name from information_schema.columns
        where table_schema = 'approval' and table_name = 'decisions' order by column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "approver_user_id",
      "decided_at",
      "id",
      "kind",
      "proposal_id",
      "reason",
      "renderer_version",
      "xact_id",
    ]);
    // xid8, NOT xid and NOT bigint. `xmin` is a 32-bit `xid` and wraps; `txid_current()`
    // is a `bigint`. Comparing `xmin` against `txid_current()` is correct only within one
    // epoch and SILENTLY WRONG after wraparound — a failure that appears only on a
    // long-lived database and looks like nothing. This column and the trigger both use
    // `pg_current_xact_id()`, which is epoch-safe on both sides.
    expect(cols.rows.find((r) => r.column_name === "xact_id")?.udt_name).toBe("xid8");
  });

  it("has an index supporting the trigger's per-decision lookup", async () => {
    // The trigger runs `where proposal_id = ... and kind = ...` on EVERY approve and EVERY
    // reject. Postgres creates no index for a foreign key, so without this the lookup is a
    // sequential scan over an append-only table that only grows — `dismissed` rows
    // accumulate by design. Nothing breaks and no pin reds; the cost is invisible until it
    // is a migration on a live table rather than a line in 015. (rev-8 review, Minor M-1.)
    const defs = await admin.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'approval' and tablename = 'decisions'`,
    );
    const joined = defs.rows.map((r) => r.indexdef).join("\n");
    expect(joined).toMatch(/USING btree \(proposal_id, kind\)/);
  });

  it("a rejection without a reason is refused by the database, not by the form", async () => {
    const u = (await admin.query(`insert into approval.users (email) values ($1) returning id`, [
      `reason-probe-${Math.random().toString(36).slice(2)}@example.com`,
    ])).rows[0].id as string;
    const p = await seedProposal();
    await expect(
      admin.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
         values ($1, 'rejected', $2, 'v0')`,
        [p, u],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Whitespace is not a reason.
    await expect(
      admin.query(
        `insert into approval.decisions (proposal_id, kind, approver_user_id, reason, renderer_version)
         values ($1, 'rejected', $2, '   ', 'v0')`,
        [p, u],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a human-authored proposal must name its author, and an agent-authored one must not", async () => {
    // CHECK-enforced BOTH ways. Without the FK this is an unattributed-actor column of
    // exactly the kind `approver-identity.md:149-150` forbids for approvers, and "the
    // agent proposed X" stops being substantiable.
    // Both directions are exercised at INSERT, not at UPDATE: `authored_by` is a FROZEN
    // column, so an UPDATE is refused by the TRIGGER (P0001) before the CHECK is ever
    // consulted — which is itself worth knowing, and is why the biconditional has to be
    // probed on the insert path.
    await expect(
      admin.query(
        `insert into approval.proposals
           (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
            expires_at, authored_by)
         values ($1, $2, 'send_email', '{}'::jsonb, 'amended by hand', repeat('b', 64),
                 now() + interval '72 hours', 'human')`,
        [TENANT, `t3-noauthor-${Math.random().toString(36).slice(2)}`],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const u = (await admin.query(`insert into approval.users (email) values ($1) returning id`, [
      `author-probe-${Math.random().toString(36).slice(2)}@example.com`,
    ])).rows[0].id as string;
    await expect(
      admin.query(
        `insert into approval.proposals
           (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
            expires_at, authored_by, authored_by_user_id)
         values ($1, $2, 'send_email', '{}'::jsonb, 'amended by hand', repeat('b', 64),
                 now() + interval '72 hours', 'agent', $3)`,
        [TENANT, `t3-badauthor-${Math.random().toString(36).slice(2)}`, u],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("A2/T3: payload immutability has TWO independent guards, and each reds alone", () => {
  it("(i) as the OWNER — table-level UPDATE — the TRIGGER raises P0001", async () => {
    // mutation: `drop trigger proposals_guard on approval.proposals` -> this reds (the
    //           owner's UPDATE succeeds). RUN ✅ 2026-08-08
    const p = await seedProposal();
    await expect(
      admin.query(`update approval.proposals set payload = '{"to":"evil@example.com"}'::jsonb
                    where id = $1`, [p]),
    ).rejects.toMatchObject({ code: "P0001" });
    // ALL EIGHT frozen columns, not just payload. The list is exhaustive on purpose: a
    // column that is frozen in 015 and unattempted here is a column that can be quietly
    // unfrozen with no pin going red, which is the precise shape this project has been
    // bitten by five times.
    for (const [col, val] of [
      ["payload_hash", `repeat('c', 64)`],
      ["rationale", `'rewritten'`],
      ["idempotency_key", `'stolen-key'`],
      ["action_type", `'send_email_but_worse'`],
      ["created_at", `now()`],
      ["authored_by", `'human'`],
    ] as const) {
      await expect(
        admin.query(`update approval.proposals set ${col} = ${val} where id = $1`, [p]),
        `${col} was not frozen`,
      ).rejects.toMatchObject({ code: "P0001" });
    }
  });

  it("(i-b) `supersedes` is frozen too — the eighth column, and the one nothing else covered", async () => {
    // mutation: remove `supersedes` from the frozen-column list at 015's trigger
    //           -> this reds (the UPDATE succeeds). RUN ✅ 2026-08-08
    //
    // 🚨 WHY THIS PIN EXISTS, because the reason is the whole point. Migration 015's own
    // comment used to say that render-time duplicate collapse DISPOSES of losing rows by
    // writing `supersedes` — which is impossible, since the column is frozen and the
    // trigger raises. A future engineer (or A3, reading 015 for the audit story) who meets
    // that documented-but-raising mechanism has an obvious and WRONG conclusion available:
    // that the freeze list is over-broad, and that `supersedes` should come out of it.
    // Doing so would delete one of the eight columns the immutability guarantee is made
    // of — and until this test existed, NO PIN WOULD HAVE RED, because the enforcement
    // tests attempted `payload` and never this column. The stale comment is corrected in
    // 015; this is the other half, because a comment is not a control.
    //
    // The value is a REAL proposal id, so that under the mutation the statement genuinely
    // SUCCEEDS rather than failing on the foreign key — a pin that reds for the wrong
    // reason is not a pin.
    const p = await seedProposal();
    const other = await seedProposal();
    await expect(
      admin.query(`update approval.proposals set supersedes = $2 where id = $1`, [p, other]),
      "supersedes is not frozen — the immutability guarantee is one column short",
    ).rejects.toMatchObject({ code: "P0001" });
    // ...and combined with the state change collapse actually makes, which is the exact
    // statement the stale comment invited someone to write.
    await expect(
      admin.query(
        `update approval.proposals set state = 'superseded', supersedes = $2 where id = $1`,
        [p, other],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    // The link is establishable at INSERT and only at INSERT — the witness, so the pin
    // above is not passing for a column nothing can ever set.
    const ins = await admin.query(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
          expires_at, supersedes)
       values ($1, $2, 'send_email', '{}'::jsonb, 'an amendment', repeat('e', 64),
               now() + interval '72 hours', $3)
       returning supersedes`,
      [TENANT, `t3-amend-${Math.random().toString(36).slice(2)}`, p],
    );
    expect(ins.rows[0].supersedes).toBe(p);
  });

  it("(ii) as the APP ROLE — column grants — PRIVILEGE refuses with 42501", async () => {
    // mutation: `grant update on approval.proposals to switchboard_approval` (table-level)
    //           -> the SQLSTATE becomes P0001, because the TRIGGER absorbs the statement.
    //           This pin reds. A bare `rejects.toThrow()` would stay GREEN through exactly
    //           this mutation, which is why the SQLSTATE is asserted. RUN ✅ 2026-08-08
    const p = await seedProposal();
    await expect(
      approval.query(`update approval.proposals set payload = '{}'::jsonb where id = $1`, [p]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      approval.query(`update approval.proposals set rationale = 'x' where id = $1`, [p]),
    ).rejects.toMatchObject({ code: "42501" });
    // `supersedes` too: no column grant exists for it, so the app role never even reaches
    // the trigger. Both guards cover it, and each is asserted against its own SQLSTATE.
    await expect(
      approval.query(`update approval.proposals set supersedes = $1 where id = $1`, [p]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("but the app role CAN update the two columns the workflow needs", async () => {
    // "Any nontrivial UPDATE will require SELECT privilege as well" — so the grant is
    // larger than `UPDATE (state)` alone, and the migration header says so.
    const p = await seedProposal();
    const r = await approval.query(
      `update approval.proposals set decided_at = now() where id = $1`,
      [p],
    );
    expect(r.rowCount).toBe(1);
  });
});

describe("A2/C-1: a proposal is BORN UNDECIDED — the creation edge", () => {
  // 🚨 THE GAP SEVEN REVIEWS MISSED, AND WHY. Every prior review inherited the frame "the
  // trigger protects state transitions" and checked UPDATE paths exhaustively. Nobody asked
  // about INSERT. The guard was `BEFORE UPDATE` only and 014 grants TABLE-LEVEL insert, so
  // `state` was caller-writable at creation and a forged `approved` row walked the whole
  // machine to `executed` with zero rows in `approval.decisions`. The lesson generalises
  // past this instance: an invariant enforced on transitions is not enforced on CREATION,
  // and the two need separate pins.
  //
  // These tests therefore attack the CREATION edge across every statement type that can
  // write a row, because "INSERT is guarded" is a claim about a family of statements and
  // not about one keyword.

  const NON_PENDING = [
    "approved",
    "rejected",
    "expired",
    "superseded",
    "executing",
    "executed",
    "execution_failed",
  ] as const;

  async function rawInsert(
    db: pg.Pool,
    cols: string,
    vals: string,
    key = `c1-${Math.random().toString(36).slice(2)}`,
  ): Promise<pg.QueryResult> {
    return db.query(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
          expires_at${cols})
       values ($1, $2, 'send_email', '{}'::jsonb, 'creation probe', repeat('a', 64),
               now() + interval '72 hours'${vals})`,
      [TENANT, key],
    );
  }

  it("refuses an INSERT naming ANY non-pending state, as the app role", async () => {
    // mutation: neutralise the state assertion inside the INSERT branch
    //           (`if new.state <> 'pending'` -> `if false`)
    //           -> 5 red, including this one and the COPY and MERGE paths. RUN ✅ 2026-08-08
    //
    // Recorded because the OBVIOUS mutation is the misleading one: deleting the whole
    // `TG_OP = 'INSERT'` branch also reds the suite, but for a MIXED reason — with the
    // branch gone every INSERT falls into the frozen-column comparison against a NULL
    // `old`, so this pin stays green for the wrong reason while the WITNESS below reds.
    // The isolated mutation above is the one that shows this assertion is doing the work.
    for (const state of NON_PENDING) {
      await expect(
        rawInsert(approval, ", state", `, '${state}'`),
        `a proposal was CREATED already in state '${state}'`,
      ).rejects.toMatchObject({ code: "P0001" });
    }
  });

  it("refuses an INSERT that pre-sets decided_at — a decision nobody made", async () => {
    // mutation: `if new.decided_at is not null` -> `if false` in 015 -> 1 red, only this.
    //           RUN ✅ 2026-08-08
    await expect(rawInsert(approval, ", decided_at", ", now()")).rejects.toMatchObject({
      code: "P0001",
    });
  });

  it("...and the OWNER cannot do it either — this is not a privilege check", async () => {
    // The distinction that makes this a trigger rather than a grant: it covers every
    // caller, including the migration owner and every role that does not exist yet.
    await expect(rawInsert(admin, ", state", ", 'approved'")).rejects.toMatchObject({
      code: "P0001",
    });
  });

  it("STILL ACCEPTS a legitimate INSERT — the witness, so the guard is not just a wall", async () => {
    const r = await approval.query(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
       values ($1, $2, 'send_email', '{}'::jsonb, 'legitimate', repeat('a', 64),
               now() + interval '72 hours')
       returning state`,
      [TENANT, `c1-ok-${Math.random().toString(36).slice(2)}`],
    );
    expect(r.rows[0].state).toBe("pending");
  });

  it("covers INSERT ... RETURNING, ON CONFLICT DO UPDATE, and MERGE — both legs", async () => {
    // A row trigger fires per row regardless of the statement that produced it, but
    // "regardless" is a claim, so each statement family is executed rather than assumed.
    const key = `c1-multi-${Math.random().toString(36).slice(2)}`;
    await expect(
      approval.query(
        `insert into approval.proposals
           (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
            expires_at, state)
         values ($1, $2, 'send_email', '{}'::jsonb, 'r', repeat('a', 64),
                 now() + interval '72 hours', 'approved')
         returning id`,
        [TENANT, key],
      ),
      "INSERT ... RETURNING",
    ).rejects.toMatchObject({ code: "P0001" });

    // A real pending row, then the upsert's UPDATE leg — caught by the transition half.
    await rawInsert(approval, "", "", key);
    await expect(
      approval.query(
        `insert into approval.proposals
           (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
         values ($1, $2, 'send_email', '{}'::jsonb, 'r', repeat('a', 64),
                 now() + interval '72 hours')
         on conflict (tenant_id, idempotency_key) do update set state = 'approved'`,
        [TENANT, key],
      ),
      "INSERT ... ON CONFLICT DO UPDATE",
    ).rejects.toMatchObject({ code: "P0001" });

    await expect(
      approval.query(
        `merge into approval.proposals t
         using (select $1::uuid tid, $2::text k) s on t.idempotency_key = s.k
         when not matched then insert
           (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
            expires_at, state)
         values (s.tid, s.k, 'send_email', '{}'::jsonb, 'r', repeat('a', 64),
                 now() + interval '72 hours', 'approved')`,
        [TENANT, `c1-merge-${Math.random().toString(36).slice(2)}`],
      ),
      "MERGE ... WHEN NOT MATCHED THEN INSERT",
    ).rejects.toMatchObject({ code: "P0001" });

    await expect(
      approval.query(
        `merge into approval.proposals t using (select $1::text k) s
           on t.idempotency_key = s.k
         when matched then update set state = 'approved'`,
        [key],
      ),
      "MERGE ... WHEN MATCHED THEN UPDATE",
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("covers COPY FROM STDIN — which bypasses RULES but not triggers", async () => {
    // PostgreSQL's COPY page: "COPY FROM will invoke any triggers and check constraints on
    // the destination table. However, it will not invoke rules." And: "It is sufficient to
    // have column privileges on the column(s) listed" — no superuser is needed for
    // `FROM STDIN`, so this is a path the app role really can take. Driven through psql
    // because node-postgres does not speak the COPY protocol.
    const file = join(tmpdir(), `c1-copy-${Math.random().toString(36).slice(2)}.tsv`);
    writeFileSync(
      file,
      `${TENANT}\tc1-copy-${Math.random().toString(36).slice(2)}\tsend_email\t{}\tr\t${"a".repeat(64)}\t2027-01-01\tapproved\n`,
    );
    try {
      const u = new URL(roleUrl(url, "switchboard_approval"));
      const res = await execFileAsync(
        "psql",
        [
          u.toString(),
          "-X",
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `\\copy approval.proposals (tenant_id,idempotency_key,action_type,payload,rationale,payload_hash,expires_at,state) from '${file}'`,
        ],
        // Hermetic like every other spawn here: psql gets no ambient PG* vars from the
        // developer's shell — the connection is entirely the URL in argv (HOME stays,
        // so ~/.pgpass-style auth still works where a machine relies on it).
        { encoding: "utf8", env: cliEnv() },
      ).catch((e: { stderr?: string; stdout?: string }) => ({
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(e),
      }));
      expect(
        `${res.stdout}${res.stderr}`,
        "COPY FROM STDIN created a forged approved row",
      ).toMatch(/born undecided/);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("A2/C-1: ENABLE ALWAYS — the guards survive session_replication_role=replica", () => {
  // 🚨 THIS REPAIRS A LIVE HOLE IN THE UPDATE GUARD WE ALREADY SHIPPED, not just the new
  // INSERT one. A trigger created the ordinary way carries `tgenabled = 'O'` and is
  // COMPLETELY INERT under `session_replication_role = replica` — and since PG 15 the
  // privilege to set that parameter is ORDINARY AND GRANTABLE
  // (`GRANT SET ON PARAMETER session_replication_role`), i.e. exactly the sort of
  // plausible-looking grant someone wires up for a replication or bulk-load tool.
  //
  // Measured, as the owner, with the triggers reverted to plain ENABLE: the forged INSERT
  // AND a bare `pending -> approved` BOTH SUCCEEDED. With ENABLE ALWAYS, all three guards
  // (creation, transition, frozen columns) still raised.

  it("the app role cannot set the parameter at all — the first line, but not the control", async () => {
    await expect(approval.query(`set session_replication_role = 'replica'`)).rejects.toThrow(
      /permission denied to set parameter/i,
    );
  });

  it("...and a caller who CAN set it is STILL guarded — which is the actual control", async () => {
    // mutation: `alter table approval.proposals enable trigger proposals_guard` +
    //           `... enable trigger proposals_guard_ins` (i.e. drop ENABLE ALWAYS)
    //           -> both assertions below red: the forged insert lands and the bare
    //           pending->approved succeeds. RUN ✅ 2026-08-08
    const c = await admin.connect();
    try {
      await c.query(`set session_replication_role = 'replica'`);
      expect((await c.query(`select current_setting('session_replication_role') as m`)).rows[0].m)
        .toBe("replica");
      await expect(
        c.query(
          `insert into approval.proposals
             (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
              expires_at, state)
           values ($1, $2, 'send_email', '{}'::jsonb, 'r', repeat('a', 64),
                   now() + interval '72 hours', 'approved')`,
          [TENANT, `replica-${Math.random().toString(36).slice(2)}`],
        ),
        "a forged approved row was INSERTED under replica mode",
      ).rejects.toMatchObject({ code: "P0001" });

      const live = await seedProposal();
      await expect(
        c.query(`update approval.proposals set state = 'approved' where id = $1`, [live]),
        "a bare pending->approved SUCCEEDED under replica mode",
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await c.query(`set session_replication_role = 'origin'`).catch(() => {});
      c.release();
    }
  });

  it("pins tgenabled = 'A' on BOTH triggers — one line that reds on a careless re-create", async () => {
    const t = await admin.query<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger
        where tgrelid = 'approval.proposals'::regclass and not tgisinternal
        order by tgname`,
    );
    expect(t.rows).toEqual([
      { tgname: "proposals_guard", tgenabled: "A" },
      { tgname: "proposals_guard_ins", tgenabled: "A" },
    ]);
  });
});

describe("A2/T3: the privilege arrangement the enforcement rests on", () => {
  it("the app role does not OWN the proposals table — an owner can drop its own trigger", async () => {
    // mutation: `alter table approval.proposals owner to switchboard_approval` -> reds.
    //           RUN ✅ 2026-08-08
    const owner = await admin.query<{ rolname: string }>(
      `select o.rolname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_roles o on o.oid = c.relowner
        where n.nspname = 'approval' and c.relname = 'proposals'`,
    );
    expect(owner.rows[0].rolname).not.toBe("switchboard_approval");
    // And it cannot disable the trigger, which is what ownership would buy.
    await expect(
      approval.query(`alter table approval.proposals disable trigger proposals_guard`),
    ).rejects.toThrow(/must be owner/i);
  });

  it("the app role cannot set session_replication_role — the trigger's one global off switch", async () => {
    await expect(approval.query(`set session_replication_role = 'replica'`)).rejects.toThrow(
      /permission denied to set parameter/i,
    );
  });

  it("the trigger function is not PUBLIC-executable, and it is the ONLY function in the schema", async () => {
    // mutation: delete `revoke execute on function approval.proposals_guard() from public`
    //           from 015 -> `proacl` is NULL and this reds:
    //           "proposals_guard has proacl NULL — PUBLIC EXECUTE by default".
    //           RUN ✅ 2026-08-08
    // mutation: `grant execute on function approval.proposals_guard() to public` -> reds on
    //           the other clause: proacl = '{switchboard=X/switchboard,=X/switchboard}'.
    //           RUN ✅ 2026-08-08
    // 🚨 IF THIS REDS, FIX THE REVOKE. Never relax the pin.
    const fns = await admin.query<{ proname: string; proacl: string | null }>(
      `select p.proname, p.proacl::text as proacl from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'approval'`,
    );
    // The subject set is ENUMERATED, not assumed empty. Two revisions of the plan claimed
    // "there is nothing to execute in this schema" while specifying a trigger function,
    // which is a `pg_proc` row like any other.
    expect(fns.rows.map((r) => r.proname)).toEqual(["proposals_guard"]);
    for (const f of fns.rows) {
      expect(f.proacl, `${f.proname} has proacl NULL — PUBLIC EXECUTE by default`).not.toBeNull();
      expect(f.proacl, `${f.proname} is PUBLIC-executable`).not.toMatch(/(^|,)"?=[a-zA-Z*]*X/);
    }
    // A direct call is refused for a second, independent reason — recorded so nobody
    // mistakes THAT for the control. It is not: `revoke` is.
    await expect(approval.query(`select approval.proposals_guard()`)).rejects.toThrow(
      /trigger functions can only be called as triggers|permission denied/i,
    );
  });

  it("holds EXACTLY the M2 grant set on the four tables — no delete, no grant option", async () => {
    const grants = await admin.query<{ table_name: string; privilege_type: string; is_grantable: string }>(
      `select table_name, privilege_type, is_grantable
         from information_schema.role_table_grants
        where table_schema = 'approval' and grantee = 'switchboard_approval'
        order by table_name, privilege_type`,
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants.rows) {
      expect(g.is_grantable, `${g.table_name}.${g.privilege_type} carries WITH GRANT OPTION`).toBe(
        "NO",
      );
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type].sort());
    }
    // TABLE-level. `UPDATE` on proposals is COLUMN-level and therefore absent here — which
    // is the point, and is checked against `column_privileges` below.
    expect(byTable.get("proposals")).toEqual(["INSERT", "SELECT"]);
    expect(byTable.get("decisions")).toEqual(["INSERT", "SELECT"]);
    expect(byTable.get("executions")).toEqual(["INSERT", "SELECT"]);
    expect(byTable.get("users"), "the role that RECORDS approvals must not MINT approvers").toEqual(
      ["SELECT"],
    );

    // COLUMN-level UPDATE, read the canonical way. `pg_class.relacl` cannot see this — a
    // column grant lives in `pg_attribute.attacl`, they render in different `\dp` columns,
    // and `information_schema.column_privileges` / `has_any_column_privilege` are the
    // documented readers. Asserting on a rendered table ACL is the exact blind spot.
    const cols = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema = 'approval' and table_name = 'proposals'
          and grantee = 'switchboard_approval' and privilege_type = 'UPDATE'
        order by column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(["decided_at", "state"]);
  });

  it("the AGENT gets 42501 on every approval.* table, read and write alike", async () => {
    // 🚨 LANDMINE. Nothing in A2 grants `switchboard_agent` anything. A red assertion here
    // is a DESIGN VIOLATION, not a stale test — stop and re-read
    // `docs/adr/agent-writer-boundary.md`.
    const agent = new pg.Pool({ connectionString: roleUrl(url, "switchboard_agent"), max: 1 });
    agent.on("error", () => {});
    try {
      for (const t of ["proposals", "users", "decisions", "executions"]) {
        await expect(agent.query(`select count(*) from approval.${t}`), t).rejects.toMatchObject({
          code: "42501",
        });
        await expect(
          agent.query(`insert into approval.${t} default values`),
          t,
        ).rejects.toMatchObject({ code: "42501" });
      }
      expect(
        (
          await admin.query<{ ok: boolean }>(
            `select has_any_column_privilege('switchboard_agent', 'approval.proposals', 'UPDATE') as ok`,
          )
        ).rows[0].ok,
        "the agent holds a column-level UPDATE somewhere on approval.proposals",
      ).toBe(false);
    } finally {
      await agent.end();
    }
  });
});

describe("A2/T3: who may mint an approver", () => {
  it("the app role CANNOT insert into approval.users (42501)", async () => {
    // mutation: `grant insert on approval.users to switchboard_approval` -> reds.
    //           RUN ✅ 2026-08-08
    //
    // A compromised approval service can already forge an approval naming a REAL user —
    // the database authenticates nobody — so this is not categorical. What it buys is
    // that it cannot MINT an approver who never existed and attach an approval to them.
    // "The set of people who can approve is not writable by the thing that records
    // approvals" is a cheap separation-of-duties property.
    await expect(
      approval.query(`insert into approval.users (email) values ('forged@example.com')`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the operator CLI CAN — connecting as the migration owner, one row, named", async () => {
    // Without this the table is empty and unfillable at merge, the decisions INSERT raises
    // 23503, and the transition to `approved` — A2's entire purpose — is unreachable in
    // every real deployment. Every approval pin would still green, because the test
    // harness connects as the owner and seeds users itself. That is the shape of rev-4's
    // B2, and this test is the answer to it: the seeding path that ships.
    const email = `broker-${Math.random().toString(36).slice(2)}@example.com`;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI, "--email", email],
      { env: cliEnv({ DATABASE_URL: url }), cwd: INGEST_DIR },
    );
    expect(stdout).toContain(email);
    const r = await admin.query(`select id, disabled_at from approval.users where email = $1`, [
      email,
    ]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].disabled_at).toBeNull();
  });

  it("...and refuses anonymously, and refuses a duplicate loudly", async () => {
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", CLI], {
        env: cliEnv({ DATABASE_URL: url }),
        cwd: INGEST_DIR,
      }),
    ).rejects.toThrow(/--email/);
    const email = `dupe-${Math.random().toString(36).slice(2)}@example.com`;
    const run = (): Promise<{ stdout: string }> =>
      execFileAsync(process.execPath, ["--import", "tsx", CLI, "--email", email], {
        env: cliEnv({ DATABASE_URL: url }),
        cwd: INGEST_DIR,
      });
    await run();
    await expect(run()).rejects.toThrow(/already/i);
  });
});
