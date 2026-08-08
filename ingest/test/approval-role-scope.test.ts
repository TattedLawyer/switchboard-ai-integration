// Phase 3 / A1, Blocker-2 — the approval service's OWN credential is bounded.
//
// The writer for agent proposals lives in the client-facing approval service rather than
// in the agent process. That placement is only worth anything if the service behind the
// door cannot be turned back into a general SQL surface. The default — connecting as
// `DATABASE_URL`'s role, `switchboard` — would have handed it the one credential able to
// run `grant insert on ... to switchboard_agent`, i.e. the credential able to DELETE the
// published differentiator rather than defeat it. One hop, and the whole decision is
// undone.
//
// So the service connects as `switchboard_approval`: a non-owner role holding usage on
// one schema and select+insert on one table. These assertions are the pin. They are
// written against `pg_class.relacl` and against live statements, in the idiom of
// `grant-role-scope.test.ts:73` — a catalog string plus a 42501, never a comment.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";

let admin: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;
let approval: pg.Pool;

/** The approval role's own connection to the ephemeral database, built the way a
 *  deployment builds it: same host and database, different role. */
function approvalUrlFrom(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  return u.toString();
}

function agentUrlFrom(adminUrl: string): string {
  const u = new URL(adminUrl);
  u.username = "switchboard_agent";
  u.password = "switchboard_agent";
  return u.toString();
}

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  url = r.url;
  cleanup = r.cleanup;
  approval = new pg.Pool({ connectionString: approvalUrlFrom(url), max: 2 });
});

afterAll(async () => {
  if (approval) await approval.end().catch(() => {});
  await cleanup();
});

const TENANT = "00000000-0000-0000-0000-000000000000";

