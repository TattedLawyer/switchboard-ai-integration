-- 019: authenticated identity for the human approval surface (Phase 3 / A0b).
--
-- WHY THIS IS A NEW FILE. 014-018 are applied and checksum-enforced
-- (src/migrate.ts:105-118): editing an applied file makes `runMigrations` refuse.
-- Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015's idiom. `migrate.ts` submits this file as ONE
-- `client.query(sql)` — a multi-statement simple query, which PostgreSQL wraps in an
-- implicit transaction provided the file contains no explicit BEGIN/COMMIT. It contains
-- none and must never contain any: the create-then-grant blocks below are only safe
-- because no window exists between them.
--
-- 🚨 WHY A NEW SCHEMA AND NOT `approval`. Migration 015 declares — and enforces by
-- granting no DELETE on anything — that the `approval` schema is append-only: decisions,
-- executions and proposals accumulate, because they are the audit trail. A web session is
-- the OPPOSITE kind of row: `express-session` destroys sessions on logout and
-- `connect-pg-simple` prunes expired ones, both of which are DELETEs. Granting DELETE
-- inside `approval` to make sessions work would dissolve the append-only claim for the
-- tables the claim is actually about. So the ephemeral auth state lives in its own schema,
-- `approval_auth`, where DELETE on `sessions` is granted deliberately and DELETE on the
-- login audit is deliberately NOT — the audit table keeps `approval`'s append-only
-- discipline even though it lives outside that schema.
--
-- 🚨 WHY THE SESSION TABLE IS MIGRATION-CREATED rather than `createTableIfMissing: true`.
-- Measured, not assumed: `switchboard_approval` holds CREATE on no schema (by design —
-- migration 014 gives it exactly the verbs the door performs), so the store's auto-create
-- fails with 42501 at first boot. And a table created outside this ledger by whoever
-- happened to hold owner credentials would diverge from the checksum-pinned migration
-- chain — the exact defect class `migrate.ts` exists to refuse. The service passes
-- `createTableIfMissing: false` and this file is the one place the table can come from.

create schema if not exists approval_auth;

-- ---------------------------------------------------------------------------------------
-- SESSIONS — the shape `connect-pg-simple` expects, byte for byte where it matters.
-- ---------------------------------------------------------------------------------------
--
-- Mirrors the store's own `table.sql` (node_modules/connect-pg-simple/table.sql): `sid`
-- varchar primary key, `sess` json NOT NULL, `expire` timestamp(6) NOT NULL, and an index
-- on `expire` for the prune query. `sess` is `json`, not `jsonb`, and `expire` is a
-- TIMESTAMP WITHOUT TIME ZONE — both the store's choices, kept verbatim because the store
-- reads and writes this table with its own SQL and the table must be the one it expects,
-- not a "better" one. (The store's `WITH (OIDS=FALSE)` clause is dropped: PG 12+ has no
-- row OIDs to disable.)
--
-- NO FK to `approval.users`, deliberately: the store owns this table's shape, an
-- anonymous pre-login session has no user yet, and the user id lives inside `sess` where
-- only the application reads it.
create table approval_auth.sessions (
  sid    varchar      not null collate "default",
  sess   json         not null,
  expire timestamp(6) not null,
  constraint sessions_pkey primary key (sid)
);

create index sessions_expire_idx on approval_auth.sessions (expire);

-- ---------------------------------------------------------------------------------------
-- MAGIC-LINK TOKENS — hashed at rest, single-use, short-lived.
-- ---------------------------------------------------------------------------------------
--
-- `token_hash` is a SHA-256 hex digest of the raw token; THE RAW TOKEN IS NEVER STORED.
-- The ADR (`docs/adr/approver-identity.md`) names the hazard: a magic link is a bearer
-- token in an inbox. Hashing at rest means a database read (backup, log, compromised
-- replica) yields nothing a browser can present. Uniqueness on the hash is uniqueness on
-- the token, without the token ever touching the table.
--
-- Single-use is enforced by `used_at` plus the application's atomic compare-and-set
-- (`update ... set used_at = now() where token_hash = $1 and used_at is null and
-- expires_at > now()`), the same conditional-UPDATE idiom decide.ts uses: check and use
-- are one statement, so two racing consumers cannot both win.
create table approval_auth.login_tokens (
  id         uuid        primary key default gen_random_uuid(),
  -- NEVER an email column here: the token names a row in the approver list, so a token
  -- for a user who was since disabled dies with the `disabled_at` check at consume time.
  user_id    uuid        not null references approval.users(id),
  token_hash text        not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,
  constraint login_tokens_hash_unique unique (token_hash)
);

-- The per-account request rate limit counts recent rows for one user; give that count an
-- index rather than a sequential scan over a table that only grows.
create index login_tokens_by_user_created
  on approval_auth.login_tokens (user_id, created_at);

-- ---------------------------------------------------------------------------------------
-- LOGIN AUDIT — append-only, one row per login.
-- ---------------------------------------------------------------------------------------
--
-- The ADR's requirement in terms: "because these links authorise outward actions — an
-- audit row for every login, not only for every approval." Append-only by the same
-- mechanism as `approval.decisions`: no role holds UPDATE or DELETE, so the 42501 is the
-- guarantee, pinned in `ingest/test/migration-019-auth.test.ts`.
create table approval_auth.login_audit (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references approval.users(id),
  -- Which link produced this session — the join an auditor wants when a login looks wrong.
  token_id     uuid        not null references approval_auth.login_tokens(id),
  logged_in_at timestamptz not null default now()
);

create index login_audit_by_user on approval_auth.login_audit (user_id, logged_in_at);

-- ---------------------------------------------------------------------------------------
-- GRANTS. Written down table by table, in 014/015's precedent, so every pin is against a
-- grant the design chose rather than one an implementer happened to write.
-- ---------------------------------------------------------------------------------------

grant usage on schema approval_auth to switchboard_approval;

-- The session store's four verbs, all of them needed and each traceable to a store query:
-- SELECT (get), INSERT+UPDATE (set's upsert, and touch's rolling-expiry UPDATE), DELETE
-- (destroy, and the expired-session prune). This is the grant that could not live in
-- `approval` — see the header.
grant select, insert, update, delete on approval_auth.sessions to switchboard_approval;

-- Tokens: issue (INSERT), look up and rate-limit (SELECT), and mark used — which is
-- COLUMN-level UPDATE on `used_at` alone, so the service that consumes tokens cannot
-- rewrite a token's hash, owner, or expiry. (Per 015's note: a nontrivial UPDATE also
-- requires SELECT, granted on the line above it.)
grant select, insert on approval_auth.login_tokens to switchboard_approval;
grant update (used_at) on approval_auth.login_tokens to switchboard_approval;

-- Append-only, like `approval.decisions`: the 42501 on UPDATE and DELETE is the guarantee.
grant select, insert on approval_auth.login_audit to switchboard_approval;

-- Nothing — not one privilege, on any of these objects — to the agent or the crm role,
-- each named here only to be denied, in 014's idiom, so the intent is legible in the
-- migration a reviewer reads and not only in a test.
revoke all on schema approval_auth from switchboard_agent;
revoke all on approval_auth.sessions     from switchboard_agent;
revoke all on approval_auth.login_tokens from switchboard_agent;
revoke all on approval_auth.login_audit  from switchboard_agent;
revoke all on schema approval_auth from switchboard_crm;
revoke all on approval_auth.sessions     from switchboard_crm;
revoke all on approval_auth.login_tokens from switchboard_crm;
revoke all on approval_auth.login_audit  from switchboard_crm;
