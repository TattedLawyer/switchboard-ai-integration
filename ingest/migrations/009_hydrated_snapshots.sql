-- 009 — hydrated snapshots for thin-webhook sources (Task C, hub-hydrate connector; D7).
--
-- The thin-webhook paradigm delivers METADATA-ONLY events; the full record is fetched
-- afterwards. D7 (spec-locked) keeps the two truths apart: the thin event stays in
-- raw.raw_events EXACTLY as received, and the fetched full record lives HERE, keyed by
-- the event that triggered the fetch, stamped with fetch time — because the snapshot is
-- FETCH-time state, not notify-time state (mutations can land in between; staging's
-- occurred_at-wins ordering governs sequencing, never this table).
--
-- tombstone = the deleted-before-fetch outcome: the object answered 404 by the time we
-- asked. A tombstone row IS a terminal hydration state (the second oracle's trichotomy:
-- snapshot | DLQ | nothing-in-limbo — tombstones are snapshot-table rows).
-- Additive and idempotent, house style.
create table if not exists ingest.hydrated_snapshots (
  tenant_id  uuid not null default '00000000-0000-0000-0000-000000000000',
  event_id   text not null,
  object_type text not null,
  object_id  text not null,
  fetched_at timestamptz not null default now(),
  snapshot   jsonb,
  tombstone  boolean not null default false,
  primary key (tenant_id, event_id),
  -- "Hydrated with nothing" is a lie: a row must carry a snapshot or be a tombstone.
  constraint hydrated_snapshots_content check (tombstone or snapshot is not null)
);

-- Reconcile and drift checks read per-object; the PK covers the per-event path.
create index if not exists ix_hydrated_snapshots_object
  on ingest.hydrated_snapshots (tenant_id, object_type, object_id);

-- Same tenant posture as every ingest table (006): app-role access + forced RLS with the
-- documented unset-context fallback.
grant select, insert, update, delete on ingest.hydrated_snapshots to switchboard_app;

alter table ingest.hydrated_snapshots enable row level security;
alter table ingest.hydrated_snapshots force row level security;
drop policy if exists tenant_isolation on ingest.hydrated_snapshots;
create policy tenant_isolation on ingest.hydrated_snapshots
  using (
    coalesce(current_setting('switchboard.tenant_id', true), '') = ''
    or tenant_id::text = current_setting('switchboard.tenant_id', true)
  )
  with check (
    coalesce(current_setting('switchboard.tenant_id', true), '') = ''
    or tenant_id::text = current_setting('switchboard.tenant_id', true)
  );
