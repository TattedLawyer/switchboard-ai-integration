create table if not exists raw.raw_events (
  id bigserial primary key,
  source text not null,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create unique index if not exists uq_raw_events_source_event_id
  on raw.raw_events (source, event_id);
-- Preserve Phase 1 history: copy-then-drop. Order by id keeps relative arrival order in the
-- new bigserial. Guarded so the script stays idempotent even if 001 ever stops recreating
-- the legacy table. CASCADE: the standing dev DB has the dbt-managed view
-- public_analytics.stg_crm__companies depending on the legacy table; that view is a derived
-- artifact whose model now reads raw.raw_events, and the next `dbt build` recreates it —
-- dropping the stale view alongside the table it reads is exactly the intended cutover.
do $$
begin
  if to_regclass('raw.raw_crm_events') is not null then
    insert into raw.raw_events (source, event_id, event_type, payload, received_at)
      select 'crm', event_id, event_type, payload, received_at
      from raw.raw_crm_events
      order by id
      on conflict (source, event_id) do nothing;
    drop table raw.raw_crm_events cascade;
  end if;
end $$;
alter table ingest.outbox add column if not exists source text not null default 'crm';
alter table ingest.quarantine add column if not exists source text not null default 'crm';
