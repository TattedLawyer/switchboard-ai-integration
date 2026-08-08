-- 011 — ingest.outbox → ingest.ingest_journal (debt-burn B10): rename to the truth,
-- bound the growth.
--
-- The table was NAMED for the transactional-outbox pattern and implemented half of it:
-- rows are written inside the ingest transaction (ingest-event.ts), and there the story
-- ends. The pattern's authority (microservices.io, Transactional Outbox) requires the
-- other half — "a separate process retrieves and publishes stored messages to the
-- broker" (Message Relay) — and this system has no relay, no broker, and no consumer:
-- dbt reads raw.raw_events directly, and delivery durability comes from pg-boss.
-- Implementing a relay would mean building a publisher with no subscriber. So the table
-- is renamed to what it actually is: an in-transaction ingest journal — one row per
-- accepted event, the demo's per-source equality counter (ledger = raw = journal) and a
-- cheap audit surface. A REAL transactional outbox becomes warranted only when a
-- downstream message consumer exists (Phase 3/4 automation surface); build it then,
-- with the relay, not the name alone.
--
-- Runs once under checksum tracking (schema_migrations), so the bare RENAMEs are safe.
-- Tenancy artifacts from 006 (tenant_id column, its index, the forced tenant_isolation
-- policy) follow the table through the rename.

alter table ingest.outbox rename to ingest_journal;
alter index if exists ix_outbox_tenant_id rename to ix_ingest_journal_tenant_id;

-- processed_at was the relay's column — the pattern promises a process that marks rows
-- processed, and nothing ever set it. A journal records; it does not dispatch.
alter table ingest.ingest_journal drop column if exists processed_at;

-- Growth bound: 30-day time TTL, chosen over a size cap (research §B10 leaves the
-- mechanism to the implementer; reasoning recorded here). The journal's one reader is
-- the equality check over a RECENT window — a row-count cap would silently shorten that
-- window under load, exactly when the counter matters most, while a time bound keeps
-- the window's meaning fixed and the demo (minutes long) untouched. Enforced by an
-- AFTER INSERT statement trigger so the bound holds through every door (service, CLI,
-- tests) with no janitor process to deploy or forget; with the index below, the prune
-- is a leftmost btree probe when nothing has expired. The 30-day constant is deliberate
-- config-free simplicity — revisit if an ops window ever needs more history.
create index if not exists ix_ingest_journal_created_at on ingest.ingest_journal (created_at);

create or replace function ingest.ingest_journal_ttl() returns trigger
language plpgsql as $$
begin
  delete from ingest.ingest_journal where created_at < now() - interval '30 days';
  return null;
end $$;

drop trigger if exists trg_ingest_journal_ttl on ingest.ingest_journal;
create trigger trg_ingest_journal_ttl
  after insert on ingest.ingest_journal
  for each statement execute function ingest.ingest_journal_ttl();