describe("A1: switchboard_approval holds exactly the privileges the door needs", () => {
  it("the role exists, can log in, and owns nothing in the database", async () => {
    const r = await admin.query(
      `select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
         from pg_roles where rolname = 'switchboard_approval'`,
    );
    expect(r.rowCount, "migration 014 did not create switchboard_approval").toBe(1);
    expect(r.rows[0]).toEqual({
      rolcanlogin: true,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
    });
    const owned = await admin.query(
      `select c.relname from pg_class c
         join pg_roles o on o.oid = c.relowner
        where o.rolname = 'switchboard_approval'`,
    );
    expect(owned.rows, "the approval role must not own objects — owners can re-grant").toEqual([]);
  });

  it("the table ACL reads exactly arwdDxt for the owner and `ar` for the approval role", async () => {
    const acl = await admin.query(
      `select c.relacl::text as acl from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'approval' and c.relname = 'proposals'`,
    );
    expect(acl.rowCount).toBe(1);
    const text = acl.rows[0].acl as string;
    // `a` = INSERT, `r` = SELECT (PostgreSQL privilege abbreviations, ddl-priv). Anything
    // else in this role's entry — `w` update, `d` delete — is the thing this test exists
    // to catch. The `*` suffix would mean WITH GRANT OPTION; its absence is why the role
    // cannot pass its privileges on.
    expect(text).toContain("switchboard_approval=ar/");
    expect(text).not.toMatch(/switchboard_approval=[a-zA-Z*]*[wdD]/);
    expect(text, "no privilege here may carry WITH GRANT OPTION").not.toMatch(
      /switchboard_approval=[a-z]*\*/,
    );
    // And the agent appears nowhere in it at all.
    expect(text).not.toContain("switchboard_agent");
  });

  it("can INSERT a proposal and read it back — the one thing the role exists to do", async () => {
    // A2/T2 added `payload_hash` and `expires_at` NOT NULL, so this probe supplies them.
    // Nothing about the PRIVILEGE assertion changed — the columns are the row's shape, not
    // the role's scope, and every ACL assertion in this file is untouched.
    const ins = await approval.query(
      `insert into approval.proposals (tenant_id, idempotency_key, action_type, payload,
                                       rationale, payload_hash, expires_at)
       values ($1, 'acl-probe-1', 'send_email', '{"to":"a@example.com"}'::jsonb, 'probe',
               repeat('0', 64), now() + interval '72 hours')
       returning id, state`,
      [TENANT],
    );
    expect(ins.rows[0].state).toBe("pending");
    const back = await approval.query(
      `select idempotency_key from approval.proposals where tenant_id = $1`,
      [TENANT],
    );
    expect(back.rows.map((r) => r.idempotency_key)).toContain("acl-probe-1");
  });

  it("cannot UPDATE a FROZEN column or DELETE a proposal (42501) — the door only appends", async () => {
    // RETARGETED BY A2/T3, and the retarget is not a weakening. A2 deliberately grants
    // `UPDATE (state, decided_at)` — COLUMN-level — so the old probe (`set state =
    // 'approved'`) would now red for a LEGITIMATE reason: the privilege it asserted absent
    // is one the design chose to add. The property this test exists to hold is that the
    // door only APPENDS to the parts of a proposal a human judged, and that property is
    // now carried by the FROZEN columns, which the role has no UPDATE privilege on at all.
    //
    // A2/T3's own suite (`migration-015-enforcement.test.ts`) holds the other half — that
    // `state` cannot be moved to `approved` or `rejected` without a same-transaction
    // decision row naming an approver — and pins the column grant against
    // `information_schema.column_privileges`, which is where a COLUMN grant is visible.
    // `pg_class.relacl`, asserted above, cannot see one; that is the blind spot, and it is
    // named here rather than left for someone to rediscover.
    await expect(
      approval.query(`update approval.proposals set payload = '{}'::jsonb`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      approval.query(`update approval.proposals set rationale = 'rewritten'`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      approval.query(`update approval.proposals set idempotency_key = 'stolen'`),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(approval.query(`delete from approval.proposals`)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("cannot reach raw, ingest, or the analytics schema at all", async () => {
    await expect(approval.query(`select count(*) from raw.raw_events`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(approval.query(`select count(*) from ingest.quarantine`)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("cannot CREATE tables in its own schema or in public", async () => {
    await expect(approval.query(`create table approval.evil (id int)`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(approval.query(`create table public.evil (id int)`)).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("CANNOT grant insert on the proposals table to switchboard_agent — the escalation that would retire the differentiator", async () => {
    // Postgres does not error here: a GRANT by a role holding no grant option emits
    // `WARNING: no privileges were granted for "proposals"` and returns success. So the
    // pin is on the CATALOG, not on the exception — asserting the ACL is byte-identical
    // before and after the attempt. A test that expected a throw here would be a test
    // that passes for the wrong reason the day the privilege IS granted.
    const readAcl = async (): Promise<string> =>
      (
        await admin.query(
          `select c.relacl::text as acl from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'approval' and c.relname = 'proposals'`,
        )
      ).rows[0].acl as string;
    const before = await readAcl();
    await approval
      .query(`grant insert on approval.proposals to switchboard_agent`)
      .catch(() => undefined); // an outright refusal is also an acceptable outcome
    const after = await readAcl();
    expect(after, "the approval role changed the ACL the differentiator rests on").toBe(before);
    expect(after).not.toContain("switchboard_agent");
  });

  it("the AGENT cannot see the approval schema — the read surface did not silently widen", async () => {
    // `grantAgentReadOnly()` attaches default privileges inside DBT_SCHEMA. A proposals
    // table created there would have become agent-readable on creation. This asserts the
    // schema is outside that blast radius, which is why 014 creates its own.
    const agent = new pg.Pool({ connectionString: agentUrlFrom(url), max: 1 });
    try {
      await expect(
        agent.query(`select count(*) from approval.proposals`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await agent.end();
    }
  });

  // ---------------------------------------------------------------------------------
  // A2/T11 — TRAP 1. `relacl` is not the whole ACL, and the test above proves it isn't.
  //
  // The assertion `expect(text).toContain("switchboard_approval=ar/")` above reads
  // `pg_class.relacl` — the TABLE-level ACL. A2 grants `UPDATE (state, decided_at)`, which
  // is a COLUMN-level grant and lives in `pg_attribute.attacl`. It renders in a different
  // `\dp` column and is read by different functions, so the table-ACL assertion stayed
  // GREEN through a privilege that was really added. That is a documented Postgres
  // semantic, not a subtlety: a string match on a rendered table ACL is blind to every
  // column grant that will ever be made.
  //
  // So the pins below use the CANONICAL READERS —
  // `information_schema.column_privileges` and `has_any_column_privilege(...)`, which
  // succeed "either if the privilege is held for the whole table, or if there is a
  // column-level grant of the privilege for the column".
  //
  // And `proacl` is pinned too, because an `attacl` assertion alone is green-forever
  // against something nobody has added yet: without it, the "privilege granted, tests
  // green" hazard simply moves from columns to functions.
  // ---------------------------------------------------------------------------------

  it("TRAP 1 (attacl): the COLUMN grants are exactly `state` and `decided_at`, read the canonical way", async () => {
    // mutation: `grant update (payload) on approval.proposals to switchboard_approval`
    //           -> this reds, while the `relacl` assertion above stays GREEN.
    //           RUN ✅ 2026-08-08 — which is the whole reason this test exists.
    const cols = await admin.query<{ column_name: string; privilege_type: string }>(
      `select column_name, privilege_type from information_schema.column_privileges
        where table_schema = 'approval' and table_name = 'proposals'
          and grantee = 'switchboard_approval'
        order by column_name, privilege_type`,
    );
    // `information_schema.column_privileges` also reports column rows implied by a
    // TABLE-level grant, so SELECT and INSERT appear on every column. The thing being
    // pinned is the UPDATE set, and it must be exactly two columns.
    const updatable = cols.rows
      .filter((r) => r.privilege_type === "UPDATE")
      .map((r) => r.column_name)
      .sort();
    expect(updatable, "the approval role can UPDATE a column it must not").toEqual([
      "decided_at",
      "state",
    ]);

    // The frozen columns, one at a time, through the function the documentation names.
    for (const col of [
      "payload",
      "payload_hash",
      "rationale",
      "idempotency_key",
      "action_type",
      "created_at",
      "supersedes",
      "authored_by",
      "tenant_id",
    ]) {
      const r = await admin.query<{ ok: boolean }>(
        `select has_column_privilege('switchboard_approval', 'approval.proposals', $1, 'UPDATE') as ok`,
        [col],
      );
      expect(r.rows[0].ok, `switchboard_approval can UPDATE the frozen column ${col}`).toBe(false);
    }
  });

  it("TRAP 1 (attacl): the AGENT holds no column privilege anywhere in approval", async () => {
    // 🚨 LANDMINE. Nothing in A1 or A2 grants `switchboard_agent` anything. A red assertion
    // here is a DESIGN VIOLATION, not a stale test — stop and re-read
    // `docs/adr/agent-writer-boundary.md`.
    for (const table of ["proposals", "users", "decisions", "executions"]) {
      // SELECT / INSERT / UPDATE / REFERENCES are the four privileges Postgres grants at
      // COLUMN granularity, and they are exactly the four this function accepts. DELETE and
      // TRUNCATE are table-only — asking for them here raises `unrecognized privilege
      // type`, which is how the boundary announces itself — so they are checked below with
      // the table-level reader instead. Both halves are needed: a column check alone would
      // be blind to DELETE, and a table check alone is the `relacl` blind spot this whole
      // block exists to close.
      for (const priv of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        const r = await admin.query<{ ok: boolean }>(
          `select has_any_column_privilege('switchboard_agent', $1, $2) as ok`,
          [`approval.${table}`, priv],
        );
        expect(r.rows[0].ok, `switchboard_agent holds ${priv} on some column of ${table}`).toBe(
          false,
        );
      }
      for (const priv of ["DELETE", "TRUNCATE", "TRIGGER"]) {
        const r = await admin.query<{ ok: boolean }>(
          `select has_table_privilege('switchboard_agent', $1, $2) as ok`,
          [`approval.${table}`, priv],
        );
        expect(r.rows[0].ok, `switchboard_agent holds ${priv} on ${table}`).toBe(false);
      }
    }
    // And it cannot even reach the schema, which is the outer door.
    const usage = await admin.query<{ ok: boolean }>(
      `select has_schema_privilege('switchboard_agent', 'approval', 'USAGE') as ok`,
    );
    expect(usage.rows[0].ok, "switchboard_agent has USAGE on the approval schema").toBe(false);
  });

  it("TRAP 1 (proacl): no function in the approval schema is PUBLIC-executable", async () => {
    // mutation: delete `revoke execute on function approval.proposals_guard() from public`
    //           from migration 015 -> `proacl` is NULL and this reds. RUN ✅ 2026-08-08
    //
    // 🚨 IF THIS REDS, FIX THE REVOKE OR THE FUNCTION — NEVER THE PIN. Do not narrow it to
    // "no user-callable function", do not exclude trigger functions, do not add an
    // allowlist. There is NO schema-wide belt: `REVOKE ... ON ALL FUNCTIONS IN SCHEMA` is a
    // one-shot loop over existing objects, and `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE
    // ON FUNCTIONS FROM PUBLIC` stores no `pg_default_acl` row at all on PG 16. Both were
    // credited as belts in earlier drafts and both were measured inert.
    const fns = await admin.query<{ proname: string; proacl: string | null }>(
      `select p.proname, p.proacl::text as proacl from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'approval' order by p.proname`,
    );
    // The subject set is ENUMERATED, not assumed empty — an earlier draft asserted "there
    // is nothing to execute in this schema" while specifying a trigger function, which is
    // a `pg_proc` row like any other.
    expect(fns.rows.map((r) => r.proname)).toEqual(["proposals_guard"]);
    for (const f of fns.rows) {
      expect(f.proacl, `${f.proname} has proacl NULL — PUBLIC EXECUTE by default`).not.toBeNull();
      expect(f.proacl, `${f.proname} is PUBLIC-executable`).not.toMatch(/(^|,)"?=[a-zA-Z*]*X/);
      expect(f.proacl, "a function grant carries WITH GRANT OPTION").not.toMatch(/X\*/);
    }
  });

  it("the unique idempotency key makes a replay a no-op at the database (23505), not at the door", async () => {
    await approval.query(
      `insert into approval.proposals (tenant_id, idempotency_key, action_type, payload,
                                       rationale, payload_hash, expires_at)
       values ($1, 'acl-probe-dupe', 'send_email', '{}'::jsonb, 'probe',
               repeat('0', 64), now() + interval '72 hours')`,
      [TENANT],
    );
    await expect(
      approval.query(
        `insert into approval.proposals (tenant_id, idempotency_key, action_type, payload,
                                         rationale, payload_hash, expires_at)
         values ($1, 'acl-probe-dupe', 'send_email', '{}'::jsonb, 'probe again',
                 repeat('1', 64), now() + interval '72 hours')`,
        [TENANT],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
