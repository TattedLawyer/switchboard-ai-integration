-- 006 — tenant isolation as a database fact.
--
-- Before this, raw.raw_events was unique on (source, event_id). That is the correct
-- exactly-once key for ONE tenant and a silent data-loss bug for two: both businesses
-- legitimately emit `evt-1` from their own CRM, and `on conflict do nothing` swallowed the
-- second and reported it as a de-duplication.
--
-- Model: shared database, shared schema, tenant_id column — the documented default, with
-- database-per-tenant reserved for compliance-driven cases. Two things make it real rather
-- than conventional:
--   1. Uniqueness is keyed on (tenant_id, source, event_id), so exactly-once is preserved
--      WITHIN a tenant while collisions ACROSS tenants become distinct rows.
--   2. Row level security is FORCEd. Postgres exempts a table's owner from its own policies
--      unless forced, which is the most common reason RLS is silently inert in production —
--      and this application connects as the owning role, exactly the vulnerable shape.
--
-- Backfill: existing single-tenant rows adopt the nil UUID as their tenant. That keeps the
-- demo, the seeded manifest, and every existing test on one coherent tenant rather than
-- inventing per-row identities that would fragment the identity layer.

-- ── The role RLS can actually bind ───────────────────────────────────────────────────────
-- PostgreSQL: "Superusers and roles with the BYPASSRLS attribute ALWAYS bypass the row
-- security system when accessing a table. Table owners normally bypass row security as well,
-- though a table owner can choose to be subject to row security with ALTER TABLE ... FORCE
-- ROW LEVEL SECURITY."
--
-- The default `switchboard` role in this project is a SUPERUSER (docker-compose creates it as
-- POSTGRES_USER). No amount of FORCE binds it. So "we enforce tenant isolation with RLS" is
-- an untrue claim for any connection using that role — which is why the accompanying test
-- proves isolation through THIS role instead, and would fail if someone pointed it back at
-- the superuser. Extends the least-privilege pattern migration 005 established for the agent.
do $$
begin
  if not exists (select from pg_roles where rolname = 'switchboard_app') then
    create role switchboard_app login password 'switchboard_app';
  end if;
exception
  when duplicate_object then null; -- lost a create race to a parallel migration: fine
end
$$;

grant usage on schema raw, ingest to switchboard_app;
grant select, insert, update, delete on all tables in schema raw, ingest to switchboard_app;
grant usage, select on all sequences in schema raw, ingest to switchboard_app;
-- FOR ROLE is required: default privileges only govern objects created by the named role,
-- and omitting it silently covers nothing when a different role runs later migrations.
alter default privileges for role switchboard in schema raw, ingest
  grant select, insert, update, delete on tables to switchboard_app;
alter default privileges for role switchboard in schema raw, ingest
  grant usage, select on sequences to switchboard_app;

-- ── raw.raw_events ───────────────────────────────────────────────────────────────────────
alter table raw.raw_events
  add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';

-- Replace the tenant-blind uniqueness key. Order matters: create the new index BEFORE
-- dropping the old one so there is no window in which duplicates could land.
create unique index if not exists uq_raw_events_tenant_source_event_id
  on raw.raw_events (tenant_id, source, event_id);
drop index if exists raw.uq_raw_events_source_event_id;

-- RLS reads this column on every row; without an index the policy predicate degrades every
-- query to a scan.
create index if not exists ix_raw_events_tenant_id on raw.raw_events (tenant_id);

-- ── ingest.outbox ────────────────────────────────────────────────────────────────────────
-- The demo's equality counter reads this. Left tenant-blind it would merge two tenants'
-- counts and the 288/288/288 proof would quietly stop meaning anything.
alter table ingest.outbox
  add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';
create index if not exists ix_outbox_tenant_id on ingest.outbox (tenant_id);

-- ── ingest.quarantine ────────────────────────────────────────────────────────────────────
-- A quarantined payload is still that tenant's data, and an operator replaying it must not
-- be able to replay it into someone else's lane.
alter table ingest.quarantine
  add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';
create index if not exists ix_quarantine_tenant_id on ingest.quarantine (tenant_id);

-- ── ingest.cursors ───────────────────────────────────────────────────────────────────────
-- Backfill position is per tenant per source; sharing one cursor across tenants would make
-- one tenant's progress skip another's events.
alter table ingest.cursors
  add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000000';

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'ingest.cursors'::regclass and contype = 'p'
      and array_length(conkey, 1) = 1
  ) then
    alter table ingest.cursors drop constraint cursors_pkey;
    alter table ingest.cursors add primary key (tenant_id, source);
  end if;
end $$;

-- ── Row level security ───────────────────────────────────────────────────────────────────
-- Policy: a row is visible when it belongs to the tenant in the session's context, OR when
-- no context has been set. The permissive fallback is deliberate and is what keeps the
-- single-tenant demo, the migration tooling, and reconcile working unchanged — those run
-- with no tenant context and legitimately operate across the whole store. Multi-tenant
-- deployments set the context per connection; the accompanying tests pin that once set, the
-- boundary holds even for the owning role.
--
-- NOTE (deferred, disclosed): the "unset context sees everything" fallback means RLS here is
-- a guard against cross-tenant LEAKS in tenant-scoped code paths, not a defence against a
-- compromised application role that simply declines to set the context. Closing that requires
-- a dedicated non-owner application role whose policy has no fallback branch. Migration 005
-- already established the least-privilege agent role, which is the pattern to extend.
do $$
declare
  t text;
begin
  foreach t in array array['raw.raw_events', 'ingest.outbox', 'ingest.quarantine', 'ingest.cursors']
  loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('drop policy if exists tenant_isolation on %s', t);
    execute format($f$
      create policy tenant_isolation on %s
        using (
          coalesce(current_setting('switchboard.tenant_id', true), '') = ''
          or tenant_id::text = current_setting('switchboard.tenant_id', true)
        )
        with check (
          coalesce(current_setting('switchboard.tenant_id', true), '') = ''
          or tenant_id::text = current_setting('switchboard.tenant_id', true)
        )
    $f$, t);
  end loop;
end $$;
