-- 014: the approval service's schema and its own least-privilege role (Phase 3 / A1).
--
-- WHY THIS IS NOT IN THE AGENT'S PROCESS. Phase 3 needs the agent to *propose* actions,
-- and proposals must be persisted. ADR `docs/adr/agent-writer-boundary.md` originally
-- said the host writes them; that rested on the premise that the agent host is already
-- the full-privilege role, which the code disproves. Putting a writable pool in the
-- agent process would permanently destroy the property the README publishes. So the
-- writer lives in the client-facing approval service (A0b builds it anyway, so the
-- marginal deployment cost is zero processes), and the agent hands it a validated
-- object across an authenticated door. `switchboard_agent`'s ACL does not change here,
-- and must not: a red `switchboard_agent=r` assertion is a design violation.
--
-- WHY A DEDICATED ROLE, AND NOT `switchboard`. The migration owner is the one role able
-- to run `grant insert on ... to switchboard_agent`. If the approval service connected
-- as the owner, an attacker who reached it would not need to defeat the containment —
-- they could simply delete the differentiator. `switchboard_approval` owns nothing, can
-- grant nothing (no privilege here carries WITH GRANT OPTION), and holds exactly the two
-- verbs the proposal door performs.
--
-- WHY ITS OWN SCHEMA, NOT THE ANALYTICS ONE. `grantAgentReadOnly()` in src/migrate.ts
-- attaches `alter default privileges ... grant select on tables to switchboard_agent`
-- inside DBT_SCHEMA. A proposals table created there would silently become readable by
-- the agent — not a violation of the write claim, but an undiscussed widening of its
-- read surface. `approval` is outside that schema and gets no agent grant of any kind.
--
-- Idempotent and concurrency-safe in the idiom of 005/006: parallel ephemeral-database
-- test migrations race the role block.

do $$
begin
  if not exists (select from pg_roles where rolname = 'switchboard_approval') then
    -- LOCAL DEV CREDENTIAL, same class as the committed docker-compose POSTGRES_PASSWORD
    -- and migration 005's. Set only at creation, so a production `alter role ... password`
    -- is never reset by re-migration. Production supplies APPROVAL_DATABASE_URL.
    create role switchboard_approval login password 'switchboard_approval';
  end if;
exception
  when duplicate_object then null; -- lost a create race to a parallel migration: fine
end
$$;

create schema if not exists approval;

-- The proposal an agent asks a human to approve. Append-only from the door's point of
-- view: the door INSERTs and never mutates. The lifecycle transition (pending ->
-- approved/rejected) belongs to A0b's approval page and arrives with its own migration
-- and its own grant, so `switchboard_approval` deliberately holds no UPDATE today —
-- privilege granted ahead of a caller is privilege nobody is watching.
create table if not exists approval.proposals (
  id                uuid primary key default gen_random_uuid(),
  -- One deployment serves one configured tenant (SEC-C1), but the column is carried so a
  -- proposal row is never tenant-blind and the flood cap below can be scoped honestly.
  tenant_id         uuid        not null,
  -- FLOOD CONTROL, half one. A compromised agent host holds the door's bearer secret, so
  -- it can forge well-formed proposals at volume; the terminal state of that is an
  -- approval queue no human can triage, which DISABLES the "nothing acts without an
  -- identified approver" constraint rather than merely annoying it. A unique key makes a
  -- replay a no-op at the database instead of at the door, and it is free only while this
  -- table is being created — retrofitting it is a migration plus a backfill.
  idempotency_key   text        not null,
  action_type       text        not null,
  payload           jsonb       not null,
  -- The agent's stated reason, carried verbatim for the human who decides. Never parsed.
  rationale         text        not null,
  state             text        not null default 'pending'
                                check (state in ('pending', 'approved', 'rejected')),
  created_at        timestamptz not null default now(),
  constraint proposals_idempotency_unique unique (tenant_id, idempotency_key)
);

-- FLOOD CONTROL, half two reads this index: the door counts pending rows for the tenant
-- before it inserts, and refuses loudly at the cap. Partial, because the count only ever
-- asks about one state.
create index if not exists proposals_pending_by_tenant
  on approval.proposals (tenant_id)
  where state = 'pending';

-- Least privilege, stated exactly. USAGE on the schema; SELECT and INSERT on the one
-- table. No UPDATE, no DELETE, no CREATE, no grant option, and nothing at all on raw,
-- ingest, or the analytics schema — the approval service has no business reading the
-- warehouse.
grant usage on schema approval to switchboard_approval;
grant select, insert on approval.proposals to switchboard_approval;

-- Belt and braces against a future `grant ... on all tables in schema public` style edit:
-- the agent is named here only to be denied. This is a no-op today (it was never granted)
-- and exists so the intent is legible in the migration a reviewer reads, not only in a
-- test. `switchboard_agent`'s ACL on the analytics schema is untouched.
revoke all on schema approval from switchboard_agent;
revoke all on approval.proposals from switchboard_agent;
