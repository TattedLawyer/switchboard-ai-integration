// A0b — migration 019: the auth schema, pinned the way 014/015's grants are pinned — a
// catalog fact plus a live 42501, never a comment.
//
// THE SHAPE UNDER TEST. `approval_auth` is a NEW schema, outside `approval`, because 015
// declares the approval schema append-only ("No DELETE anywhere") and a web session store
// requires DELETE (destroy, and the expired-session prune). The three tables:
//   · `sessions`      — connect-pg-simple's OWN expected DDL, store-verified below;
//   · `login_tokens`  — hashed magic-link tokens; UPDATE is column-scoped to `used_at`;
//   · `login_audit`   — append-only, `approval.decisions`' discipline.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";

let admin: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;
let approval: pg.Pool;
let agent: pg.Pool;

function asRole(adminUrl: string, role: string): string {
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
  approval = new pg.Pool({ connectionString: asRole(url, "switchboard_approval"), max: 2 });
  approval.on("error", () => {});
  agent = new pg.Pool({ connectionString: asRole(url, "switchboard_agent"), max: 1 });
  agent.on("error", () => {});
}, 60_000);

afterAll(async () => {
  if (approval) await approval.end().catch(() => {});
  if (agent) await agent.end().catch(() => {});
  if (cleanup) await cleanup();
});

async function seedUser(): Promise<string> {
  const r = await admin.query(
    `insert into approval.users (email) values ($1) returning id`,
    [`m019-${Math.random().toString(36).slice(2)}@example.com`],
  );
  return r.rows[0].id as string;
}

async function seedToken(userId: string): Promise<string> {
  const r = await approval.query(
    `insert into approval_auth.login_tokens (user_id, token_hash, expires_at)
     values ($1, $2, now() + interval '15 minutes') returning id`,
    [userId, `hash-${Math.random().toString(36).slice(2)}`],
  );
  return r.rows[0].id as string;
}

describe("019: the session table is the one connect-pg-simple expects", () => {
  it("has exactly the store's columns and types: sid varchar PK, sess json, expire timestamp(6)", async () => {
    // mutation: change `sess json` to `sess jsonb` in 019 -> reds on data_type.
    //           RUN ✅ 2026-08-15 — observed: 1 failed | 6 passed; diff read
    //             -     "data_type": "json",
    //             +     "data_type": "jsonb",
    //           The store ROUND-TRIP below stayed GREEN under the same mutation (jsonb is
    //           read-compatible), which is exactly why this catalog pin exists alongside
    //           it: the round-trip alone would bless a drifted table. Restored, green (7).
    const cols = await admin.query(
      `select column_name, data_type, datetime_precision, is_nullable
         from information_schema.columns
        where table_schema = 'approval_auth' and table_name = 'sessions'
        order by ordinal_position`,
    );
    expect(cols.rows).toEqual([
      { column_name: "sid", data_type: "character varying", datetime_precision: null, is_nullable: "NO" },
      { column_name: "sess", data_type: "json", datetime_precision: null, is_nullable: "NO" },
      // timestamp(6) WITHOUT time zone — the store's own table.sql, kept verbatim.
      { column_name: "expire", data_type: "timestamp without time zone", datetime_precision: 6, is_nullable: "NO" },
    ]);
    const pk = await admin.query(
      `select a.attname from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
        where n.nspname = 'approval_auth' and c.relname = 'sessions' and i.indisprimary`,
    );
    expect(pk.rows.map((r) => r.attname)).toEqual(["sid"]);
    // The prune query (`DELETE ... WHERE expire < ...`) ranges over expire; the store's
    // own DDL ships this index and so do we.
    const idx = await admin.query(
      `select indexdef from pg_indexes
        where schemaname = 'approval_auth' and tablename = 'sessions'
          and indexdef like '%(expire)%'`,
    );
    expect(idx.rowCount).toBe(1);
  });

  it("the approval role could NOT have auto-created it: CREATE is held on no schema", async () => {
    // Constraint re-verified rather than trusted: `createTableIfMissing: true` would 42501
    // at first boot, and a table minted outside the checksum-pinned ledger is the defect
    // class migrate.ts refuses. This pin is what keeps `createTableIfMissing: false` from
    // quietly becoming `true` on the grounds that "it works on my machine" (where the
    // operator ran as owner).
    const r = await admin.query(
      `select has_schema_privilege('switchboard_approval', s, 'create') as can_create,
              s as schema
         from unnest(array['public', 'approval', 'approval_auth']) s`,
    );
    for (const row of r.rows) {
      expect(row.can_create, `CREATE on schema ${row.schema}`).toBe(false);
    }
  });

  it("connect-pg-simple round-trips against the migration-created table as switchboard_approval", async () => {
    // The DDL claim, verified by the CONSUMER rather than by string comparison: the real
    // store, `createTableIfMissing: false`, on the approval role's own connection.
    const { default: session } = await import("express-session");
    const { default: connectPgSimple } = await import("connect-pg-simple");
    const PgStore = connectPgSimple(session);
    const store = new PgStore({
      pool: approval,
      schemaName: "approval_auth",
      tableName: "sessions",
      createTableIfMissing: false,
      pruneSessionInterval: false,
    });
    const sid = `m019-${Math.random().toString(36).slice(2)}`;
    const sess = { cookie: { maxAge: 60_000 }, userId: "someone" };
    await new Promise<void>((res, rej) => store.set(sid, sess as never, (e) => (e ? rej(e) : res())));
    const got = await new Promise<unknown>((res, rej) =>
      store.get(sid, (e, s) => (e ? rej(e) : res(s))),
    );
    expect((got as { userId?: string }).userId).toBe("someone");
    await new Promise<void>((res, rej) => store.destroy(sid, (e) => (e ? rej(e) : res())));
    const gone = await new Promise<unknown>((res, rej) =>
      store.get(sid, (e, s) => (e ? rej(e) : res(s))),
    );
    expect(gone == null).toBe(true);
  });
});

describe("019: grants — each verb the surface needs, and not one more", () => {
  it("sessions: the approval role holds all four verbs (the store's get/set/touch/destroy/prune)", async () => {
    await approval.query(
      `insert into approval_auth.sessions (sid, sess, expire)
       values ('acl-probe', '{}'::json, now()::timestamp + interval '1 hour')`,
    );
    await approval.query(`update approval_auth.sessions set expire = expire where sid = 'acl-probe'`);
    const sel = await approval.query(`select sid from approval_auth.sessions where sid = 'acl-probe'`);
    expect(sel.rowCount).toBe(1);
    // THE DELETE THAT COULD NOT LIVE IN `approval`: 015's "No DELETE anywhere" is about
    // the audit trail, and this row is not audit — it is ephemeral by design.
    await approval.query(`delete from approval_auth.sessions where sid = 'acl-probe'`);
  });

  it("login_tokens: UPDATE is column-scoped — used_at yes (42501-free), token_hash NO", async () => {
    // mutation: widen 019's grant to `grant update on approval_auth.login_tokens` (table
    //           level) -> the token_hash 42501 assertion reds. RUN ✅ 2026-08-15 —
    //           observed: 1 failed | 6 passed, AssertionError: promise resolved
    //           "Result{ command: 'UPDATE', …(9) }" instead of rejecting, at the
    //           `set token_hash = 'rewritten'` expect. Restored, green (7).
    const userId = await seedUser();
    const tokenId = await seedToken(userId);
    await approval.query(
      `update approval_auth.login_tokens set used_at = now() where id = $1`,
      [tokenId],
    );
    await expect(
      approval.query(
        `update approval_auth.login_tokens set token_hash = 'rewritten' where id = $1`,
        [tokenId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      approval.query(`delete from approval_auth.login_tokens where id = $1`, [tokenId]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("login_audit: append-only — INSERT+SELECT live, UPDATE and DELETE are 42501", async () => {
    // mutation: widen 019 to `grant select, insert, update, delete on
    //           approval_auth.login_audit` -> reds. RUN ✅ 2026-08-16 — observed:
    //           1 failed | 6 passed, AssertionError: promise resolved
    //           "Result{ command: 'UPDATE', …(9) }" instead of rejecting (the UPDATE
    //           expect throws first; the DELETE expect is behind the same grant).
    //           Restored, green (7).
    const userId = await seedUser();
    const tokenId = await seedToken(userId);
    const ins = await approval.query(
      `insert into approval_auth.login_audit (user_id, token_id) values ($1, $2) returning id`,
      [userId, tokenId],
    );
    const auditId = ins.rows[0].id as string;
    const sel = await approval.query(`select user_id from approval_auth.login_audit where id = $1`, [auditId]);
    expect(sel.rows[0].user_id).toBe(userId);
    await expect(
      approval.query(`update approval_auth.login_audit set logged_in_at = now() where id = $1`, [auditId]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      approval.query(`delete from approval_auth.login_audit where id = $1`, [auditId]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the agent role reaches NOTHING here — schema USAGE itself is denied", async () => {
    // 42501 with "permission denied for schema" — the deny happens before any table ACL
    // is even consulted, which is what `revoke all on schema ... from switchboard_agent`
    // plus never granting USAGE buys.
    await expect(agent.query(`select * from approval_auth.sessions`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(agent.query(`select * from approval_auth.login_tokens`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(agent.query(`select * from approval_auth.login_audit`)).rejects.toMatchObject({
      code: "42501",
    });
  });
});
